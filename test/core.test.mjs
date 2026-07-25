import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { createRecord, producer, recordRef } from "../src/core/records.mjs";
import { assertCanonicalRecord } from "../src/core/validate-record.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { deriveProbabilitySlots } from "../src/model/forecast.mjs";
import { predictHazard, trainLogisticHazard } from "../src/model/logistic-hazard.mjs";
import { startScheduler } from "../src/runtime/scheduler.mjs";
import { latestRevisionsAsOf } from "../src/core/revisions.mjs";
import { addCoverageInterval } from "../src/pipeline/coverage.mjs";
import {
  getProviderFreshness,
  getReadiness,
} from "../src/runtime/readiness.mjs";
import { featureVectorAt } from "../src/model/features.mjs";
import { evaluationEvidenceMode } from "../src/model/evaluation.mjs";
import { sha256, stableStringify } from "../src/core/hash.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { DEMO_CONFIG_OVERRIDES } from "../src/demo/config.mjs";
import { modelContractHash } from "../src/model/contract.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../src/core/outcome-contract.mjs";

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-forecaster-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new JsonlStore(directory).init();
}

test("demo seed and demo server share one explicit model contract", async () => {
  const live = await loadConfig();
  const seed = await loadConfig({ overrides: DEMO_CONFIG_OVERRIDES });
  const server = await loadConfig({
    overrides: {
      ...DEMO_CONFIG_OVERRIDES,
      runtime: {
        data_dir: "/tmp/another-demo-data-root",
        host: "0.0.0.0",
        port: 18799,
        scheduler_enabled: true,
      },
    },
  });

  assert.deepEqual(seed.model.outcome_coverage_providers, ["demo"]);
  assert.equal(seed.config_hash, server.config_hash);
  assert.equal(modelContractHash(seed), modelContractHash(server));
  assert.notEqual(modelContractHash(seed), modelContractHash(live));
  assert.deepEqual(live.model.outcome_coverage_providers, ["x"]);
});

function observation(text = "Example") {
  return rawObservationFromItem({
    provider_item_id: "1",
    canonical_url: "https://x.com/example/status/1",
    published_at: "2026-01-01T00:00:00Z",
    author: {
      provider_author_id: "author-1",
      identity_id: "person-1",
      display_handle: "@example",
    },
    native_relations: [],
    content: { text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: {},
    firstSeenAt: "2026-01-01T00:01:00Z",
    fetchedAt: "2026-01-01T00:01:00Z",
  });
}

test("evaluation evidence mode is provider-neutral and follows time provenance", () => {
  const live = observation();
  const archived = structuredClone(live);
  archived.data.ingest_provider = "independent_archive_adapter";
  archived.data.first_seen_at = "2026-01-03T00:00:00.000Z";
  archived.data.availability_attestation = {
    available_at: "2026-01-01T00:00:00.000Z",
    basis: "direct_source_publication",
    attestor_url: archived.data.canonical_url,
    verified_at: "2026-01-03T00:00:00.000Z",
    verification: "source-id-and-time",
  };
  assert.equal(evaluationEvidenceMode([live], ["x"]), "historical_walk_forward");
  assert.equal(
    evaluationEvidenceMode([archived], ["independent_archive_adapter"]),
    "archive_replay",
  );
  assert.equal(evaluationEvidenceMode([], ["fixture"]), "synthetic_replay");
});

test("JSONL store is idempotent and enforces append-only revisions", async (t) => {
  const store = await temporaryStore(t);
  const original = observation();
  assert.equal((await store.append(original)).inserted, true);
  assert.equal((await store.append(original)).inserted, false);

  const conflicting = structuredClone(original);
  conflicting.data.content.text = "Mutated immutable record";
  await assert.rejects(() => store.append(conflicting), /Conflicting immutable revision/);

  const correction = createRecord({
    recordType: "raw_observation",
    naturalKey: "x:1",
    createdAt: "2026-01-01T01:00:00Z",
    revision: 2,
    supersedes: recordRef(original),
    producer: producer("test", "1"),
    data: { ...original.data, fetched_at: "2026-01-01T01:00:00Z" },
  });
  assert.equal(correction.record_id, original.record_id);
  assert.equal((await store.append(correction)).inserted, true);
  assert.equal((await store.all("raw_observation")).at(0).revision, 2);
});

test("model aliases retain an immutable artifact that historical predictions can replay", async (t) => {
  const store = await temporaryStore(t);
  const model = {
    artifact_version: "reset-model-artifact/test",
    model_version: "reset-model/test",
    family: "ridge_logistic_discrete_time_hazard",
    training_cutoff: "2026-07-01T00:00:00.000Z",
  };
  model.artifact_hash = sha256(stableStringify(model));
  await store.writeModel("challenger", model);
  await store.writeModel("champion", {
    ...model,
    promoted_at: "2026-07-02T00:00:00.000Z",
    promotion_evaluation: { brier_score: 0.1 },
  });
  assert.deepEqual(await store.readModelArtifact(model.artifact_hash), model);
  await assert.rejects(
    store.writeModel("challenger", { ...model, family: "different" }),
    /hash does not match/,
  );

  await fs.writeFile(
    path.join(store.root, "models", "champion.json"),
    `${JSON.stringify({ ...model, family: "tampered" })}\n`,
    "utf8",
  );
  await assert.rejects(
    store.readModel("champion"),
    /Stored model artifact hash does not match/,
  );
  assert.equal(
    await store.readModel("champion", { invalidAsNull: true }),
    null,
  );
});

test("hazard derivation preserves first-event probability identities", () => {
  const entries = Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    end: new Date(Date.UTC(2026, 0, 1, index + 1)).toISOString(),
    hazard: 0.1,
    interval80: [0.05, 0.15],
  }));
  const result = deriveProbabilitySlots(entries);
  assert.ok(Math.abs(result.slots[0].first_reset_probability - 0.1) < 1e-12);
  assert.ok(Math.abs(result.slots[1].first_reset_probability - 0.09) < 1e-12);
  assert.ok(Math.abs(result.slots[0].rolling_4h_probability - 0.3439) < 1e-12);
  assert.ok(Math.abs(result.noResetProbability - 0.6561) < 1e-12);
  const mass = result.slots.reduce((sum, slot) => sum + slot.first_reset_probability, 0);
  assert.ok(Math.abs(mass + result.noResetProbability - 1) < 1e-12);
});

