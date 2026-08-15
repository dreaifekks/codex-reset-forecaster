import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { modelContractHash } from "../src/model/contract.mjs";
import { extractSignal } from "../src/pipeline/extract.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";

test("configured extractor versions bind signals, configuration, and the model contract", async () => {
  const baseline = await loadConfig();
  const upgraded = await loadConfig({
    overrides: {
      extractor: {
        model: "deterministic-rules",
        model_version: "0.2.7-test",
        prompt_version: "reset-extract/rules-0.2.7-test",
      },
    },
  });
  assert.notEqual(upgraded.config_hash, baseline.config_hash);
  assert.notEqual(modelContractHash(upgraded), modelContractHash(baseline));

  const observation = rawObservationFromItem({
    provider_item_id: "extractor-contract",
    canonical_url: "https://x.com/thsottiaux/status/1234567890123456789",
    published_at: "2026-07-18T03:28:00Z",
    author: {
      provider_author_id: "tibo-x-id",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "We have reset Codex usage limits across all paid plans.",
      language: "en",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: upgraded.providers.x,
    firstSeenAt: "2026-07-18T03:29:00Z",
    fetchedAt: "2026-07-18T03:29:00Z",
  });
  const signal = extractSignal(observation, upgraded);
  const upgradedContract = extractorContract(upgraded);
  assert.deepEqual(signal.data.extraction, {
    model: upgraded.extractor.model,
    model_version: upgraded.extractor.model_version,
    prompt_version: upgraded.extractor.prompt_version,
    semantic_policy_hash: upgradedContract.semantic_policy_hash,
    confidence: 0.94,
    relevance: {
      policy_version: upgradedContract.topic_relevance_policy_version,
      decision: "relevant",
      reason_code: "target_operational_claim",
      basis: "self",
      matched_segments: [
        "We have reset Codex usage limits across all paid plans.",
      ],
      context_refs: [],
    },
  });
  assert.equal(signal.producer.version, upgraded.extractor.model_version);
  assert.throws(
    () => extractorContract({ extractor: { model: "deterministic-rules" } }),
    /prompt_version|model_version/,
  );
});

test("authority generic-completion scope policy is part of the extractor contract", async () => {
  const baseline = await loadConfig();
  const authorityWithoutScopePolicy = await loadConfig({
    overrides: {
      outcome_definition: {
        event_semantics: "qualifying_authority_completion_statement",
        authority_identity_ids: ["person_tibo_sottiaux"],
      },
    },
  });
  const authoritySemantics = await loadConfig({
    overrides: {
      outcome_definition: {
        event_semantics: "qualifying_authority_completion_statement",
        authority_identity_ids: ["person_tibo_sottiaux"],
        scope_policy: "explicit-platform-or-authority-general-codex/1",
      },
    },
  });
  assert.notEqual(
    extractorContract(authoritySemantics).semantic_policy_hash,
    extractorContract(baseline).semantic_policy_hash,
  );
  assert.notEqual(
    extractorContract(authoritySemantics).semantic_policy_hash,
    extractorContract(authorityWithoutScopePolicy).semantic_policy_hash,
  );
});

test("semantic assistance behavior, but not its credential path, is contract-bound", async () => {
  const baseline = await loadConfig();
  const enabled = await loadConfig({
    overrides: {
      extractor: {
        semantic_assistance: {
          enabled: true,
          token_file: "/tmp/semantic-token-a",
        },
      },
    },
  });
  const sameBehaviorDifferentCredential = await loadConfig({
    overrides: {
      extractor: {
        semantic_assistance: {
          enabled: true,
          token_file: "/tmp/semantic-token-b",
        },
      },
    },
  });
  const differentModel = await loadConfig({
    overrides: {
      extractor: {
        semantic_assistance: {
          enabled: true,
          model: "another-model",
          token_file: "/tmp/semantic-token-a",
        },
      },
    },
  });

  assert.notEqual(
    extractorContract(enabled).semantic_policy_hash,
    extractorContract(baseline).semantic_policy_hash,
  );
  assert.equal(
    extractorContract(enabled).semantic_policy_hash,
    extractorContract(sameBehaviorDifferentCredential).semantic_policy_hash,
  );
  assert.equal(enabled.config_hash, sameBehaviorDifferentCredential.config_hash);
  assert.notEqual(
    extractorContract(enabled).semantic_policy_hash,
    extractorContract(differentModel).semantic_policy_hash,
  );
});

test("conflicting roles for one provider-neutral identity fail closed", async () => {
  const conflicting = await loadConfig({
    overrides: {
      providers: {
        conflicting_adapter: {
          confirmation_identities: [{
            identity_id: "person_tibo_sottiaux",
            source_role: "community",
          }],
        },
      },
    },
  });
  assert.throws(
    () => extractorContract(conflicting),
    /Conflicting source roles.*person_tibo_sottiaux/,
  );
  assert.throws(
    () => modelContractHash(conflicting),
    /Conflicting source roles.*person_tibo_sottiaux/,
  );
});
