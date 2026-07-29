import { hashLabel } from "../core/hash.mjs";
import { predictHazard } from "./logistic-hazard.mjs";

export const LIVE_FORECAST_PROMOTION_GUARD_VERSION =
  "live-forecast-promotion-guard/2";

export const DEFAULT_LIVE_FORECAST_PROMOTION_GUARD_POLICY = Object.freeze({
  version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
  enabled: true,
  comparison_hours: 4,
  probability_ratio: 10,
  probability_ratio_denominator_floor: 1e-6,
  minimum_candidate_probability: 0.5,
  minimum_absolute_probability_increase: 0.25,
  minimum_combined_positive_clip_logit_contribution: 3,
  maximum_cumulative_probability_by_horizon: Object.freeze({
    4: 0.8,
    24: 0.98,
    72: 0.995,
  }),
  block_on_out_of_distribution_probability_anomaly: true,
});

export function assertLiveForecastPromotionGuardPolicy(policy) {
  const probabilities = [
    policy?.probability_ratio_denominator_floor,
    policy?.minimum_candidate_probability,
    policy?.minimum_absolute_probability_increase,
  ];
  const horizonLimits = policy?.maximum_cumulative_probability_by_horizon;
  const requiredHorizons = ["4", "24", "72"];
  if (
    policy?.version !== LIVE_FORECAST_PROMOTION_GUARD_VERSION ||
    typeof policy.enabled !== "boolean" ||
    !Number.isInteger(policy.comparison_hours) ||
    policy.comparison_hours < 1 ||
    !Number.isFinite(policy.probability_ratio) ||
    policy.probability_ratio <= 1 ||
    !Number.isFinite(policy.probability_ratio_denominator_floor) ||
    policy.probability_ratio_denominator_floor <= 0 ||
    probabilities.some((value) =>
      !Number.isFinite(value) || value < 0 || value > 1
    ) ||
    !Number.isFinite(
      policy.minimum_combined_positive_clip_logit_contribution,
    ) ||
    policy.minimum_combined_positive_clip_logit_contribution <= 0 ||
    typeof policy.block_on_out_of_distribution_probability_anomaly !==
      "boolean" ||
    !horizonLimits ||
    typeof horizonLimits !== "object" ||
    Array.isArray(horizonLimits) ||
    Object.keys(horizonLimits).length !== requiredHorizons.length ||
    requiredHorizons.some((horizon) =>
      !Object.hasOwn(horizonLimits, horizon) ||
      !Number.isFinite(horizonLimits[horizon]) ||
      horizonLimits[horizon] <= 0 ||
      horizonLimits[horizon] >= 1
    ) ||
    !(
      horizonLimits["4"] <
      horizonLimits["24"] &&
      horizonLimits["24"] <
      horizonLimits["72"]
    )
  ) {
    throw new TypeError(
      "model.live_forecast_promotion_guard must use the supported versioned thresholds",
    );
  }
}

function modelRef(model) {
  if (!model) return null;
  return {
    model_version: model.model_version ?? null,
    artifact_hash: model.artifact_hash ?? null,
    model_contract_hash: model.model_contract_hash ?? null,
    training_cutoff: model.training_cutoff ?? null,
  };
}

function snapshotRef(snapshot) {
  return {
    record_id: snapshot.record_id,
    revision: snapshot.revision,
  };
}

function featureRow(snapshot, featureNames) {
  return featureNames.map((name) => {
    const value = Number(snapshot?.data?.features?.[name] ?? 0);
    if (!Number.isFinite(value)) {
      throw new TypeError(`Forecast snapshot feature ${name} must be finite`);
    }
    return value;
  });
}

