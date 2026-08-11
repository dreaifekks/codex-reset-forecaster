import { hashLabel } from "../core/hash.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import {
  evaluationContractHash,
  modelContractHash,
} from "../model/contract.mjs";
import {
  AS_OF_MODE,
  latestObservationsAsOf,
  latestOutcomesAsOf,
  latestSignalsAsOf,
} from "../model/as-of.mjs";
import {
  COVERAGE_AS_OF_MODE,
  adequateCoverageAssertionsAsOf,
  coverageAssertionRevisions,
} from "../model/coverage-as-of.mjs";
import { verifyIssuedEvaluationArtifact } from "../model/issued-evaluation.mjs";
import {
  MODEL_VERSION_PREFIX,
  modelReleaseFromVersion,
} from "../model/model-version.mjs";
import { normalizeCoverageIntervals } from "../pipeline/coverage.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";

export const PROBABILITY_THRESHOLD_PROFILE_VERSION =
  "probability-threshold-profile/1";
export const NOTIFICATION_THRESHOLD_CALIBRATION_VERSION =
  "notification-threshold-calibration/1";

const HOUR_MS = 3_600_000;
const DEFAULT_BIN_COUNT = 20;
const DEFAULT_THRESHOLD_STEP = 0.01;
const PROBABILITY_GRID_SCALE = 100;
const PROBABILITY_GRID_EPSILON = 1e-10;
const DISPLAY_STANDARD_DEVIATIONS = 4;
const SUGGESTED_THRESHOLD_STANDARD_DEVIATIONS = 2;
const MINIMUM_DISPLAY_RANGE = 0.05;
export const PROBABILITY_PROFILE_POINT_MINIMUM_WINDOWS = 20;

function finiteTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function exactRef(record) {
  return { record_id: record.record_id, revision: record.revision };
}

function exactRefKey(recordOrRef) {
  return `${recordOrRef.record_id}@${recordOrRef.revision}`;
}

function overlaps(start, end, range) {
  return Date.parse(start) < Date.parse(range.end) &&
    Date.parse(end) > Date.parse(range.start);
}

function covered(start, end, intervals) {
  let cursor = Date.parse(start);
  const endMs = Date.parse(end);
  for (const interval of intervals) {
    const intervalStart = Date.parse(interval.start);
    const intervalEnd = Date.parse(interval.end);
    if (intervalEnd <= cursor) continue;
    if (intervalStart > cursor) return false;
    cursor = Math.max(cursor, intervalEnd);
    if (cursor >= endMs) return true;
  }
  return false;
}

function boundedProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

export function parseProbabilityProfileHorizon(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new RangeError("horizon_hours must be an integer from 1 through 168");
  }
  const horizonHours = Number(text);
  if (horizonHours < 1 || horizonHours > 168) {
    throw new RangeError("horizon_hours must be an integer from 1 through 168");
  }
  return horizonHours;
}

function validateProfileOptions({
  horizonHours,
  minimumWindows,
  minimumEvents,
  binCount,
  thresholdStep,
}) {
  parseProbabilityProfileHorizon(horizonHours);
  if (!Number.isInteger(minimumWindows) || minimumWindows < 1) {
    throw new RangeError("minimumWindows must be a positive integer");
  }
  if (!Number.isInteger(minimumEvents) || minimumEvents < 1) {
    throw new RangeError("minimumEvents must be a positive integer");
  }
  if (!Number.isInteger(binCount) || binCount < 2 || binCount > 100) {
    throw new RangeError("binCount must be an integer from 2 through 100");
  }
  if (
    !Number.isFinite(thresholdStep) ||
    thresholdStep <= 0 ||
    thresholdStep > 1
  ) {
    throw new RangeError("thresholdStep must be greater than zero and at most one");
  }
}

function predictionIsWellFormed(prediction, horizonHours) {
  const slots = prediction?.data?.slots;
  const anchor = slots?.[0]?.start;
  const issuedAt = prediction?.data?.issued_at;
  if (
    !Array.isArray(slots) ||
    slots.length < horizonHours ||
    finiteTimestamp(anchor) === null ||
    finiteTimestamp(issuedAt) === null ||
    Date.parse(issuedAt) > Date.parse(anchor)
  ) return false;
  for (let index = 0; index < horizonHours; index += 1) {
    const slot = slots[index];
    const expectedStart = Date.parse(anchor) + index * HOUR_MS;
    if (
      finiteTimestamp(slot?.start) !== expectedStart ||
      finiteTimestamp(slot?.end) !== expectedStart + HOUR_MS ||
      boundedProbability(slot?.reset_by_end_probability) === null
    ) return false;
  }
  return true;
}

