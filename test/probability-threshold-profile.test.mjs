import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { hashLabel } from "../src/core/hash.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  modelContractHash,
} from "../src/model/contract.mjs";
import {
  recomputeFrozenIssuedEvaluationArtifact,
} from "../src/model/issued-evaluation.mjs";
import {
  buildProbabilityThresholdProfile,
  loadProbabilityThresholdProfiles,
  NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
  parseProbabilityProfileHorizon,
  selectLatestIssuedPredictionsByAnchor,
} from "../src/query/probability-threshold-profile.mjs";

const HOUR_MS = 3_600_000;
const MODEL_RELEASE = "reset-model/0.3.2";

function prediction({
  id,
  anchor,
  issuedAt = new Date(Date.parse(anchor) - 60_000).toISOString(),
  hazard = 0.01,
  modelVersion = `${MODEL_RELEASE}-test`,
  dataQuality = 0.99,
}) {
  let survival = 1;
  const slots = Array.from({ length: 168 }, (_, index) => {
    const start = new Date(Date.parse(anchor) + index * HOUR_MS).toISOString();
    const end = new Date(Date.parse(start) + HOUR_MS).toISOString();
    const firstResetProbability = survival * hazard;
    survival *= 1 - hazard;
    return {
      start,
      end,
      hazard,
      first_reset_probability: firstResetProbability,
      reset_by_end_probability: 1 - survival,
      rolling_4h_probability: index <= 164 ? 1 - (1 - hazard) ** 4 : null,
      epistemic_interval_80: null,
    };
  });
  return {
    record_id: id,
    revision: 1,
    data: {
      issued_at: issuedAt,
      knowledge_cutoff: issuedAt,
      slots,
      model: { version: modelVersion },
      data_quality: {
        score: dataQuality,
        extraction_confidence: dataQuality,
      },
    },
  };
}

function outcome(id, start, end) {
  return {
    record_id: id,
    revision: 1,
    data: {
      status: "confirmed",
      occurred_time_range: { start, end },
    },
  };
}

function issuedEvaluationFixture(appConfig, predictions) {
  const rows = predictions.map((item, index) => ({
    prediction_ref: { record_id: item.record_id, revision: item.revision },
    settlement_ref: { record_id: `settlement_${index}`, revision: 1 },
    issued_at: item.data.issued_at,
    knowledge_cutoff: item.data.knowledge_cutoff,
    window_start: item.data.slots[0].start,
    window_end: item.data.slots[3].end,
    probability: item.data.slots[0].rolling_4h_probability,
    baseline_probability: 0.02,
    label: 0,
    model_version: item.data.model.version,
  }));
  const artifact = {
    artifact_version: "reset-issued-evaluation-rows/0.1.0",
    evaluation_contract_hash: evaluationContractHash(appConfig),
    alert_policy: {
      type: "fixed_top_n_per_calendar_week",
      budget: 1,
      tie_breaker: "probability_desc_then_window_start",
    },
    thresholds: {
      minimum_event_window_recall:
        appConfig.model.promotion.minimum_event_window_recall,
      require_brier_skill_above:
        appConfig.model.promotion.require_brier_skill_above,
      maximum_expected_calibration_error:
        appConfig.model.promotion.maximum_expected_calibration_error,
    },
    duplicate_predictions_excluded_count: 0,
    rows,
    alerts: [[...rows].sort((left, right) =>
      right.probability - left.probability ||
      left.window_start.localeCompare(right.window_start)
    )[0]],
    events: [],
  };
  const recomputed = recomputeFrozenIssuedEvaluationArtifact(artifact);
  const rowSampleHash = hashLabel(artifact);
  const rowSampleRef = "blob://issued-evaluation/test.json";
  const predictionSnapshot = predictions.map((item) => ({
    record_id: item.record_id,
    revision: item.revision,
    data_hash: hashLabel(item.data),
  }));
  const summary = {
    evaluation_version: "reset-issued-evaluation/0.3.0",
    mode: "as_issued",
    evaluation_cutoff: "2026-08-02T00:00:00.000Z",
    provenance: {
      model_contract_hash: modelContractHash(appConfig),
      evaluation_contract_hash: evaluationContractHash(appConfig),
      row_sample_schema_version: artifact.artifact_version,
      row_sample_ref: rowSampleRef,
      row_sample_hash: rowSampleHash,
      prediction_snapshot_refs: predictionSnapshot,
      prediction_snapshot_hash: hashLabel(predictionSnapshot),
    },
    metrics: recomputed.metrics,
    calibration: recomputed.calibration,
    events: recomputed.events,
    gate: recomputed.gate,
  };
  summary.evaluation_artifact_hash = evaluationArtifactHash(summary);
  return { artifact, rowSampleRef, summary };
}