function assertAuditableModelTransform(model, label) {
  if (
    !model ||
    !Array.isArray(model.feature_names) ||
    !Array.isArray(model.means) ||
    !Array.isArray(model.scales) ||
    !Array.isArray(model.weights) ||
    model.means.length !== model.feature_names.length ||
    model.scales.length !== model.feature_names.length ||
    model.weights.length !== model.feature_names.length + 1
  ) {
    throw new TypeError(`${label} model has an invalid feature transform shape`);
  }
  const clip = Number(model.feature_transform?.standardized_feature_clip);
  if (!Number.isFinite(clip) || clip <= 0) {
    throw new TypeError(`${label} model has no finite standardized feature clip`);
  }
  for (let index = 0; index < model.feature_names.length; index += 1) {
    if (
      !Number.isFinite(model.means[index]) ||
      !Number.isFinite(model.scales[index]) ||
      model.scales[index] <= 0 ||
      !Number.isFinite(model.weights[index + 1])
    ) {
      throw new TypeError(`${label} model feature transform must be finite`);
    }
  }
  return clip;
}

function rollingProbability(probabilities) {
  return 1 - probabilities.reduce(
    (survival, probability) => survival * (1 - probability),
    1,
  );
}

function probabilityComparison(candidate, previous, thresholds) {
  const denominator = Math.max(
    previous,
    thresholds.probability_ratio_denominator_floor,
  );
  const ratio = candidate / denominator;
  const absoluteIncrease = candidate - previous;
  return {
    previous,
    candidate,
    ratio,
    absolute_increase: absoluteIncrease,
    surge: Boolean(
      candidate >= thresholds.minimum_candidate_probability &&
      ratio >= thresholds.probability_ratio &&
      absoluteIncrease >= thresholds.minimum_absolute_probability_increase
    ),
  };
}

function candidateClipDiagnostics(model, rows, snapshots, thresholds) {
  const clip = model.feature_transform.standardized_feature_clip;
  const combinedBySnapshot = rows.map((row, rowIndex) => {
    let positiveContribution = 0;
    const featureNames = [];
    for (
      let featureIndex = 0;
      featureIndex < model.feature_names.length;
      featureIndex += 1
    ) {
      const standardized =
        (row[featureIndex] - model.means[featureIndex]) /
        model.scales[featureIndex];
      if (Math.abs(standardized) < clip) continue;
      const transformed = Math.max(-clip, Math.min(clip, standardized));
      const contribution =
        model.weights[featureIndex + 1] * transformed;
      if (contribution <= 0) continue;
      positiveContribution += contribution;
      featureNames.push(model.feature_names[featureIndex]);
    }
    return {
      snapshot_ref: snapshotRef(snapshots[rowIndex]),
      positive_logit_contribution: positiveContribution,
      feature_names: featureNames,
    };
  });
  const peakCombined = combinedBySnapshot.reduce(
    (peak, entry) =>
      entry.positive_logit_contribution >
        peak.positive_logit_contribution
        ? entry
        : peak,
    {
      snapshot_ref: null,
      positive_logit_contribution: 0,
      feature_names: [],
    },
  );
  const diagnostics = model.feature_names.map((featureName, featureIndex) => {
    let clippedSnapshotCount = 0;
    let peakPositiveContribution = 0;
    let peakAbsoluteStandardizedValue = 0;
    let firstClippedSnapshotRef = null;
    for (let index = 0; index < rows.length; index += 1) {
      const standardized =
        (rows[index][featureIndex] - model.means[featureIndex]) /
        model.scales[featureIndex];
      peakAbsoluteStandardizedValue = Math.max(
        peakAbsoluteStandardizedValue,
        Math.abs(standardized),
      );
      if (Math.abs(standardized) < clip) continue;
      clippedSnapshotCount += 1;
      firstClippedSnapshotRef ??= snapshotRef(snapshots[index]);
      const transformed = Math.max(-clip, Math.min(clip, standardized));
      peakPositiveContribution = Math.max(
        peakPositiveContribution,
        model.weights[featureIndex + 1] * transformed,
      );
    }
    if (clippedSnapshotCount === 0) return null;
    return {
      feature_name: featureName,
      clipped_snapshot_count: clippedSnapshotCount,
      peak_absolute_unclipped_standardized_value:
        peakAbsoluteStandardizedValue,
      peak_positive_logit_contribution: peakPositiveContribution,
      large_positive_contribution:
        peakPositiveContribution >=
          thresholds.minimum_combined_positive_clip_logit_contribution,
      first_clipped_snapshot_ref: firstClippedSnapshotRef,
    };
  }).filter(Boolean);
  return {
    standardized_feature_clip: clip,
    clipped_features: diagnostics,
    large_positive_clip_bound_features: diagnostics.filter(
      (entry) => entry.large_positive_contribution,
    ),
    peak_combined_positive_clip_logit_contribution: peakCombined,
    combined_positive_clip_logit_contribution_exceeded:
      peakCombined.positive_logit_contribution >=
        thresholds.minimum_combined_positive_clip_logit_contribution,
  };
}