export function selectLatestIssuedPredictionsByAnchor(
  predictions,
  { horizonHours, modelRelease = MODEL_VERSION_PREFIX } = {},
) {
  const horizon = parseProbabilityProfileHorizon(horizonHours);
  const selected = new Map();
  const excluded = {
    malformed: 0,
    incompatible_model_release: 0,
    duplicate_anchor: 0,
  };
  for (const prediction of predictions) {
    if (!predictionIsWellFormed(prediction, horizon)) {
      excluded.malformed += 1;
      continue;
    }
    if (
      modelRelease &&
      modelReleaseFromVersion(prediction.data.model?.version) !== modelRelease
    ) {
      excluded.incompatible_model_release += 1;
      continue;
    }
    const anchor = prediction.data.slots[0].start;
    const previous = selected.get(anchor);
    const shouldReplace = !previous ||
      prediction.data.issued_at > previous.data.issued_at ||
      (
        prediction.data.issued_at === previous.data.issued_at &&
        exactRefKey(prediction).localeCompare(exactRefKey(previous)) < 0
      );
    if (previous) excluded.duplicate_anchor += 1;
    if (shouldReplace) selected.set(anchor, prediction);
  }
  return {
    selected: [...selected.values()].sort((left, right) =>
      left.data.slots[0].start.localeCompare(right.data.slots[0].start)
    ),
    excluded,
  };
}

function classifyWindow({
  prediction,
  horizonHours,
  evaluationCutoff,
  outcomes,
  ambiguousOutcomes,
  coverageIntervals,
}) {
  const start = prediction.data.slots[0].start;
  const end = prediction.data.slots[horizonHours - 1].end;
  if (Date.parse(end) > Date.parse(evaluationCutoff)) {
    return { status: "immature", start, end, outcomeRefs: [] };
  }
  const allOutcomeCandidates = [...outcomes, ...ambiguousOutcomes];
  if (allOutcomeCandidates.some((outcome) => {
    const range = outcome.data.occurred_time_range;
    return Date.parse(range.start) <= Date.parse(start) &&
      Date.parse(start) < Date.parse(range.end);
  })) {
    return { status: "censored_anchor_inside_outcome", start, end, outcomeRefs: [] };
  }
  if (ambiguousOutcomes.some((outcome) =>
    overlaps(start, end, outcome.data.occurred_time_range)
  )) {
    return { status: "censored_ambiguous_outcome", start, end, outcomeRefs: [] };
  }
  const matchingOutcomes = outcomes.filter((outcome) => {
    const range = outcome.data.occurred_time_range;
    return Date.parse(start) < Date.parse(range.start) &&
      overlaps(start, end, range);
  });
  if (matchingOutcomes.length > 0) {
    return {
      status: "positive",
      start,
      end,
      outcomeRefs: matchingOutcomes.map(exactRef),
    };
  }
  if (!covered(start, end, coverageIntervals)) {
    return { status: "censored_incomplete_coverage", start, end, outcomeRefs: [] };
  }
  return { status: "negative", start, end, outcomeRefs: [] };
}

function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (!Number.isInteger(trials) || trials < 1) return null;
  const rate = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (rate + z2 / (2 * trials)) / denominator;
  const halfWidth = z * Math.sqrt(
    (rate * (1 - rate) + z2 / (4 * trials)) / trials,
  ) / denominator;
  return {
    lower: successes === 0 ? 0 : Math.max(0, center - halfWidth),
    upper: successes === trials ? 1 : Math.min(1, center + halfWidth),
    level: 0.95,
    method: "wilson_score",
  };
}

function nonOverlappingRows(rows) {
  const selected = [];
  let availableAt = -Infinity;
  for (const row of rows) {
    const start = Date.parse(row.window_start);
    if (start < availableAt) continue;
    selected.push(row);
    availableAt = Date.parse(row.window_end);
  }
  return selected;
}