test("arbitrary-horizon calibration uses cumulative as-issued probability and covered labels", () => {
  const predictions = [0, 4, 8].map((offset) => prediction({
    id: `pred_${offset}`,
    anchor: new Date(Date.parse("2026-08-01T00:00:00.000Z") + offset * HOUR_MS)
      .toISOString(),
  }));
  const profile = buildProbabilityThresholdProfile({
    predictions,
    outcomes: [outcome(
      "outcome_1",
      "2026-08-01T02:00:00.000Z",
      "2026-08-01T03:00:00.000Z",
    )],
    coverageIntervals: [{
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-01T12:00:00.000Z",
    }],
    evaluationCutoff: "2026-08-01T12:00:00.000Z",
    horizonHours: 4,
    modelRelease: MODEL_RELEASE,
    minimumWindows: 3,
    minimumEvents: 1,
  });

  assert.equal(
    profile.schema_version,
    NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
  );
  assert.equal(profile.status, "available");
  assert.equal(profile.horizon_hours, 4);
  assert.equal(profile.sample_count, 3);
  assert.equal(profile.event_count, 1);
  assert.deepEqual(profile.sample, {
    positive_windows: 1,
    negative_windows: 2,
    first_window_start: "2026-08-01T00:00:00.000Z",
    last_window_start: "2026-08-01T08:00:00.000Z",
  });
  const zeroThreshold = profile.points.find((point) => point.probability === 0);
  assert.equal(zeroThreshold.sample_count_above, 3);
  assert.equal(zeroThreshold.confidence_above, null);
  assert.equal(zeroThreshold.historical_hit_rate_above, 1 / 3);
  assert.deepEqual(zeroThreshold.point_sample_gate, {
    minimum_windows: 20,
    evaluated_windows: 3,
    passed: false,
  });
  assert.equal(zeroThreshold.window_count_above, 3);
  assert.equal(zeroThreshold.event_recall, 1);
  assert.equal(zeroThreshold.confidence_interval.method, "wilson_score");
  assert.equal(
    profile.distribution.bins.reduce((sum, bin) => sum + bin.windows, 0),
    3,
  );
  assert.equal(profile.threshold_curve[0].descriptive_window_reset_rate, 1 / 3);
  assert.equal(Object.hasOwn(profile, "data_quality"), false);
  assert.equal(Object.hasOwn(profile.points[0], "extraction_confidence"), false);
});

test("overlap-aware confidence counts non-overlapping horizons separately from descriptive windows", () => {
  const start = Date.parse("2026-08-01T00:00:00.000Z");
  const predictions = Array.from({ length: 4 }, (_, index) => prediction({
    id: `pred_${index}`,
    anchor: new Date(start + index * HOUR_MS).toISOString(),
  }));
  const profile = buildProbabilityThresholdProfile({
    predictions,
    outcomes: [],
    coverageIntervals: [{
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-01T08:00:00.000Z",
    }],
    evaluationCutoff: "2026-08-01T08:00:00.000Z",
    horizonHours: 4,
    modelRelease: MODEL_RELEASE,
    minimumWindows: 4,
    minimumEvents: 1,
  });

  assert.equal(profile.status, "preliminary");
  assert.equal(profile.sample_count, 4);
  assert.equal(profile.points[0].window_count_above, 4);
  assert.equal(profile.points[0].sample_count_above, 1);
  assert.equal(profile.points[0].confidence_above, null);
  assert.equal(profile.points[0].historical_hit_rate_above, 0);
  assert.equal(profile.sample_gate.windows_passed, true);
  assert.equal(profile.sample_gate.events_passed, false);
});

test("point estimates require 20 independent windows and thresholds are strict", () => {
  const start = Date.parse("2026-08-01T00:00:00.000Z");
  const predictions = Array.from({ length: 20 }, (_, index) => prediction({
    id: `point_gate_${index}`,
    anchor: new Date(start + index * HOUR_MS).toISOString(),
    hazard: 0.5,
  }));
  const profile = buildProbabilityThresholdProfile({
    predictions,
    outcomes: [],
    coverageIntervals: [{
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-01T20:00:00.000Z",
    }],
    evaluationCutoff: "2026-08-01T21:00:00.000Z",
    horizonHours: 1,
    modelRelease: MODEL_RELEASE,
    minimumWindows: 20,
    minimumEvents: 1,
  });

  const zeroThreshold = profile.points.find((point) => point.probability === 0);
  assert.deepEqual(zeroThreshold.point_sample_gate, {
    minimum_windows: 20,
    evaluated_windows: 20,
    passed: true,
  });
  assert.equal(zeroThreshold.confidence_above, 0);
  assert.equal(zeroThreshold.confidence_interval.method, "wilson_score");
  const exactThreshold = profile.threshold_curve.find((point) =>
    point.threshold === 0.5
  );
  assert.equal(exactThreshold.selected_windows, 0);
  assert.equal(profile.semantics.threshold_comparison, "probability strictly greater than threshold");
});

