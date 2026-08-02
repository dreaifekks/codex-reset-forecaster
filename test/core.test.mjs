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
import {
  COEFFICIENT_PRIOR_POLICY_VERSION,
  FEATURE_TRANSFORM_VERSION,
  assertModelCompatibility,
  predictHazard,
  trainLogisticHazard,
} from "../src/model/logistic-hazard.mjs";
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
  AS_OF_MODE,
  latestOutcomesAsOf,
} from "../src/model/as-of.mjs";
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
  assert.equal(live.config_version, "provider-config/0.3.3");
  assert.equal(live.taxonomy_version, "reset-taxonomy/0.3.1");
  assert.equal(live.feature_schema_version, "reset-features/0.3.1");
  assert.equal(live.deduplication_version, "reset-dedup/0.2.3");
  assert.equal(live.extractor.model_version, "0.3.2");
  assert.equal(
    live.extractor.prompt_version,
    "reset-extract/rules-0.3.2",
  );
  assert.equal(
    live.model.coefficient_priors.renewal_periodic_kernel ?? 0,
    0,
  );
});

function observation(text = "Example", providerItemId = "1") {
  return rawObservationFromItem({
    provider_item_id: providerItemId,
    canonical_url: `https://x.com/example/status/${providerItemId}`,
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

test("JSONL store streams records whose lines cross file-read chunks", async (t) => {
  const store = await temporaryStore(t);
  const original = observation("x".repeat(256 * 1024));
  const correction = createRecord({
    recordType: "raw_observation",
    naturalKey: "x:1",
    createdAt: "2026-01-01T01:00:00Z",
    revision: 2,
    supersedes: recordRef(original),
    producer: producer("test", "1"),
    data: {
      ...original.data,
      fetched_at: "2026-01-01T01:00:00Z",
      content: {
        ...original.data.content,
        text: "corrected",
      },
    },
  });
  await fs.writeFile(
    store.recordPath("raw_observation"),
    `${JSON.stringify(original)}\n${JSON.stringify(correction)}\n`,
    "utf8",
  );

  assert.deepEqual(
    (await store.all("raw_observation", { latestOnly: false })).map(
      (record) => record.revision,
    ),
    [1, 2],
  );
  assert.equal((await store.all("raw_observation")).at(0).revision, 2);
});

test("JSONL store resolves exact refs without filling the full-record cache", async (t) => {
  const store = await temporaryStore(t);
  const first = observation("first", "11");
  const second = observation("second", "12");
  const third = observation("third", "13");
  await fs.writeFile(
    store.recordPath("raw_observation"),
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    "utf8",
  );

  const selected = await store.allByRefs("raw_observation", [
    recordRef(second),
    { record_id: "obs_missing", revision: 1 },
    recordRef(first),
  ]);
  assert.deepEqual(selected.map((record) => record.record_id), [
    second.record_id,
    first.record_id,
  ]);
  assert.deepEqual(
    await store.allByRefs("raw_observation", [recordRef(third)]),
    [],
  );

  await fs.appendFile(
    store.recordPath("raw_observation"),
    `${JSON.stringify(third)}\n`,
    "utf8",
  );
  assert.deepEqual(
    (await store.allByRefs("raw_observation", [recordRef(third)]))
      .map((record) => record.record_id),
    [third.record_id],
  );
  assert.equal(
    (await store.all("raw_observation", { latestOnly: false })).length,
    3,
  );
});

test("JSONL store reuses deterministic first revisions with a bounded scan", async (t) => {
  const store = await temporaryStore(t);
  const first = observation("first", "21");
  const second = observation("second", "22");
  const inserted = await store.appendOrReuseMany([first, second]);
  assert.deepEqual(inserted.map((result) => result.inserted), [true, true]);

  const regeneratedFirst = observation("regenerated content", "21");
  const reused = await store.appendOrReuseMany([regeneratedFirst]);
  assert.equal(reused[0].inserted, false);
  assert.deepEqual(reused[0].record, first);

  const correction = createRecord({
    recordType: "raw_observation",
    naturalKey: "x:21",
    createdAt: "2026-01-01T01:00:00Z",
    revision: 2,
    supersedes: recordRef(first),
    producer: producer("test", "1"),
    data: {
      ...first.data,
      fetched_at: "2026-01-01T01:00:00.000Z",
    },
  });
  await fs.appendFile(
    store.recordPath("raw_observation"),
    `${JSON.stringify(correction)}\n`,
    "utf8",
  );
  const correctedReuse = await store.appendOrReuseMany([regeneratedFirst]);
  assert.deepEqual(correctedReuse[0].record, correction);
  assert.equal(
    (await store.all("raw_observation", { latestOnly: false })).length,
    3,
  );
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
      post_outcome_refractory: {
        policy_version:
          "post-outcome-refractory-piecewise-hazard-multiplier/1",
        applied: false,
        status: "disabled",
        outcome_selection_basis:
          "latest_eligible_confirmed_outcome_available_at_cutoff",
        time_basis: "occurred_time_range_end",
        prior_basis:
          "versioned_non_learned_minimum_inter_event_prior",
        outcome_ref: null,
        outcome_known_at: null,
        outcome_available_at: null,
        outcome_occurred_time_range: null,
        as_of_mode: "live",
        recovery_end_at: null,
        first_slot_multiplier: null,
        base_horizon_probability: 0.1,
        conditioned_horizon_probability: 0.1,
      },
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
  const legacyPrediction = structuredClone(prediction);
  legacyPrediction.producer = {
    name: "reset-forecaster",
    version: "0.3.1",
    config_hash: null,
  };
  delete legacyPrediction.data.post_outcome_refractory;
  assert.doesNotThrow(
    () => assertCanonicalRecord(legacyPrediction),
    "reset-intel/0.2 predictions issued before refractory metadata remain valid",
  );
  const currentPredictionWithoutRefractory =
    structuredClone(legacyPrediction);
  currentPredictionWithoutRefractory.producer.version = "0.3.2";
  assert.throws(
    () => assertCanonicalRecord(currentPredictionWithoutRefractory),
    /requires post-outcome refractory metadata/,
  );
  const futurePredictionWithoutRefractory =
    structuredClone(currentPredictionWithoutRefractory);
  futurePredictionWithoutRefractory.producer.version = "0.3.3";
  assert.throws(
    () => assertCanonicalRecord(futurePredictionWithoutRefractory),
    /requires post-outcome refractory metadata/,
  );
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
  assert.equal(
    informed.coefficient_prior_policy,
    COEFFICIENT_PRIOR_POLICY_VERSION,
  );
  assert.equal(informed.raw_coefficient_priors[1], 0.5);
  assert.equal(
    informed.coefficient_priors[1],
    informed.raw_coefficient_priors[1] * informed.scales[0],
  );
  const inconsistent = structuredClone(informed);
  delete inconsistent.artifact_hash;
  inconsistent.coefficient_priors[1] += 0.25;
  assert.throws(
    () => assertModelCompatibility(inconsistent, {
      featureNames: ["intent"],
    }),
    /effective coefficient priors/,
  );
  assert.ok(informed.weights[1] > neutral.weights[1]);
});

test("live inference clips extreme standardized feature drift", () => {
  const model = {
    feature_names: ["rare_intent"],
    means: [0],
    scales: [0.000001],
    weights: [-6, 0.2],
    covariance: null,
    uncertainty: {
      status: "unavailable",
      reason: "test",
    },
    feature_transform: {
      version: FEATURE_TRANSFORM_VERSION,
      standardized_feature_clip: 8,
    },
  };
  const result = predictHazard(model, [1]);
  assert.ok(result.probability > 0.01);
  assert.ok(result.probability < 0.02);
  assert.equal(result.interval80, null);
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

test("scheduler can refresh collection and forecasts on ten-minute boundaries", async (t) => {
  const store = await temporaryStore(t);
  const scheduler = startScheduler({
    store,
    config: {
      runtime: {
        run_on_start: false,
        retrain_interval_hours: 24,
        scheduler_delay_seconds: 5,
        scheduler_interval_minutes: 10,
      },
    },
    now: () => new Date("2026-07-22T18:31:00.000Z"),
    logger: { info() {}, error() {} },
    run: async () => ({
      status: "completed",
      training: {},
      forecast: { prediction: { record_id: "pred_ten_minute" } },
      collection: {},
      timing: { knowledge_cutoff: "2026-07-22T18:31:00.000Z" },
    }),
  });
  t.after(() => scheduler.stop());
  assert.equal(scheduler.nextRunAt, "2026-07-22T18:40:05.000Z");
});

test("hourly scheduler records coverage observation as waiting, not failure", async (t) => {
  const store = await temporaryStore(t);
  const coverageWaiting = {
    schema_version: "coverage-waiting/1",
    status: "waiting_for_coverage",
    reason_code: "coverage_stability_observation_pending",
    providers: ["authority_ledger"],
    candidate_count: 12,
    earliest_first_observed_at: "2026-07-22T12:00:00.000Z",
    earliest_recheck_at: "2026-07-22T18:00:00.000Z",
    recheck_due: true,
    observed_at: "2026-07-22T18:30:00.000Z",
  };
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-22T18:30:00Z"),
    logger: { info() {}, error() {} },
    run: async () => ({
      status: "waiting_for_coverage",
      coverage_waiting: coverageWaiting,
      training: {
        succeeded: false,
        skipped: true,
        reason_code: coverageWaiting.reason_code,
      },
      forecast: null,
      collection: {},
      timing: { knowledge_cutoff: "2026-07-22T18:30:00.000Z" },
    }),
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "waiting_for_coverage");
  assert.deepEqual(state.last_waiting, coverageWaiting);
  assert.equal(state.last_error, null);
  assert.equal(state.last_failure_at, undefined);
  assert.equal(state.last_prediction_id, null);
  assert.equal(state.last_success_at, "2026-07-22T18:30:00.000Z");
});

test("coverage stability recheck wakes at its deadline before the next hour", async (t) => {
  const store = await temporaryStore(t);
  const current = new Date("2026-07-26T03:00:05.000Z");
  const scheduler = startScheduler({
    store,
    config: {
      runtime: {
        run_on_start: false,
        retrain_interval_hours: 24,
        scheduler_delay_seconds: 5,
      },
    },
    now: () => new Date(current),
    logger: { info() {}, error() {} },
    run: async () => ({
      status: "waiting_for_coverage",
      coverage_waiting: {
        schema_version: "coverage-waiting/1",
        status: "waiting_for_coverage",
        reason_code: "coverage_stability_observation_pending",
        providers: ["historical_monitor"],
        candidate_count: 180,
        earliest_first_observed_at: "2026-07-25T21:07:11.000Z",
        earliest_recheck_at: "2026-07-26T03:07:11.000Z",
        recheck_due: false,
        observed_at: "2026-07-26T03:00:05.000Z",
      },
      training: { succeeded: false, skipped: true },
      forecast: null,
      collection: {},
      timing: { knowledge_cutoff: "2026-07-26T03:00:05.000Z" },
    }),
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  assert.equal(scheduler.nextRunAt, "2026-07-26T03:07:16.000Z");
});

test("evaluation waiting still wakes a new coverage candidate at its exact deadline", async (t) => {
  const store = await temporaryStore(t);
  const current = new Date("2026-07-26T12:00:05.000Z");
  const evaluationWaiting = {
    schema_version: "evaluation-waiting/1",
    status: "waiting_for_evaluation",
    reason_code: "walk_forward_fold_pending",
    evaluation_cutoff: "2026-07-26T12:00:00.000Z",
    accepted_fold_count: 0,
    rejected_fold_count: 0,
    evaluated_windows: 0,
    evaluated_events: 0,
    minimum_evaluation_windows: 1008,
    minimum_evaluation_events: 20,
  };
  const scheduler = startScheduler({
    store,
    config: {
      runtime: {
        run_on_start: false,
        retrain_interval_hours: 24,
        scheduler_delay_seconds: 5,
      },
    },
    now: () => new Date(current),
    logger: { info() {}, error() {} },
    run: async () => ({
      status: "waiting_for_evaluation",
      evaluation_waiting: evaluationWaiting,
      training: { succeeded: false, skipped: true, evaluation: null },
      forecast: null,
      collection: {
        historical_monitor: {
          ok: true,
          required: true,
          coverage_waiting: {
            schema_version: "coverage-waiting/1",
            status: "observing",
            reason_code: "coverage_stability_observation_pending",
            provider_id: "historical_monitor",
            candidate_count: 1,
            earliest_first_observed_at: "2026-07-26T06:00:08.014Z",
            earliest_recheck_at: "2026-07-26T12:00:08.014Z",
            observed_at: "2026-07-26T12:00:05.000Z",
          },
        },
      },
      timing: { knowledge_cutoff: "2026-07-26T12:00:05.000Z" },
    }),
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  assert.equal(scheduler.nextRunAt, "2026-07-26T12:00:13.014Z");
});

test("hourly scheduler records evaluation waiting and does not refit every hour", async (t) => {
  const store = await temporaryStore(t);
  const evaluationWaiting = {
    schema_version: "evaluation-waiting/1",
    status: "waiting_for_evaluation",
    reason_code: "walk_forward_fold_pending",
    evaluation_cutoff: "2026-07-25T20:00:00.000Z",
    accepted_fold_count: 0,
    rejected_fold_count: 0,
    evaluated_windows: 0,
    evaluated_events: 0,
    minimum_evaluation_windows: 1008,
    minimum_evaluation_events: 20,
  };
  const promotionGuard = {
    schema_version: "live-forecast-promotion-guard/1",
    mode: "bootstrap_enforced",
    passed: true,
    blockers: [],
  };
  const retrainValues = [];
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-25T20:30:00.000Z"),
    logger: { info() {}, error() {} },
    run: async (_store, _config, options) => {
      retrainValues.push(options.retrain);
      return {
        status: "waiting_for_evaluation",
        evaluation_waiting: evaluationWaiting,
        training: {
          succeeded: options.retrain,
          skipped: !options.retrain,
          evaluation: null,
          promotion_guard: options.retrain ? promotionGuard : null,
        },
        forecast: null,
        collection: {},
        timing: { knowledge_cutoff: "2026-07-25T20:30:00.000Z" },
      };
    },
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  await scheduler.runNow();

  assert.deepEqual(retrainValues, [true, false]);
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "waiting_for_evaluation");
  assert.deepEqual(state.last_evaluation_waiting, evaluationWaiting);
  assert.deepEqual(state.last_promotion_guard, promotionGuard);
  assert.equal(state.last_training_at, "2026-07-25T20:30:00.000Z");
  assert.equal(
    state.last_retrain_requested_at,
    "2026-07-25T20:30:00.000Z",
  );
  assert.equal(state.last_prediction_id, null);
  assert.equal(state.last_error, null);
  assert.equal(state.last_failure_at, undefined);
});

test("scheduler preserves a reused-challenger guard rejection as a structured terminal state", async (t) => {
  const store = await temporaryStore(t);
  const promotionGuard = {
    schema_version: "live-forecast-promotion-guard/1",
    mode: "bootstrap_enforced",
    passed: false,
    blockers: [
      "bootstrap_probability_saturation_with_positive_clip_bound_contribution",
    ],
  };
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-25T20:30:00.000Z"),
    logger: { info() {}, error() {} },
    run: async () => ({
      status: "promotion_blocked",
      promotion_guard: promotionGuard,
      training: {
        succeeded: false,
        skipped: true,
        reused_challenger: true,
        promotion_guard: promotionGuard,
        promotion: {
          promoted: false,
          reason: "live_forecast_promotion_guard_rejected",
        },
      },
      forecast: null,
      collection: {},
      timing: { knowledge_cutoff: "2026-07-25T20:30:00.000Z" },
    }),
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "promotion_blocked");
  assert.deepEqual(state.last_promotion_guard, promotionGuard);
  assert.equal(
    state.last_promotion_status,
    "live_forecast_promotion_guard_rejected",
  );
  assert.equal(state.last_prediction_id, null);
  assert.equal(state.last_error, null);
  assert.equal(state.last_failure_at, undefined);
});

test("evaluation waiting can keep a compatible champion forecast in service", async (t) => {
  const store = await temporaryStore(t);
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-25T20:30:00.000Z"),
    logger: { info() {}, error() {} },
    run: async () => ({
      status: "waiting_for_evaluation",
      evaluation_waiting: {
        schema_version: "evaluation-waiting/1",
        status: "waiting_for_evaluation",
        reason_code: "evaluation_sample_threshold_not_met",
        evaluation_cutoff: "2026-07-25T20:00:00.000Z",
        accepted_fold_count: 1,
        rejected_fold_count: 0,
        evaluated_windows: 165,
        evaluated_events: 2,
        minimum_evaluation_windows: 1008,
        minimum_evaluation_events: 20,
      },
      training: { succeeded: true },
      forecast: { prediction: { record_id: "pred_champion" } },
      collection: {},
      timing: { knowledge_cutoff: "2026-07-25T20:30:00.000Z" },
    }),
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "waiting_for_evaluation");
  assert.equal(state.last_prediction_id, "pred_champion");
  assert.equal(state.last_error, null);
});

test("stable champion fallback keeps serving but exposes the training failure", async (t) => {
  const store = await temporaryStore(t);
  const retrainValues = [];
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-25T20:30:00.000Z"),
    logger: { info() {}, error() {} },
    run: async (_store, _config, options) => {
      retrainValues.push(options.retrain);
      return {
        status: "completed_with_training_error",
        training: {
          status: "failed",
          succeeded: false,
          error: "model artifact write failed",
        },
        forecast: { prediction: { record_id: "pred_stable_champion" } },
        collection: {},
        timing: { knowledge_cutoff: "2026-07-25T20:30:00.000Z" },
      };
    },
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  await scheduler.runNow();
  assert.deepEqual(retrainValues, [true, false]);
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "degraded");
  assert.equal(state.last_prediction_id, "pred_stable_champion");
  assert.equal(state.last_error, "model artifact write failed");
  assert.equal(state.last_success_at, "2026-07-25T20:30:00.000Z");
  assert.equal(state.last_failure_at, "2026-07-25T20:30:00.000Z");
  assert.equal(state.last_training_at, null);
  assert.equal(
    state.last_retrain_requested_at,
    "2026-07-25T20:30:00.000Z",
  );
});

test("hourly scheduler still records genuine pipeline exceptions as failures", async (t) => {
  const store = await temporaryStore(t);
  const scheduler = startScheduler({
    store,
    config: {
      runtime: { run_on_start: false, retrain_interval_hours: 24 },
    },
    now: () => new Date("2026-07-25T20:30:00.000Z"),
    logger: { info() {}, error() {} },
    run: async () => {
      throw new Error("model artifact write failed");
    },
  });
  t.after(() => scheduler.stop());

  await scheduler.runNow();
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "error");
  assert.equal(state.last_error, "model artifact write failed");
  assert.equal(state.last_failure_at, "2026-07-25T20:30:00.000Z");
  assert.equal(state.last_success_at, undefined);
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

test("as-of selection preserves millisecond precision for Date cutoffs", () => {
  const records = [{
    record_id: "millisecond-boundary",
    revision: 1,
    created_at: "2026-07-28T05:56:29.293Z",
    data: { available_at: "2026-07-28T05:56:29.293Z" },
  }];
  assert.equal(
    latestRevisionsAsOf(
      records,
      new Date("2026-07-28T05:56:29.292Z"),
      (record) => record.data.available_at,
    ).length,
    0,
  );
  assert.equal(
    latestRevisionsAsOf(
      records,
      new Date("2026-07-28T05:56:29.293Z"),
      (record) => record.data.available_at,
    ).length,
    1,
  );
  const outcome = {
    record_id: "outcome-millisecond-boundary",
    revision: 1,
    supersedes: null,
    created_at: "2026-07-28T05:56:29.293Z",
    data: {
      known_at: "2026-07-28T05:56:29.293Z",
      replay_available_at: null,
    },
  };
  assert.equal(
    latestOutcomesAsOf(
      [outcome],
      new Date("2026-07-28T05:56:29.293Z"),
      AS_OF_MODE.ARCHIVE_REPLAY,
    ).length,
    1,
  );
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

test("freshness exposes an exact gateway by canonical adapter ID without granting coverage", async (t) => {
  const store = await temporaryStore(t);
  const now = new Date("2026-07-25T10:00:00Z");
  const config = await loadConfig({ overrides: {
    providers: {
      x: { enabled: false },
      x_search_gateway: { enabled: true, upstream_provider: "socialdata" },
    },
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
  assert.deepEqual(
    freshness.providers.x_search_gateway.roles,
    ["exact", "context"],
  );
  assert.ok(
    !freshness.groups.required_outcome.providers.includes("x_search_gateway"),
  );
});

test("X Search Gateway cannot be configured as exhaustive outcome coverage", async () => {
  await assert.rejects(
    loadConfig({ overrides: {
      providers: {
        x_search_gateway: {
          enabled: true,
          upstream_provider: "socialdata",
        },
      },
      model: {
        outcome_coverage_providers: ["x_search_gateway_socialdata"],
      },
    } }),
    /cannot use discovery-only gateway or RSSHub timeline providers/,
  );
});

test("RSSHub exact timelines cannot be configured as outcome coverage", async () => {
  await assert.rejects(
    loadConfig({ overrides: {
      model: {
        outcome_coverage_providers: ["rsshub_x_timeline"],
      },
    } }),
    /finite feeds are not exhaustive coverage/,
  );
});

test("impact episode policy is versioned and bounded", async () => {
  const config = await loadConfig();
  assert.deepEqual(config.impact_tracking, {
    version: "impact-episode-policy/1",
    enabled: true,
    cluster_gap_hours: 72,
    active_evidence_ttl_hours: 24,
    freshness_half_life_hours: 36,
  });
  await assert.rejects(
    loadConfig({ overrides: {
      impact_tracking: {
        active_evidence_ttl_hours: 0,
      },
    } }),
    /supported bounded impact-episode-policy/,
  );
});

test("gateway impact discovery mirrors high-impact and recovery vocabulary", async () => {
  const config = await loadConfig();
  const query = config.providers.x_search_gateway.queries.find((entry) =>
    entry.name === "codex-impact-lifecycle"
  )?.query ?? "";
  for (const term of [
    "vulnerability",
    "compromised",
    "credential",
    "truncated",
    "incompatible",
    "\"version mismatch\"",
    "\"working again\"",
    "recovered",
    "restored",
    "workaround",
  ]) {
    assert.ok(query.includes(term), `gateway impact query should include ${term}`);
  }
  assert.equal(config.providers.x_search_gateway.refresh_interval_minutes, 30);
  await assert.rejects(
    loadConfig({ overrides: {
      providers: {
        x_search_gateway: {
          queries: [],
        },
      },
    } }),
    /non-empty uniquely named queries/,
  );
  await assert.rejects(
    loadConfig({ overrides: {
      providers: {
        x_search_gateway: {
          queries: [
            { name: "duplicate", query: "Codex broken" },
            { name: "duplicate", query: "Codex fixed" },
          ],
        },
      },
    } }),
    /non-empty uniquely named queries/,
  );
});

test("RSSHub provider identity and capabilities cannot be reconfigured", async () => {
  await assert.rejects(
    loadConfig({ overrides: {
      providers: {
        rsshub_x_timeline: {
          provider_name: "x",
        },
      },
    } }),
    /fixed exact-evidence, non-coverage contract/,
  );
  await assert.rejects(
    loadConfig({ overrides: {
      providers: {
        rsshub_x_timeline: {
          capabilities: ["context_discovery"],
        },
      },
    } }),
    /fixed exact-evidence, non-coverage contract/,
  );
  await assert.rejects(
    loadConfig({ overrides: {
      providers: {
        rsshub_x_timeline: {
          include_replies: false,
        },
      },
    } }),
    /fixed exact-evidence, non-coverage contract/,
  );
});

test("RSSHub timeline freshness is exact evidence without coverage authority", async (t) => {
  const store = await temporaryStore(t);
  const now = new Date("2026-07-26T10:00:00Z");
  const config = await loadConfig({ overrides: {
    providers: {
      x: { enabled: false },
      rsshub_x_timeline: { enabled: true },
    },
  } });
  await store.writeState("rsshub-x-timeline-provider", {
    last_success_at: now.toISOString(),
    last_error: null,
  });
  const freshness = await getProviderFreshness(store, config, now);
  assert.deepEqual(
    freshness.providers.rsshub_x_timeline.roles,
    ["exact", "context"],
  );
  assert.equal(freshness.providers.rsshub_x_timeline.status, "fresh");
  assert.ok(freshness.groups.exact.providers.includes("rsshub_x_timeline"));
  assert.ok(
    !freshness.groups.required_outcome.providers.includes(
      "rsshub_x_timeline",
    ),
  );
});

test("Grokbuild gateway readiness is context-only rather than an exact source", async (t) => {
  const store = await temporaryStore(t);
  const now = new Date("2026-07-26T10:00:00Z");
  const config = await loadConfig({ overrides: {
    providers: {
      x: { enabled: false },
      x_search_gateway: { enabled: true, upstream_provider: "grokbuild" },
    },
  } });
  await store.writeState("x-search-gateway-provider", {
    upstream_provider: "grokbuild",
    last_success_at: now.toISOString(),
    last_error: null,
  });

  const freshness = await getProviderFreshness(store, config, now);
  assert.equal(
    freshness.providers.x_search_gateway.provider_id,
    "x_search_gateway_grokbuild",
  );
  assert.deepEqual(
    freshness.providers.x_search_gateway.roles,
    ["context"],
  );
  assert.ok(
    !freshness.groups.exact.providers.includes("x_search_gateway"),
  );
  assert.ok(
    freshness.groups.context.providers.includes("x_search_gateway"),
  );
});