test("canonical predictions bind their full horizon, feature snapshots, and training clock", () => {
  const prediction = createRecord({
    recordType: "prediction",
    naturalKey: "prediction-contract-test",
    createdAt: "2026-07-25T10:00:00Z",
    producer: producer("test", "1"),
    data: {
      issued_at: "2026-07-25T10:00:00.000Z",
      knowledge_cutoff: "2026-07-25T10:00:00.000Z",
      event_process: "first_reset",
      scope: {
        vendor: "openai",
        product: "codex",
        population: "platform",
        plans: ["paid"],
        regions: ["global"],
        quota_bucket: null,
      },
      horizon: {
        start: "2026-07-25T10:00:00.000Z",
        end: "2026-07-25T11:00:00.000Z",
        boundary: "[start,end)",
      },
      base_slot: "PT1H",
      display_horizon: "PT4H",
      slots: [{
        start: "2026-07-25T10:00:00.000Z",
        end: "2026-07-25T11:00:00.000Z",
        hazard: 0.1,
        first_reset_probability: 0.1,
        reset_by_end_probability: 0.1,
        rolling_4h_probability: null,
        epistemic_interval_80: [0.05, 0.2],
      }],
      no_reset_probability: 0.9,
      data_quality: {
        score: 0.8,
        provider_coverage: 0.7,
        outcome_sample_count: 20,
        sample_sufficiency: 1,
        independent_evidence_groups: 1,
      },
      feature_snapshot_refs: [{ record_id: "feat_test", revision: 1 }],
      model: {
        family: "ridge_logistic_discrete_time_hazard",
        version: "reset-model/test",
        artifact_hash: "a".repeat(64),
        model_contract_hash: `sha256:${"b".repeat(64)}`,
        training_cutoff: "2026-07-25T09:00:00.000Z",
        calibrator_version: null,
        training_data_hash: `sha256:${"c".repeat(64)}`,
      },
    },
  });
  assert.doesNotThrow(() => assertCanonicalRecord(prediction));
  assert.throws(
    () => assertCanonicalRecord({
      ...prediction,
      data: {
        ...prediction.data,
        horizon: { ...prediction.data.horizon, end: "2026-07-25T12:00:00.000Z" },
      },
    }),
    /exactly cover/,
  );
  assert.throws(
    () => assertCanonicalRecord({
      ...prediction,
      data: { ...prediction.data, feature_snapshot_refs: [] },
    }),
    /one feature snapshot/,
  );
  assert.throws(
    () => assertCanonicalRecord({
      ...prediction,
      data: {
        ...prediction.data,
        model: {
          ...prediction.data.model,
          training_cutoff: "2026-07-25T10:30:00.000Z",
        },
      },
    }),
    /trained after/,
  );
});

test("ridge hazard learns an interval-censored positive region", () => {
  const examples = [];
  for (let index = 0; index < 80; index += 1) examples.push({ type: "negative", row: [0, index % 2] });
  for (let index = 0; index < 12; index += 1) {
    examples.push({ type: "event_interval", rows: [[1, 0], [0.9, 1]] });
  }
  const model = trainLogisticHazard(examples, ["signal", "noise"], {
    lambda: 0.5,
    learningRate: 0.1,
    maxIterations: 900,
  });
  const low = predictHazard(model, [0, 0]).probability;
  const high = predictHazard(model, [1, 0]).probability;
  assert.ok(high > low * 3, `${high} should materially exceed ${low}`);
  assert.ok(model.covariance.length === 3);
});

