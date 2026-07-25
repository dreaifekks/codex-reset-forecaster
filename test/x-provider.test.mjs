import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { hashLabel } from "../src/core/hash.mjs";
import { XProvider } from "../src/providers/x-provider.mjs";
import {
  adequateCoverageIntervals,
  coverageAssertions,
} from "../src/pipeline/coverage.mjs";
import { getProviderFreshness } from "../src/runtime/readiness.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("X provider paginates timelines, normalizes relations, persists cursors, and stays idempotent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-provider-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x: {
      enabled: true,
      max_pages_per_poll: 3,
      backfill_start: "2026-07-01T00:00:00Z",
      context_identities: [],
      context_queries: ["Codex reset"],
    } },
  } });
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url.toString());
    if (url.pathname === "/2/users/by/username/thsottiaux") {
      return json({ data: { id: "10", username: "thsottiaux", name: "Tibo" } });
    }
    if (url.pathname === "/2/users/10/tweets") {
      if (!url.searchParams.get("pagination_token")) {
        return json({
          data: [{ id: "101", author_id: "10", created_at: "2026-07-22T10:00:00Z", lang: "en", text: "We will reset Codex usage limits for all paid users soon." }],
          includes: { users: [{ id: "10", username: "thsottiaux" }] },
          meta: { next_token: "next-page" },
        });
      }
      return json({
        data: [{ id: "100", author_id: "10", created_at: "2026-07-21T10:00:00Z", lang: "en", text: "Codex capacity update." }],
        includes: { users: [{ id: "10", username: "thsottiaux" }] },
        meta: {},
      });
    }
    if (url.pathname === "/2/tweets/search/recent") {
      return json({
        data: [{
          id: "200",
          author_id: "20",
          created_at: "2026-07-22T11:00:00Z",
          lang: "en",
          text: "Community expects a Codex reset.",
          referenced_tweets: [{ type: "quoted", id: "101" }],
        }],
        includes: { users: [{ id: "20", username: "community" }] },
        meta: {},
      });
    }
    return new Response("not found", { status: 404 });
  };
  const provider = new XProvider({
    config: config.providers.x,
    bearerToken: "test-token",
    fetchFn,
    now: () => new Date("2026-07-22T12:00:00Z"),
  });
  const first = await provider.collect(store);
  assert.equal(first.collected, 3);
  assert.ok(calls.some((call) => call.includes("pagination_token=next-page")));
  const records = await store.all("raw_observation");
  const quote = records.find((record) => record.data.provider_item_id === "200");
  assert.deepEqual(quote.data.native_relations[0], {
    type: "quotes",
    provider_item_id: "101",
    url: "https://x.com/i/status/101",
  });
  const state = await store.readState("x-provider");
  assert.equal(state.timelines.thsottiaux, "101");
  assert.equal(state.queries["Codex reset"], "200");
  const coverage = await store.readState("coverage");
  assert.equal(coverage.providers.x[0].start, "2026-07-01T00:00:00.000Z");
  assert.equal(coverage.providers.x[0].end, "2026-07-22T12:00:00.000Z");
  assert.equal(coverage.providers.x[0].adequacy, "outcome_only");
  assert.deepEqual(await adequateCoverageIntervals(store, ["x"]), []);
  const second = await provider.collect(store);
  assert.equal(second.collected, 0);
  assert.equal((await store.all("raw_observation")).length, 4);
});

