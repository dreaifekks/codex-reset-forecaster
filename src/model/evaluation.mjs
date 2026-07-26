import { addHours, clamp, floorHour, toUtcIso } from "../core/time.mjs";
import { hashLabel, sha256, stableStringify } from "../core/hash.mjs";
import {
  coverageAssertions,
  normalizeCoverageIntervals,
  verifyCoverageAssertionEvidence,
} from "../pipeline/coverage.mjs";
import { FEATURE_NAMES, featureVectorAt, featuresToArray } from "./features.mjs";
import {
  assertModelCompatibility,
  predictHazard,
  trainLogisticHazard,
} from "./logistic-hazard.mjs";
import { buildTrainingExamples } from "./training.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { extractorContract } from "../core/extractor-contract.mjs";
import {
  averagePrecision,
  calibrationFit,
  falseAlertsByMonth,
  medianPolicyPeakAbsoluteError,
} from "./diagnostics.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  modelContractHash,
  modelVersionFor,
  trainingAlgorithmSignature,
} from "./contract.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import {
  AS_OF_MODE,
  asOfModeForEvidence,
  latestObservationsAsOf,
  latestOutcomesAsOf,
  latestSignalsAsOf,
  outcomeAvailableAt,
} from "./as-of.mjs";
import {
  COVERAGE_AS_OF_MODE,
  adequateCoverageAssertionsAsOf,
  coverageAssertionRevisions,
} from "./coverage-as-of.mjs";
import { conditionAuthorityTimingHazards } from "./authority-timing.mjs";

export const EVALUATION_WAITING_SCHEMA_VERSION = "evaluation-waiting/1";

export class EvaluationPendingError extends Error {
  constructor(reasonCode, details = {}) {
    super("Walk-forward evaluation is waiting for causal test data");
    this.name = "EvaluationPendingError";
    this.code = "evaluation_pending";
    this.status = "waiting_for_evaluation";
    this.reasonCode = reasonCode;
    this.details = structuredClone(details);
  }

  toJSON() {
    return {
      schema_version: EVALUATION_WAITING_SCHEMA_VERSION,
      status: this.status,
      reason_code: this.reasonCode,
      ...structuredClone(this.details),
    };
  }
}

export function evaluationWaitingFromError(error) {
  return error instanceof EvaluationPendingError
    ? error.toJSON()
    : null;
}

export function normalizeEvaluationWaiting(value) {
  if (
    !value ||
    value.schema_version !== EVALUATION_WAITING_SCHEMA_VERSION ||
    value.status !== "waiting_for_evaluation" ||
    typeof value.reason_code !== "string" ||
    typeof value.evaluation_cutoff !== "string" ||
    !Number.isFinite(Date.parse(value.evaluation_cutoff))
  ) {
    return null;
  }
  const normalized = {
    schema_version: EVALUATION_WAITING_SCHEMA_VERSION,
    status: "waiting_for_evaluation",
    reason_code: value.reason_code,
    evaluation_cutoff: new Date(value.evaluation_cutoff).toISOString(),
    accepted_fold_count: Number.isInteger(value.accepted_fold_count)
      ? Math.max(0, value.accepted_fold_count)
      : 0,
    rejected_fold_count: Number.isInteger(value.rejected_fold_count)
      ? Math.max(0, value.rejected_fold_count)
      : 0,
    evaluated_windows: Number.isInteger(value.evaluated_windows)
      ? Math.max(0, value.evaluated_windows)
      : 0,
    evaluated_events: Number.isInteger(value.evaluated_events)
      ? Math.max(0, value.evaluated_events)
      : 0,
    minimum_evaluation_windows:
      Number.isInteger(value.minimum_evaluation_windows)
        ? Math.max(0, value.minimum_evaluation_windows)
        : null,
    minimum_evaluation_events:
      Number.isInteger(value.minimum_evaluation_events)
        ? Math.max(0, value.minimum_evaluation_events)
        : null,
  };
  return normalized;
}

function overlaps(start, end, range) {
  return Date.parse(start) < Date.parse(range.end) && Date.parse(end) > Date.parse(range.start);
}

function covered(start, end, intervals) {
  return intervals.some((interval) =>
    Date.parse(interval.start) <= Date.parse(start) && Date.parse(interval.end) >= Date.parse(end),
  );
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calibration(rows) {
  const buckets = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    predictions: [],
    labels: [],
  }));
  for (const row of rows) {
    const index = Math.min(9, Math.floor(row.probability * 10));
    buckets[index].predictions.push(row.probability);
    buckets[index].labels.push(row.label);
  }
  return buckets.map((bucket) => ({
    lower: bucket.lower,
    upper: bucket.upper,
    count: bucket.labels.length,
    mean_prediction: mean(bucket.predictions),
    observed_rate: mean(bucket.labels),
  }));
}

function rollingPrediction(model, featureRows, {
  anchor,
  signals,
  observations,
  outcomes,
  config,
  asOfMode,
  excludedSourceRecordIds,
  excludedIndependenceGroupIds,
}) {
  const hazardEntries = featureRows.map((row, offset) => {
    const start = addHours(anchor, offset);
    return {
      start: toUtcIso(start),
      end: toUtcIso(addHours(start, 1)),
      hazard: predictHazard(model, row).probability,
      interval80: null,
    };
  });
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries,
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff: anchor,
    asOfMode,
    excludedSourceRecordIds,
    excludedIndependenceGroupIds,
  });
  return {
    probability: 1 - conditioned.hazardEntries.reduce(
      (survival, entry) => survival * (1 - entry.hazard),
      1,
    ),
    conditioning: conditioned.metadata,
  };
}

function sortByProbability(rows) {
  return [...rows].sort((left, right) =>
    right.probability - left.probability || left.anchor.localeCompare(right.anchor),
  );
}

export function selectFixedBudgetAlerts(rows, budget) {
  return sortByProbability(rows).slice(0, Math.min(budget, rows.length));
}

export function causalWindowLabel(anchor, windowEnd, outcomes, censoredOutcomes = []) {
  if (censoredOutcomes.some((outcome) =>
    overlaps(anchor, windowEnd, outcome.data.occurred_time_range),
  )) {
    return null;
  }
  const anchorMs = Date.parse(anchor);
  if (outcomes.some((outcome) => {
    const range = outcome.data.occurred_time_range;
    return Date.parse(range.start) <= anchorMs && anchorMs < Date.parse(range.end);
  })) {
    return null;
  }
  return outcomes.some((outcome) => {
    const range = outcome.data.occurred_time_range;
    return anchorMs < Date.parse(range.start) && overlaps(anchor, windowEnd, range);
  }) ? 1 : 0;
}

export function fourHourAnchorsWithinFold(origin, testEnd) {
  const anchors = [];
  for (
    let anchor = new Date(origin);
    addHours(anchor, 4) <= new Date(testEnd);
    anchor = addHours(anchor, 1)
  ) {
    anchors.push(anchor);
  }
  return anchors;
}

export function assessFoldCoverage(origin, testEnd, coverageIntervals) {
  const anchors = fourHourAnchorsWithinFold(origin, testEnd);
  const coveredAnchors = anchors.filter((anchor) =>
    covered(anchor, addHours(anchor, 4), coverageIntervals),
  );
  return {
    anchors,
    coveredAnchors,
    requiredAnchorCount: anchors.length,
    coveredAnchorCount: coveredAnchors.length,
    coverageFraction: anchors.length === 0 ? 0 : coveredAnchors.length / anchors.length,
    eligible: anchors.length > 0 && coveredAnchors.length === anchors.length,
  };
}

export function summarizeFoldDispositions(dispositions) {
  const normalized = dispositions.map((entry) => ({ ...entry }));
  const rejected = normalized.filter((entry) => entry.status === "rejected");
  return {
    count: normalized.length,
    rejected_count: rejected.length,
    disposition_hash: hashLabel(normalized),
    passed: rejected.length === 0,
  };
}

function sourceExclusions(outcomes) {
  return {
    recordIds: new Set(outcomes.flatMap((outcome) => [
      outcome.record_id,
      ...(outcome.data.verification ?? []).map((entry) => entry.observation_ref.record_id),
    ])),
    independenceGroupIds: new Set(outcomes.flatMap((outcome) =>
      (outcome.data.verification ?? [])
        .map((entry) => entry.independence_group_id)
        .filter(Boolean),
    )),
  };
}

function compatibleFeatureContract(model, config) {
  return model?.feature_schema_version === config.feature_schema_version &&
    JSON.stringify(model.feature_names) === JSON.stringify(FEATURE_NAMES);
}