test("incomplete coverage, immature horizons, ambiguous outcomes, and future-issued forecasts do not become labels", () => {
  const predictions = [
    prediction({ id: "incomplete", anchor: "2026-07-31T00:00:00.000Z" }),
    prediction({ id: "positive", anchor: "2026-08-01T01:00:00.000Z" }),
    prediction({ id: "ambiguous", anchor: "2026-08-02T00:00:00.000Z" }),
    prediction({ id: "immature", anchor: "2026-08-03T00:00:00.000Z" }),
    prediction({
      id: "future_issued",
      anchor: "2026-08-04T00:00:00.000Z",
      issuedAt: "2026-08-04T00:01:00.000Z",
    }),
  ];
  const profile = buildProbabilityThresholdProfile({
    predictions,
    outcomes: [outcome(
      "outcome_positive",
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    )],
    ambiguousOutcomes: [outcome(
      "outcome_ambiguous",
      "2026-08-02T10:00:00.000Z",
      "2026-08-02T11:00:00.000Z",
    )],
    coverageIntervals: [{
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-01T08:00:00.000Z",
    }],
    evaluationCutoff: "2026-08-03T12:00:00.000Z",
    horizonHours: 24,
    modelRelease: MODEL_RELEASE,
    minimumWindows: 2,
    minimumEvents: 2,
  });

  assert.equal(profile.status, "preliminary");
  assert.equal(profile.sample_count, 1, "a positive does not require negative coverage");
  assert.equal(profile.sample.positive_windows, 1);
  assert.equal(profile.exclusions.censored_incomplete_coverage, 1);
  assert.equal(profile.exclusions.censored_ambiguous_outcome, 1);
  assert.equal(profile.exclusions.immature, 1);
  assert.equal(profile.exclusions.malformed, 1);
});

test("latest issued prediction per anchor is deterministic and current-release only", () => {
  const anchor = "2026-08-01T04:00:00.000Z";
  const older = prediction({
    id: "older",
    anchor,
    issuedAt: "2026-08-01T03:50:00.000Z",
  });
  const newer = prediction({
    id: "newer",
    anchor,
    issuedAt: "2026-08-01T03:55:00.000Z",
  });
  const oldRelease = prediction({
    id: "old_release",
    anchor: "2026-08-01T05:00:00.000Z",
    modelVersion: "reset-model/0.3.1-old",
  });
  const selected = selectLatestIssuedPredictionsByAnchor(
    [older, oldRelease, newer],
    { horizonHours: 4, modelRelease: MODEL_RELEASE },
  );

  assert.deepEqual(selected.selected.map((item) => item.record_id), ["newer"]);
  assert.equal(selected.excluded.duplicate_anchor, 1);
  assert.equal(selected.excluded.incompatible_model_release, 1);
});

test("multi-horizon loading verifies and reads the frozen artifact only once", async () => {
  const appConfig = await loadConfig({ configPath: "config/default.json" });
  const predictions = [
    prediction({
      id: "context_1",
      anchor: "2026-08-01T04:00:00.000Z",
      hazard: 0.01,
    }),
    prediction({
      id: "context_2",
      anchor: "2026-08-01T08:00:00.000Z",
      hazard: 0.02,
    }),
  ];
  const fixture = issuedEvaluationFixture(appConfig, predictions);
  const counts = {
    rowSampleReads: 0,
    issuedStateReads: 0,
    predictionReads: 0,
  };
  const store = {
    async readState(name, fallback) {
      if (name === "issued-evaluation-summary") {
        counts.issuedStateReads += 1;
        return structuredClone(fixture.summary);
      }
      return structuredClone(fallback);
    },
    async readBlob(ref) {
      assert.equal(ref, fixture.rowSampleRef);
      counts.rowSampleReads += 1;
      return structuredClone(fixture.artifact);
    },
    async allByRefs(type, refs) {
      assert.equal(type, "prediction");
      counts.predictionReads += 1;
      const keys = new Set(refs.map((ref) => `${ref.record_id}@${ref.revision}`));
      return structuredClone(predictions.filter((item) =>
        keys.has(`${item.record_id}@${item.revision}`)
      ));
    },
    async all() {
      return [];
    },
    async allAudit() {
      return [];
    },
  };

  const profiles = await loadProbabilityThresholdProfiles(store, appConfig, {
    horizons: [4, 24],
  });

  assert.deepEqual([...profiles.keys()], [4, 24]);
  assert.equal(profiles.get(4).horizon_hours, 4);
  assert.equal(profiles.get(24).horizon_hours, 24);
  assert.match(
    profiles.get(4).lineage.context_generation_hash,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    profiles.get(4).lineage.context_generation_hash,
    profiles.get(24).lineage.context_generation_hash,
  );
  assert.deepEqual(counts, {
    rowSampleReads: 1,
    issuedStateReads: 1,
    predictionReads: 1,
  });
});

test("subscription calibration horizon accepts only integer hours from 1 through 168", () => {
  assert.equal(parseProbabilityProfileHorizon("1"), 1);
  assert.equal(parseProbabilityProfileHorizon(168), 168);
  for (const value of [0, 169, "4.5", "", null]) {
    assert.throws(
      () => parseProbabilityProfileHorizon(value),
      /integer from 1 through 168/,
    );
  }
});
