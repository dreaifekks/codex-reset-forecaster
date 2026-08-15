import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { confirmationIdentityIds } from "../src/core/sources.mjs";
import { assertCanonicalRecord } from "../src/core/validate-record.mjs";
import {
  isAuthorityTimingSupportSignal,
} from "../src/model/authority-timing-eligibility.mjs";
import { extractSignal, normalizeNewObservations } from "../src/pipeline/extract.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import { adjudicateOutcomes } from "../src/pipeline/outcomes.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";
import {
  OpenAICompatibleSemanticTimingAssessor,
} from "../src/semantic-assistance/openai-compatible-chat.mjs";
import {
  semanticTimingPhaseHasWrapperSupport,
} from "../src/semantic-assistance/phase-policy.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

function response(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

async function enabledConfig(tokenFile, directory) {
  return loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: {
      extractor: {
        semantic_assistance: {
          enabled: true,
          token_file: tokenFile,
        },
      },
      runtime: { data_dir: directory },
    },
  });
}

function observation(text, id, config, {
  identityId = "person_tibo_sottiaux",
  handle = "thsottiaux",
  nativeRelations = [],
  publishedAt = "2026-08-13T01:01:00.000Z",
  firstSeenAt = "2026-08-13T01:02:00.000Z",
} = {}) {
  return rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/${handle}/status/${id}`,
    published_at: publishedAt,
    author: {
      provider_author_id: `${handle}-x-id`,
      identity_id: identityId,
      display_handle: `@${handle}`,
    },
    native_relations: nativeRelations,
    content: { media_type: "text/plain", text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: config.providers.x,
    firstSeenAt,
    fetchedAt: firstSeenAt,
  });
}

test("semantic assistance configuration is disabled safely and requires a secret file when enabled", async () => {
  const disabled = await loadConfig();
  assert.equal(disabled.extractor.semantic_assistance.enabled, false);
  assert.equal(disabled.extractor.semantic_assistance.token_file, null);
  await assert.rejects(
    loadConfig({
      overrides: {
        extractor: { semantic_assistance: { enabled: true } },
      },
    }),
    /requires a token_file/,
  );
  await assert.rejects(
    loadConfig({
      overrides: {
        extractor: {
          semantic_assistance: {
            base_url: "http://tokenflux.example/v1",
          },
        },
      },
    }),
    /fail-closed policy/,
  );
});

test("OpenAI-compatible assessor sends bounded public text and accepts only safe timing phases", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-client-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "tokenflux-test-key\n", { mode: 0o600 });
  const config = await enabledConfig(tokenFile, directory);
  const requests = [];
  const assessor = new OpenAICompatibleSemanticTimingAssessor({
    policy: config.extractor.semantic_assistance,
    now: () => new Date("2026-08-13T01:03:00.000Z"),
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return response({
        choices: [{
          message: {
            content: JSON.stringify({
              self_contained_timing_claim: true,
              phase: "started",
              confidence: 0.93,
              reason_code: "own_rollout",
            }),
          },
        }],
      });
    },
  });

  const assessed = await assessor.assess({
    wrapper_text: "Enjoy another reset everyone. Rolling out over the next hour.",
    quote_text: "Codex usage limits were reset for all paid users.",
    target_product: "codex",
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://tokenflux.dev/v1/chat/completions",
  );
  assert.equal(
    requests[0].options.headers.authorization,
    "Bearer tokenflux-test-key",
  );
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.ok(!requests[0].options.body.includes("tokenflux-test-key"));
  assert.deepEqual(assessed, {
    policy_version: "semantic-timing-assistance/1",
    protocol: "openai-compatible-chat-completions/1",
    model: "deepseek-v4-flash",
    prompt_version: "authority-quote-timing/1",
    decision: "applied",
    phase: "started",
    confidence: 0.93,
    response_hash: assessed.response_hash,
    completed_at: "2026-08-13T01:03:00.000Z",
  });
  assert.match(assessed.response_hash, /^sha256:[a-f0-9]{64}$/);

  const completionAssessor = new OpenAICompatibleSemanticTimingAssessor({
    policy: config.extractor.semantic_assistance,
    now: () => new Date("2026-08-13T01:03:00.000Z"),
    fetchFn: async () => response({
      choices: [{
        message: {
          content: JSON.stringify({
            self_contained_timing_claim: true,
            phase: "completed",
            confidence: 0.99,
            reason_code: "completed_or_past",
          }),
        },
      }],
    }),
  });
  assert.equal(await completionAssessor.assess({
    wrapper_text: "The reset is complete.",
    quote_text: "Codex usage limits were discussed.",
    target_product: "codex",
  }), null);

  const inconsistentAssessor = new OpenAICompatibleSemanticTimingAssessor({
    policy: config.extractor.semantic_assistance,
    fetchFn: async () => response({
      choices: [{
        message: {
          content: JSON.stringify({
            self_contained_timing_claim: true,
            phase: "expected",
            confidence: 0.99,
            reason_code: "own_expectation",
          }),
        },
      }],
    }),
  });
  assert.equal(await inconsistentAssessor.assess({
    wrapper_text: "Enjoy another reset everyone. Rolling out over the next hour.",
    quote_text: "Codex usage limits were discussed.",
    target_product: "codex",
  }), null);
});

test("semantic phase policy requires matching wrapper cues and rejects lower-priority conflicts", () => {
  assert.equal(semanticTimingPhaseHasWrapperSupport(
    "Enjoy another reset everyone. Landing in the next hour.",
    "started",
  ), true);
  assert.equal(semanticTimingPhaseHasWrapperSupport(
    "Enjoy another reset everyone. Landing in the next hour.",
    "expected",
  ), false);
  assert.equal(semanticTimingPhaseHasWrapperSupport(
    "We will reset everyone tomorrow.",
    "scheduled",
  ), true);
  assert.equal(semanticTimingPhaseHasWrapperSupport(
    "We should reset everyone tomorrow.",
    "scheduled",
  ), false);
  assert.equal(semanticTimingPhaseHasWrapperSupport(
    "We should reset everyone tomorrow.",
    "expected",
  ), true);
});

test("semantic client rejects unsafe token files and malformed model output", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-fail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "tokenflux-test-key\n", { mode: 0o644 });
  const config = await enabledConfig(tokenFile, directory);
  const badMode = new OpenAICompatibleSemanticTimingAssessor({
    policy: config.extractor.semantic_assistance,
    fetchFn: async () => assert.fail("unsafe token must fail before fetch"),
  });
  await assert.rejects(
    badMode.assess({
      wrapper_text: "Reset rolling out soon.",
      quote_text: "Codex usage limits.",
      target_product: "codex",
    }),
    /mode must be 0400 or 0600/,
  );

  await fs.chmod(tokenFile, 0o600);
  const malformed = new OpenAICompatibleSemanticTimingAssessor({
    policy: config.extractor.semantic_assistance,
    fetchFn: async () => response({
      choices: [{ message: { content: "not json" } }],
    }),
  });
  await assert.rejects(
    malformed.assess({
      wrapper_text: "Reset rolling out soon.",
      quote_text: "Codex usage limits.",
      target_product: "codex",
    }),
    /non-JSON model content/,
  );
});

test("semantic quote assistance creates only a primary started signal with exact late lineage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-pipeline-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "tokenflux-test-key\n", { mode: 0o600 });
  const config = await enabledConfig(tokenFile, directory);
  const store = await new JsonlStore(directory).init();
  const quoted = observation(
    "Codex usage limits were reset for all paid users.",
    "semantic-source",
    config,
    {
      identityId: "community_member",
      handle: "community",
      publishedAt: "2026-08-13T00:40:00.000Z",
      firstSeenAt: "2026-08-13T01:00:00.000Z",
    },
  );
  const wrapper = observation(
    "Enjoy another reset everyone. Landing in the next hour.",
    "semantic-wrapper",
    config,
    {
      nativeRelations: [{
        type: "quotes",
        provider_item_id: "semantic-source",
        url: "https://x.com/community/status/semantic-source",
      }],
      publishedAt: "2026-08-13T01:01:00.000Z",
      firstSeenAt: "2026-08-13T01:02:00.000Z",
    },
  );
  await store.appendMany([quoted, wrapper]);
  let calls = 0;
  const semanticAssessor = {
    async assess(input) {
      calls += 1;
      assert.equal(input.target_product, "codex");
      assert.equal(input.wrapper_text, wrapper.data.content.text);
      assert.equal(input.quote_text, quoted.data.content.text);
      return {
        policy_version: "semantic-timing-assistance/1",
        protocol: "openai-compatible-chat-completions/1",
        model: "deepseek-v4-flash",
        prompt_version: "authority-quote-timing/1",
        decision: "applied",
        phase: "started",
        confidence: 0.91,
        response_hash: `sha256:${"a".repeat(64)}`,
        completed_at: "2026-08-13T01:03:05.000Z",
      };
    },
  };
  const normalized = await normalizeNewObservations(store, config, {
    now: new Date("2026-08-13T01:03:00.000Z"),
    semanticAssessor,
  });
  assert.equal(calls, 1);
  assert.deepEqual(normalized.semantic_assistance, {
    enabled: true,
    attempted: 1,
    applied: 1,
    rejected: 0,
    failed: 0,
  });
  const wrapperSignal = normalized.records.find((signal) =>
    signal.data.observation_refs[0].record_id === wrapper.record_id
  );
  assert.ok(wrapperSignal);
  assertCanonicalRecord(wrapperSignal);
  assert.equal(wrapperSignal.created_at, "2026-08-13T01:03:05.000Z");
  assert.equal(wrapperSignal.data.available_at, "2026-08-13T01:03:05.000Z");
  assert.equal(wrapperSignal.data.claim.phase, "started");
  assert.equal(wrapperSignal.data.claim.scope.product, "codex");
  assert.equal(wrapperSignal.data.claim.scope.population, "platform");
  assert.equal(wrapperSignal.data.provenance.derivation, "primary_statement");
  assert.equal(wrapperSignal.data.extraction.relevance.basis, "self");
  assert.equal(
    wrapperSignal.data.extraction.relevance.reason_code,
    "semantic_authority_quote_timing",
  );
  assert.deepEqual(
    wrapperSignal.data.extraction.semantic_assistance.context_ref,
    { record_id: quoted.record_id, revision: quoted.revision },
  );
  assert.equal(isAuthorityTimingSupportSignal({
    signal: wrapperSignal,
    observation: wrapper,
    policy: config.model.authority_timing,
    confirmationIdentityIds: confirmationIdentityIds(config),
    targetScope: config.target,
  }), true);

  await linkEventCandidates(store, config, {
    asOf: new Date("2026-08-13T01:04:00.000Z"),
  });
  await adjudicateOutcomes(store, config, {
    now: new Date("2026-08-13T01:05:00.000Z"),
  });
  assert.equal((await store.all("reset_outcome")).length, 0);
});

test("semantic assistance errors and completion attempts fall back without promoting quote lineage", async (t) => {
  for (const mode of ["throw", "completed"]) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `semantic-fallback-${mode}-`),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const tokenFile = path.join(directory, "token");
    await fs.writeFile(tokenFile, "tokenflux-test-key\n", { mode: 0o600 });
    const config = await enabledConfig(tokenFile, directory);
    const store = await new JsonlStore(directory).init();
    const quoted = observation(
      "Codex usage limits were reset for all paid users.",
      `fallback-source-${mode}`,
      config,
      {
        identityId: "community_member",
        handle: "community",
        firstSeenAt: "2026-08-13T01:00:00.000Z",
      },
    );
    const wrapper = observation(
      "Enjoy another reset everyone. Landing in the next hour.",
      `fallback-wrapper-${mode}`,
      config,
      {
        nativeRelations: [{
          type: "quotes",
          provider_item_id: `fallback-source-${mode}`,
          url: `https://x.com/community/status/fallback-source-${mode}`,
        }],
      },
    );
    await store.appendMany([quoted, wrapper]);
    const semanticAssessor = {
      async assess() {
        if (mode === "throw") throw new Error("provider unavailable");
        return {
          policy_version: "semantic-timing-assistance/1",
          protocol: "openai-compatible-chat-completions/1",
          model: "deepseek-v4-flash",
          prompt_version: "authority-quote-timing/1",
          decision: "applied",
          phase: "completed",
          confidence: 0.99,
          response_hash: `sha256:${"b".repeat(64)}`,
          completed_at: "2026-08-13T01:03:05.000Z",
        };
      },
    };
    const normalized = await normalizeNewObservations(store, config, {
      now: new Date("2026-08-13T01:03:00.000Z"),
      semanticAssessor,
    });
    const wrapperSignal = normalized.records.find((signal) =>
      signal.data.observation_refs[0].record_id === wrapper.record_id
    );
    assert.ok(wrapperSignal);
    assert.equal(wrapperSignal.data.extraction.semantic_assistance, undefined);
    assert.equal(wrapperSignal.data.extraction.relevance.basis, "quote");
    assert.equal(wrapperSignal.data.provenance.derivation, "quotes");
    assert.equal(normalized.semantic_assistance.applied, 0);
    assert.equal(
      mode === "throw"
        ? normalized.semantic_assistance.failed
        : normalized.semantic_assistance.rejected,
      1,
    );
    assert.equal(extractSignal(wrapper, config, {
      contexts: [],
      semanticAssistance: mode === "completed"
        ? await semanticAssessor.assess()
        : null,
    })?.data?.extraction?.semantic_assistance, undefined);
  }
});