test("incomplete confirmation pagination degrades health without advancing cursor or coverage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-provider-incomplete-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x: {
      enabled: true,
      max_pages_per_poll: 1,
      backfill_start: "2026-07-01T00:00:00Z",
      context_identities: [],
      context_queries: [],
    } },
  } });
  const fetchFn = async (url) => {
    if (url.pathname === "/2/users/by/username/thsottiaux") {
      return json({ data: { id: "10", username: "thsottiaux", name: "Tibo" } });
    }
    if (url.pathname === "/2/users/10/tweets") {
      if (url.searchParams.get("pagination_token")) {
        return json({
          data: [{
            id: "300",
            author_id: "10",
            created_at: "2026-07-21T10:00:00Z",
            lang: "en",
            text: "Codex capacity update.",
          }],
          includes: { users: [{ id: "10", username: "thsottiaux" }] },
          meta: {},
        });
      }
      return json({
        data: [{
          id: "301",
          author_id: "10",
          created_at: "2026-07-22T10:00:00Z",
          lang: "en",
          text: "We will reset Codex usage limits for all paid users soon.",
        }],
        includes: { users: [{ id: "10", username: "thsottiaux" }] },
        meta: { next_token: "still-more" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const provider = new XProvider({
    config: config.providers.x,
    bearerToken: "test-token",
    fetchFn,
    now: () => new Date("2026-07-22T12:00:00Z"),
  });
  const result = await provider.collect(store);
  assert.equal(result.collected, 1);
  assert.equal(result.health.ok, false);
  assert.match(result.health.error, /pagination was not exhausted/);
  const state = await store.readState("x-provider");
  assert.equal(state.timelines.thsottiaux, null);
  assert.equal(state.last_success_at, null);
  assert.match(state.last_error, /coverage was not advanced/);
  const coverage = await store.readState("coverage", { providers: {} });
  assert.deepEqual(coverage.providers, {});

  provider.config.max_pages_per_poll = 2;
  const recovered = await provider.collect(store);
  assert.equal(recovered.collected, 1);
  assert.equal(recovered.health.ok, true);
  const recoveredState = await store.readState("x-provider");
  assert.equal(recoveredState.timelines.thsottiaux, "301");
  assert.equal(recoveredState.confirmation_backfill_complete, true);
  assert.equal(recoveredState.last_error, null);
  const recoveredCoverage = await store.readState("coverage");
  assert.equal(recoveredCoverage.providers.x[0].start, "2026-07-01T00:00:00.000Z");
  assert.equal(recoveredCoverage.providers.x[0].end, "2026-07-22T12:00:00.000Z");
  assert.equal(recoveredCoverage.providers.x[0].adequacy, "outcome_only");
});

test("confirmation coverage stops at poll start while exhaustion evidence uses fetch completion", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-provider-watermark-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x: {
      enabled: true,
      max_pages_per_poll: 1,
      max_retries: 0,
      coverage_safety_lag_seconds: 60,
      backfill_start: "2026-07-01T00:00:00Z",
      context_identities: [],
      context_queries: [],
      revision_recheck_limit: 0,
    } },
  } });
  const fetchFn = async (url) => {
    if (url.pathname === "/2/users/by/username/thsottiaux") {
      return json({ data: { id: "10", username: "thsottiaux", name: "Tibo" } });
    }
    if (url.pathname === "/2/users/10/tweets") {
      return json({
        data: [],
        includes: { users: [] },
        meta: {},
      });
    }
    return new Response("not found", { status: 404 });
  };
  const times = [
    "2026-07-22T12:00:00Z",
    "2026-07-22T12:05:00Z",
    "2026-07-22T12:05:00Z",
  ];
  const provider = new XProvider({
    config: config.providers.x,
    bearerToken: "test-token",
    fetchFn,
    now: () => new Date(times.shift() ?? "2026-07-22T12:05:00Z"),
  });

  await provider.collect(store);

  const [assertion] = await store.allAudit("coverage_assertion");
  assert.equal(assertion.end, "2026-07-22T11:59:00.000Z");
  assert.equal(
    assertion.evidence_refs[0].exhausted_at,
    "2026-07-22T12:05:00.000Z",
  );
  const state = await store.readState("x-provider");
  assert.equal(
    state.last_confirmation_coverage_end_at,
    "2026-07-22T11:59:00.000Z",
  );
  assert.equal(assertion.adequacy, "outcome_only");
});