function trainingOptionsFromArtifact(model, config) {
  const configuredPriors = model.training_hyperparameters?.coefficient_priors ??
    Object.fromEntries(FEATURE_NAMES.map((name, index) => [
      name,
      Number(model.coefficient_priors?.[index + 1] ?? 0),
    ]));
  return {
    lambda: Number(model.training_hyperparameters?.lambda ?? model.lambda),
    initialStep: Number(
      model.training_hyperparameters?.initial_step ?? config.model.learning_rate,
    ),
    gradientTolerance: Number(
      model.training_hyperparameters?.gradient_tolerance ??
      config.model.gradient_tolerance,
    ),
    objectiveTolerance: Number(
      model.training_hyperparameters?.objective_tolerance ??
      config.model.objective_tolerance,
    ),
    hessianStep: Number(
      model.training_hyperparameters?.hessian_step ?? config.model.hessian_step,
    ),
    maxIterations: Number(
      model.training_hyperparameters?.max_iterations ?? config.model.max_iterations,
    ),
    coefficientPriors: configuredPriors,
  };
}

const PAIRED_NON_REGRESSION_TOLERANCE = 1e-12;
const FROZEN_EVALUATION_VERSION = "reset-evaluation-rows/0.1.0";

export function assessEvaluationSampleGate(metrics, thresholds) {
  const minimumWindows = thresholds?.minimum_live_evaluation_windows;
  const minimumEvents = thresholds?.minimum_live_evaluation_events;
  if (
    !Number.isInteger(minimumWindows) ||
    minimumWindows < 1 ||
    !Number.isInteger(minimumEvents) ||
    minimumEvents < 1
  ) {
    throw new TypeError("Evaluation sample thresholds must be positive integers");
  }
  const evaluatedWindows = metrics?.evaluated_windows;
  const evaluatedEvents = metrics?.evaluated_events;
  const windowsPassed = Number.isInteger(evaluatedWindows) &&
    evaluatedWindows >= minimumWindows;
  const eventsPassed = Number.isInteger(evaluatedEvents) &&
    evaluatedEvents >= minimumEvents;
  return {
    minimum_live_evaluation_windows: minimumWindows,
    minimum_live_evaluation_events: minimumEvents,
    evaluated_windows_passed: windowsPassed,
    evaluated_events_passed: eventsPassed,
    sample_threshold_passed: windowsPassed && eventsPassed,
  };
}

export function recomputeFrozenEvaluationArtifact(artifact) {
  if (artifact?.artifact_version !== FROZEN_EVALUATION_VERSION) {
    throw new Error("Unsupported frozen evaluation artifact version");
  }
  for (const field of ["rows", "alerts", "events", "folds", "fold_dispositions"]) {
    if (!Array.isArray(artifact[field])) {
      throw new Error(`Frozen evaluation artifact ${field} must be an array`);
    }
  }
  const rows = artifact.rows;
  if (
    rows.length === 0 ||
    rows.some((row) =>
      typeof row.anchor !== "string" ||
      typeof row.window_end !== "string" ||
      typeof row.fold_origin !== "string" ||
      typeof row.features_hash !== "string" ||
      !Number.isFinite(row.probability) ||
      !Number.isFinite(row.baseline_probability) ||
      ![0, 1].includes(row.label)
    )
  ) {
    throw new Error("Frozen evaluation rows are incomplete");
  }
  const budget = artifact.alert_policy?.budget;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error("Frozen evaluation alert budget is invalid");
  }
  const expectedAlerts = artifact.folds.flatMap((fold) =>
    selectFixedBudgetAlerts(
      rows.filter((row) => row.fold_origin === fold.origin),
      budget,
    )
  );
  if (hashLabel(expectedAlerts) !== hashLabel(artifact.alerts)) {
    throw new Error("Frozen evaluation alerts do not match the fixed policy");
  }
  for (const fold of artifact.folds) {
    const foldRows = rows.filter((row) => row.fold_origin === fold.origin);
    if (
      fold.evaluated_windows !== foldRows.length ||
      fold.evaluated_window_hash !== hashLabel(foldRows)
    ) {
      throw new Error("Frozen evaluation fold rows do not match their hash");
    }
  }
  const brier = mean(rows.map((row) => (row.probability - row.label) ** 2));
  const baselineBrier = mean(
    rows.map((row) => (row.baseline_probability - row.label) ** 2),
  );
  const brierSkill = baselineBrier === 0 ? 0 : 1 - brier / baselineBrier;
  const logLoss = mean(rows.map((row) => {
    const probability = clamp(row.probability, 1e-12, 1 - 1e-12);
    return -(row.label * Math.log(probability) +
      (1 - row.label) * Math.log(1 - probability));
  }));
  const calibrationBuckets = calibration(rows);
  const expectedCalibrationError = calibrationBuckets.reduce((sum, bucket) =>
    sum + (bucket.count === 0
      ? 0
      : (bucket.count / rows.length) *
        Math.abs(bucket.mean_prediction - bucket.observed_rate)), 0);
  const calibrationRegression = calibrationFit(rows);
  const events = artifact.events.map((event) => {
    const eventStart = Date.parse(event.occurred_time_range?.start);
    if (!Number.isFinite(eventStart)) {
      throw new Error("Frozen evaluation event time is invalid");
    }
    const foldRows = rows.filter((row) =>
      !event.fold_origin || row.fold_origin === event.fold_origin
    );
    const foldAlerts = artifact.alerts.filter((row) =>
      !event.fold_origin || row.fold_origin === event.fold_origin
    );
    const eligibleRows = foldRows.filter((row) =>
      Date.parse(row.anchor) < eventStart &&
      overlaps(
        row.anchor,
        row.window_end,
        event.occurred_time_range,
      )
    );
    const matchingAlerts = foldAlerts.filter((row) =>
      Date.parse(row.anchor) < eventStart &&
      overlaps(
        row.anchor,
        row.window_end,
        event.occurred_time_range,
      )
    );
    const highestPrior = sortByProbability(eligibleRows)[0] ?? null;
    const ranked = sortByProbability(foldRows);
    const policyPeak = sortByProbability(
      foldAlerts.filter((row) => Date.parse(row.anchor) < eventStart),
    )[0] ?? null;
    const expected = {
      hit: matchingAlerts.length > 0,
      settlement: matchingAlerts.length > 0 ? "hit" : "miss",
      useful_lead_hours: matchingAlerts.length === 0
        ? null
        : Math.max(...matchingAlerts.map((row) =>
          (eventStart - Date.parse(row.anchor)) / 3_600_000
        )),
      maximum_prior_probability: highestPrior?.probability ?? 0,
      highest_prior_rank: highestPrior
        ? ranked.findIndex((row) => row.anchor === highestPrior.anchor) + 1
        : null,
      alert_rank_cutoff: Math.min(budget, ranked.length),
      forecast_issued_at:
        highestPrior?.anchor ?? event.fold_origin ?? null,
      ranked_window: highestPrior ? {
        start: highestPrior.anchor,
        end: highestPrior.window_end,
        probability: highestPrior.probability,
      } : null,
      policy_peak_window: policyPeak ? {
        start: policyPeak.anchor,
        end: policyPeak.window_end,
        probability: policyPeak.probability,
      } : null,
    };
    const actual = Object.fromEntries(
      Object.keys(expected).map((key) => [key, event[key] ?? null]),
    );
    if (hashLabel(actual) !== hashLabel(expected)) {
      throw new Error(
        "Frozen evaluation event does not match rows and fixed alerts",
      );
    }
    return { ...event, ...expected };
  });
  const eventWindowRecall = events.length === 0
    ? 0
    : events.filter((event) => event.hit === true).length / events.length;
  const falseAlerts = artifact.alerts.filter((row) => row.label === 0).length;
  const metrics = {
    evaluated_windows: rows.length,
    evaluated_events: events.length,
    event_window_recall: eventWindowRecall,
    brier_score: brier,
    baseline_brier_score: baselineBrier,
    brier_skill: brierSkill,
    expected_calibration_error: expectedCalibrationError,
    calibration_intercept: calibrationRegression.intercept,
    calibration_slope: calibrationRegression.slope,
    average_precision: averagePrecision(rows),
    log_loss: logLoss,
    false_high_probability_alerts: falseAlerts,
    false_high_probability_alerts_by_month:
      falseAlertsByMonth(artifact.alerts, -Infinity),
    false_alerts_top_n_policy: falseAlerts,
    false_probability_ge_0_5_windows:
      rows.filter((row) => row.probability >= 0.5 && row.label === 0).length,
    median_useful_lead_hours:
      median(events.map((event) => event.useful_lead_hours)
        .filter((value) => value !== null)),
    median_policy_peak_absolute_error_hours:
      medianPolicyPeakAbsoluteError(events),
  };
  const thresholds = artifact.thresholds;
  if (
    !Number.isFinite(thresholds?.minimum_event_window_recall) ||
    !Number.isFinite(thresholds?.require_brier_skill_above) ||
    !Number.isFinite(thresholds?.maximum_expected_calibration_error)
  ) {
    throw new Error("Frozen evaluation thresholds are invalid");
  }
  const sampleGate = assessEvaluationSampleGate(metrics, thresholds);
  const dispositionSummary = summarizeFoldDispositions(
    artifact.fold_dispositions,
  );
  const gate = {
    minimum_event_window_recall: thresholds.minimum_event_window_recall,
    require_brier_skill_above: thresholds.require_brier_skill_above,
    maximum_expected_calibration_error:
      thresholds.maximum_expected_calibration_error,
    event_window_recall_passed:
      eventWindowRecall >= thresholds.minimum_event_window_recall,
    brier_skill_passed:
      brierSkill > thresholds.require_brier_skill_above,
    calibration_passed:
      expectedCalibrationError <=
        thresholds.maximum_expected_calibration_error,
    coverage_passed:
      artifact.fold_dispositions.every((entry) =>
        entry.reason !== "incomplete_fold_coverage"
      ) &&
      artifact.folds.every((fold) => fold.coverage_fraction === 1),
    fold_disposition_passed: dispositionSummary.passed,
    ...sampleGate,
  };
  gate.passed = gate.event_window_recall_passed &&
    gate.brier_skill_passed &&
    gate.calibration_passed &&
    gate.coverage_passed &&
    gate.fold_disposition_passed &&
    gate.sample_threshold_passed;
  let pairedChampionMetrics = null;
  let pairedMetricDeltas = null;
  if (
    artifact.paired_status === "available" &&
    rows.every((row) => Number.isFinite(row.champion_probability))
  ) {
    const pairedRows = rows.map((row) => ({
      ...row,
      probability: row.champion_probability,
    }));
    const pairedBuckets = calibration(pairedRows);
    const pairedExpectedCalibrationError = pairedBuckets.reduce((sum, bucket) =>
      sum + (bucket.count === 0
        ? 0
        : (bucket.count / pairedRows.length) *
          Math.abs(bucket.mean_prediction - bucket.observed_rate)), 0);
    pairedChampionMetrics = {
      brier_score: mean(
        pairedRows.map((row) => (row.probability - row.label) ** 2),
      ),
      expected_calibration_error: pairedExpectedCalibrationError,
      log_loss: mean(pairedRows.map((row) => {
        const probability = clamp(row.probability, 1e-12, 1 - 1e-12);
        return -(row.label * Math.log(probability) +
          (1 - row.label) * Math.log(1 - probability));
      })),
    };
    pairedMetricDeltas = {
      brier_score: brier - pairedChampionMetrics.brier_score,
      expected_calibration_error:
        expectedCalibrationError -
        pairedChampionMetrics.expected_calibration_error,
      log_loss: logLoss - pairedChampionMetrics.log_loss,
    };
  }
  return {
    metrics,
    calibration: calibrationBuckets,
    gate,
    paired_champion_metrics: pairedChampionMetrics,
    paired_metric_deltas: pairedMetricDeltas,
    evaluation_sample_hash: hashLabel(rows),
    fold_signature: hashLabel(artifact.folds),
    fold_disposition_hash: dispositionSummary.disposition_hash,
  };
}