function distributionFor(rows, binCount) {
  const width = 1 / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index * width,
    upper: (index + 1) * width,
    windows: 0,
    positive_windows: 0,
    negative_windows: 0,
    density: 0,
    historical_reset_rate: null,
  }));
  for (const row of rows) {
    const index = Math.min(binCount - 1, Math.floor(row.probability / width));
    const bin = bins[index];
    bin.windows += 1;
    if (row.label === 1) bin.positive_windows += 1;
    else bin.negative_windows += 1;
  }
  for (const bin of bins) {
    bin.density = rows.length === 0 ? 0 : bin.windows / (rows.length * width);
    bin.historical_reset_rate = bin.windows === 0
      ? null
      : bin.positive_windows / bin.windows;
  }
  return {
    type: "histogram",
    bin_count: binCount,
    bin_width: width,
    bins,
  };
}

function floorProbabilityGridIndex(value) {
  return Math.floor(
    value * PROBABILITY_GRID_SCALE + PROBABILITY_GRID_EPSILON,
  );
}

function ceilProbabilityGridIndex(value) {
  return Math.ceil(
    value * PROBABILITY_GRID_SCALE - PROBABILITY_GRID_EPSILON,
  );
}

function distributionSummaryFor(rows) {
  if (rows.length === 0) {
    return {
      mean_probability: null,
      standard_deviation: null,
      observed_range: {
        lower: null,
        upper: null,
      },
      display_range: {
        lower: null,
        upper: null,
        standard_deviations: DISPLAY_STANDARD_DEVIATIONS,
        clipped_below: 0,
        clipped_above: 0,
      },
      suggested_threshold: {
        probability: null,
        standard_deviations: SUGGESTED_THRESHOLD_STANDARD_DEVIATIONS,
      },
    };
  }

  // Welford's algorithm keeps the calculation on the original eligible-row
  // probabilities and avoids introducing histogram or grid-rounding error.
  let mean = 0;
  let squaredDifferenceSum = 0;
  let observedLower = Infinity;
  let observedUpper = -Infinity;
  rows.forEach((row, index) => {
    const probability = row.probability;
    const count = index + 1;
    const difference = probability - mean;
    mean += difference / count;
    squaredDifferenceSum += difference * (probability - mean);
    observedLower = Math.min(observedLower, probability);
    observedUpper = Math.max(observedUpper, probability);
  });
  const standardDeviation = Math.sqrt(
    Math.max(0, squaredDifferenceSum / rows.length),
  );

  let displayLowerIndex = floorProbabilityGridIndex(Math.max(
    0,
    mean - DISPLAY_STANDARD_DEVIATIONS * standardDeviation,
  ));
  let displayUpperIndex = ceilProbabilityGridIndex(Math.min(
    1,
    mean + DISPLAY_STANDARD_DEVIATIONS * standardDeviation,
  ));

  const minimumDisplayGridSteps =
    MINIMUM_DISPLAY_RANGE * PROBABILITY_GRID_SCALE;
  if (displayUpperIndex - displayLowerIndex < minimumDisplayGridSteps) {
    const missingSteps = minimumDisplayGridSteps -
      (displayUpperIndex - displayLowerIndex);
    displayLowerIndex = Math.max(
      0,
      Math.floor(displayLowerIndex - missingSteps / 2),
    );
    displayUpperIndex = Math.min(
      PROBABILITY_GRID_SCALE,
      Math.ceil(displayUpperIndex + missingSteps / 2),
    );
  }
  // Symmetric expansion can still be truncated by the probability boundary.
  // Shift the remaining width to the side that has room while staying on-grid.
  if (displayUpperIndex - displayLowerIndex < minimumDisplayGridSteps) {
    if (displayLowerIndex === 0) {
      displayUpperIndex = minimumDisplayGridSteps;
    } else {
      displayLowerIndex = PROBABILITY_GRID_SCALE - minimumDisplayGridSteps;
    }
  }
  const displayLower = displayLowerIndex / PROBABILITY_GRID_SCALE;
  const displayUpper = displayUpperIndex / PROBABILITY_GRID_SCALE;

  const suggestedProbability = Math.min(
    0.99,
    Math.max(
      0.01,
      ceilProbabilityGridIndex(
        mean + SUGGESTED_THRESHOLD_STANDARD_DEVIATIONS * standardDeviation,
      ) / PROBABILITY_GRID_SCALE,
    ),
  );

  return {
    mean_probability: mean,
    standard_deviation: standardDeviation,
    observed_range: {
      lower: observedLower,
      upper: observedUpper,
    },
    display_range: {
      lower: displayLower,
      upper: displayUpper,
      standard_deviations: DISPLAY_STANDARD_DEVIATIONS,
      clipped_below: rows.filter((row) =>
        row.probability < displayLower
      ).length,
      clipped_above: rows.filter((row) =>
        row.probability > displayUpper
      ).length,
    },
    suggested_threshold: {
      probability: suggestedProbability,
      standard_deviations: SUGGESTED_THRESHOLD_STANDARD_DEVIATIONS,
    },
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function kdeBandwidth(probabilities) {
  if (probabilities.length < 2) return 0.05;
  const mean = probabilities.reduce((sum, value) => sum + value, 0) /
    probabilities.length;
  const variance = probabilities.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / probabilities.length;
  const sorted = [...probabilities].sort((left, right) => left - right);
  const interquartileRange = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const robustScale = interquartileRange > 0
    ? Math.min(Math.sqrt(variance), interquartileRange / 1.34)
    : Math.sqrt(variance);
  const silverman = 0.9 * robustScale * probabilities.length ** -0.2;
  return Math.max(0.01, Math.min(0.15, silverman || 0.05));
}

function reflectedKernelDensity(probabilities, x, bandwidth) {
  if (probabilities.length === 0) return 0;
  const normalizer = Math.sqrt(2 * Math.PI) * bandwidth;
  const kernel = (distance) =>
    Math.exp(-0.5 * (distance / bandwidth) ** 2) / normalizer;
  return probabilities.reduce((sum, probability) =>
    sum +
      kernel(x - probability) +
      kernel(x + probability) +
      kernel(x - (2 - probability)),
  0) / probabilities.length;
}

function thresholdValues(step) {
  const count = Math.floor(1 / step);
  const values = Array.from({ length: count + 1 }, (_, index) =>
    Math.min(1, index * step)
  );
  if (values.at(-1) !== 1) values.push(1);
  return [...new Set(values.map((value) => Number(value.toFixed(12))))];
}

function thresholdCurve(rows, scorableOutcomeKeys, step) {
  return thresholdValues(step).map((threshold) => {
    const selected = rows.filter((row) => row.probability > threshold);
    const selectedPositive = selected.filter((row) => row.label === 1);
    const independent = nonOverlappingRows(selected);
    const independentPositive = independent.filter((row) => row.label === 1);
    const hitOutcomeKeys = new Set(
      selected.flatMap((row) => row.outcome_refs.map(exactRefKey)),
    );
    return {
      threshold,
      selected_windows: selected.length,
      selected_positive_windows: selectedPositive.length,
      descriptive_window_reset_rate: selected.length === 0
        ? null
        : selectedPositive.length / selected.length,
      non_overlapping_windows: independent.length,
      non_overlapping_positive_windows: independentPositive.length,
      historical_reset_rate: independent.length === 0
        ? null
        : independentPositive.length / independent.length,
      historical_reset_rate_interval_95: wilsonInterval(
        independentPositive.length,
        independent.length,
      ),
      scorable_events: scorableOutcomeKeys.size,
      events_hit: hitOutcomeKeys.size,
      event_recall: scorableOutcomeKeys.size === 0
        ? null
        : hitOutcomeKeys.size / scorableOutcomeKeys.size,
    };
  });
}

function compactPoints(rows, curve) {
  const probabilities = rows.map((row) => row.probability);
  const bandwidth = kdeBandwidth(probabilities);
  return curve.map((point) => {
    const pointSampleGatePassed =
      point.non_overlapping_windows >= PROBABILITY_PROFILE_POINT_MINIMUM_WINDOWS;
    return {
      probability: point.threshold,
      density: reflectedKernelDensity(
        probabilities,
        point.threshold,
        bandwidth,
      ),
      confidence_above: pointSampleGatePassed
        ? point.historical_reset_rate
        : null,
      historical_hit_rate_above: point.historical_reset_rate,
      sample_count_above: point.non_overlapping_windows,
      confidence_interval:
        point.historical_reset_rate_interval_95,
      point_sample_gate: {
        minimum_windows: PROBABILITY_PROFILE_POINT_MINIMUM_WINDOWS,
        evaluated_windows: point.non_overlapping_windows,
        passed: pointSampleGatePassed,
      },
      window_count_above: point.selected_windows,
      event_recall: point.event_recall,
    };
  });
}

function emptyProfile({
  horizonHours,
  evaluationCutoff,
  modelRelease,
  minimumWindows,
  minimumEvents,
  status,
  reason,
  lineage = {},
  binCount = DEFAULT_BIN_COUNT,
}) {
  const distribution = distributionFor([], binCount);
  const distributionSummary = distributionSummaryFor([]);
  return {
    schema_version: NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
    detail_schema_version: PROBABILITY_THRESHOLD_PROFILE_VERSION,
    status,
    reason,
    preliminary: true,
    horizon_hours: horizonHours,
    evaluation_cutoff: evaluationCutoff,
    model_release: modelRelease,
    sample_count: 0,
    min_sample_count: minimumWindows,
    event_count: 0,
    min_event_count: minimumEvents,
    points: [],
    sample_gate: {
      minimum_windows: minimumWindows,
      minimum_events: minimumEvents,
      evaluated_windows: 0,
      evaluated_events: 0,
      windows_passed: false,
      events_passed: false,
      passed: false,
    },
    exclusions: {},
    distribution_summary: distributionSummary,
    distribution,
    threshold_curve: [],
    lineage,
    semantics: profileSemantics(),
  };
}

function profileSemantics() {
  return {
    probability:
      "as-issued cumulative first-reset probability through the selected hourly horizon",
    positive_label:
      "an eligible confirmed reset starts after the forecast anchor and overlaps the half-open horizon",
    negative_label:
      "no eligible reset overlaps and negative-label-eligible coverage spans the entire half-open horizon",
    censored_label:
      "immature windows, incomplete coverage, ambiguous outcomes, and anchors inside an outcome are excluded",
    descriptive_window_rate:
      "uses all eligible hourly anchors and is descriptive because horizons can overlap",
    historical_reset_rate:
      "uses a chronological non-overlapping subset; its Wilson 95% interval is observational historical reliability, not model confidence",
    confidence_above_field:
      "compact transport alias for historical_hit_rate_above; it is not extraction confidence, epistemic confidence, or forecast probability",
    density:
      "boundary-reflected Gaussian kernel density over eligible as-issued probabilities",
    display_range:
      "visualization-only range over eligible as-issued probabilities; clipped rows remain included in all statistics, samples, and threshold calculations",
    suggested_threshold:
      "mean plus two population standard deviations, rounded up to a real one-percent threshold point and bounded to 0.01 through 0.99",
    threshold_comparison: "probability strictly greater than threshold",
    excluded_metrics: [
      "extraction_confidence",
      "data_quality",
      "epistemic_uncertainty",
    ],
  };
}

export function buildProbabilityThresholdProfile({
  predictions,
  outcomes,
  ambiguousOutcomes = [],
  coverageIntervals,
  evaluationCutoff,
  horizonHours,
  modelRelease = MODEL_VERSION_PREFIX,
  minimumWindows = 1008,
  minimumEvents = 20,
  binCount = DEFAULT_BIN_COUNT,
  thresholdStep = DEFAULT_THRESHOLD_STEP,
  lineage = {},
}) {
  const horizon = parseProbabilityProfileHorizon(horizonHours);
  validateProfileOptions({
    horizonHours: horizon,
    minimumWindows,
    minimumEvents,
    binCount,
    thresholdStep,
  });
  if (finiteTimestamp(evaluationCutoff) === null) {
    throw new TypeError("evaluationCutoff must be a valid timestamp");
  }
  const normalizedCoverage = [...coverageIntervals]
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .filter((interval) =>
      finiteTimestamp(interval.start) !== null &&
      finiteTimestamp(interval.end) !== null &&
      Date.parse(interval.end) > Date.parse(interval.start)
    )
    .sort((left, right) => left.start.localeCompare(right.start));
  const selection = selectLatestIssuedPredictionsByAnchor(predictions, {
    horizonHours: horizon,
    modelRelease,
  });
  const exclusions = {
    ...selection.excluded,
    immature: 0,
    censored_anchor_inside_outcome: 0,
    censored_ambiguous_outcome: 0,
    censored_incomplete_coverage: 0,
  };
  const rows = [];
  for (const prediction of selection.selected) {
    const classification = classifyWindow({
      prediction,
      horizonHours: horizon,
      evaluationCutoff,
      outcomes,
      ambiguousOutcomes,
      coverageIntervals: normalizedCoverage,
    });
    if (!["positive", "negative"].includes(classification.status)) {
      exclusions[classification.status] += 1;
      continue;
    }
    rows.push({
      prediction_ref: exactRef(prediction),
      model_version: prediction.data.model.version,
      issued_at: prediction.data.issued_at,
      knowledge_cutoff: prediction.data.knowledge_cutoff,
      window_start: classification.start,
      window_end: classification.end,
      probability:
        prediction.data.slots[horizon - 1].reset_by_end_probability,
      label: classification.status === "positive" ? 1 : 0,
      outcome_refs: classification.outcomeRefs,
    });
  }
  const scorableOutcomeKeys = new Set(
    rows.flatMap((row) => row.outcome_refs.map(exactRefKey)),
  );
  const gate = {
    minimum_windows: minimumWindows,
    minimum_events: minimumEvents,
    evaluated_windows: rows.length,
    evaluated_events: scorableOutcomeKeys.size,
    windows_passed: rows.length >= minimumWindows,
    events_passed: scorableOutcomeKeys.size >= minimumEvents,
  };
  gate.passed = gate.windows_passed && gate.events_passed;
  const distribution = distributionFor(rows, binCount);
  const distributionSummary = distributionSummaryFor(rows);
  const curve = thresholdCurve(rows, scorableOutcomeKeys, thresholdStep);
  return {
    schema_version: NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
    detail_schema_version: PROBABILITY_THRESHOLD_PROFILE_VERSION,
    status: rows.length === 0
      ? "insufficient"
      : gate.passed
        ? "available"
        : "preliminary",
    reason: rows.length === 0
      ? "no_mature_covered_as_issued_windows"
      : gate.passed
        ? null
        : "minimum_sample_gate_not_met",
    preliminary: !gate.passed,
    horizon_hours: horizon,
    evaluation_cutoff: new Date(evaluationCutoff).toISOString(),
    model_release: modelRelease,
    sample_count: rows.length,
    min_sample_count: minimumWindows,
    event_count: scorableOutcomeKeys.size,
    min_event_count: minimumEvents,
    points: compactPoints(rows, curve),
    sample_gate: gate,
    sample: {
      positive_windows: rows.filter((row) => row.label === 1).length,
      negative_windows: rows.filter((row) => row.label === 0).length,
      first_window_start: rows[0]?.window_start ?? null,
      last_window_start: rows.at(-1)?.window_start ?? null,
    },
    exclusions,
    distribution_summary: distributionSummary,
    distribution,
    threshold_curve: curve,
    lineage: {
      ...lineage,
      evaluated_row_hash: hashLabel(rows),
    },
    semantics: profileSemantics(),
  };
}

async function exactPredictionsForArtifact(store, artifact, modelRelease) {
  const rows = (artifact.rows ?? []).filter((row) =>
    modelReleaseFromVersion(row.model_version) === modelRelease
  );
  const refs = [...new Map(rows.map((row) => [
    exactRefKey(row.prediction_ref),
    row.prediction_ref,
  ])).values()];
  const predictions = typeof store.allByRefs === "function"
    ? await store.allByRefs("prediction", refs)
    : (await store.all("prediction", { latestOnly: false })).filter(
      (prediction) => refs.some((ref) => exactRefKey(ref) === exactRefKey(prediction)),
    );
  return { refs, predictions };
}

function unavailableProfileContext({
  reason,
  evaluationCutoff,
  modelRelease,
  minimumWindows,
  minimumEvents,
  lineage = {},
}) {
  const generationHash = hashLabel({
    status: "insufficient",
    reason,
    evaluation_cutoff: evaluationCutoff,
    model_release: modelRelease,
    lineage,
  });
  return {
    schema_version: "probability-threshold-profile-context/1",
    status: "insufficient",
    reason,
    evaluation_cutoff: evaluationCutoff,
    model_release: modelRelease,
    minimum_windows: minimumWindows,
    minimum_events: minimumEvents,
    generation_hash: generationHash,
    predictions: [],
    outcomes: [],
    ambiguous_outcomes: [],
    coverage_intervals: [],
    lineage,
  };
}

export async function loadProbabilityThresholdProfileContext(
  store,
  config,
  { modelRelease = MODEL_VERSION_PREFIX } = {},
) {
  const minimumWindows = config.model.minimum_live_evaluation_windows;
  const minimumEvents = config.model.minimum_live_evaluation_events;
  const summary = await store.readState("issued-evaluation-summary", null);
  const fallbackCutoff = new Date(0).toISOString();
  if (!summary) {
    return unavailableProfileContext({
      evaluationCutoff: fallbackCutoff,
      modelRelease,
      minimumWindows,
      minimumEvents,
      reason: "issued_evaluation_not_ready",
    });
  }
  const evaluationCutoff = summary.evaluation_cutoff;
  if (
    finiteTimestamp(evaluationCutoff) === null ||
    summary.provenance?.model_contract_hash !== modelContractHash(config) ||
    summary.provenance?.evaluation_contract_hash !==
      evaluationContractHash(config)
  ) {
    return unavailableProfileContext({
      evaluationCutoff: finiteTimestamp(evaluationCutoff) === null
        ? fallbackCutoff
        : new Date(evaluationCutoff).toISOString(),
      modelRelease,
      minimumWindows,
      minimumEvents,
      reason: "issued_evaluation_incompatible",
      lineage: {
        source_evaluation_artifact_hash:
          summary.evaluation_artifact_hash ?? null,
      },
    });
  }
  const verification = await verifyIssuedEvaluationArtifact(store, summary);
  if (!verification.valid) {
    return unavailableProfileContext({
      evaluationCutoff: new Date(evaluationCutoff).toISOString(),
      modelRelease,
      minimumWindows,
      minimumEvents,
      reason: verification.reason,
      lineage: {
        source_evaluation_artifact_hash:
          summary.evaluation_artifact_hash ?? null,
      },
    });
  }
  const { refs, predictions } = await exactPredictionsForArtifact(
    store,
    verification.artifact,
    modelRelease,
  );
  if (refs.length === 0) {
    return unavailableProfileContext({
      evaluationCutoff: new Date(evaluationCutoff).toISOString(),
      modelRelease,
      minimumWindows,
      minimumEvents,
      reason: "current_model_release_has_no_mature_as_issued_rows",
      lineage: {
        source_evaluation_artifact_hash:
          summary.evaluation_artifact_hash ?? null,
      },
    });
  }
  const expectedSnapshotByRef = new Map(
    (summary.provenance?.prediction_snapshot_refs ?? []).map((entry) => [
      exactRefKey(entry),
      entry.data_hash,
    ]),
  );
  const predictionsValid = predictions.length === refs.length &&
    predictions.every((prediction) =>
      expectedSnapshotByRef.get(exactRefKey(prediction)) ===
        hashLabel(prediction.data)
    );
  if (!predictionsValid) {
    return unavailableProfileContext({
      evaluationCutoff: new Date(evaluationCutoff).toISOString(),
      modelRelease,
      minimumWindows,
      minimumEvents,
      reason: "prediction_snapshot_mismatch",
      lineage: {
        source_evaluation_artifact_hash:
          summary.evaluation_artifact_hash ?? null,
      },
    });
  }
  // The exact records can carry large feature/provenance payloads that are not
  // needed by the calibration view. Keep the verified identity and hourly
  // curve only, so the shared request cache does not pin the full artifacts in
  // the serving process for its entire TTL.
  const compactPredictions = predictions.map((prediction) => ({
    record_id: prediction.record_id,
    revision: prediction.revision,
    data: {
      issued_at: prediction.data.issued_at,
      knowledge_cutoff: prediction.data.knowledge_cutoff,
      model: { version: prediction.data.model.version },
      slots: prediction.data.slots.map((slot) => ({
        start: slot.start,
        end: slot.end,
        reset_by_end_probability: slot.reset_by_end_probability,
      })),
    },
  }));
  const [outcomeRevisions, signalRevisions, observationRevisions, assertions] =
    await Promise.all([
      store.all("reset_outcome", { latestOnly: false }),
      store.all("normalized_signal", { latestOnly: false }),
      store.all("raw_observation", { latestOnly: false }),
      coverageAssertionRevisions(
        store,
        config.model.outcome_coverage_providers,
        { config },
      ),
    ]);
  const signals = selectCurrentSignals(latestSignalsAsOf(
    signalRevisions,
    evaluationCutoff,
    AS_OF_MODE.LIVE,
  ));
  const observations = latestObservationsAsOf(
    observationRevisions,
    evaluationCutoff,
    AS_OF_MODE.LIVE,
  );
  const eligibility = {
    ...buildOutcomeEligibilityContext({ observations, signals, config }),
    confirmationIdentityIds: confirmationIdentityIds(config),
  };
  const outcomeCandidates = latestOutcomesAsOf(
    outcomeRevisions,
    evaluationCutoff,
    AS_OF_MODE.LIVE,
  ).filter((outcome) =>
    outcome.data.status === "confirmed" &&
    outcome.data.occurred_time_range
  );
  const outcomes = outcomeCandidates.filter((outcome) =>
    isEligibleConfirmedOutcome(outcome, eligibility)
  );
  const ambiguousOutcomes = outcomeCandidates.filter((outcome) =>
    !outcomes.includes(outcome)
  );
  const adequateAssertions = adequateCoverageAssertionsAsOf(
    assertions,
    evaluationCutoff,
    config.model.outcome_coverage_providers,
    COVERAGE_AS_OF_MODE.LIVE,
  );
  const outcomeSnapshot = outcomeCandidates.map((outcome) => ({
    record_id: outcome.record_id,
    revision: outcome.revision,
    data_hash: hashLabel(outcome.data),
  })).sort((left, right) =>
    left.record_id.localeCompare(right.record_id) ||
    left.revision - right.revision
  );
  const lineage = {
    source_mode: "as_issued",
    source_evaluation_artifact_hash: summary.evaluation_artifact_hash,
    source_evaluation_row_sample_hash:
      summary.provenance.row_sample_hash,
    prediction_snapshot_hash:
      summary.provenance.prediction_snapshot_hash,
    outcome_snapshot_hash: hashLabel(outcomeSnapshot),
    coverage_assertion_snapshot_hash: hashLabel(adequateAssertions),
  };
  return {
    schema_version: "probability-threshold-profile-context/1",
    status: "ready",
    reason: null,
    evaluation_cutoff: new Date(evaluationCutoff).toISOString(),
    model_release: modelRelease,
    minimum_windows: minimumWindows,
    minimum_events: minimumEvents,
    generation_hash: hashLabel({
      evaluation_cutoff: evaluationCutoff,
      model_release: modelRelease,
      lineage,
    }),
    predictions: compactPredictions,
    outcomes,
    ambiguous_outcomes: ambiguousOutcomes,
    coverage_intervals: normalizeCoverageIntervals(adequateAssertions),
    lineage,
  };
}

export function buildProbabilityThresholdProfileFromContext(context, {
  horizonHours,
  binCount = DEFAULT_BIN_COUNT,
  thresholdStep = DEFAULT_THRESHOLD_STEP,
} = {}) {
  const horizon = parseProbabilityProfileHorizon(horizonHours);
  validateProfileOptions({
    horizonHours: horizon,
    minimumWindows: context.minimum_windows,
    minimumEvents: context.minimum_events,
    binCount,
    thresholdStep,
  });
  if (context.status !== "ready") {
    return emptyProfile({
      horizonHours: horizon,
      evaluationCutoff: context.evaluation_cutoff,
      modelRelease: context.model_release,
      minimumWindows: context.minimum_windows,
      minimumEvents: context.minimum_events,
      status: "insufficient",
      reason: context.reason,
      binCount,
      lineage: {
        ...context.lineage,
        context_generation_hash: context.generation_hash,
      },
    });
  }
  return buildProbabilityThresholdProfile({
    predictions: context.predictions,
    outcomes: context.outcomes,
    ambiguousOutcomes: context.ambiguous_outcomes,
    coverageIntervals: context.coverage_intervals,
    evaluationCutoff: context.evaluation_cutoff,
    horizonHours: horizon,
    modelRelease: context.model_release,
    minimumWindows: context.minimum_windows,
    minimumEvents: context.minimum_events,
    binCount,
    thresholdStep,
    lineage: {
      ...context.lineage,
      context_generation_hash: context.generation_hash,
    },
  });
}

export async function loadProbabilityThresholdProfiles(store, config, {
  horizons,
  modelRelease = MODEL_VERSION_PREFIX,
  binCount = DEFAULT_BIN_COUNT,
  thresholdStep = DEFAULT_THRESHOLD_STEP,
} = {}) {
  if (!Array.isArray(horizons) || horizons.length === 0) {
    throw new TypeError("horizons must contain at least one horizon_hours value");
  }
  const normalizedHorizons = [
    ...new Set(horizons.map(parseProbabilityProfileHorizon)),
  ];
  const context = await loadProbabilityThresholdProfileContext(store, config, {
    modelRelease,
  });
  return new Map(normalizedHorizons.map((horizonHours) => [
    horizonHours,
    buildProbabilityThresholdProfileFromContext(context, {
      horizonHours,
      binCount,
      thresholdStep,
    }),
  ]));
}

export async function loadProbabilityThresholdProfile(store, config, {
  horizonHours,
  modelRelease = MODEL_VERSION_PREFIX,
  binCount = DEFAULT_BIN_COUNT,
  thresholdStep = DEFAULT_THRESHOLD_STEP,
} = {}) {
  const context = await loadProbabilityThresholdProfileContext(store, config, {
    modelRelease,
  });
  return buildProbabilityThresholdProfileFromContext(context, {
    horizonHours,
    binCount,
    thresholdStep,
  });
}