test("context failures use a separate degraded clock without invalidating confirmation freshness", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-context-health-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x: {
      enabled: true,
      max_pages_per_poll: 1,
      max_retries: 0,
      backfill_start: "2026-07-01T00:00:00Z",
      context_identities: [{
        username: "OpenAI",
        identity_id: "org_openai",
        source_role: "official",
      }],
      context_queries: ["Codex reset"],
      revision_recheck_limit: 25,
    } },
    model: { outcome_coverage_providers: ["x"] },
  } });
  const fetchFn = async (url) => {
    if (url.pathname === "/2/users/by/username/thsottiaux") {
      return json({ data: { id: "10", username: "thsottiaux", name: "Tibo" } });
    }
    if (url.pathname === "/2/users/10/tweets") {
      return json({
        data: [{
          id: "101",
          author_id: "10",
          created_at: "2026-07-22T10:00:00Z",
          lang: "en",
          text: "Codex capacity update.",
        }],
        includes: { users: [{ id: "10", username: "thsottiaux" }] },
        meta: {},
      });
    }
    return new Response("context unavailable", { status: 503 });
  };
  const provider = new XProvider({
    config: config.providers.x,
    bearerToken: "test-token",
    fetchFn,
    now: () => new Date("2026-07-22T12:00:00Z"),
  });

  const result = await provider.collect(store);

  assert.equal(result.health.ok, true);
  assert.equal(result.context_errors.length, 2);
  const state = await store.readState("x-provider");
  assert.equal(state.last_success_at, "2026-07-22T12:00:00.000Z");
  assert.equal(state.last_context_success_at, null);
  assert.equal(state.last_context_failure_at, "2026-07-22T12:00:00.000Z");
  assert.equal(state.context_status, "degraded");
  const freshness = await getProviderFreshness(
    store,
    config,
    new Date("2026-07-22T12:30:00Z"),
  );
  assert.equal(freshness.groups.required_outcome.status, "fresh");
  assert.equal(freshness.groups.context.status, "degraded");
});

test("X provider reads a bearer token from a read-only file without exposing it in config", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-token-file-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "x-bearer-token");
  await fs.writeFile(tokenFile, "file-token\n", { mode: 0o400 });
  let authorization = null;
  const provider = new XProvider({
    config: {
      base_url: "https://api.x.test/2",
      token_file: tokenFile,
      max_retries: 0,
    },
    bearerToken: "",
    fetchFn: async (_url, options) => {
      authorization = options.headers.authorization;
      return json({ data: { id: "10" } });
    },
  });

  await provider.request("/users/by/username/test");

  assert.equal(authorization, "Bearer file-token");
  assert.equal(provider.config.token_file, tokenFile);
  assert.equal(JSON.stringify(provider.config).includes("file-token"), false);
});

test("X_BEARER_TOKEN_FILE enables direct X collection without putting the token in config", {
  concurrency: false,
}, async () => {
  const previous = process.env.X_BEARER_TOKEN_FILE;
  process.env.X_BEARER_TOKEN_FILE = "/run/secrets/x-bearer-token";
  try {
    const config = await loadConfig();
    assert.equal(config.providers.x.enabled, true);
    assert.equal(
      config.providers.x.token_file,
      "/run/secrets/x-bearer-token",
    );
    assert.equal(JSON.stringify(config).includes("file-token"), false);
  } finally {
    if (previous === undefined) delete process.env.X_BEARER_TOKEN_FILE;
    else process.env.X_BEARER_TOKEN_FILE = previous;
  }
});

