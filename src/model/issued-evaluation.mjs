import { addHours, clamp, floorHour, toUtcIso } from "../core/time.mjs";
import { latestRevisionsAsOf } from "../core/revisions.mjs";
import { hashLabel } from "../core/hash.mjs";
import { normalizeCoverageIntervals } from "../pipeline/coverage.mjs";
import {
  averagePrecision,
  calibrationFit,
  falseAlertsByMonth,
  medianPolicyPeakAbsoluteError,
} from "./diagnostics.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  modelContractHash,
} from "./contract.mjs";
import { extractorContract } from "../core/extractor-contract.mjs";
import {
  AS_OF_MODE,
  latestObservationsAsOf,
  latestOutcomesAsOf,
  latestSignalsAsOf,
} from "./as-of.mjs";
import {
  COVERAGE_AS_OF_MODE,
  adequateCoverageAssertionsAsOf,
  coverageAssertionRevisions,
} from "./coverage-as-of.mjs";
import {
  MODEL_VERSION_PREFIX,
  modelReleaseFromVersion,
} from "./model-version.mjs";

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function overlaps(start, end, range) {
  return Date.parse(start) < Date.parse(range.end) && Date.parse(end) > Date.parse(range.start);
}

function covered(start, end, intervals) {
  return intervals.some((interval) =>
    Date.parse(interval.start) <= Date.parse(start) && Date.parse(interval.end) >= Date.parse(end),
  );
}

function calibration(rows) {
  return Array.from({ length: 10 }, (_, index) => {
    const values = rows.filter((row) =>
      row.probability >= index / 10 &&
      (index === 9 ? row.probability <= 1 : row.probability < (index + 1) / 10),
    );
    return {
      lower: index / 10,
      upper: (index + 1) / 10,
      count: values.length,
      mean_prediction: mean(values.map((row) => row.probability)),
      observed_rate: mean(values.map((row) => row.label)),
    };
  });
}

