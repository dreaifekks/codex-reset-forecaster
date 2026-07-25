import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { hashLabel } from "../src/core/hash.mjs";
import {
  assessEvaluationCompatibility,
  getReadiness,
} from "../src/runtime/readiness.mjs";
import { createRequestHandler } from "../src/web/app.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  modelContractHash,
} from "../src/model/contract.mjs";
import { recomputeFrozenEvaluationArtifact } from "../src/model/evaluation.mjs";

const HOUR_MS = 3_600_000;

class MemoryStore {
  constructor({ records = {}, states = {}, models = {}, blobs = {} } = {}) {
    this.records = records;
    this.states = states;
    this.models = models;
    this.blobs = blobs;
  }

  async all(type, { latestOnly = true } = {}) {
    const records = [...(this.records[type] ?? [])];
    if (!latestOnly) return records;
    const latest = new Map();
    for (const record of records) {
      const previous = latest.get(record.record_id);
      if (!previous || record.revision > previous.revision) latest.set(record.record_id, record);
    }
    return [...latest.values()];
  }

  async readState(name, fallback = {}) {
    return structuredClone(this.states[name] ?? fallback);
  }

  async readModel(name) {
    const value = this.models[name] ?? null;
    if (value instanceof Error) throw value;
    return structuredClone(value);
  }

  async readBlob(ref) {
    if (!(ref in this.blobs)) throw new Error(`missing blob: ${ref}`);
    return structuredClone(this.blobs[ref]);
  }
}

function config(overrides = {}) {
  return {
    config_hash: "sha256:test-config",
    feature_schema_version: "features/test",
    deduplication_version: "dedup/test",
    taxonomy_version: "taxonomy/test",
    timezone_database_version: "tzdata-test",
    extractor: {
      model: "deterministic-rules",
      model_version: "test",
      prompt_version: "rules/test",
    },
    providers: {
      x: {
        enabled: true,
        confirmation_identities: [{
          identity_id: "person_tibo_sottiaux",
          source_role: "product_lead",
        }],
        context_identities: [],
        context_queries: [],
      },
    },
    model: {
      outcome_coverage_providers: ["x"],
      minimum_live_evaluation_windows: 168,
      minimum_live_evaluation_events: 3,
      maximum_training_days: 180,
      promotion: {
        top_window_hours_per_week: 36,
        minimum_event_window_recall: 0.8,
        require_brier_skill_above: 0,
        maximum_expected_calibration_error: 0.1,
      },
    },
    runtime: {
      forecast_fresh_age_hours: 1.5,
      forecast_stale_age_hours: 3,
    },
    ...overrides,
  };
}

function prediction({
  issuedAt = "2026-07-25T10:05:00.000Z",
  cutoff = "2026-07-25T10:00:00.000Z",
} = {}) {
  const start = Date.parse(cutoff);
  const slots = Array.from({ length: 168 }, (_, index) => ({
    start: new Date(start + index * HOUR_MS).toISOString(),
    end: new Date(start + (index + 1) * HOUR_MS).toISOString(),
    hazard: 0.01,
    first_reset_probability: 0.01 * (0.99 ** index),
    reset_by_end_probability: 1 - 0.99 ** (index + 1),
    rolling_4h_probability: index <= 164 ? 1 - 0.99 ** 4 : null,
    epistemic_interval_80: [0.005, 0.02],
  }));
  return {
    record_id: "pred_test",
    revision: 1,
    data: {
      issued_at: issuedAt,
      knowledge_cutoff: cutoff,
      horizon: {
        start: slots[0].start,
        end: slots.at(-1).end,
      },
      slots,
      no_reset_probability: 0.99 ** 168,
      data_quality: { score: 0.8, provider_coverage: 0.6 },
      model: {
        version: "model/test",
        training_cutoff: "2026-07-20T00:00:00.000Z",
      },
    },
  };
}