test("a pinned independent outcome-exhaustiveness attestation can upgrade X coverage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-attested-coverage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const baseConfig = await loadConfig();
  const attestation = {
    attestation_version: "x-outcome-exhaustiveness-attestation/1",
    contract_version: "x-outcome-exhaustiveness/1",
    provider: "x",
    exhaustive_for: "completed_platform_reset_outcomes",
    independent: true,
    attestor: "independent-reset-auditor",
    method: "signed-complete-outcome-ledger-reconciliation",
    issued_at: "2026-07-20T00:00:00Z",
    expires_at: "2026-07-30T00:00:00Z",
    target_scope: baseConfig.target,
    confirmation_identity_ids: ["person_tibo_sottiaux"],
    interval: {
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-23T00:00:00Z",
      boundary: "[start,end)",
    },
  };
  const attestationFile = path.join(directory, "x-outcome-attestation.json");
  await fs.writeFile(attestationFile, `${JSON.stringify(attestation)}\n`, { mode: 0o400 });
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x: {
      enabled: true,
      max_pages_per_poll: 1,
      max_retries: 0,
      backfill_start: "2026-07-01T00:00:00Z",
      context_identities: [],
      context_queries: [],
      revision_recheck_limit: 0,
      outcome_exhaustiveness_contract: {
        version: "x-outcome-exhaustiveness/1",
        attestation_file: attestationFile,
        attestation_sha256: hashLabel(attestation),
      },
    } },
  } });
  const provider = new XProvider({
    config: config.providers.x,
    target: config.target,
    bearerToken: "test-token",
    fetchFn: async (url) => {
      if (url.pathname === "/2/users/by/username/thsottiaux") {
        return json({ data: { id: "10", username: "thsottiaux", name: "Tibo" } });
      }
      if (url.pathname === "/2/users/10/tweets") {
        return json({ data: [], includes: { users: [] }, meta: {} });
      }
      return new Response("not found", { status: 404 });
    },
    now: () => new Date("2026-07-22T12:00:00Z"),
  });

  const result = await provider.collect(store);

  assert.equal(result.coverage_adequacy, "negative_label_eligible");
  assert.equal(result.outcome_exhaustiveness_attestation_status, "valid");
  assert.deepEqual(await adequateCoverageIntervals(store, ["x"]), [{
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-22T12:00:00.000Z",
  }]);
  const [assertion] = await coverageAssertions(store, ["x"]);
  assert.equal(
    assertion.evidence_refs.some((evidence) =>
      evidence.kind === "independent_outcome_exhaustiveness_attestation"
    ),
    true,
  );
});

test("an expired X outcome-exhaustiveness attestation fails closed to outcome-only", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-x-expired-attestation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const baseConfig = await loadConfig();
  const attestation = {
    attestation_version: "x-outcome-exhaustiveness-attestation/1",
    contract_version: "x-outcome-exhaustiveness/1",
    provider: "x",
    exhaustive_for: "completed_platform_reset_outcomes",
    independent: true,
    attestor: "independent-reset-auditor",
    method: "signed-complete-outcome-ledger-reconciliation",
    issued_at: "2026-07-01T00:00:00Z",
    expires_at: "2026-07-21T00:00:00Z",
    target_scope: baseConfig.target,
    confirmation_identity_ids: ["person_tibo_sottiaux"],
    interval: {
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-23T00:00:00Z",
      boundary: "[start,end)",
    },
  };
  const attestationFile = path.join(directory, "expired-x-outcome-attestation.json");
  await fs.writeFile(attestationFile, JSON.stringify(attestation), { mode: 0o400 });
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x: {
      enabled: true,
      max_pages_per_poll: 1,
      max_retries: 0,
      backfill_start: "2026-07-01T00:00:00Z",
      context_identities: [],
      context_queries: [],
      revision_recheck_limit: 0,
      outcome_exhaustiveness_contract: {
        version: "x-outcome-exhaustiveness/1",
        attestation_file: attestationFile,
        attestation_sha256: hashLabel(attestation),
      },
    } },
  } });
  const provider = new XProvider({
    config: config.providers.x,
    target: config.target,
    bearerToken: "test-token",
    fetchFn: async (url) => {
      if (url.pathname === "/2/users/by/username/thsottiaux") {
        return json({ data: { id: "10", username: "thsottiaux", name: "Tibo" } });
      }
      if (url.pathname === "/2/users/10/tweets") {
        return json({ data: [], includes: { users: [] }, meta: {} });
      }
      return new Response("not found", { status: 404 });
    },
    now: () => new Date("2026-07-22T12:00:00Z"),
  });

  const result = await provider.collect(store);

  assert.equal(result.coverage_adequacy, "outcome_only");
  assert.equal(result.outcome_exhaustiveness_attestation_status, "invalid");
  assert.deepEqual(await adequateCoverageIntervals(store, ["x"]), []);
  const state = await store.readState("x-provider");
  assert.ok(
    state.outcome_exhaustiveness_attestation_reasons
      .includes("attestation_expired_or_not_yet_valid"),
  );
});