function weekKey(value) {
  const date = floorHour(value);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function coveredHoursBefore(cutoff, intervals, maximumDays) {
  const end = Date.parse(cutoff);
  const start = end - maximumDays * 24 * 3_600_000;
  return intervals.reduce((sum, interval) => {
    const overlapStart = Math.max(start, Date.parse(interval.start));
    const overlapEnd = Math.min(end, Date.parse(interval.end));
    return sum + Math.max(0, overlapEnd - overlapStart) / 3_600_000;
  }, 0);
}

export function baselineOutcomesAt(
  outcomes,
  knowledgeCutoff,
  coverageIntervals,
  maximumTrainingDays,
) {
  const riskWindowEnd = Date.parse(knowledgeCutoff);
  const riskWindowStart = riskWindowEnd -
    maximumTrainingDays * 24 * 3_600_000;
  return outcomes.filter((outcome) =>
    Date.parse(outcome.data.known_at) <= riskWindowEnd &&
    Date.parse(outcome.data.occurred_time_range.start) >= riskWindowStart &&
    Date.parse(outcome.data.occurred_time_range.end) <= riskWindowEnd &&
    covered(
      outcome.data.occurred_time_range.start,
      outcome.data.occurred_time_range.end,
      coverageIntervals,
    ),
  );
}

export function selectLatestPredictionPerWindow(predictions) {
  const selectedByWindow = new Map();
  const excluded = [];
  for (const prediction of predictions) {
    if (prediction.data.slots.length < 4) continue;
    const windowStart = prediction.data.slots[0].start;
    if (Date.parse(prediction.data.issued_at) > Date.parse(windowStart)) continue;
    const previous = selectedByWindow.get(windowStart);
    const shouldReplace = !previous ||
      prediction.data.issued_at > previous.data.issued_at ||
      (
        prediction.data.issued_at === previous.data.issued_at &&
        prediction.record_id.localeCompare(previous.record_id) < 0
      );
    if (shouldReplace) {
      if (previous) excluded.push(previous);
      selectedByWindow.set(windowStart, prediction);
    } else {
      excluded.push(prediction);
    }
  }
  return {
    selected: [...selectedByWindow.values()]
      .sort((left, right) =>
        left.data.slots[0].start.localeCompare(right.data.slots[0].start),
      ),
    excluded: excluded.sort((left, right) =>
      left.data.slots[0].start.localeCompare(right.data.slots[0].start) ||
      left.data.issued_at.localeCompare(right.data.issued_at) ||
      left.record_id.localeCompare(right.record_id),
    ),
  };
}

const FROZEN_ISSUED_EVALUATION_VERSION =
  "reset-issued-evaluation-rows/0.1.0";

function fixedPolicyAlerts(rows, budget) {
  const alerts = [];
  for (const weekRows of Map.groupBy(
    rows,
    (row) => weekKey(row.window_start),
  ).values()) {
    alerts.push(...[...weekRows]
      .sort((left, right) =>
        right.probability - left.probability ||
        left.window_start.localeCompare(right.window_start)
      )
      .slice(0, Math.min(budget, weekRows.length)));
  }
  return alerts;
}

function fixedPolicyAlertEpisodeCounts(alerts) {
  const episodes = [];
  for (const row of [...alerts].sort((left, right) =>
    left.window_start.localeCompare(right.window_start) ||
    left.window_end.localeCompare(right.window_end)
  )) {
    const previous = episodes.at(-1);
    if (
      previous &&
      Date.parse(row.window_start) < Date.parse(previous.end)
    ) {
      if (Date.parse(row.window_end) > Date.parse(previous.end)) {
        previous.end = row.window_end;
      }
      previous.has_event ||= row.label === 1;
      continue;
    }
    episodes.push({
      start: row.window_start,
      end: row.window_end,
      has_event: row.label === 1,
    });
  }
  return {
    selected: episodes.length,
    non_event: episodes.filter((episode) => !episode.has_event).length,
  };
}

const ISSUED_EVENT_SCORE_FIELDS = [
  "hit",
  "settlement",
  "useful_lead_hours",
  "maximum_prior_probability",
  "forecast_issued_at",
  "ranked_window",
  "policy_peak_window",
  "model_version",
  "prediction_refs",
];

function scoreIssuedEvent(event, rows, alerts) {
  const eventStart = Date.parse(event.occurred_time_range?.start);
  if (!Number.isFinite(eventStart)) {
    throw new Error("Frozen issued event time is invalid");
  }
  const matchingRows = rows.filter((row) =>
    Date.parse(row.window_start) < eventStart &&
    overlaps(
      row.window_start,
      row.window_end,
      event.occurred_time_range,
    )
  );
  const matchingAlerts = alerts.filter((row) =>
    Date.parse(row.window_start) < eventStart &&
    overlaps(
      row.window_start,
      row.window_end,
      event.occurred_time_range,
    )
  );
  const highestPrior = [...matchingRows]
    .sort((left, right) =>
      right.probability - left.probability ||
      left.window_start.localeCompare(right.window_start)
    )[0] ?? null;
  const policyPeak = [...alerts]
    .filter((row) =>
      weekKey(row.window_start) ===
        weekKey(event.occurred_time_range.start) &&
      Date.parse(row.window_start) < eventStart
    )
    .sort((left, right) =>
      right.probability - left.probability ||
      left.window_start.localeCompare(right.window_start)
    )[0] ?? null;
  return {
    ...event,
    hit: matchingAlerts.length > 0,
    settlement: matchingAlerts.length > 0 ? "hit" : "miss",
    useful_lead_hours: matchingAlerts.length === 0
      ? null
      : Math.max(...matchingAlerts.map((row) =>
        (eventStart - Date.parse(row.window_start)) / 3_600_000
      )),
    maximum_prior_probability: highestPrior?.probability ?? 0,
    forecast_issued_at: highestPrior?.issued_at ?? null,
    ranked_window: highestPrior ? {
      start: highestPrior.window_start,
      end: highestPrior.window_end,
      probability: highestPrior.probability,
    } : null,
    policy_peak_window: policyPeak ? {
      start: policyPeak.window_start,
      end: policyPeak.window_end,
      probability: policyPeak.probability,
    } : null,
    model_version: highestPrior?.model_version ?? null,
    prediction_refs: matchingRows.map((row) => row.prediction_ref),
  };
}

export function recomputeFrozenIssuedEvaluationArtifact(artifact) {
  if (artifact?.artifact_version !== FROZEN_ISSUED_EVALUATION_VERSION) {
    throw new Error("Unsupported frozen issued evaluation artifact version");
  }
  if (
    !Array.isArray(artifact.rows) ||
    !Array.isArray(artifact.alerts) ||
    !Array.isArray(artifact.events) ||
    artifact.rows.length === 0
  ) {
    throw new Error("Frozen issued evaluation artifact is incomplete");
  }
  const budget = artifact.alert_policy?.budget;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error("Frozen issued evaluation alert budget is invalid");
  }
  const expectedAlerts = fixedPolicyAlerts(artifact.rows, budget);
  if (hashLabel(expectedAlerts) !== hashLabel(artifact.alerts)) {
    throw new Error("Frozen issued alerts do not match the fixed policy");
  }
  const events = artifact.events.map((event) => {
    const expectedEvent = scoreIssuedEvent(
      event,
      artifact.rows,
      artifact.alerts,
    );
    const expected = Object.fromEntries(
      ISSUED_EVENT_SCORE_FIELDS.map((key) => [key, expectedEvent[key] ?? null]),
    );
    const actual = Object.fromEntries(
      ISSUED_EVENT_SCORE_FIELDS.map((key) => [key, event[key] ?? null]),
    );
    if (hashLabel(actual) !== hashLabel(expected)) {
      throw new Error(
        "Frozen issued event does not match rows and fixed alerts",
      );
    }
    return expectedEvent;
  });
  const rows = artifact.rows;
  const brier = mean(rows.map((row) => (row.probability - row.label) ** 2));
  const baselineBrier = mean(
    rows.map((row) => (row.baseline_probability - row.label) ** 2),
  );
  const brierSkill = baselineBrier === 0 ? 0 : 1 - brier / baselineBrier;
  const buckets = calibration(rows);
  const expectedCalibrationError = buckets.reduce((sum, bucket) =>
    sum + (bucket.count === 0
      ? 0
      : (bucket.count / rows.length) *
        Math.abs(bucket.mean_prediction - bucket.observed_rate)), 0);
  const eventWindowRecall = events.length === 0
    ? null
    : events.filter((event) => event.hit).length / events.length;
  const regression = calibrationFit(rows);
  const falseAlerts = artifact.alerts.filter((row) => row.label === 0).length;
  const metrics = {
    evaluated_windows: rows.length,
    duplicate_issued_predictions_excluded:
      artifact.duplicate_predictions_excluded_count,
    evaluated_events: events.length,
    event_window_recall: eventWindowRecall,
    brier_score: brier,
    baseline_brier_score: baselineBrier,
    brier_skill: brierSkill,
    expected_calibration_error: expectedCalibrationError,
    calibration_intercept: regression.intercept,
    calibration_slope: regression.slope,
    average_precision: averagePrecision(rows),
    log_loss: mean(rows.map((row) => {
      const probability = clamp(row.probability, 1e-12, 1 - 1e-12);
      return -(row.label * Math.log(probability) +
        (1 - row.label) * Math.log(1 - probability));
    })),
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
  const gate = {
    minimum_event_window_recall: thresholds.minimum_event_window_recall,
    require_brier_skill_above: thresholds.require_brier_skill_above,
    maximum_expected_calibration_error:
      thresholds.maximum_expected_calibration_error,
    event_window_recall_passed:
      eventWindowRecall !== null &&
      eventWindowRecall >= thresholds.minimum_event_window_recall,
    brier_skill_passed:
      brierSkill > thresholds.require_brier_skill_above,
    calibration_passed:
      expectedCalibrationError <=
        thresholds.maximum_expected_calibration_error,
  };
  gate.passed = gate.event_window_recall_passed &&
    gate.brier_skill_passed &&
    gate.calibration_passed;
  return {
    metrics,
    calibration: buckets,
    events,
    gate,
    row_content_hash: hashLabel(rows),
  };
}

export function buildIssuedEvaluationReportingView(artifact, {
  modelRelease = MODEL_VERSION_PREFIX,
  sourceEvaluationArtifactHash = null,
} = {}) {
  if (artifact?.artifact_version !== FROZEN_ISSUED_EVALUATION_VERSION) {
    throw new Error("Unsupported frozen issued evaluation artifact version");
  }
  const budget = artifact.alert_policy?.budget;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error("Frozen issued evaluation alert budget is invalid");
  }
  const rows = (artifact.rows ?? []).filter((row) =>
    modelReleaseFromVersion(row.model_version) === modelRelease
  );
  if (rows.length === 0) {
    return {
      status: "waiting_for_mature_rows",
      scope: "current_model_release",
      model_release: modelRelease,
      source_evaluation_artifact_hash: sourceEvaluationArtifactHash,
    };
  }
  const alerts = fixedPolicyAlerts(rows, budget);
  const eventSeeds = (artifact.events ?? []).filter((event) =>
    rows.some((row) => overlaps(
      row.window_start,
      row.window_end,
      event.occurred_time_range,
    ))
  );
  const events = eventSeeds.map((event) =>
    scoreIssuedEvent(event, rows, alerts)
  );
  const cohortArtifact = {
    ...artifact,
    duplicate_predictions_excluded_count: null,
    rows,
    alerts,
    events,
  };
  const recomputed = recomputeFrozenIssuedEvaluationArtifact(cohortArtifact);
  const alertEpisodes = fixedPolicyAlertEpisodeCounts(alerts);
  return {
    status: "available",
    scope: "current_model_release",
    model_release: modelRelease,
    model_versions: [...new Set(rows.map((row) => row.model_version))].sort(),
    source_evaluation_artifact_hash: sourceEvaluationArtifactHash,
    metrics: recomputed.metrics,
    calibration: recomputed.calibration,
    events: recomputed.events,
    false_alerts: {
      probability_threshold: 0.5,
      high_probability_non_event_windows:
        recomputed.metrics.false_probability_ge_0_5_windows,
      policy_selected_non_event_windows:
        recomputed.metrics.false_alerts_top_n_policy,
      policy_selected_episodes: alertEpisodes.selected,
      policy_selected_non_event_episodes: alertEpisodes.non_event,
    },
    audit_context: {
      all_history_evaluated_windows: artifact.rows.length,
      all_history_evaluated_events: artifact.events.length,
      excluded_earlier_release_windows: artifact.rows.length - rows.length,
      excluded_earlier_release_events: artifact.events.length - events.length,
    },
  };
}