export async function verifyEvaluationArtifact(store, evaluation) {
  if (
    evaluation?.evaluation_version !== "reset-evaluation/0.3.0" ||
    typeof evaluation.evaluation_artifact_hash !== "string" ||
    evaluationArtifactHash(evaluation) !== evaluation.evaluation_artifact_hash
  ) {
    return { valid: false, reason: "evaluation_artifact_hash_mismatch" };
  }
  const provenance = evaluation.provenance ?? {};
  if (
    provenance.row_sample_schema_version !== FROZEN_EVALUATION_VERSION ||
    typeof provenance.row_sample_ref !== "string" ||
    typeof provenance.row_sample_hash !== "string"
  ) {
    return { valid: false, reason: "evaluation_row_sample_missing" };
  }
  if (typeof store.readBlob !== "function") {
    return { valid: false, reason: "evaluation_row_sample_unavailable" };
  }
  let artifact;
  try {
    artifact = await store.readBlob(provenance.row_sample_ref);
  } catch {
    return { valid: false, reason: "evaluation_row_sample_unavailable" };
  }
  if (
    hashLabel(artifact) !== provenance.row_sample_hash ||
    artifact.candidate_artifact_hash !== evaluation.candidate?.artifact_hash ||
    artifact.evaluation_contract_hash !==
      provenance.evaluation_contract_hash
  ) {
    return { valid: false, reason: "evaluation_row_sample_hash_mismatch" };
  }
  let recomputed;
  try {
    recomputed = recomputeFrozenEvaluationArtifact(artifact);
  } catch {
    return { valid: false, reason: "evaluation_row_sample_invalid" };
  }
  if (
    recomputed.evaluation_sample_hash !==
      evaluation.candidate?.evaluation_sample_hash ||
    recomputed.fold_signature !== provenance.fold_signature ||
    recomputed.fold_disposition_hash !==
      provenance.fold_disposition_hash ||
    hashLabel(artifact.folds) !== hashLabel(evaluation.folds) ||
    hashLabel(artifact.fold_dispositions) !==
      hashLabel(evaluation.fold_dispositions) ||
    hashLabel(artifact.events) !== hashLabel(evaluation.events) ||
    hashLabel(recomputed.metrics) !== hashLabel(evaluation.metrics) ||
    hashLabel(recomputed.calibration) !==
      hashLabel(evaluation.calibration) ||
    hashLabel(recomputed.gate) !== hashLabel(evaluation.gate) ||
    evaluation.paired_comparison?.status !== artifact.paired_status ||
    hashLabel(recomputed.paired_champion_metrics) !==
      hashLabel(evaluation.paired_comparison?.champion_metrics ?? null) ||
    hashLabel(recomputed.paired_metric_deltas) !==
      hashLabel(evaluation.paired_comparison?.metric_deltas ?? null)
  ) {
    return {
      valid: false,
      reason: "evaluation_recomputed_summary_mismatch",
    };
  }
  return { valid: true, reason: null, artifact, recomputed };
}

export function evaluationEvidenceMode(observations, outcomeCoverageProviders) {
  const providers = new Set(outcomeCoverageProviders);
  if (providers.size > 0 && [...providers].every((provider) => ["demo", "fixture"].includes(provider))) {
    return "synthetic_replay";
  }
  const retrospectiveEvidence = observations.some((observation) => {
    if (!providers.has(observation.data.ingest_provider)) return false;
    if (observation.data.content.media_type !== "text/plain") return false;
    const attestation = observation.data.availability_attestation;
    return attestation &&
      Date.parse(attestation.available_at) < Date.parse(observation.data.first_seen_at);
  });
  return retrospectiveEvidence ? "archive_replay" : "historical_walk_forward";
}