function observation(id, revision, text, publishedAt) {
  return {
    record_id: id,
    revision,
    created_at: publishedAt,
    data: {
      canonical_url: `https://x.com/example/status/${id}-${revision}`,
      published_at: publishedAt,
      ingest_provider: "x",
      author: { display_handle: `@source-r${revision}` },
      content: { text },
    },
  };
}

function signal({
  id,
  observationRef,
  availableAt,
  role,
  derivation,
  identity = null,
  group = id,
}) {
  return {
    record_id: id,
    revision: 1,
    created_at: availableAt,
    data: {
      available_at: availableAt,
      observation_refs: [observationRef],
      claim: {
        event_type: "release",
        phase: "completed",
        scope: { vendor: "openai", product: "codex" },
      },
      extraction: { model_version: "test", prompt_version: "test" },
      provenance: {
        source_role: role,
        source_identity_id: identity,
        derivation,
        independence_group_id: group,
      },
    },
  };
}

function coverageAssertion() {
  const evidence = {
    method: "test_complete_poll",
    exhausted_at: "2026-07-25T09:59:00.000Z",
    interval: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-25T09:59:00.000Z",
    },
  };
  return {
    assertion_id: "cov_test",
    revision: 1,
    provider: "x",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-25T09:59:00.000Z",
    mode: "explicit_complete_poll",
    adequacy: "negative_label_eligible",
    evidence_refs: [{
      kind: "complete_poll",
      ref: "blob://test/coverage.json",
      sha256: hashLabel(evidence),
      method: evidence.method,
      exhausted_at: evidence.exhausted_at,
    }],
    asserted_at: "2026-07-25T09:59:00.000Z",
  };
}

function coverageBlob() {
  return {
    method: "test_complete_poll",
    exhausted_at: "2026-07-25T09:59:00.000Z",
    interval: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-25T09:59:00.000Z",
    },
  };
}