export async function verifyIssuedEvaluationArtifact(store, evaluation) {
  if (
    evaluation?.evaluation_version !==
      "reset-issued-evaluation/0.3.0" ||
    evaluationArtifactHash(evaluation) !==
      evaluation?.evaluation_artifact_hash
  ) {
    return {
      valid: false,
      reason: "evaluation_artifact_hash_mismatch",
    };
  }
  const provenance = evaluation.provenance ?? {};
  if (
    provenance.row_sample_schema_version !==
      FROZEN_ISSUED_EVALUATION_VERSION ||
    typeof provenance.row_sample_ref !== "string" ||
    typeof provenance.row_sample_hash !== "string" ||
    typeof store.readBlob !== "function"
  ) {
    return { valid: false, reason: "evaluation_row_sample_missing" };
  }
  let artifact;
  try {
    artifact = await store.readBlob(provenance.row_sample_ref);
  } catch {
    return { valid: false, reason: "evaluation_row_sample_unavailable" };
  }
  if (
    hashLabel(artifact) !== provenance.row_sample_hash ||
    artifact.evaluation_contract_hash !==
      provenance.evaluation_contract_hash
  ) {
    return {
      valid: false,
      reason: "evaluation_row_sample_hash_mismatch",
    };
  }
  let recomputed;
  try {
    recomputed = recomputeFrozenIssuedEvaluationArtifact(artifact);
  } catch {
    return { valid: false, reason: "evaluation_row_sample_invalid" };
  }
  if (
    hashLabel(recomputed.metrics) !== hashLabel(evaluation.metrics) ||
    hashLabel(recomputed.calibration) !== hashLabel(evaluation.calibration) ||
    hashLabel(recomputed.events) !== hashLabel(evaluation.events) ||
    hashLabel(recomputed.gate) !== hashLabel(evaluation.gate)
  ) {
    return {
      valid: false,
      reason: "evaluation_recomputed_summary_mismatch",
    };
  }
  return { valid: true, reason: null, artifact, recomputed };
}