export async function evaluateWalkForward(store, config, {
  evaluationCutoff = floorHour(new Date()),
  minimumTrainingDays = 14,
} = {}) {
  const cutoff = floorHour(evaluationCutoff);
  const [
    signals,
    outcomes,
    observations,
    assertions,
    challenger,
    champion,
  ] = await Promise.all([
    store.all("normalized_signal", { latestOnly: false }),
    store.all("reset_outcome", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    coverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
    store.readModel("challenger"),
    store.readModel("champion", { invalidAsNull: true }),
  ]);
  const evidenceMode = evaluationEvidenceMode(
    observations,
    config.model.outcome_coverage_providers,
  );
  const coverageAsOfMode = evidenceMode === "synthetic_replay"
    ? COVERAGE_AS_OF_MODE.SYNTHETIC_REPLAY
    : evidenceMode === "archive_replay"
      ? COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY
      : COVERAGE_AS_OF_MODE.LIVE;
  const evaluationCoverageAssertions = adequateCoverageAssertionsAsOf(
    assertions,
    cutoff,
    config.model.outcome_coverage_providers,
    coverageAsOfMode,
  );
  const coverage = normalizeCoverageIntervals(evaluationCoverageAssertions);
  if (coverage.length === 0) {
    throw new EvaluationPendingError(
      "walk_forward_coverage_cutoff_pending",
      {
        evaluation_cutoff: toUtcIso(cutoff),
        accepted_fold_count: 0,
        rejected_fold_count: 0,
        evaluated_windows: 0,
        evaluated_events: 0,
        minimum_evaluation_windows:
          config.model.minimum_live_evaluation_windows,
        minimum_evaluation_events:
          config.model.minimum_live_evaluation_events,
      },
    );
  }
  if (!challenger) throw new Error("No challenger model exists for walk-forward evaluation");
  assertModelCompatibility(challenger, {
    featureNames: FEATURE_NAMES,
    featureSchemaVersion: config.feature_schema_version,
    modelContractHash: modelContractHash(config),
    requireConverged: true,
  });
  const asOfMode = evidenceMode === "synthetic_replay"
    ? AS_OF_MODE.SYNTHETIC_REPLAY
    : asOfModeForEvidence(
      observations,
      config.model.outcome_coverage_providers,
    );
  const extractor = extractorContract(config);
  const confirmationIds = confirmationIdentityIds(config);
  const currentSignals = selectCurrentSignals(latestSignalsAsOf(
    signals,
    cutoff,
    asOfMode,
  ));
  const currentObservations = latestObservationsAsOf(
    observations,
    cutoff,
    asOfMode,
  );
  const outcomeEligibility = buildOutcomeEligibilityContext({
    observations: currentObservations,
    signals: currentSignals,
    config,
  });
  const outcomeCandidates = latestOutcomesAsOf(
    outcomes,
    cutoff,
    asOfMode,
  ).filter((outcome) =>
    outcome.data.status === "confirmed" &&
    outcome.data.occurred_time_range &&
    Date.parse(outcomeAvailableAt(outcome, asOfMode)) <= cutoff.getTime(),
  );
  const evaluationOutcomes = outcomeCandidates.filter((outcome) =>
    isEligibleConfirmedOutcome(outcome, {
      ...outcomeEligibility,
      confirmationIdentityIds: confirmationIds,
    }),
  );
  const ambiguousOutcomes = outcomeCandidates.filter((outcome) =>
    !evaluationOutcomes.includes(outcome),
  );
  const coverageStart = new Date(Math.min(...coverage.map((interval) => Date.parse(interval.start))));
  const coverageEnd = new Date(Math.min(
    cutoff.getTime(),
    Math.max(...coverage.map((interval) => Date.parse(interval.end))),
  ));
  const evaluationLabelCoverageAssertions = evaluationCoverageAssertions
    .filter((assertion) =>
      Date.parse(assertion.start) < coverageEnd.getTime() &&
      Date.parse(assertion.end) > coverageStart.getTime(),
    )
    .sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) || left.revision - right.revision,
    );
  const coverageSnapshotByRef = new Map(
    evaluationLabelCoverageAssertions.map((assertion) => [
      `${assertion.assertion_id}@${assertion.revision}`,
      assertion,
    ]),
  );
  let origin = addHours(floorHour(coverageStart), minimumTrainingDays * 24);
  const folds = [];
  const rejectedFolds = [];
  const foldDispositions = [];
  const allRows = [];
  const allAlertRows = [];
  const eventResults = [];
  const evaluationFailures = [];
  const outcomeSnapshotByRef = new Map(
    outcomeCandidates
      .filter((outcome) =>
        overlaps(origin, coverageEnd, outcome.data.occurred_time_range),
      )
      .map((outcome) => [
      `${outcome.record_id}@${outcome.revision}`,
      {
        record_id: outcome.record_id,
        revision: outcome.revision,
        data_hash: hashLabel(outcome.data),
      },
      ]),
  );
  let pairedStatus = !champion
    ? "not_applicable"
    : champion.model_contract_hash !== modelContractHash(config)
      ? "champion_model_contract_incompatible"
      : champion.training_algorithm_signature !== trainingAlgorithmSignature(config)
        ? "champion_training_policy_incompatible"
      : !compatibleFeatureContract(champion, config)
        ? "champion_model_contract_incompatible"
      : champion.family !== config.model.family
        ? "paired_champion_evaluation_unavailable"
        : "available";
  let burnInReached = false;
  const rejectFold = (foldOrigin, testEnd, reason, details = {}) => {
    const diagnosticHash = hashLabel({ reason, ...details });
    const rejection = {
      origin: toUtcIso(foldOrigin),
      end: toUtcIso(testEnd),
      reason,
      diagnostic_hash: diagnosticHash,
      ...details,
    };
    rejectedFolds.push(rejection);
    foldDispositions.push({
      origin: rejection.origin,
      end: rejection.end,
      status: "rejected",
      reason,
      diagnostic_hash: diagnosticHash,
    });
  };

  while (addHours(origin, 168) <= coverageEnd) {
    const testEnd = addHours(origin, 168);
    const foldCoverage = assessFoldCoverage(origin, testEnd, coverage);
    const allFoldAnchors = foldCoverage.anchors;
    const coveredFoldAnchors = foldCoverage.coveredAnchors;
    const causalTrainingCoverage = adequateCoverageAssertionsAsOf(
      assertions,
      origin,
      config.model.outcome_coverage_providers,
      coverageAsOfMode,
    );
    if (causalTrainingCoverage.length === 0) {
      origin = addHours(origin, 168);
      continue;
    }
    let training;
    try {
      training = await buildTrainingExamples(store, config, {
        trainingCutoff: origin,
        coverageIntervals: coverage,
        coverageAssertionRecords: assertions,
        asOfMode,
        coverageAsOfMode,
      });
    } catch (error) {
      evaluationFailures.push(error);
      if (burnInReached) {
        rejectFold(origin, testEnd, "training_example_build_failed", {
          error_name: error?.name ?? "Error",
          error_message_hash: hashLabel(String(error?.message ?? error)),
        });
      }
      origin = addHours(origin, 168);
      continue;
    }
    if (training.eventCount < config.model.minimum_outcomes) {
      if (burnInReached) {
        rejectFold(origin, testEnd, "post_burn_in_insufficient_outcomes", {
          training_event_count: training.eventCount,
          minimum_outcomes: config.model.minimum_outcomes,
        });
      }
      origin = addHours(origin, 168);
      continue;
    }
    burnInReached = true;
    const foldCoverageSnapshots = new Map(
      training.coverageAssertionSnapshot.map((assertion) => [
        `${assertion.assertion_id}@${assertion.revision}`,
        assertion,
      ]),
    );
    if (!foldCoverage.eligible) {
      rejectFold(origin, testEnd, "incomplete_fold_coverage", {
        required_anchor_count: foldCoverage.requiredAnchorCount,
        covered_anchor_count: foldCoverage.coveredAnchorCount,
        coverage_fraction: foldCoverage.coverageFraction,
      });
      origin = addHours(origin, 168);
      continue;
    }
    let model;
    try {
      model = trainLogisticHazard(training.examples, FEATURE_NAMES, {
        lambda: config.model.lambda,
        initialStep: config.model.learning_rate,
        gradientTolerance: config.model.gradient_tolerance,
        objectiveTolerance: config.model.objective_tolerance,
        hessianStep: config.model.hessian_step,
        maxIterations: config.model.max_iterations,
        coefficientPriors: config.model.coefficient_priors,
      });
    } catch (error) {
      evaluationFailures.push(error);
      rejectFold(origin, testEnd, "challenger_training_failed", {
        error_name: error?.name ?? "Error",
        error_message_hash: hashLabel(String(error?.message ?? error)),
      });
      origin = addHours(origin, 168);
      continue;
    }
    if (!model.converged) {
      evaluationFailures.push(
        new Error(`Walk-forward challenger did not converge: ${model.stop_reason}`),
      );
      rejectFold(origin, testEnd, "challenger_nonconverged", {
        stop_reason: model.stop_reason,
        training_event_count: training.eventCount,
        gradient_norm: model.gradient_norm,
      });
      origin = addHours(origin, 168);
      continue;
    }
    const foldModelVersion = modelVersionFor({
      fitArtifactHash: model.artifact_hash,
      modelContractHash: modelContractHash(config),
      algorithmSignature: trainingAlgorithmSignature(config),
    }).modelVersion.replace("reset-model/", "walk-forward/");
    let pairedChampionModel = null;
    if (pairedStatus === "available") {
      try {
        pairedChampionModel = trainLogisticHazard(
          training.examples,
          FEATURE_NAMES,
          trainingOptionsFromArtifact(champion, config),
        );
        if (!pairedChampionModel.converged) {
          pairedStatus = "paired_champion_evaluation_unavailable";
          pairedChampionModel = null;
        }
      } catch {
        pairedStatus = "paired_champion_evaluation_unavailable";
        pairedChampionModel = null;
      }
    }
    const trainingExposureHours =
      training.negativeCount + training.eventExposureHours;
    const baselineHourly = clamp(
      training.eventCount / Math.max(1, trainingExposureHours),
      1e-6,
      0.25,
    );
    const baseline4h = 1 - (1 - baselineHourly) ** 4;
    const foldRows = [];
    const foldEvents = evaluationOutcomes.filter((outcome) => {
      const eventStart = Date.parse(outcome.data.occurred_time_range.start);
      return origin.getTime() <= eventStart && eventStart < testEnd.getTime();
    });
    const foldAmbiguousOutcomes = ambiguousOutcomes.filter((outcome) =>
      overlaps(origin, testEnd, outcome.data.occurred_time_range),
    );
    const exclusions = sourceExclusions(foldEvents);
    for (const anchor of coveredFoldAnchors) {
      const windowEnd = addHours(anchor, 4);
      const label = causalWindowLabel(
        anchor,
        windowEnd,
        evaluationOutcomes,
        ambiguousOutcomes,
      );
      if (label === null) continue;
      for (const assertion of adequateCoverageAssertionsAsOf(
        assertions,
        anchor,
        config.model.outcome_coverage_providers,
        coverageAsOfMode,
      )) {
        foldCoverageSnapshots.set(
          `${assertion.assertion_id}@${assertion.revision}`,
          assertion,
        );
      }
      const featureRows = Array.from({ length: 4 }, (_, offset) => {
        const target = addHours(anchor, offset);
        return featuresToArray(featureVectorAt({
          targetTime: target,
          knowledgeCutoff: anchor,
          signals,
          outcomes,
          observations,
          coverageIntervals: coverage,
          coverageAssertionRecords: assertions,
          confirmationIdentityIds: confirmationIds,
          expectedExtractor: extractor,
          targetScope: config.target,
          outcomeCoverageProviders: new Set(config.model.outcome_coverage_providers),
          excludedSourceRecordIds: exclusions.recordIds,
          excludedIndependenceGroupIds: exclusions.independenceGroupIds,
          asOfMode,
          coverageAsOfMode,
        }).features);
      });
      const challengerPrediction = rollingPrediction(model, featureRows, {
        anchor,
        signals,
        observations,
        outcomes,
        config,
        asOfMode,
        excludedSourceRecordIds: exclusions.recordIds,
        excludedIndependenceGroupIds: exclusions.independenceGroupIds,
      });
      const championPrediction = pairedChampionModel
        ? rollingPrediction(pairedChampionModel, featureRows, {
            anchor,
            signals,
            observations,
            outcomes,
            config,
            asOfMode,
            excludedSourceRecordIds: exclusions.recordIds,
            excludedIndependenceGroupIds:
              exclusions.independenceGroupIds,
          })
        : null;
      foldRows.push({
        fold_origin: toUtcIso(origin),
        anchor: toUtcIso(anchor),
        window_end: toUtcIso(windowEnd),
        probability: challengerPrediction.probability,
        champion_probability: championPrediction?.probability ?? null,
        baseline_probability: baseline4h,
        features_hash: hashLabel({
          feature_rows: featureRows,
          authority_conditioning: {
            policy_version:
              challengerPrediction.conditioning.policy_version,
            applied: challengerPrediction.conditioning.applied,
            phase: challengerPrediction.conditioning.phase,
            prior_reliability:
              challengerPrediction.conditioning.prior_reliability,
            signal_ref: challengerPrediction.conditioning.signal_ref,
            asserted_time_range:
              challengerPrediction.conditioning.asserted_time_range,
          },
        }),
        label,
      });
    }
    if (foldRows.length === 0) {
      rejectFold(origin, testEnd, "no_scorable_anchors", {
        required_anchor_count: allFoldAnchors.length,
        covered_anchor_count: coveredFoldAnchors.length,
      });
      origin = addHours(origin, 168);
      continue;
    }
    const topCount = config.model.promotion.top_window_hours_per_week;
    if (foldRows.length < topCount) {
      rejectFold(origin, testEnd, "insufficient_scorable_anchors_for_fixed_alert_budget", {
        required_anchor_count: allFoldAnchors.length,
        covered_anchor_count: coveredFoldAnchors.length,
        scorable_anchor_count: foldRows.length,
        coverage_fraction: foldCoverage.coverageFraction,
      });
      origin = addHours(origin, 168);
      continue;
    }
    for (const assertion of foldCoverageSnapshots.values()) {
      coverageSnapshotByRef.set(
        `${assertion.assertion_id}@${assertion.revision}`,
        assertion,
      );
    }
    for (const entry of training.outcomeSnapshot) {
      outcomeSnapshotByRef.set(`${entry.record_id}@${entry.revision}`, entry);
    }
    const alerts = selectFixedBudgetAlerts(foldRows, topCount);
    const ranked = sortByProbability(foldRows);
    const scorableFoldEvents = foldEvents.filter((outcome) => {
      const eventStart = Date.parse(outcome.data.occurred_time_range.start);
      return foldRows.some((row) =>
        Date.parse(row.anchor) < eventStart &&
        overlaps(row.anchor, row.window_end, outcome.data.occurred_time_range),
      );
    });
    for (const outcome of scorableFoldEvents) {
      const eventStart = Date.parse(outcome.data.occurred_time_range.start);
      const eligibleRows = foldRows.filter((row) =>
        Date.parse(row.anchor) < eventStart &&
        overlaps(row.anchor, row.window_end, outcome.data.occurred_time_range),
      );
      const matching = alerts.filter((alert) =>
        Date.parse(alert.anchor) < eventStart &&
        overlaps(alert.anchor, alert.window_end, outcome.data.occurred_time_range),
      );
      const highestPrior = sortByProbability(eligibleRows)[0] ?? null;
      const policyPeak = sortByProbability(
        alerts.filter((alert) => Date.parse(alert.anchor) < eventStart),
      )[0] ?? null;
      const highestPriorRank = highestPrior
        ? ranked.findIndex((row) => row.anchor === highestPrior.anchor) + 1
        : null;
      const leadHours = matching.length === 0
        ? null
        : Math.max(...matching.map((alert) => (eventStart - Date.parse(alert.anchor)) / 3_600_000));
      eventResults.push({
        outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
        occurred_time_range: outcome.data.occurred_time_range,
        fold_origin: toUtcIso(origin),
        hit: matching.length > 0,
        settlement: matching.length > 0 ? "hit" : "miss",
        useful_lead_hours: leadHours,
        maximum_prior_probability: highestPrior?.probability ?? 0,
        highest_prior_rank: highestPriorRank,
        alert_rank_cutoff: Math.min(topCount, ranked.length),
        forecast_issued_at: highestPrior?.anchor ?? toUtcIso(origin),
        ranked_window: highestPrior ? {
          start: highestPrior.anchor,
          end: highestPrior.window_end,
          probability: highestPrior.probability,
        } : null,
        policy_peak_window: policyPeak ? {
          start: policyPeak.anchor,
          end: policyPeak.window_end,
          probability: policyPeak.probability,
        } : null,
        model_version: foldModelVersion,
      });
    }
    const fold = {
      origin: toUtcIso(origin),
      end: toUtcIso(testEnd),
      training_event_count: training.eventCount,
      training_exposure_hours: trainingExposureHours,
      training_data_hash: model.training_data_hash,
      model_version: foldModelVersion,
      evaluated_windows: foldRows.length,
      event_count: scorableFoldEvents.length,
      unscorable_event_count: foldEvents.length - scorableFoldEvents.length,
      censored_ambiguous_outcome_count: foldAmbiguousOutcomes.length,
      top_window_count: topCount,
      selected_alert_count: alerts.length,
      required_anchor_count: allFoldAnchors.length,
      covered_anchor_count: coveredFoldAnchors.length,
      coverage_fraction: foldCoverage.coverageFraction,
      evaluated_window_hash: hashLabel(foldRows),
    };
    folds.push(fold);
    foldDispositions.push({
      origin: fold.origin,
      end: fold.end,
      status: "accepted",
      evaluated_window_hash: fold.evaluated_window_hash,
    });
    allRows.push(...foldRows);
    allAlertRows.push(...alerts);
    origin = addHours(origin, 168);
  }

  if (folds.length === 0) {
    const dispositionSummary = summarizeFoldDispositions(foldDispositions);
    if (evaluationFailures.length > 0) {
      throw new AggregateError(
        evaluationFailures,
        "Walk-forward evaluation failed before any fold could be accepted",
      );
    }
    const waiting = new EvaluationPendingError(
      "walk_forward_fold_pending",
      {
        evaluation_cutoff: toUtcIso(cutoff),
        accepted_fold_count: 0,
        rejected_fold_count: dispositionSummary.rejected_count,
        evaluated_windows: 0,
        evaluated_events: 0,
        minimum_evaluation_windows:
          config.model.minimum_live_evaluation_windows,
        minimum_evaluation_events:
          config.model.minimum_live_evaluation_events,
      },
    );
    await store.writeState("walk-forward-rejections", {
      ...waiting.toJSON(),
      fold_dispositions: foldDispositions,
      ...dispositionSummary,
    });
    throw waiting;
  }
  const brier = mean(allRows.map((row) => (row.probability - row.label) ** 2));
  const baselineBrier = mean(allRows.map((row) => (row.baseline_probability - row.label) ** 2));
  const logLoss = mean(allRows.map((row) => {
    const probability = clamp(row.probability, 1e-12, 1 - 1e-12);
    return -(row.label * Math.log(probability) + (1 - row.label) * Math.log(1 - probability));
  }));
  const eventWindowRecall = eventResults.length === 0
    ? 0
    : eventResults.filter((event) => event.hit).length / eventResults.length;
  const falseAlerts = allAlertRows.filter((row) => row.label === 0).length;
  const legacyThresholdFalseAlerts =
    allRows.filter((row) => row.probability >= 0.5 && row.label === 0).length;
  const usefulLead = median(eventResults.map((event) => event.useful_lead_hours).filter((value) => value !== null));
  const brierSkill = baselineBrier === 0 ? 0 : 1 - brier / baselineBrier;
  const calibrationBuckets = calibration(allRows);
  const expectedCalibrationError = calibrationBuckets.reduce((sum, bucket) =>
    sum + (bucket.count === 0
      ? 0
      : (bucket.count / allRows.length) * Math.abs(bucket.mean_prediction - bucket.observed_rate)), 0);
  const calibrationRegression = calibrationFit(allRows);
  const gate = {
    minimum_event_window_recall: config.model.promotion.minimum_event_window_recall,
    require_brier_skill_above: config.model.promotion.require_brier_skill_above,
    maximum_expected_calibration_error:
      config.model.promotion.maximum_expected_calibration_error,
    event_window_recall_passed:
      eventWindowRecall >= config.model.promotion.minimum_event_window_recall,
    brier_skill_passed: brierSkill > config.model.promotion.require_brier_skill_above,
    calibration_passed:
      expectedCalibrationError <= config.model.promotion.maximum_expected_calibration_error,
    coverage_passed:
      rejectedFolds.every((fold) => fold.reason !== "incomplete_fold_coverage") &&
      folds.every((fold) => fold.coverage_fraction === 1),
    fold_disposition_passed:
      summarizeFoldDispositions(foldDispositions).passed,
    ...assessEvaluationSampleGate({
      evaluated_windows: allRows.length,
      evaluated_events: eventResults.length,
    }, config.model),
  };
  gate.passed = gate.event_window_recall_passed &&
    gate.brier_skill_passed &&
    gate.calibration_passed &&
    gate.coverage_passed &&
    gate.fold_disposition_passed &&
    gate.sample_threshold_passed;
  const modelVersions = [...new Set(
    folds.map((fold) => fold.model_version).filter(Boolean),
  )].sort();
  const evaluationSampleHash = hashLabel(allRows);
  const outcomeSnapshot = [...outcomeSnapshotByRef.values()]
    .sort((left, right) =>
      left.record_id.localeCompare(right.record_id) || left.revision - right.revision,
    );
  const usedCoverageAssertions = [...coverageSnapshotByRef.values()]
    .sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) ||
      left.revision - right.revision,
    );
  const coverageAssertionRefs = usedCoverageAssertions.map((assertion) => ({
    assertion_id: assertion.assertion_id,
    revision: assertion.revision,
  }));
  let pairedChampionMetrics = null;
  let pairedMetricDeltas = null;
  if (
    pairedStatus === "available" &&
    allRows.every((row) => Number.isFinite(row.champion_probability))
  ) {
    const pairedRows = allRows.map((row) => ({
      ...row,
      probability: row.champion_probability,
    }));
    const pairedBuckets = calibration(pairedRows);
    const pairedExpectedCalibrationError = pairedBuckets.reduce((sum, bucket) =>
      sum + (bucket.count === 0
        ? 0
        : (bucket.count / pairedRows.length) *
          Math.abs(bucket.mean_prediction - bucket.observed_rate)), 0);
    pairedChampionMetrics = {
      brier_score: mean(
        pairedRows.map((row) => (row.probability - row.label) ** 2),
      ),
      expected_calibration_error: pairedExpectedCalibrationError,
      log_loss: mean(pairedRows.map((row) => {
        const probability = clamp(row.probability, 1e-12, 1 - 1e-12);
        return -(row.label * Math.log(probability) +
          (1 - row.label) * Math.log(1 - probability));
      })),
    };
    pairedMetricDeltas = {
      brier_score: brier - pairedChampionMetrics.brier_score,
      expected_calibration_error:
        expectedCalibrationError - pairedChampionMetrics.expected_calibration_error,
      log_loss: logLoss - pairedChampionMetrics.log_loss,
    };
  }
  const metrics = {
    evaluated_windows: allRows.length,
    evaluated_events: eventResults.length,
    event_window_recall: eventWindowRecall,
    brier_score: brier,
    baseline_brier_score: baselineBrier,
    brier_skill: brierSkill,
    expected_calibration_error: expectedCalibrationError,
    calibration_intercept: calibrationRegression.intercept,
    calibration_slope: calibrationRegression.slope,
    average_precision: averagePrecision(allRows),
    log_loss: logLoss,
    false_high_probability_alerts: falseAlerts,
    false_high_probability_alerts_by_month:
      falseAlertsByMonth(allAlertRows, -Infinity),
    false_alerts_top_n_policy: falseAlerts,
    false_probability_ge_0_5_windows: legacyThresholdFalseAlerts,
    median_useful_lead_hours: usefulLead,
    median_policy_peak_absolute_error_hours:
      medianPolicyPeakAbsoluteError(eventResults),
  };
  const frozenEvaluationArtifact = {
    artifact_version: FROZEN_EVALUATION_VERSION,
    candidate_artifact_hash: challenger.artifact_hash,
    evaluation_contract_hash: evaluationContractHash(config),
    alert_policy: {
      type: "fixed_top_n_per_fold",
      budget: config.model.promotion.top_window_hours_per_week,
      tie_breaker: "earlier_anchor",
    },
    thresholds: {
      minimum_event_window_recall:
        config.model.promotion.minimum_event_window_recall,
      require_brier_skill_above:
        config.model.promotion.require_brier_skill_above,
      maximum_expected_calibration_error:
        config.model.promotion.maximum_expected_calibration_error,
      minimum_live_evaluation_windows:
        config.model.minimum_live_evaluation_windows,
      minimum_live_evaluation_events:
        config.model.minimum_live_evaluation_events,
    },
    paired_status: pairedStatus,
    rows: allRows,
    alerts: allAlertRows,
    events: eventResults,
    folds,
    fold_dispositions: foldDispositions,
  };
  const recomputedArtifact = recomputeFrozenEvaluationArtifact(
    frozenEvaluationArtifact,
  );
  if (
    hashLabel(recomputedArtifact.metrics) !== hashLabel(metrics) ||
    hashLabel(recomputedArtifact.calibration) !==
      hashLabel(calibrationBuckets) ||
    hashLabel(recomputedArtifact.gate) !== hashLabel(gate) ||
    hashLabel(recomputedArtifact.paired_champion_metrics) !==
      hashLabel(pairedChampionMetrics) ||
    hashLabel(recomputedArtifact.paired_metric_deltas) !==
      hashLabel(pairedMetricDeltas)
  ) {
    throw new Error("Frozen evaluation artifact does not reproduce its summary");
  }
  if (
    typeof store.writeBlob !== "function" ||
    typeof store.readBlob !== "function"
  ) {
    throw new Error("Store cannot persist immutable evaluation artifacts");
  }
  const rowSampleHash = hashLabel(frozenEvaluationArtifact);
  const rowSampleRef = await store.writeBlob(
    "walk-forward-evaluation",
    rowSampleHash,
    frozenEvaluationArtifact,
  );
  const storedEvaluationArtifact = await store.readBlob(rowSampleRef);
  if (hashLabel(storedEvaluationArtifact) !== rowSampleHash) {
    throw new Error("Stored frozen evaluation artifact hash mismatch");
  }
  const summary = {
    evaluation_version: "reset-evaluation/0.3.0",
    mode: "walk_forward",
    evidence_mode: evidenceMode,
    generated_at: new Date().toISOString(),
    evaluation_cutoff: toUtcIso(cutoff),
    outcome_coverage_providers: [...config.model.outcome_coverage_providers],
    folds,
    rejected_folds: rejectedFolds,
    fold_dispositions: foldDispositions,
    provenance: {
      config_hash: config.config_hash,
      model_contract_hash: modelContractHash(config),
      evaluation_contract_hash: evaluationContractHash(config),
      extractor_model: extractor.model,
      extractor_model_version: extractor.model_version,
      extractor_prompt_version: extractor.prompt_version,
      feature_schema_version: config.feature_schema_version,
      deduplication_version: config.deduplication_version,
      taxonomy_version: config.taxonomy_version,
      coverage_assertion_refs: coverageAssertionRefs,
      coverage_assertion_snapshot_hash: hashLabel(usedCoverageAssertions),
      outcome_snapshot_refs: outcomeSnapshot,
      outcome_snapshot_hash: hashLabel(outcomeSnapshot),
      fold_signature: hashLabel(folds),
      fold_disposition_count: foldDispositions.length,
      rejected_fold_count: rejectedFolds.length,
      fold_disposition_hash:
        summarizeFoldDispositions(foldDispositions).disposition_hash,
      row_sample_schema_version: FROZEN_EVALUATION_VERSION,
      row_sample_ref: rowSampleRef,
      row_sample_hash: rowSampleHash,
      model_versions: modelVersions,
      outcome_as_of_mode: asOfMode,
      coverage_as_of_mode: coverageAsOfMode,
    },
    candidate: {
      artifact_hash: challenger.artifact_hash,
      training_data_hash: challenger.training_data_hash,
      model_version: challenger.model_version,
      model_contract_hash: challenger.model_contract_hash,
      algorithm_signature: trainingAlgorithmSignature(config),
      evaluation_sample_hash: evaluationSampleHash,
    },
    alert_policy: {
      type: "fixed_top_n_per_fold",
      budget: config.model.promotion.top_window_hours_per_week,
      tie_breaker: "earlier_anchor",
    },
    paired_comparison: {
      status: pairedStatus,
      method: "same_frozen_folds_retrained_hyperparameter_policy",
      sample_hash: evaluationSampleHash,
      fold_signature: hashLabel(folds),
      challenger_artifact_hash: challenger.artifact_hash,
      champion_artifact_hash: champion?.artifact_hash ?? null,
      champion_metrics: pairedChampionMetrics,
      metric_deltas: pairedMetricDeltas,
    },
    metrics,
    calibration: calibrationBuckets,
    events: eventResults,
    gate,
  };
  summary.evaluation_artifact_hash = evaluationArtifactHash(summary);
  await store.writeState("walk-forward-summary", summary);
  return summary;
}