test("ridge hazard retains an explicit coefficient prior when evidence is sparse", () => {
  const examples = Array.from({ length: 48 }, (_, index) => ({
    type: "negative",
    row: [index === 47 ? 1 : 0],
  }));
  examples.push({ type: "event_interval", rows: [[0]] });
  const neutral = trainLogisticHazard(examples, ["intent"], {
    lambda: 4,
    maxIterations: 300,
  });
  const informed = trainLogisticHazard(examples, ["intent"], {
    lambda: 4,
    maxIterations: 300,
    coefficientPriors: { intent: 0.5 },
  });
  assert.equal(informed.coefficient_priors[1], 0.5);
  assert.ok(informed.weights[1] > neutral.weights[1]);
});

test("renewal-periodic baseline uses only outcomes known by the cutoff", () => {
  const featureConfig = {
    target: {
      vendor: "openai",
      product: "codex",
      population: "platform",
      plans: ["paid"],
      regions: ["global"],
      quota_bucket: null,
    },
    extractor: {
      model: "deterministic-rules",
      model_version: "test",
      prompt_version: "rules/test",
    },
    providers: {
      x: {
        confirmation_identities: [{
          identity_id: "person-1",
          source_role: "product_lead",
        }],
      },
    },
  };
  const expectedExtractor = extractorContract(featureConfig);
  const evidence = (id, occurredAt, knownAt) => {
    const end = new Date(Date.parse(occurredAt) + 3_600_000).toISOString();
    const source = rawObservationFromItem({
      provider_item_id: id,
      canonical_url: `https://x.com/example/status/${id}`,
      published_at: occurredAt,
      author: {
        provider_author_id: "author-1",
        identity_id: "person-1",
        display_handle: "@example",
      },
      native_relations: [],
      content: { text: `${id} completed`, language: "en" },
    }, {
      providerName: "x",
      providerVersion: "test",
      config: {},
      firstSeenAt: knownAt,
      fetchedAt: knownAt,
    });
    const signal = createRecord({
      recordType: "normalized_signal",
      naturalKey: `${id}:signal`,
      createdAt: knownAt,
      producer: producer(
        "rule-claim-extractor",
        expectedExtractor.model_version,
      ),
      data: {
        available_at: knownAt,
        observation_refs: [recordRef(source)],
        claim: {
          event_type: "quota_reset",
          phase: "completed",
          stance: "supports",
          asserted_time_range: { start: occurredAt, end },
          scope: featureConfig.target,
        },
        provenance: {
          source_identity_id: "person-1",
          source_role: "product_lead",
          independence_group_id: `ind_${id}`,
          derivation: "primary_statement",
        },
        extraction: expectedExtractor,
      },
    });
    const confirmed = createRecord({
      recordType: "reset_outcome",
      naturalKey: id,
      createdAt: knownAt,
      producer: producer(
        "outcome-adjudicator",
        OUTCOME_ADJUDICATOR_VERSION,
      ),
      data: {
        status: "confirmed",
        label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
        event_identity: `event_${id}`,
        event_type: "quota_reset",
        scope: featureConfig.target,
        occurred_time_range: { start: occurredAt, end },
        known_at: knownAt,
        verification: [{
          kind: "official_confirmation",
          observation_ref: recordRef(source),
          independence_group_id: `ind_${id}`,
        }],
        candidate_refs: [{ record_id: `candidate_${id}`, revision: 1 }],
      },
    });
    return { source, signal, confirmed };
  };
  const knownEvidence = [
    evidence("one", "2026-01-01T18:00:00Z", "2026-01-01T19:00:00Z"),
    evidence("two", "2026-01-08T19:00:00Z", "2026-01-08T20:00:00Z"),
  ];
  const futureEvidence = evidence(
    "future",
    "2026-01-15T20:00:00Z",
    "2026-01-15T21:00:00Z",
  );
  const arguments_ = {
    targetTime: "2026-01-10T19:00:00Z",
    knowledgeCutoff: "2026-01-10T19:00:00Z",
    signals: [...knownEvidence, futureEvidence].map((entry) => entry.signal),
    observations: [...knownEvidence, futureEvidence].map((entry) => entry.source),
    confirmationIdentityIds: new Set(["person-1"]),
    expectedExtractor,
    targetScope: featureConfig.target,
  };
  const known = knownEvidence.map((entry) => entry.confirmed);
  const withoutFuture = featureVectorAt({ ...arguments_, outcomes: known });
  const withFuture = featureVectorAt({
    ...arguments_,
    outcomes: [...known, futureEvidence.confirmed],
  });
  assert.ok(withoutFuture.features.renewal_periodic_kernel > 0);
  assert.equal(
    withFuture.features.renewal_periodic_kernel,
    withoutFuture.features.renewal_periodic_kernel,
  );
});