test("semantic assistance candidate gate rejects inherited, narrow, banked, community, and stale wrappers", async (t) => {
  const cases = [
    { name: "inherited", text: "Yep." },
    {
      name: "narrow",
      text: "Enjoy a reset for Pro users. Landing in the next hour.",
    },
    {
      name: "banked",
      text: "A banked Codex reset voucher is landing for later use.",
    },
    {
      name: "community",
      text: "Enjoy another reset everyone. Landing in the next hour.",
      identityId: "community_wrapper",
      handle: "community_wrapper",
    },
    {
      name: "stale",
      text: "Enjoy another reset everyone. Landing in the next hour.",
      firstSeenAt: "2026-08-12T18:00:00.000Z",
    },
  ];

  for (const entry of cases) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `semantic-gate-${entry.name}-`),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const tokenFile = path.join(directory, "token");
    await fs.writeFile(tokenFile, "tokenflux-test-key\n", { mode: 0o600 });
    const config = await enabledConfig(tokenFile, directory);
    const store = await new JsonlStore(directory).init();
    const sourceId = `gate-source-${entry.name}`;
    const quoted = observation(
      "Codex usage limits were reset for all paid users.",
      sourceId,
      config,
      {
        identityId: "community_member",
        handle: "community",
        firstSeenAt: "2026-08-13T01:00:00.000Z",
      },
    );
    const wrapper = observation(
      entry.text,
      `gate-wrapper-${entry.name}`,
      config,
      {
        identityId: entry.identityId,
        handle: entry.handle,
        nativeRelations: [{
          type: "quotes",
          provider_item_id: sourceId,
          url: `https://x.com/community/status/${sourceId}`,
        }],
        firstSeenAt: entry.firstSeenAt,
      },
    );
    await store.appendMany([quoted, wrapper]);
    let calls = 0;
    const normalized = await normalizeNewObservations(store, config, {
      now: new Date("2026-08-13T01:03:00.000Z"),
      semanticAssessor: {
        async assess() {
          calls += 1;
          return null;
        },
      },
    });
    assert.equal(calls, 0, entry.name);
    assert.equal(normalized.semantic_assistance.attempted, 0, entry.name);
  }
});