async function serverFor(t, store, appConfig, now) {
  const server = http.createServer(createRequestHandler({
    store,
    config: appConfig,
    now: () => new Date(now),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("recent evidence is aligned to the forecast cutoff and aggregator summaries never become core", async (t) => {
  const before = observation(
    "obs_before",
    1,
    "Codex released a new coding model.",
    "2026-07-25T09:30:00.000Z",
  );
  const afterAggregator = observation(
    "obs_after_aggregator",
    1,
    "Summary of a Tibo Codex update.",
    "2026-07-25T10:01:00.000Z",
  );
  const afterCommunity = observation(
    "obs_after_community",
    1,
    "Community report about Codex.",
    "2026-07-25T10:02:00.000Z",
  );
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      raw_observation: [before, afterAggregator, afterCommunity],
      normalized_signal: [
        signal({
          id: "sig_before",
          observationRef: { record_id: before.record_id, revision: 1 },
          availableAt: before.created_at,
          role: "product_lead",
          derivation: "primary_statement",
          identity: "person_tibo_sottiaux",
        }),
        signal({
          id: "sig_after_aggregator",
          observationRef: { record_id: afterAggregator.record_id, revision: 1 },
          availableAt: afterAggregator.created_at,
          role: "aggregator",
          derivation: "summarizes",
          identity: "person_tibo_sottiaux",
        }),
        signal({
          id: "sig_after_community",
          observationRef: { record_id: afterCommunity.record_id, revision: 1 },
          availableAt: afterCommunity.created_at,
          role: "community",
          derivation: "independent_observation",
        }),
      ],
    },
  });
  const base = await serverFor(t, store, config(), "2026-07-25T10:10:00.000Z");
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.equal(evidence.knowledge_cutoff, "2026-07-25T10:00:00.000Z");
  assert.deepEqual(evidence.core.map((item) => item.signal_ref.record_id), ["sig_before"]);
  assert.ok(evidence.items.every((item) => item.available_at <= evidence.knowledge_cutoff));
  assert.deepEqual(
    new Set(evidence.pending_next_forecast.items.map((item) => item.signal_ref.record_id)),
    new Set(["sig_after_aggregator", "sig_after_community"]),
  );
  assert.equal(evidence.pending_next_forecast.core.length, 0);
  assert.ok(evidence.pending_next_forecast.items.every((item) =>
    item.pending_next_forecast && !item.included_in_forecast,
  ));
});

test("stale forecasts are explicit and cannot make health or publication readiness green", async (t) => {
  const assertion = coverageAssertion();
  const stalePrediction = prediction({
    issuedAt: "2026-07-25T05:05:00.000Z",
    cutoff: "2026-07-25T05:00:00.000Z",
  });
  const appConfig = config();
  const store = new MemoryStore({
    records: {
      prediction: [stalePrediction],
      raw_observation: [observation(
        "obs_x",
        1,
        "Exact X source",
        "2026-07-25T09:30:00.000Z",
      )],
    },
    states: {
      coverage: { providers: { x: [assertion] } },
      "x-provider": {
        last_success_at: "2026-07-25T09:55:00.000Z",
        last_error: null,
      },
      runtime: {
        last_success_at: "2026-07-25T09:56:00.000Z",
        last_error: null,
      },
    },
    models: { champion: { model_version: "model/test" } },
  });
  const readiness = await getReadiness(store, appConfig, {
    now: new Date("2026-07-25T10:10:00.000Z"),
  });
  assert.equal(readiness.current_forecast.status, "stale");
  assert.equal(readiness.current_forecast.effective_stale, true);
  assert.equal(readiness.provider_freshness.groups.exact.status, "fresh");
  assert.equal(readiness.publication_ready, false);
  assert.ok(readiness.publication_blockers.includes("forecast_stale"));

  const base = await serverFor(t, store, appConfig, "2026-07-25T10:10:00.000Z");
  const [forecastResponse, healthResponse] = await Promise.all([
    fetch(`${base}/api/forecast/current`),
    fetch(`${base}/api/health`),
  ]);
  assert.equal(forecastResponse.status, 503);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.serving.status, "stale");
  assert.equal(forecast.data, undefined);
  assert.deepEqual(forecast.saved_prediction_ref, {
    record_id: stalePrediction.record_id,
    revision: stalePrediction.revision,
    issued_at: stalePrediction.data.issued_at,
    knowledge_cutoff: stalePrediction.data.knowledge_cutoff,
  });
  assert.equal(healthResponse.status, 503);
  const health = await healthResponse.json();
  assert.equal(health.status, "stale");
  assert.equal(health.effective_stale, true);
  assert.equal(health.publication_ready, false);
});

