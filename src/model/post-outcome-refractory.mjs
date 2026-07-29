import { recordRef } from "../core/records.mjs";
import { clamp, HOUR_MS } from "../core/time.mjs";
import { AS_OF_MODE, outcomeAvailableAt } from "./as-of.mjs";
import { latestRecurrenceAnchorAsOf } from "./authority-timing.mjs";

export const POST_OUTCOME_REFRACTORY_POLICY_VERSION =
  "post-outcome-refractory-piecewise-hazard-multiplier/1";
export const POST_OUTCOME_REFRACTORY_SELECTION_BASIS =
  "latest_eligible_confirmed_outcome_available_at_cutoff";
export const POST_OUTCOME_REFRACTORY_TIME_BASIS =
  "occurred_time_range_end";
export const POST_OUTCOME_REFRACTORY_PRIOR_BASIS =
  "versioned_non_learned_minimum_inter_event_prior";

const EPSILON = 1e-12;

function horizonProbability(hazardEntries) {
  return 1 - hazardEntries.reduce(
    (survival, entry) => survival * (1 - clamp(entry.hazard, 0, 1)),
    1,
  );
}

function exactRefKey(record) {
  return `${record.record_id}@${record.revision}`;
}

function assertRecoveryCurve(curve) {
  if (!Array.isArray(curve) || curve.length < 2) {
    throw new TypeError(
      "Post-outcome refractory recovery_curve must contain at least two knots",
    );
  }
  for (const [index, knot] of curve.entries()) {
    if (
      !knot ||
      !Number.isFinite(knot.elapsed_hours) ||
      knot.elapsed_hours < 0 ||
      !Number.isFinite(knot.multiplier) ||
      knot.multiplier < 0 ||
      knot.multiplier > 1
    ) {
      throw new TypeError(
        "Post-outcome refractory knots require non-negative elapsed_hours and multipliers in [0,1]",
      );
    }
    if (index > 0) {
      const previous = curve[index - 1];
      if (
        knot.elapsed_hours <= previous.elapsed_hours ||
        knot.multiplier < previous.multiplier
      ) {
        throw new TypeError(
          "Post-outcome refractory recovery_curve must increase in time and recover monotonically",
        );
      }
    }
  }
  if (
    curve[0].elapsed_hours !== 0 ||
    curve[0].multiplier >= 1 ||
    curve.at(-1).multiplier !== 1
  ) {
    throw new TypeError(
      "Post-outcome refractory recovery_curve must start below one at zero hours and end at one",
    );
  }
}

export function assertPostOutcomeRefractoryPolicy(policy) {
  if (
    policy?.version !== POST_OUTCOME_REFRACTORY_POLICY_VERSION ||
    typeof policy.enabled !== "boolean" ||
    policy.outcome_selection_basis !==
      POST_OUTCOME_REFRACTORY_SELECTION_BASIS ||
    policy.time_basis !== POST_OUTCOME_REFRACTORY_TIME_BASIS ||
    policy.prior_basis !== POST_OUTCOME_REFRACTORY_PRIOR_BASIS
  ) {
    throw new TypeError(
      "model.post_outcome_refractory must use the supported piecewise hourly-hazard multiplier policy",
    );
  }
  assertRecoveryCurve(policy.recovery_curve);
}

export function postOutcomeRefractoryMultiplier(policy, elapsedHours) {
  assertPostOutcomeRefractoryPolicy(policy);
  if (!Number.isFinite(elapsedHours)) {
    throw new TypeError(
      "Post-outcome refractory elapsed hours must be finite",
    );
  }
  const elapsed = Math.max(0, elapsedHours);
  const curve = policy.recovery_curve;
  if (elapsed >= curve.at(-1).elapsed_hours) return 1;
  for (let index = 1; index < curve.length; index += 1) {
    const right = curve[index];
    if (elapsed > right.elapsed_hours) continue;
    const left = curve[index - 1];
    const fraction =
      (elapsed - left.elapsed_hours) /
      (right.elapsed_hours - left.elapsed_hours);
    return clamp(
      left.multiplier +
        fraction * (right.multiplier - left.multiplier),
      left.multiplier,
      right.multiplier,
    );
  }
  return 1;
}