export async function promoteChallenger(store, evaluation, config) {
  const challenger = await store.readModel("challenger");
  if (!challenger) throw new Error("No challenger model exists");
  const challengerPayload = { ...challenger };
  delete challengerPayload.artifact_hash;
  const incompatible = (reason) => ({
    promoted: false,
    reason,
    model: challenger,
  });
  if (
    typeof evaluation?.evaluation_artifact_hash !== "string" ||
    evaluationArtifactHash(evaluation) !== evaluation.evaluation_artifact_hash
  ) {
    return incompatible("evaluation_artifact_hash_mismatch");
  }
  if (
    evaluation?.evaluation_version !== "reset-evaluation/0.3.0" ||
    evaluation?.candidate?.artifact_hash !== challenger.artifact_hash ||
    evaluation?.candidate?.training_data_hash !== challenger.training_data_hash ||
    evaluation?.candidate?.model_version !== challenger.model_version ||
    evaluation?.candidate?.model_contract_hash !== challenger.model_contract_hash ||
    evaluation?.candidate?.algorithm_signature !== challenger.training_algorithm_signature ||
    sha256(stableStringify(challengerPayload)) !== challenger.artifact_hash
  ) {
    return incompatible("evaluation_challenger_artifact_mismatch");
  }
  const evaluationArtifactVerification =
    await verifyEvaluationArtifact(store, evaluation);
  if (!evaluationArtifactVerification.valid) {
    return incompatible(evaluationArtifactVerification.reason);
  }
  const rowSampleRef = evaluation.provenance?.row_sample_ref;
  const rowSampleHash = evaluation.provenance?.row_sample_hash;
  if (
    evaluation.provenance?.row_sample_schema_version !==
      FROZEN_EVALUATION_VERSION ||
    typeof rowSampleRef !== "string" ||
    typeof rowSampleHash !== "string" ||
    typeof store.readBlob !== "function"
  ) {
    return incompatible("evaluation_row_sample_missing");
  }
  let frozenEvaluationArtifact;
  try {
    frozenEvaluationArtifact = await store.readBlob(rowSampleRef);
  } catch {
    return incompatible("evaluation_row_sample_unavailable");
  }
  if (
    hashLabel(frozenEvaluationArtifact) !== rowSampleHash ||
    frozenEvaluationArtifact.candidate_artifact_hash !==
      challenger.artifact_hash ||
    frozenEvaluationArtifact.evaluation_contract_hash !==
      challenger.evaluation_contract_hash
  ) {
    return incompatible("evaluation_row_sample_hash_mismatch");
  }
  let configuredSampleGate;
  try {
    configuredSampleGate = assessEvaluationSampleGate(
      evaluation.metrics,
      config?.model,
    );
  } catch {
    return incompatible("promotion_sample_threshold_config_invalid");
  }
  if (
    frozenEvaluationArtifact.thresholds?.minimum_live_evaluation_windows !==
      configuredSampleGate.minimum_live_evaluation_windows ||
    frozenEvaluationArtifact.thresholds?.minimum_live_evaluation_events !==
      configuredSampleGate.minimum_live_evaluation_events
  ) {
    return incompatible("evaluation_sample_threshold_mismatch");
  }
  let recomputedEvaluation;
  try {
    recomputedEvaluation = recomputeFrozenEvaluationArtifact(
      frozenEvaluationArtifact,
    );
  } catch {
    return incompatible("evaluation_row_sample_invalid");
  }
  if (
    recomputedEvaluation.evaluation_sample_hash !==
      evaluation.candidate.evaluation_sample_hash ||
    recomputedEvaluation.fold_signature !==
      evaluation.provenance.fold_signature ||
    recomputedEvaluation.fold_disposition_hash !==
      evaluation.provenance.fold_disposition_hash ||
    hashLabel(frozenEvaluationArtifact.folds) !== hashLabel(evaluation.folds) ||
    hashLabel(frozenEvaluationArtifact.fold_dispositions) !==
      hashLabel(evaluation.fold_dispositions) ||
    hashLabel(frozenEvaluationArtifact.events) !== hashLabel(evaluation.events) ||
    hashLabel(recomputedEvaluation.metrics) !== hashLabel(evaluation.metrics) ||
    hashLabel(recomputedEvaluation.calibration) !==
      hashLabel(evaluation.calibration) ||
    hashLabel(recomputedEvaluation.gate) !== hashLabel(evaluation.gate) ||
    evaluation.paired_comparison?.status !==
      frozenEvaluationArtifact.paired_status ||
    hashLabel(recomputedEvaluation.paired_champion_metrics) !==
      hashLabel(evaluation.paired_comparison?.champion_metrics ?? null) ||
    hashLabel(recomputedEvaluation.paired_metric_deltas) !==
      hashLabel(evaluation.paired_comparison?.metric_deltas ?? null)
  ) {
    return incompatible("evaluation_recomputed_summary_mismatch");
  }
  if (!configuredSampleGate.sample_threshold_passed) {
    return {
      promoted: false,
      reason: "evaluation_sample_threshold_not_met",
      model: challenger,
      sample_gate: configuredSampleGate,
    };
  }
  const expectedOutcomeAsOfMode =
    evaluation.evidence_mode === "archive_replay"
      ? AS_OF_MODE.ARCHIVE_REPLAY
      : evaluation.evidence_mode === "synthetic_replay"
        ? AS_OF_MODE.SYNTHETIC_REPLAY
        : AS_OF_MODE.LIVE;
  const expectedCoverageAsOfMode =
    evaluation.evidence_mode === "archive_replay"
      ? COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY
      : evaluation.evidence_mode === "synthetic_replay"
        ? COVERAGE_AS_OF_MODE.SYNTHETIC_REPLAY
        : COVERAGE_AS_OF_MODE.LIVE;
  if (
    challenger.converged !== true ||
    evaluation.provenance?.model_contract_hash !== challenger.model_contract_hash ||
    evaluation.provenance?.evaluation_contract_hash !==
      challenger.evaluation_contract_hash ||
    evaluation.provenance?.extractor_model !== challenger.extractor_model ||
    evaluation.provenance?.extractor_model_version !== challenger.extractor_model_version ||
    evaluation.provenance?.extractor_prompt_version !== challenger.extractor_prompt_version ||
    evaluation.provenance?.feature_schema_version !== challenger.feature_schema_version ||
    evaluation.provenance?.taxonomy_version !== challenger.taxonomy_version ||
    evaluation.provenance?.deduplication_version !== challenger.deduplication_version ||
    !Object.values(AS_OF_MODE).includes(evaluation.provenance?.outcome_as_of_mode) ||
    !Object.values(COVERAGE_AS_OF_MODE).includes(
      evaluation.provenance?.coverage_as_of_mode,
    ) ||
    evaluation.provenance.outcome_as_of_mode !== expectedOutcomeAsOfMode ||
    evaluation.provenance.coverage_as_of_mode !== expectedCoverageAsOfMode
  ) {
    return incompatible("evaluation_model_contract_mismatch");
  }
  if (
    evaluation.provenance?.fold_signature !== hashLabel(evaluation.folds) ||
    evaluation.paired_comparison?.fold_signature !== evaluation.provenance.fold_signature ||
    evaluation.paired_comparison?.sample_hash !== evaluation.candidate.evaluation_sample_hash ||
    evaluation.paired_comparison?.challenger_artifact_hash !== challenger.artifact_hash
  ) {
    return incompatible("evaluation_frozen_fold_mismatch");
  }
  const allCoverageAssertions = typeof store.allAudit === "function"
    ? await store.allAudit("coverage_assertion")
    : await coverageAssertions(store, evaluation.outcome_coverage_providers);
  const latestCoverageById = new Map();
  for (const assertion of allCoverageAssertions) {
    const previous = latestCoverageById.get(assertion.assertion_id);
    if (!previous || assertion.revision > previous.revision) {
      latestCoverageById.set(assertion.assertion_id, assertion);
    }
  }
  const referencedCoverageAssertions = [];
  for (const ref of evaluation.provenance.coverage_assertion_refs ?? []) {
    const exact = allCoverageAssertions.find((assertion) =>
      assertion.assertion_id === ref.assertion_id && assertion.revision === ref.revision,
    );
    if (!exact) return incompatible("evaluation_coverage_assertion_missing");
    if (
      exact.mode === "authoritative_daily_tibo_ledger" &&
      !(await verifyCoverageAssertionEvidence(
        store,
        exact,
        { config },
      )).valid
    ) {
      return incompatible("evaluation_coverage_assertion_contract_mismatch");
    }
    referencedCoverageAssertions.push(exact);
  }
  const maximumReferencedCoverageRevision = new Map();
  for (const ref of evaluation.provenance.coverage_assertion_refs ?? []) {
    maximumReferencedCoverageRevision.set(
      ref.assertion_id,
      Math.max(maximumReferencedCoverageRevision.get(ref.assertion_id) ?? 0, ref.revision),
    );
  }
  for (const [assertionId, revision] of maximumReferencedCoverageRevision) {
    const latest = latestCoverageById.get(assertionId);
    if (
      latest?.revision !== revision ||
      latest.adequacy !== "negative_label_eligible" ||
      latest.revoked === true
    ) {
      return incompatible("evaluation_coverage_assertion_superseded");
    }
  }
  referencedCoverageAssertions.sort((left, right) =>
    left.assertion_id.localeCompare(right.assertion_id) || left.revision - right.revision,
  );
  if (
    evaluation.provenance.coverage_assertion_snapshot_hash !==
    hashLabel(referencedCoverageAssertions)
  ) {
    return incompatible("evaluation_coverage_assertions_changed");
  }
  const outcomeSnapshot = evaluation.provenance.outcome_snapshot_refs;
  if (
    !Array.isArray(outcomeSnapshot) ||
    evaluation.provenance.outcome_snapshot_hash !== hashLabel(outcomeSnapshot)
  ) {
    return incompatible("evaluation_outcome_snapshot_mismatch");
  }
  const allOutcomeRevisions = await store.all("reset_outcome", { latestOnly: false });
  const latestOutcomeById = new Map();
  for (const outcome of allOutcomeRevisions) {
    const previous = latestOutcomeById.get(outcome.record_id);
    if (!previous || outcome.revision > previous.revision) {
      latestOutcomeById.set(outcome.record_id, outcome);
    }
  }
  const maximumReferencedOutcomeRevision = new Map();
  for (const entry of outcomeSnapshot) {
    const exact = allOutcomeRevisions.find((outcome) =>
      outcome.record_id === entry.record_id && outcome.revision === entry.revision,
    );
    if (!exact || hashLabel(exact.data) !== entry.data_hash) {
      return incompatible("evaluation_outcome_revision_changed");
    }
    maximumReferencedOutcomeRevision.set(
      entry.record_id,
      Math.max(maximumReferencedOutcomeRevision.get(entry.record_id) ?? 0, entry.revision),
    );
  }
  for (const [recordId, revision] of maximumReferencedOutcomeRevision) {
    if (latestOutcomeById.get(recordId)?.revision !== revision) {
      return incompatible("evaluation_outcome_revision_superseded");
    }
  }
  const maximumFoldEnd = Math.max(...evaluation.folds.map((fold) => Date.parse(fold.end)));
  const outcomesAvailableAtEvaluation = latestOutcomesAsOf(
    allOutcomeRevisions,
    evaluation.evaluation_cutoff,
    evaluation.provenance.outcome_as_of_mode,
  ).filter((outcome) =>
    outcome.data.status === "confirmed" &&
    outcome.data.occurred_time_range &&
    Date.parse(outcome.data.occurred_time_range.start) < maximumFoldEnd,
  );
  const snapshotKeys = new Set(
    outcomeSnapshot.map((entry) => `${entry.record_id}@${entry.revision}`),
  );
  if (outcomesAvailableAtEvaluation.some((outcome) =>
    !snapshotKeys.has(`${outcome.record_id}@${outcome.revision}`),
  )) {
    return incompatible("evaluation_outcome_snapshot_incomplete");
  }
  if (!evaluation.gate.passed) {
    return { promoted: false, reason: "evaluation_gate_failed", model: challenger };
  }
  const champion = await store.readModel("champion", { invalidAsNull: true });
  const boundEvaluation = structuredClone(evaluation);
  if (champion) {
    const modelContractChanged =
      champion.model_contract_hash !== challenger.model_contract_hash;
    const trainingPolicyChanged =
      champion.training_algorithm_signature !== challenger.training_algorithm_signature;
    if (modelContractChanged || trainingPolicyChanged) {
      const expectedStatus = trainingPolicyChanged && !modelContractChanged
        ? "champion_training_policy_incompatible"
        : "champion_model_contract_incompatible";
      if (
        evaluation.paired_comparison.status !== expectedStatus ||
        evaluation.paired_comparison.champion_artifact_hash !== champion.artifact_hash
      ) {
        return incompatible("evaluation_champion_contract_mismatch");
      }
      return {
        ...incompatible("explicit_migration_required"),
        migration: {
          model_contract_changed: modelContractChanged,
          training_policy_changed: trainingPolicyChanged,
          bridge_evaluation_available: false,
        },
      };
    } else {
      const paired = evaluation.paired_comparison;
      if (
        paired.status !== "available" ||
        paired.champion_artifact_hash !== champion.artifact_hash ||
        !paired.champion_metrics ||
        !paired.metric_deltas
      ) {
        return incompatible("paired_champion_evaluation_unavailable");
      }
      if (
        paired.metric_deltas.brier_score >
        PAIRED_NON_REGRESSION_TOLERANCE
      ) {
        return {
          ...incompatible("challenger_refit_regressed_brier"),
          paired_delta: paired.metric_deltas,
        };
      }
      if (
        paired.metric_deltas.expected_calibration_error >
        PAIRED_NON_REGRESSION_TOLERANCE
      ) {
        return {
          ...incompatible("challenger_refit_regressed_calibration"),
          paired_delta: paired.metric_deltas,
        };
      }
    }
  }
  const promoted = {
    ...challenger,
    promoted_at: new Date().toISOString(),
    promotion_evaluation: {
      event_window_recall: evaluation.metrics.event_window_recall,
      brier_score: evaluation.metrics.brier_score,
      brier_skill: evaluation.metrics.brier_skill,
      expected_calibration_error: evaluation.metrics.expected_calibration_error,
      challenger_artifact_hash: challenger.artifact_hash,
      fold_signature: evaluation.provenance.fold_signature,
      evaluation_sample_hash: evaluation.candidate.evaluation_sample_hash,
      paired_metric_deltas: boundEvaluation.paired_comparison.metric_deltas,
    },
  };
  await store.writeModel("champion", promoted);
  await store.writeState("champion-evaluation", boundEvaluation);
  return {
    promoted: true,
    reason: !champion
      ? "evaluation_gate_passed"
      : evaluation.paired_comparison.status === "available"
        ? "champion_refit_refreshed"
        : "evaluation_gate_passed",
    model: promoted,
  };
}