test("coverage stability observation is a machine-readable wait, not a pipeline error", async (t) => {
  const providerWaiting = {
    schema_version: "coverage-waiting/1",
    status: "observing",
    reason_code: "coverage_stability_observation_pending",
    provider_id: "authority_ledger",
    candidate_count: 180,
    earliest_first_observed_at: "2026-07-25T20:00:00.000Z",
    earliest_recheck_at: "2026-07-26T02:00:00.000Z",
    observed_at: "2026-07-25T20:00:00.000Z",
  };
  const appConfig = config({
    providers: {
      authority_adapter: {
        enabled: true,
        provider_name: "authority_ledger",
        freshness_max_age_hours: 2,
        confirmation_identities: [],
        context_identities: [],
        context_queries: [],
      },
    },
    model: {
      ...config().model,
      outcome_coverage_providers: ["authority_ledger"],
    },
  });
  const store = new MemoryStore({
    states: {
      "authority-adapter-provider": {
        provider: "authority_ledger",
        last_success_at: "2026-07-25T20:00:00.000Z",
        last_error: null,
        coverage_waiting: providerWaiting,
      },
      runtime: {
        last_success_at: "2026-07-25T20:00:00.000Z",
        last_status: "waiting_for_coverage",
        last_error: null,
      },
    },
  });
  const now = new Date("2026-07-25T21:00:00.000Z");
  const readiness = await getReadiness(store, appConfig, { now });
  assert.equal(readiness.pipeline_status, "waiting_for_coverage");
  assert.equal(readiness.outcome_coverage.status, "waiting_for_stability");
  assert.equal(readiness.coverage_waiting.candidate_count, 180);
  assert.equal(
    readiness.coverage_waiting.earliest_first_observed_at,
    "2026-07-25T20:00:00.000Z",
  );
  assert.equal(
    readiness.coverage_waiting.earliest_recheck_at,
    "2026-07-26T02:00:00.000Z",
  );
  assert.equal(readiness.coverage_waiting.recheck_due, false);
  assert.equal(readiness.publication_ready, false);
  assert.ok(
    readiness.publication_blockers.includes("negative_label_coverage_pending"),
  );
  assert.ok(
    !readiness.publication_blockers.includes("negative_label_coverage_missing"),
  );
  assert.ok(!readiness.publication_blockers.includes("pipeline_error"));

  const base = await serverFor(t, store, appConfig, now);
  const [healthResponse, forecastResponse] = await Promise.all([
    fetch(`${base}/api/health`),
    fetch(`${base}/api/forecast/current`),
  ]);
  assert.equal(healthResponse.status, 503);
  const health = await healthResponse.json();
  assert.equal(health.status, "waiting");
  assert.equal(health.pipeline_status, "waiting_for_coverage");
  assert.equal(health.pipeline_last_error, null);
  assert.equal(health.coverage_waiting.candidate_count, 180);
  assert.equal(forecastResponse.status, 503);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.pipeline_status, "waiting_for_coverage");
  assert.equal(forecast.coverage_waiting.candidate_count, 180);
});

test("walk-forward accumulation is exposed as evaluation waiting, not pipeline error", async (t) => {
  const evaluationWaiting = {
    schema_version: "evaluation-waiting/1",
    status: "waiting_for_evaluation",
    reason_code: "walk_forward_fold_pending",
    evaluation_cutoff: "2026-07-25T10:00:00.000Z",
    accepted_fold_count: 0,
    rejected_fold_count: 0,
    evaluated_windows: 0,
    evaluated_events: 0,
    minimum_evaluation_windows: 1008,
    minimum_evaluation_events: 20,
  };
  const assertion = coverageAssertion();
  const appConfig = config();
  const store = new MemoryStore({
    records: {
      raw_observation: [observation(
        "obs_x",
        1,
        "Exact X source",
        "2026-07-25T09:30:00.000Z",
      )],
    },
    states: {
      coverage: { providers: { x: [assertion] } },
      "x-provider": {
        last_success_at: "2026-07-25T09:55:00.000Z",
        last_error: null,
      },
      runtime: {
        last_success_at: "2026-07-25T10:00:00.000Z",
        last_status: "waiting_for_evaluation",
        last_evaluation_waiting: evaluationWaiting,
        last_error: null,
      },
    },
    blobs: {
      "blob://test/coverage.json": coverageBlob(),
    },
  });
  const now = new Date("2026-07-25T10:10:00.000Z");
  const readiness = await getReadiness(store, appConfig, { now });
  assert.equal(readiness.pipeline_status, "waiting_for_evaluation");
  assert.deepEqual(readiness.evaluation_waiting, evaluationWaiting);
  assert.equal(readiness.publication_ready, false);
  assert.ok(readiness.publication_blockers.includes("model_evaluation_pending"));
  assert.ok(!readiness.publication_blockers.includes("pipeline_error"));

  const base = await serverFor(t, store, appConfig, now);
  const [healthResponse, forecastResponse] = await Promise.all([
    fetch(`${base}/api/health`),
    fetch(`${base}/api/forecast/current`),
  ]);
  assert.equal(healthResponse.status, 503);
  const health = await healthResponse.json();
  assert.equal(health.status, "waiting");
  assert.equal(health.pipeline_status, "waiting_for_evaluation");
  assert.deepEqual(health.evaluation_waiting, evaluationWaiting);
  assert.equal(health.pipeline_last_error, null);
  assert.equal(forecastResponse.status, 503);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.pipeline_status, "waiting_for_evaluation");
  assert.deepEqual(forecast.evaluation_waiting, evaluationWaiting);
});