test("hourly scheduler records success and does not overlap manual runs", async (t) => {
  const store = await temporaryStore(t);
  let calls = 0;
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-22T18:30:00Z"),
    logger: { info() {}, error() {} },
    run: async (_store, _config, options) => {
      calls += 1;
      assert.equal(options.collect, true);
      assert.equal(options.retrain, true);
      assert.equal(options.now, undefined);
      assert.equal(typeof options.clock, "function");
      return {
        training: {},
        forecast: { prediction: { record_id: "pred_test" } },
        timing: { knowledge_cutoff: "2026-07-22T18:30:00.000Z" },
      };
    },
  });
  t.after(() => scheduler.stop());
  await scheduler.runNow();
  assert.equal(calls, 1);
  const state = await store.readState("runtime");
  assert.equal(state.last_prediction_id, "pred_test");
  assert.equal(state.last_error, null);
  assert.equal(state.current_run_started_at, null);
  assert.equal(state.last_timing.knowledge_cutoff, "2026-07-22T18:30:00.000Z");
});

test("as-of selection cannot leak a later correction into an old cutoff", () => {
  const records = [
    { record_id: "sig_1", revision: 1, created_at: "2026-01-01T01:00:00Z", data: { available_at: "2026-01-01T01:00:00Z" } },
    { record_id: "sig_1", revision: 2, created_at: "2026-01-03T01:00:00Z", data: { available_at: "2026-01-03T01:00:00Z" } },
  ];
  const old = latestRevisionsAsOf(records, "2026-01-02T00:00:00Z", (record) => record.data.available_at);
  const current = latestRevisionsAsOf(records, "2026-01-04T00:00:00Z", (record) => record.data.available_at);
  assert.equal(old[0].revision, 1);
  assert.equal(current[0].revision, 2);
});

test("outcome-only archive coverage never proves real negative-label readiness", async (t) => {
  const store = await temporaryStore(t);
  const config = await loadConfig({ overrides: {
    providers: { historical_archive: { enabled: true } },
    model: { outcome_coverage_providers: ["historical_archive"] },
  } });
  const start = new Date("2026-06-01T00:00:00Z");
  const end = new Date("2026-07-01T00:00:00Z");
  await store.append(rawObservationFromItem({
    provider_item_id: "archive-1",
    canonical_url: null,
    published_at: start,
    author: {},
    native_relations: [],
    content: { media_type: "text/plain", text: "Archive coverage marker", language: "en" },
  }, {
    providerName: "historical_archive",
    providerVersion: "test",
    config: {},
    firstSeenAt: start,
    fetchedAt: start,
  }));
  await addCoverageInterval(store, "historical_archive", start, end);
  await store.writeState("walk-forward-summary", {
    outcome_coverage_providers: ["historical_archive"],
    metrics: { event_window_recall: 0.8 },
    gate: { passed: true },
  });
  const readiness = await getReadiness(store, config);
  assert.equal(readiness.provider_enabled, true);
  assert.equal(readiness.providers_enabled.historical_archive, true);
  assert.equal(readiness.synthetic_only, false);
  assert.equal(readiness.outcome_coverage.negative_label_eligible.hours, 0);
  assert.equal(readiness.outcome_coverage.outcome_only.hours, 30 * 24);
  assert.equal(readiness.model.real_walk_forward_acceptance_proven, false);
  assert.ok(readiness.publication_blockers.includes("negative_label_coverage_missing"));
});

test("freshness matches required providers by canonical adapter ID, not config key", async (t) => {
  const store = await temporaryStore(t);
  const now = new Date("2026-07-25T10:00:00Z");
  const config = await loadConfig({ overrides: {
    providers: {
      x: { enabled: false },
      x_search_gateway: { enabled: true, upstream_provider: "socialdata" },
    },
    model: { outcome_coverage_providers: ["x_search_gateway_socialdata"] },
  } });
  await store.writeState("x-search-gateway-provider", {
    upstream_provider: "socialdata",
    last_success_at: now.toISOString(),
    last_error: null,
  });
  const freshness = await getProviderFreshness(store, config, now);
  assert.equal(
    freshness.providers.x_search_gateway.provider_id,
    "x_search_gateway_socialdata",
  );
  assert.equal(freshness.groups.required_outcome.status, "fresh");
  assert.deepEqual(freshness.groups.required_outcome.providers, ["x_search_gateway"]);
});