export function assessLiveForecastPromotionGuard({
  candidate,
  previous = null,
  snapshots,
  policy = DEFAULT_LIVE_FORECAST_PROMOTION_GUARD_POLICY,
  thresholds: overrides = {},
} = {}) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new TypeError("Live forecast promotion guard requires feature snapshots");
  }
  assertLiveForecastPromotionGuardPolicy(policy);
  const {
    version: _version,
    enabled: _enabled,
    ...configuredThresholds
  } = policy;
  const thresholds = {
    ...configuredThresholds,
    ...overrides,
    maximum_cumulative_probability_by_horizon: {
      ...configuredThresholds.maximum_cumulative_probability_by_horizon,
      ...(overrides.maximum_cumulative_probability_by_horizon ?? {}),
    },
  };
  const horizonEntries = Object.entries(
    thresholds.maximum_cumulative_probability_by_horizon,
  )
    .map(([hours, maximum]) => [Number(hours), maximum])
    .sort((left, right) => left[0] - right[0]);
  const maximumHorizon = horizonEntries.at(-1)?.[0] ?? 0;
  if (
    !Number.isInteger(thresholds.comparison_hours) ||
    thresholds.comparison_hours < 1 ||
    snapshots.length < thresholds.comparison_hours ||
    !Number.isInteger(maximumHorizon) ||
    maximumHorizon < thresholds.comparison_hours ||
    snapshots.length < maximumHorizon
  ) {
    throw new RangeError(
      "Live forecast promotion guard horizons must fit the snapshots",
    );
  }
  assertAuditableModelTransform(candidate, "Candidate");
  if (previous) {
    assertAuditableModelTransform(previous, "Previous");
    if (
      candidate.feature_names.length !== previous.feature_names.length ||
      candidate.feature_names.some(
        (name, index) => name !== previous.feature_names[index],
      )
    ) {
      throw new TypeError(
        "Candidate and previous models must use the same ordered features",
      );
    }
  }

  const horizonSnapshots = snapshots.slice(0, maximumHorizon);
  const comparedSnapshots = horizonSnapshots.slice(
    0,
    thresholds.comparison_hours,
  );
  const candidateRows = horizonSnapshots.map((snapshot) =>
    featureRow(snapshot, candidate.feature_names)
  );
  const candidateHazards = candidateRows.map((row) =>
    predictHazard(candidate, row).probability
  );
  const clipDiagnostics = candidateClipDiagnostics(
    candidate,
    candidateRows,
    horizonSnapshots,
    thresholds,
  );
  const snapshotRefs = snapshots.map(snapshotRef);
  const outOfDistributionSnapshots = horizonSnapshots.filter(
    (snapshot) => snapshot?.data?.data_quality?.out_of_distribution === true,
  );
  const candidateCumulativeByHorizon = Object.fromEntries(
    horizonEntries.map(([hours, maximum]) => {
      const candidateProbability = rollingProbability(
        candidateHazards.slice(0, hours),
      );
      return [String(hours), {
        hours,
        previous: null,
        candidate: candidateProbability,
        maximum_allowed: maximum,
        safety_limit_exceeded: candidateProbability > maximum,
        surge: candidateProbability > maximum,
      }];
    }),
  );
  const base = {
    schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
    mode: !policy.enabled
      ? "disabled"
      : previous
        ? "enforced"
        : "bootstrap_enforced",
    passed: true,
    blockers: [],
    thresholds,
    candidate: modelRef(candidate),
    previous: modelRef(previous),
    snapshot_set: {
      snapshot_count: snapshots.length,
      compared_snapshot_count: comparedSnapshots.length,
      horizon_snapshot_count: horizonSnapshots.length,
      snapshot_refs_hash: hashLabel(snapshotRefs),
      first_snapshot_ref: snapshotRefs[0],
      last_snapshot_ref: snapshotRefs.at(-1),
      target: {
        start: snapshots[0]?.data?.target?.start ?? null,
        end: snapshots.at(-1)?.data?.target?.end ?? null,
      },
    },
    data_quality_audit: {
      out_of_distribution_snapshot_count:
        outOfDistributionSnapshots.length,
      blocking: false,
    },
    candidate_clip_diagnostics: clipDiagnostics,
    probability_comparison: null,
  };
  if (!policy.enabled) return base;
  const previousHazards = previous
    ? horizonSnapshots.map((snapshot) =>
      predictHazard(
        previous,
        featureRow(snapshot, previous.feature_names),
      ).probability
    )
    : null;
  const cumulativeByHorizon = Object.fromEntries(
    horizonEntries.map(([hours]) => {
      const candidateEntry =
        candidateCumulativeByHorizon[String(hours)];
      if (!previousHazards) return [String(hours), candidateEntry];
      const comparison = probabilityComparison(
        candidateEntry.candidate,
        rollingProbability(previousHazards.slice(0, hours)),
        thresholds,
      );
      return [String(hours), {
        hours,
        ...comparison,
        maximum_allowed: candidateEntry.maximum_allowed,
        safety_limit_exceeded:
          candidateEntry.safety_limit_exceeded,
      }];
    }),
  );
  const nearTermCandidateHazards = candidateHazards.slice(
    0,
    thresholds.comparison_hours,
  );
  const hourly = nearTermCandidateHazards.map((candidateHazard, index) => ({
    target: {
      start: comparedSnapshots[index]?.data?.target?.start ?? null,
      end: comparedSnapshots[index]?.data?.target?.end ?? null,
    },
    ...(previousHazards
      ? probabilityComparison(
        candidateHazard,
        previousHazards[index],
        thresholds,
      )
      : {
        previous: null,
        candidate: candidateHazard,
        ratio: null,
        absolute_increase: null,
        surge: false,
      }),
  }));
  const horizonSafetyBreaches = Object.values(cumulativeByHorizon)
    .filter((entry) => entry.safety_limit_exceeded)
    .map((entry) => entry.hours);
  const hasProbabilitySurge = previous
    ? Object.values(cumulativeByHorizon).some((entry) => entry.surge) ||
      hourly.some((entry) => entry.surge)
    : horizonSafetyBreaches.length > 0;
  const combinedClipContributionExceeded =
    clipDiagnostics.combined_positive_clip_logit_contribution_exceeded;
  const oodProbabilityAnomaly =
    policy.block_on_out_of_distribution_probability_anomaly &&
    outOfDistributionSnapshots.length > 0 &&
    hasProbabilitySurge;
  const blockers = [];
  if (horizonSafetyBreaches.length > 0) {
    blockers.push("candidate_cumulative_probability_exceeds_safety_limit");
  }
  if (combinedClipContributionExceeded) {
    blockers.push("combined_positive_clip_bound_contribution_exceeded");
  }
  if (oodProbabilityAnomaly) {
    blockers.push("probability_anomaly_on_out_of_distribution_snapshots");
  }
  const firstRolling = cumulativeByHorizon[
    String(thresholds.comparison_hours)
  ] ?? null;
  return {
    ...base,
    passed: blockers.length === 0,
    blockers,
    data_quality_audit: {
      ...base.data_quality_audit,
      blocking: oodProbabilityAnomaly,
    },
    probability_comparison: {
      first_rolling_4h: firstRolling,
      first_hourly_hazards: hourly,
      cumulative_by_horizon: cumulativeByHorizon,
      safety_limit_breach_horizons: horizonSafetyBreaches,
    },
  };
}