function inactiveMetadata({
  policy,
  status,
  baseHorizonProbability,
  outcome = null,
  occurredTimeRange = null,
  recoveryEndAt = null,
  firstSlotMultiplier = null,
  asOfMode,
}) {
  const availableAt = outcome
    ? outcomeAvailableAt(outcome, asOfMode)
    : null;
  return {
    policy_version: policy.version,
    applied: false,
    status,
    outcome_selection_basis: policy.outcome_selection_basis,
    time_basis: policy.time_basis,
    prior_basis: policy.prior_basis,
    as_of_mode: asOfMode,
    outcome_ref: outcome ? recordRef(outcome) : null,
    outcome_known_at: outcome?.data.known_at ?? null,
    outcome_available_at: availableAt,
    outcome_occurred_time_range: occurredTimeRange,
    recovery_end_at: recoveryEndAt,
    first_slot_multiplier: firstSlotMultiplier,
    base_horizon_probability: baseHorizonProbability,
    conditioned_horizon_probability: baseHorizonProbability,
  };
}

export function conditionPostOutcomeRefractoryHazards({
  hazardEntries,
  signals = [],
  observations = [],
  outcomes = [],
  config,
  knowledgeCutoff,
  asOfMode = AS_OF_MODE.LIVE,
  excludedSourceRecordIds = new Set(),
  excludedIndependenceGroupIds = new Set(),
}) {
  if (!Array.isArray(hazardEntries) || hazardEntries.length === 0) {
    throw new TypeError(
      "Post-outcome refractory conditioning requires hazard entries",
    );
  }
  const policy = config.model.post_outcome_refractory;
  assertPostOutcomeRefractoryPolicy(policy);
  const baseHorizonProbability = horizonProbability(hazardEntries);
  if (!policy.enabled) {
    return {
      hazardEntries,
      metadata: inactiveMetadata({
        policy,
        status: "disabled",
        baseHorizonProbability,
        asOfMode,
      }),
    };
  }

  const anchor = latestRecurrenceAnchorAsOf({
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff,
    asOfMode,
    excludedSourceRecordIds,
    excludedIndependenceGroupIds,
  });
  if (!anchor) {
    return {
      hazardEntries,
      metadata: inactiveMetadata({
        policy,
        status: "no_eligible_outcome",
        baseHorizonProbability,
        asOfMode,
      }),
    };
  }
  const outcome = outcomes.find((candidate) =>
    exactRefKey(candidate) === exactRefKey(anchor.outcome_ref)
  );
  if (!outcome) {
    throw new Error(
      "Post-outcome refractory anchor does not resolve to an exact outcome revision",
    );
  }
  const availableAt = outcomeAvailableAt(outcome, asOfMode);
  if (Date.parse(availableAt) > Date.parse(knowledgeCutoff)) {
    throw new Error(
      "Post-outcome refractory outcome became available after the forecast cutoff",
    );
  }

  const anchorEnd = Date.parse(anchor.occurred_time_range.end);
  const recoveryHours = policy.recovery_curve.at(-1).elapsed_hours;
  const recoveryEndAt = new Date(
    anchorEnd + recoveryHours * HOUR_MS,
  ).toISOString();
  const multipliers = hazardEntries.map((entry) =>
    postOutcomeRefractoryMultiplier(
      policy,
      (Date.parse(entry.start) - anchorEnd) / HOUR_MS,
    )
  );
  const firstSlotMultiplier = multipliers[0];
  if (multipliers.every((multiplier) => multiplier >= 1 - EPSILON)) {
    return {
      hazardEntries,
      metadata: inactiveMetadata({
        policy,
        status: "recovered",
        baseHorizonProbability,
        outcome,
        occurredTimeRange: anchor.occurred_time_range,
        recoveryEndAt,
        firstSlotMultiplier: 1,
        asOfMode,
      }),
    };
  }

  const conditionedEntries = hazardEntries.map((entry, index) => {
    const multiplier = multipliers[index];
    return {
      ...entry,
      hazard: clamp(entry.hazard, 0, 1) * multiplier,
      interval80: Array.isArray(entry.interval80)
        ? entry.interval80.map((value) =>
            clamp(value, 0, 1) * multiplier
          )
        : null,
    };
  });
  return {
    hazardEntries: conditionedEntries,
    metadata: {
      policy_version: policy.version,
      applied: true,
      status: "active",
      outcome_selection_basis: policy.outcome_selection_basis,
      time_basis: policy.time_basis,
      prior_basis: policy.prior_basis,
      as_of_mode: asOfMode,
      outcome_ref: recordRef(outcome),
      outcome_known_at: outcome.data.known_at,
      outcome_available_at: availableAt,
      outcome_occurred_time_range: anchor.occurred_time_range,
      recovery_end_at: recoveryEndAt,
      first_slot_multiplier: firstSlotMultiplier,
      base_horizon_probability: baseHorizonProbability,
      conditioned_horizon_probability:
        horizonProbability(conditionedEntries),
    },
  };
}