export async function evaluateIssuedForecasts(store, config, {
  evaluationCutoff = floorHour(new Date()),
} = {}) {
  const cutoff = floorHour(evaluationCutoff);
  const extractor = extractorContract(config);
  const [
    predictions,
    outcomeRevisions,
    signals,
    observations,
    assertions,
    settlements,
  ] = await Promise.all([
    store.all("prediction", { latestOnly: false }),
    store.all("reset_outcome", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    coverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
    store.all("prediction_settlement", { latestOnly: false }),
  ]);
  const currentPredictions = latestRevisionsAsOf(
    predictions,
    cutoff,
    (prediction) => prediction.data.issued_at,
  );
  const predictionSelection = selectLatestPredictionPerWindow(currentPredictions);
  const currentSettlements = latestRevisionsAsOf(
    settlements,
    cutoff,
    (settlement) => settlement.data.settled_at,
  );
  const settlementByPrediction = new Map(
    currentSettlements.map((settlement) => [
      settlement.data.prediction_ref.record_id,
      settlement,
    ]),
  );
  const currentSignals = selectCurrentSignals(latestSignalsAsOf(
    signals,
    cutoff,
    AS_OF_MODE.LIVE,
  ));
  const currentObservations = latestObservationsAsOf(
    observations,
    cutoff,
    AS_OF_MODE.LIVE,
  );
  const outcomeEligibility = buildOutcomeEligibilityContext({
    observations: currentObservations,
    signals: currentSignals,
    config,
  });
  const confirmationIds = confirmationIdentityIds(config);
  const outcomeCandidates = latestOutcomesAsOf(
    outcomeRevisions,
    cutoff,
    AS_OF_MODE.LIVE,
  ).filter((outcome) =>
    outcome.data.status === "confirmed" && outcome.data.occurred_time_range,
  );
  const outcomes = outcomeCandidates.filter((outcome) =>
    isEligibleConfirmedOutcome(outcome, {
      ...outcomeEligibility,
      confirmationIdentityIds: confirmationIds,
    }),
  );
  const ambiguousOutcomes = outcomeCandidates.filter((outcome) =>
    !outcomes.includes(outcome),
  );
  const rows = [];
  const baselineCoverageSnapshotByRef = new Map();
  const settlementCoverageSnapshotByRef = new Map();
  const baselineOutcomeSnapshotByRef = new Map();
  for (const prediction of predictionSelection.selected) {
    const windowStart = prediction.data.slots[0].start;
    const windowEnd = prediction.data.slots[3].end;
    const settlement = settlementByPrediction.get(prediction.record_id);
    if (!settlement || !["positive", "negative"].includes(settlement.data.status)) continue;
    const settlementCoverageAssertions = (
      settlement.data.coverage_assertion_refs ?? []
    ).map((ref) => assertions.find((assertion) =>
      assertion.assertion_id === ref.assertion_id &&
      assertion.revision === ref.revision
    )).filter(Boolean).sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) ||
      left.revision - right.revision,
    );
    if (
      settlementCoverageAssertions.length !==
        (settlement.data.coverage_assertion_refs ?? []).length ||
      settlement.data.coverage_assertion_snapshot_hash !==
        hashLabel(settlementCoverageAssertions)
    ) {
      continue;
    }
    if (
      settlement.data.status === "negative" &&
      (
        settlement.data.coverage?.complete !== true ||
        !covered(
          windowStart,
          windowEnd,
          normalizeCoverageIntervals(settlementCoverageAssertions),
        )
      )
    ) {
      continue;
    }
    for (const assertion of settlementCoverageAssertions) {
      settlementCoverageSnapshotByRef.set(
        `${assertion.assertion_id}@${assertion.revision}`,
        assertion,
      );
    }
    if (ambiguousOutcomes.some((outcome) =>
      overlaps(windowStart, windowEnd, outcome.data.occurred_time_range),
    )) {
      continue;
    }
    if (
      settlement.data.status === "positive" &&
      !outcomes.some((outcome) =>
        overlaps(windowStart, windowEnd, outcome.data.occurred_time_range),
      )
    ) {
      continue;
    }
    if (outcomes.some((outcome) => {
      const eventStart = Date.parse(outcome.data.occurred_time_range.start);
      return eventStart <= Date.parse(windowStart) &&
        Date.parse(windowStart) < Date.parse(outcome.data.occurred_time_range.end);
    })) {
      continue;
    }
    const baselineWindowStart = Date.parse(prediction.data.knowledge_cutoff) -
      config.model.maximum_training_days * 24 * 3_600_000;
    const baselineCoverageAssertions = adequateCoverageAssertionsAsOf(
      assertions,
      prediction.data.knowledge_cutoff,
      config.model.outcome_coverage_providers,
      COVERAGE_AS_OF_MODE.LIVE,
    ).filter((assertion) =>
      Date.parse(assertion.start) < Date.parse(prediction.data.knowledge_cutoff) &&
      Date.parse(assertion.end) > baselineWindowStart,
    ).sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) ||
      left.revision - right.revision,
    );
    const baselineCoverage = normalizeCoverageIntervals(
      baselineCoverageAssertions,
    );
    for (const assertion of baselineCoverageAssertions) {
      baselineCoverageSnapshotByRef.set(
        `${assertion.assertion_id}@${assertion.revision}`,
        assertion,
      );
    }
    const baselineSignals = selectCurrentSignals(latestSignalsAsOf(
      signals,
      prediction.data.knowledge_cutoff,
      AS_OF_MODE.LIVE,
    ));
    const baselineObservations = latestObservationsAsOf(
      observations,
      prediction.data.knowledge_cutoff,
      AS_OF_MODE.LIVE,
    );
    const baselineEligibility = buildOutcomeEligibilityContext({
      observations: baselineObservations,
      signals: baselineSignals,
      config,
    });
    const baselineOutcomeCandidates = latestOutcomesAsOf(
      outcomeRevisions,
      prediction.data.knowledge_cutoff,
      AS_OF_MODE.LIVE,
    ).filter((outcome) =>
      outcome.data.status === "confirmed" &&
      outcome.data.occurred_time_range &&
      isEligibleConfirmedOutcome(outcome, {
        ...baselineEligibility,
        confirmationIdentityIds: confirmationIds,
      }),
    );
    const priorOutcomes = baselineOutcomesAt(
      baselineOutcomeCandidates,
      prediction.data.knowledge_cutoff,
      baselineCoverage,
      config.model.maximum_training_days,
    );
    const baselineOutcomeSnapshot = baselineOutcomeCandidates
      .map((outcome) => ({
        record_id: outcome.record_id,
        revision: outcome.revision,
        data_hash: hashLabel(outcome.data),
      }))
      .sort((left, right) =>
        left.record_id.localeCompare(right.record_id) ||
        left.revision - right.revision,
      );
    for (const entry of baselineOutcomeSnapshot) {
      baselineOutcomeSnapshotByRef.set(
        `${entry.record_id}@${entry.revision}`,
        entry,
      );
    }
    const coveredHours = coveredHoursBefore(
      prediction.data.knowledge_cutoff,
      baselineCoverage,
      config.model.maximum_training_days,
    );
    const baselineHourly = clamp(priorOutcomes.length / Math.max(1, coveredHours), 1e-6, 0.25);
    rows.push({
      prediction_ref: { record_id: prediction.record_id, revision: prediction.revision },
      settlement_ref: { record_id: settlement.record_id, revision: settlement.revision },
      issued_at: prediction.data.issued_at,
      knowledge_cutoff: prediction.data.knowledge_cutoff,
      window_start: windowStart,
      window_end: windowEnd,
      probability: prediction.data.slots[0].rolling_4h_probability,
      baseline_probability: 1 - (1 - baselineHourly) ** 4,
      baseline_coverage_assertion_refs: baselineCoverageAssertions.map(
        (assertion) => ({
          assertion_id: assertion.assertion_id,
          revision: assertion.revision,
        }),
      ),
      baseline_coverage_assertion_snapshot_hash:
        hashLabel(baselineCoverageAssertions),
      baseline_outcome_snapshot_refs: baselineOutcomeSnapshot,
      baseline_outcome_snapshot_hash: hashLabel(baselineOutcomeSnapshot),
      settlement_coverage_assertion_refs:
        settlement.data.coverage_assertion_refs,
      settlement_coverage_assertion_snapshot_hash:
        settlement.data.coverage_assertion_snapshot_hash,
      label: settlement.data.status === "positive" ? 1 : 0,
      model_version: prediction.data.model.version,
    });
  }
  if (rows.length === 0) return null;

  const alertRows = [];
  for (const weekRows of Map.groupBy(rows, (row) => weekKey(row.window_start)).values()) {
    alertRows.push(...[...weekRows]
      .sort((left, right) =>
        right.probability - left.probability ||
        left.window_start.localeCompare(right.window_start),
      )
      .slice(0, Math.min(config.model.promotion.top_window_hours_per_week, weekRows.length)));
  }
  const scorableOutcomes = outcomes.filter((outcome) =>
    rows.some((row) => overlaps(row.window_start, row.window_end, outcome.data.occurred_time_range)),
  );
  const events = scorableOutcomes.map((outcome) => {
    const matchingRows = rows.filter((row) =>
      Date.parse(row.window_start) < Date.parse(outcome.data.occurred_time_range.start) &&
      overlaps(row.window_start, row.window_end, outcome.data.occurred_time_range),
    );
    const matchingAlerts = alertRows.filter((row) =>
      Date.parse(row.window_start) < Date.parse(outcome.data.occurred_time_range.start) &&
      overlaps(row.window_start, row.window_end, outcome.data.occurred_time_range),
    );
    const eventStart = Date.parse(outcome.data.occurred_time_range.start);
    const highestPrior = [...matchingRows]
      .sort((left, right) => right.probability - left.probability)[0];
    const policyPeak = [...alertRows]
      .filter((row) =>
        weekKey(row.window_start) ===
          weekKey(outcome.data.occurred_time_range.start) &&
        Date.parse(row.window_start) < eventStart
      )
      .sort((left, right) =>
        right.probability - left.probability ||
        left.window_start.localeCompare(right.window_start)
      )[0] ?? null;
    return {
      outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
      occurred_time_range: outcome.data.occurred_time_range,
      hit: matchingAlerts.length > 0,
      settlement: matchingAlerts.length > 0 ? "hit" : "miss",
      useful_lead_hours: matchingAlerts.length === 0
        ? null
        : Math.max(...matchingAlerts.map((row) => (eventStart - Date.parse(row.window_start)) / 3_600_000)),
      maximum_prior_probability: highestPrior.probability,
      forecast_issued_at: highestPrior.issued_at,
      ranked_window: {
        start: highestPrior.window_start,
        end: highestPrior.window_end,
        probability: highestPrior.probability,
      },
      policy_peak_window: policyPeak ? {
        start: policyPeak.window_start,
        end: policyPeak.window_end,
        probability: policyPeak.probability,
      } : null,
      model_version: highestPrior.model_version,
      prediction_refs: matchingRows.map((row) => row.prediction_ref),
    };
  });
  const brier = mean(rows.map((row) => (row.probability - row.label) ** 2));
  const baselineBrier = mean(rows.map((row) => (row.baseline_probability - row.label) ** 2));
  const brierSkill = baselineBrier === 0 ? 0 : 1 - brier / baselineBrier;
  const buckets = calibration(rows);
  const expectedCalibrationError = buckets.reduce((sum, bucket) =>
    sum + (bucket.count === 0
      ? 0
      : (bucket.count / rows.length) * Math.abs(bucket.mean_prediction - bucket.observed_rate)), 0);
  const eventWindowRecall = events.length === 0
    ? null
    : events.filter((event) => event.hit).length / events.length;
  const calibrationRegression = calibrationFit(rows);
  const gate = {
    minimum_event_window_recall: config.model.promotion.minimum_event_window_recall,
    require_brier_skill_above: config.model.promotion.require_brier_skill_above,
    maximum_expected_calibration_error: config.model.promotion.maximum_expected_calibration_error,
    event_window_recall_passed:
      eventWindowRecall !== null &&
      eventWindowRecall >= config.model.promotion.minimum_event_window_recall,
    brier_skill_passed: brierSkill > config.model.promotion.require_brier_skill_above,
    calibration_passed:
      expectedCalibrationError <= config.model.promotion.maximum_expected_calibration_error,
  };
  gate.passed = gate.event_window_recall_passed && gate.brier_skill_passed && gate.calibration_passed;
  const falseAlerts = alertRows.filter((row) => row.label === 0).length;
  const usedCoverageAssertionsByRef = new Map([
    ...baselineCoverageSnapshotByRef,
    ...settlementCoverageSnapshotByRef,
  ]);
  const usedCoverageAssertions = [...usedCoverageAssertionsByRef.values()]
    .sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) || left.revision - right.revision,
    );
  const coverageAssertionRefs = usedCoverageAssertions
    .map((assertion) => ({
      assertion_id: assertion.assertion_id,
      revision: assertion.revision,
    }));
  const outcomeSnapshotByRef = new Map(baselineOutcomeSnapshotByRef);
  for (const outcome of outcomeCandidates.filter((candidate) =>
    rows.some((row) =>
      overlaps(row.window_start, row.window_end, candidate.data.occurred_time_range)
    )
  )) {
    const entry = {
      record_id: outcome.record_id,
      revision: outcome.revision,
      data_hash: hashLabel(outcome.data),
    };
    outcomeSnapshotByRef.set(
      `${entry.record_id}@${entry.revision}`,
      entry,
    );
  }
  const outcomeSnapshot = [...outcomeSnapshotByRef.values()]
    .sort((left, right) =>
      left.record_id.localeCompare(right.record_id) || left.revision - right.revision,
    );
  const scoredPredictionKeys = new Set(
    rows.map((row) => `${row.prediction_ref.record_id}@${row.prediction_ref.revision}`),
  );
  const predictionSnapshot = predictionSelection.selected
    .filter((prediction) =>
      scoredPredictionKeys.has(`${prediction.record_id}@${prediction.revision}`),
    )
    .map((prediction) => ({
      record_id: prediction.record_id,
      revision: prediction.revision,
      data_hash: hashLabel(prediction.data),
    }))
    .sort((left, right) =>
      left.record_id.localeCompare(right.record_id) || left.revision - right.revision,
    );
  const scoredSettlementKeys = new Set(
    rows.map((row) => `${row.settlement_ref.record_id}@${row.settlement_ref.revision}`),
  );
  const settlementSnapshot = currentSettlements
    .filter((settlement) =>
      scoredSettlementKeys.has(`${settlement.record_id}@${settlement.revision}`),
    )
    .map((settlement) => ({
      record_id: settlement.record_id,
      revision: settlement.revision,
      data_hash: hashLabel(settlement.data),
    }))
    .sort((left, right) =>
      left.record_id.localeCompare(right.record_id) || left.revision - right.revision,
    );
  const rowContentHash = hashLabel(rows.map((row) => ({
    prediction_ref: row.prediction_ref,
    settlement_ref: row.settlement_ref,
    window_start: row.window_start,
    window_end: row.window_end,
    probability: row.probability,
    baseline_probability: row.baseline_probability,
    baseline_coverage_assertion_refs: row.baseline_coverage_assertion_refs,
    baseline_coverage_assertion_snapshot_hash:
      row.baseline_coverage_assertion_snapshot_hash,
    baseline_outcome_snapshot_refs: row.baseline_outcome_snapshot_refs,
    baseline_outcome_snapshot_hash: row.baseline_outcome_snapshot_hash,
    settlement_coverage_assertion_refs:
      row.settlement_coverage_assertion_refs,
    settlement_coverage_assertion_snapshot_hash:
      row.settlement_coverage_assertion_snapshot_hash,
    label: row.label,
    model_version: row.model_version,
  })));
  const modelVersions = [...new Set(
    rows.map((row) => row.model_version).filter(Boolean),
  )].sort();
  const frozenEvaluationArtifact = {
    artifact_version: FROZEN_ISSUED_EVALUATION_VERSION,
    evaluation_contract_hash: evaluationContractHash(config),
    alert_policy: {
      type: "fixed_top_n_per_calendar_week",
      budget: config.model.promotion.top_window_hours_per_week,
      tie_breaker: "probability_desc_then_window_start",
    },
    thresholds: {
      minimum_event_window_recall:
        config.model.promotion.minimum_event_window_recall,
      require_brier_skill_above:
        config.model.promotion.require_brier_skill_above,
      maximum_expected_calibration_error:
        config.model.promotion.maximum_expected_calibration_error,
    },
    duplicate_predictions_excluded_count:
      predictionSelection.excluded.length,
    rows,
    alerts: alertRows,
    events,
  };
  const recomputedArtifact = recomputeFrozenIssuedEvaluationArtifact(
    frozenEvaluationArtifact,
  );
  if (
    typeof store.writeBlob !== "function" ||
    typeof store.readBlob !== "function"
  ) {
    throw new Error("Store cannot persist immutable issued evaluation artifacts");
  }
  const rowSampleHash = hashLabel(frozenEvaluationArtifact);
  const rowSampleRef = await store.writeBlob(
    "issued-evaluation",
    rowSampleHash,
    frozenEvaluationArtifact,
  );
  if (hashLabel(await store.readBlob(rowSampleRef)) !== rowSampleHash) {
    throw new Error("Stored frozen issued evaluation artifact hash mismatch");
  }
  const summary = {
    evaluation_version: "reset-issued-evaluation/0.3.0",
    mode: "as_issued",
    evidence_mode: "as_issued",
    generated_at: new Date().toISOString(),
    evaluation_cutoff: toUtcIso(cutoff),
    outcome_coverage_providers: [...config.model.outcome_coverage_providers],
    folds: [],
    duplicate_predictions_excluded: predictionSelection.excluded.map((prediction) => ({
      prediction_ref: {
        record_id: prediction.record_id,
        revision: prediction.revision,
      },
      window_start: prediction.data.slots[0].start,
      issued_at: prediction.data.issued_at,
    })),
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
      prediction_snapshot_refs: predictionSnapshot,
      prediction_snapshot_hash: hashLabel(predictionSnapshot),
      settlement_snapshot_refs: settlementSnapshot,
      settlement_snapshot_hash: hashLabel(settlementSnapshot),
      row_sample_schema_version: FROZEN_ISSUED_EVALUATION_VERSION,
      row_sample_ref: rowSampleRef,
      row_sample_hash: rowSampleHash,
      row_content_hash: rowContentHash,
      fold_signature: hashLabel([]),
      model_versions: modelVersions,
      outcome_as_of_mode: AS_OF_MODE.LIVE,
      coverage_as_of_mode: COVERAGE_AS_OF_MODE.LIVE,
    },
    alert_policy: {
      type: "fixed_top_n_per_calendar_week",
      budget: config.model.promotion.top_window_hours_per_week,
      tie_breaker: "probability_desc_then_window_start",
    },
    metrics: recomputedArtifact.metrics,
    calibration: recomputedArtifact.calibration,
    events: recomputedArtifact.events,
    gate: recomputedArtifact.gate,
  };
  summary.evaluation_artifact_hash = evaluationArtifactHash(summary);
  await store.writeState("issued-evaluation-summary", summary);
  return summary;
}