test("a corrupt champion is reported as incompatible instead of crashing health", async (t) => {
  const appConfig = config();
  const store = new MemoryStore({
    models: { champion: new Error("stored artifact hash mismatch") },
  });
  const base = await serverFor(t, store, appConfig, "2026-07-25T10:10:00.000Z");
  const [readinessResponse, healthResponse] = await Promise.all([
    fetch(`${base}/api/readiness`),
    fetch(`${base}/api/health`),
  ]);
  assert.equal(readinessResponse.status, 200);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.model.compatibility.compatible, false);
  assert.match(readiness.model.compatibility.reason, /artifact hash mismatch/);
  assert.ok(readiness.publication_blockers.includes("champion_incompatible"));
  assert.equal(healthResponse.status, 503);
  assert.notEqual((await healthResponse.json()).error, "internal_error");
});

test("evaluation cache compatibility and outcome/source revisions are exact", async (t) => {
  const assertion = coverageAssertion();
  const appConfig = config();
  const outcomeV1 = {
    record_id: "out_test",
    revision: 1,
    data: {
      status: "confirmed",
      occurred_time_range: {
        start: "2026-07-20T10:00:00.000Z",
        end: "2026-07-20T11:00:00.000Z",
        precision: "hour",
      },
      known_at: "2026-07-20T11:05:00.000Z",
      label_grade: "gold",
      verification: [{
        observation_ref: { record_id: "obs_source", revision: 1 },
      }],
    },
  };
  const outcomeV2 = {
    ...outcomeV1,
    revision: 2,
    data: {
      ...outcomeV1.data,
      verification: [{
        observation_ref: { record_id: "obs_source", revision: 2 },
      }],
    },
  };
  const candidateArtifactHash = hashLabel({ fixture: "candidate" });
  const fold = {
    origin: "2026-07-20T00:00:00.000Z",
    end: "2026-07-27T00:00:00.000Z",
    model_version: "walk-model/test",
    coverage_fraction: 1,
  };
  const frozenRows = [
    {
      fold_origin: fold.origin,
      anchor: "2026-07-20T00:00:00.000Z",
      window_end: "2026-07-20T04:00:00.000Z",
      probability: 0.05,
      champion_probability: null,
      baseline_probability: 0.5,
      features_hash: hashLabel({ fixture: "negative-row" }),
      label: 0,
    },
    {
      fold_origin: fold.origin,
      anchor: "2026-07-20T08:00:00.000Z",
      window_end: "2026-07-20T12:00:00.000Z",
      probability: 0.95,
      champion_probability: null,
      baseline_probability: 0.5,
      features_hash: hashLabel({ fixture: "positive-row" }),
      label: 1,
    },
  ];
  fold.evaluated_windows = frozenRows.length;
  fold.evaluated_window_hash = hashLabel(frozenRows);
  const foldDispositions = [{
    origin: fold.origin,
    end: fold.end,
    status: "accepted",
    evaluated_window_hash: fold.evaluated_window_hash,
  }];
  const frozenEvents = [{
    fold_origin: fold.origin,
    outcome_ref: { record_id: "out_test", revision: 1 },
    hit: true,
    settlement: "hit",
    useful_lead_hours: 2,
    maximum_prior_probability: 0.95,
    highest_prior_rank: 1,
    alert_rank_cutoff: 1,
    forecast_issued_at: "2026-07-20T08:00:00.000Z",
    ranked_window: {
      start: "2026-07-20T08:00:00.000Z",
      end: "2026-07-20T12:00:00.000Z",
      probability: 0.95,
    },
    policy_peak_window: {
      start: "2026-07-20T08:00:00.000Z",
      end: "2026-07-20T12:00:00.000Z",
      probability: 0.95,
    },
    occurred_time_range: outcomeV1.data.occurred_time_range,
    model_version: "walk-model/test",
  }];
  const frozenArtifact = {
    artifact_version: "reset-evaluation-rows/0.1.0",
    candidate_artifact_hash: candidateArtifactHash,
    evaluation_contract_hash: evaluationContractHash(appConfig),
    alert_policy: {
      type: "fixed_top_n_per_fold",
      budget: 1,
      tie_breaker: "earlier_anchor",
    },
    thresholds: {
      minimum_event_window_recall:
        appConfig.model.promotion.minimum_event_window_recall,
      require_brier_skill_above:
        appConfig.model.promotion.require_brier_skill_above,
      maximum_expected_calibration_error:
        appConfig.model.promotion.maximum_expected_calibration_error,
      minimum_live_evaluation_windows:
        appConfig.model.minimum_live_evaluation_windows,
      minimum_live_evaluation_events:
        appConfig.model.minimum_live_evaluation_events,
    },
    paired_status: "not_applicable",
    rows: frozenRows,
    alerts: [frozenRows[1]],
    events: frozenEvents,
    folds: [fold],
    fold_dispositions: foldDispositions,
  };
  const recomputed = recomputeFrozenEvaluationArtifact(frozenArtifact);
  const frozenArtifactHash = hashLabel(frozenArtifact);
  const frozenArtifactRef =
    `blob://test/evaluation-${frozenArtifactHash.slice("sha256:".length)}.json`;
  const evaluation = {
    evaluation_version: "reset-evaluation/0.3.0",
    mode: "walk_forward",
    evidence_mode: "historical_walk_forward",
    folds: [fold],
    fold_dispositions: foldDispositions,
    candidate: {
      model_version: "candidate/test",
      artifact_hash: candidateArtifactHash,
      evaluation_sample_hash: recomputed.evaluation_sample_hash,
    },
    metrics: recomputed.metrics,
    calibration: recomputed.calibration,
    events: frozenEvents,
    gate: recomputed.gate,
    paired_comparison: {
      status: "not_applicable",
      fold_signature: recomputed.fold_signature,
      sample_hash: recomputed.evaluation_sample_hash,
      champion_metrics: null,
      metric_deltas: null,
    },
    provenance: {
      config_hash: appConfig.config_hash,
      feature_schema_version: appConfig.feature_schema_version,
      deduplication_version: appConfig.deduplication_version,
      taxonomy_version: appConfig.taxonomy_version,
      model_contract_hash: modelContractHash(appConfig),
      evaluation_contract_hash: evaluationContractHash(appConfig),
      extractor_model: appConfig.extractor.model,
      extractor_model_version: appConfig.extractor.model_version,
      extractor_prompt_version: appConfig.extractor.prompt_version,
      coverage_assertion_refs: [{ assertion_id: assertion.assertion_id, revision: 1 }],
      coverage_assertion_snapshot_hash: hashLabel([assertion]),
      outcome_snapshot_refs: [{
        record_id: outcomeV1.record_id,
        revision: outcomeV1.revision,
        data_hash: hashLabel(outcomeV1.data),
      }],
      outcome_snapshot_hash: hashLabel([{
        record_id: outcomeV1.record_id,
        revision: outcomeV1.revision,
        data_hash: hashLabel(outcomeV1.data),
      }]),
      fold_signature: recomputed.fold_signature,
      fold_disposition_hash: recomputed.fold_disposition_hash,
      fold_disposition_count: foldDispositions.length,
      rejected_fold_count: 0,
      model_versions: ["walk-model/test"],
      row_sample_schema_version: frozenArtifact.artifact_version,
      row_sample_ref: frozenArtifactRef,
      row_sample_hash: frozenArtifactHash,
    },
  };
  evaluation.evaluation_artifact_hash = evaluationArtifactHash(evaluation);
  const unknownFutureEvaluation = structuredClone(evaluation);
  unknownFutureEvaluation.evaluation_version = "reset-evaluation/999.0.0";
  unknownFutureEvaluation.evaluation_artifact_hash =
    evaluationArtifactHash(unknownFutureEvaluation);
  assert.ok(
    assessEvaluationCompatibility(
      unknownFutureEvaluation,
      appConfig,
      [assertion],
      { outcomeRevisions: [outcomeV1] },
    ).reasons.includes("evaluation_version_unsupported"),
  );
  const store = new MemoryStore({
    records: {
      reset_outcome: [outcomeV1],
      raw_observation: [
        observation("obs_source", 1, "original revision", "2026-07-20T11:00:00.000Z"),
        observation("obs_source", 2, "corrected revision", "2026-07-21T11:00:00.000Z"),
      ],
    },
    states: {
      coverage: { providers: { x: [assertion] } },
      "walk-forward-summary": evaluation,
    },
    blobs: {
      "blob://test/coverage.json": coverageBlob(),
      [frozenArtifactRef]: frozenArtifact,
    },
  });
  const readiness = await getReadiness(store, appConfig, {
    now: new Date("2026-07-25T10:10:00.000Z"),
  });
  assert.equal(
    readiness.model.walk_forward_sample_gate.sample_threshold_passed,
    false,
  );
  assert.equal(readiness.model.real_walk_forward_acceptance_proven, false);
  assert.ok(
    readiness.publication_blockers.includes("real_walk_forward_not_proven"),
  );
  const base = await serverFor(t, store, appConfig, "2026-07-25T10:10:00.000Z");
  const [summaryResponse, eventsResponse] = await Promise.all([
    fetch(`${base}/api/evaluation/summary`),
    fetch(`${base}/api/evaluation/events`),
  ]);
  const summary = await summaryResponse.json();
  assert.equal(summaryResponse.status, 200, JSON.stringify(summary));
  assert.equal(summary.compatibility.compatible, true);
  const events = await eventsResponse.json();
  const scoredRevision = events.events.find((event) =>
    event.outcome_ref.record_id === "out_test" && event.outcome_ref.revision === 1,
  );
  assert.equal(scoredRevision.source.text, "original revision");
  assert.equal(scoredRevision.evaluation.outcome_ref.revision, 1);

  store.states["walk-forward-summary"].metrics.brier_score = 0.001;
  const tamperedResponse = await fetch(`${base}/api/evaluation/summary`);
  assert.equal(tamperedResponse.status, 503);
  const tampered = await tamperedResponse.json();
  assert.ok(
    tampered.invalidated[0].reasons.includes("evaluation_artifact_hash_mismatch"),
  );
  store.states["walk-forward-summary"] = structuredClone(evaluation);

  store.records.reset_outcome.push(outcomeV2);
  const supersededResponse = await fetch(`${base}/api/evaluation/summary`);
  assert.equal(supersededResponse.status, 503);
  const superseded = await supersededResponse.json();
  assert.ok(
    superseded.invalidated[0].reasons.includes("outcome_revision_superseded"),
  );

  store.states["walk-forward-summary"] = {
    ...evaluation,
    evaluation_version: "reset-evaluation/0.2.2",
    provenance: undefined,
  };
  const invalidatedResponse = await fetch(`${base}/api/evaluation/summary`);
  assert.equal(invalidatedResponse.status, 503);
  const invalidated = await invalidatedResponse.json();
  assert.equal(invalidated.error, "evaluation_invalidated");
  assert.ok(invalidated.invalidated[0].reasons.includes("evaluation_version_unsupported"));
});
