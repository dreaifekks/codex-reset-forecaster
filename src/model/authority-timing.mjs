import { recordRef } from "../core/records.mjs";
import { clamp } from "../core/time.mjs";
import {
  extractorContract,
  matchesExtractorContract,
} from "../core/extractor-contract.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  AS_OF_MODE,
  latestObservationsAsOf,
  latestOutcomesAsOf,
  latestSignalsAsOf,
  outcomeAvailableAt,
} from "./as-of.mjs";
import { isResetTimingSignalActiveAt } from "./signal-lifecycle.mjs";
import {
  isAuthorityTimingCandidateSignal,
  isAuthorityTimingSupportSignal,
} from "./authority-timing-eligibility.mjs";

const EPSILON = 1e-12;

export const AUTHORITY_TIMING_POLICY_VERSION =
  "authority-timing-first-event-mixture/2";
export const AUTHORITY_TIMING_RELIABILITY_BASIS =
  "versioned_prior_non_exhaustive_statement_history";
export const AUTHORITY_TIMING_WITHIN_WINDOW_MASS_BASIS =
  "tempered_baseline_first_event_mass";
export const DEFAULT_AUTHORITY_TIMING_WITHIN_WINDOW_BASELINE_POWER = 0.5;

function withinWindowBaselinePower(config) {
  return config.model?.authority_timing?.within_window_baseline_power ??
    DEFAULT_AUTHORITY_TIMING_WITHIN_WINDOW_BASELINE_POWER;
}

function exactRefKey(reference) {
  return `${reference.record_id}@${reference.revision}`;
}

function outcomeIsExcluded(
  outcome,
  excludedSourceRecordIds,
  excludedIndependenceGroupIds,
) {
  return excludedSourceRecordIds.has(outcome.record_id) ||
    (outcome.data.verification ?? []).some((entry) =>
      excludedSourceRecordIds.has(entry.observation_ref.record_id) ||
      excludedIndependenceGroupIds.has(entry.independence_group_id)
    );
}

function visibleEvidence({
  signals,
  observations,
  outcomes,
  config,
  knowledgeCutoff,
  asOfMode,
}) {
  const cutoff = new Date(knowledgeCutoff).toISOString();
  const visibleObservations = latestObservationsAsOf(
    observations,
    cutoff,
    asOfMode,
  );
  const visibleSignals = selectCurrentSignals(
    latestSignalsAsOf(signals, cutoff, asOfMode)
      .filter((signal) =>
        matchesExtractorContract(signal, extractorContract(config))
      ),
  );
  const outcomeContext = buildOutcomeEligibilityContext({
    observations: visibleObservations,
    signals: visibleSignals,
    config,
  });
  const visibleOutcomes = latestOutcomesAsOf(outcomes, cutoff, asOfMode)
    .filter((outcome) =>
      Date.parse(outcomeAvailableAt(outcome, asOfMode)) <= Date.parse(cutoff) &&
      isEligibleConfirmedOutcome(outcome, {
        ...outcomeContext,
        confirmationIdentityIds: confirmationIdentityIds(config),
      })
    )
    .sort((left, right) =>
      left.data.occurred_time_range.start.localeCompare(
        right.data.occurred_time_range.start,
      )
    );
  return {
    cutoff,
    observations: visibleObservations,
    signals: visibleSignals,
    outcomes: visibleOutcomes,
  };
}

export function latestRecurrenceAnchorAsOf({
  signals = [],
  observations = [],
  outcomes = [],
  config,
  knowledgeCutoff,
  asOfMode = AS_OF_MODE.LIVE,
  excludedSourceRecordIds = new Set(),
  excludedIndependenceGroupIds = new Set(),
}) {
  const visible = visibleEvidence({
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff,
    asOfMode,
  });
  const outcome = visible.outcomes.filter((candidate) =>
    !outcomeIsExcluded(
      candidate,
      excludedSourceRecordIds,
      excludedIndependenceGroupIds,
    )
  ).at(-1) ?? null;
  return outcome
    ? {
        outcome_ref: recordRef(outcome),
        occurred_time_range: outcome.data.occurred_time_range,
      }
    : null;
}

function authorityTimingCandidates({
  visible,
  config,
  horizonStart,
  excludedSourceRecordIds,
  excludedIndependenceGroupIds,
}) {
  const policy = config.model.authority_timing;
  const identities = confirmationIdentityIds(config);
  const observationsByRef = new Map(
    visible.observations.map((observation) => [
      exactRefKey(observation),
      observation,
    ]),
  );
  const authoritySignals = visible.signals.filter((signal) => {
    const observation = observationsByRef.get(
      exactRefKey(signal.data.observation_refs[0] ?? {}),
    );
    return isAuthorityTimingCandidateSignal({
      signal,
      observation,
      policy,
      confirmationIdentityIds: identities,
      targetScope: config.target,
      excludedSourceRecordIds,
      excludedIndependenceGroupIds,
    });
  });
  const latestContradictionAt = authoritySignals
    .filter((signal) => signal.data.claim.stance === "contradicts")
    .map((signal) => Date.parse(signal.data.available_at))
    .sort((left, right) => left - right)
    .at(-1) ?? -Infinity;
  const lifecycleOutcomes = visible.outcomes.filter((outcome) =>
    !outcomeIsExcluded(
      outcome,
      excludedSourceRecordIds,
      excludedIndependenceGroupIds,
    )
  );
  return authoritySignals
    .filter((signal) => {
      const observation = observationsByRef.get(
        exactRefKey(signal.data.observation_refs[0] ?? {}),
      );
      return isAuthorityTimingSupportSignal({
        signal,
        observation,
        policy,
        confirmationIdentityIds: identities,
        targetScope: config.target,
        excludedSourceRecordIds,
        excludedIndependenceGroupIds,
      }) &&
        Date.parse(signal.data.available_at) > latestContradictionAt &&
        isResetTimingSignalActiveAt(signal, {
          outcomes: lifecycleOutcomes,
          targetTime: horizonStart,
        });
    })
    .sort((left, right) =>
      right.data.available_at.localeCompare(left.data.available_at) ||
      String(right.record_id).localeCompare(String(left.record_id))
    );
}

export function selectAuthorityTimingSignalAsOf({
  signals = [],
  observations = [],
  outcomes = [],
  config,
  knowledgeCutoff,
  horizonStart,
  asOfMode = AS_OF_MODE.LIVE,
  excludedSourceRecordIds = new Set(),
  excludedIndependenceGroupIds = new Set(),
}) {
  if (config.model.authority_timing?.enabled !== true) return null;
  const visible = visibleEvidence({
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff,
    asOfMode,
  });
  return authorityTimingCandidates({
    visible,
    config,
    horizonStart,
    excludedSourceRecordIds,
    excludedIndependenceGroupIds,
  })[0] ?? null;
}

function firstEventMass(hazardEntries) {
  let survival = 1;
  const mass = hazardEntries.map((entry) => {
    const value = survival * clamp(entry.hazard, 0, 1);
    survival -= value;
    return value;
  });
  return { mass, noReset: Math.max(0, survival) };
}

function hazardsFromFirstEventMass(hazardEntries, masses) {
  let remaining = 1;
  return hazardEntries.map((entry, index) => {
    const mass = clamp(masses[index], 0, remaining);
    const hazard = remaining <= EPSILON ? 0 : clamp(mass / remaining, 0, 1);
    remaining = Math.max(0, remaining - mass);
    return {
      ...entry,
      hazard,
      interval80: null,
    };
  });
}

function overlapWithRange(entry, rangeStart, rangeEnd) {
  const entryStart = Date.parse(entry.start);
  const entryEnd = Date.parse(entry.end);
  const start = Math.max(entryStart, rangeStart);
  const end = Math.min(entryEnd, rangeEnd);
  return {
    entryStart,
    entryEnd,
    start,
    end,
    duration: Math.max(0, end - start),
  };
}

function durationUniformMass(hazardEntries, rangeStart, rangeEnd) {
  const duration = rangeEnd - rangeStart;
  return hazardEntries.map((entry) =>
    overlapWithRange(entry, rangeStart, rangeEnd).duration / duration
  );
}

function exposureHazard(hazard, exposureFraction) {
  const value = clamp(hazard, 0, 1);
  if (value >= 1) return exposureFraction > 0 ? 1 : 0;
  return clamp(
    -Math.expm1(exposureFraction * Math.log1p(-value)),
    0,
    1,
  );
}

function completeAllocationIntervals(entries, rangeStart, rangeEnd) {
  const intervals = entries
    .map((entry) => ({
      entry,
      ...overlapWithRange(entry, rangeStart, rangeEnd),
    }))
    .filter((interval) => interval.duration > 0)
    .sort((left, right) =>
      left.start - right.start || left.end - right.end
    );
  let cursor = rangeStart;
  for (const interval of intervals) {
    if (
      interval.entryEnd <= interval.entryStart ||
      interval.start !== cursor
    ) {
      return null;
    }
    cursor = interval.end;
  }
  return cursor === rangeEnd ? intervals : null;
}

function temperedAllocationMass(
  intervals,
  rangeStart,
  rangeEnd,
  baselinePower,
) {
  const duration = rangeEnd - rangeStart;
  let survival = 1;
  const weighted = intervals.map((interval) => {
    const fraction = interval.duration /
      (interval.entryEnd - interval.entryStart);
    const effectiveHazard = exposureHazard(
      interval.entry.hazard,
      fraction,
    );
    const baselineMass = survival * effectiveHazard;
    survival = Math.max(0, survival - baselineMass);
    return {
      ...interval,
      uniformMass: interval.duration / duration,
      baselineMass,
    };
  });
  const baselineTotal = weighted.reduce(
    (sum, entry) => sum + entry.baselineMass,
    0,
  );
  if (baselineTotal <= EPSILON) {
    return weighted.map((entry) => ({
      ...entry,
      authorityMass: entry.uniformMass,
    }));
  }
  const rawWeights = weighted.map((entry) => {
    const baselineShare = entry.baselineMass / baselineTotal;
    const densityRatio = baselineShare / entry.uniformMass;
    return entry.uniformMass * Math.pow(
      Math.max(EPSILON, densityRatio),
      baselinePower,
    );
  });
  const rawTotal = rawWeights.reduce((sum, value) => sum + value, 0);
  if (rawTotal <= EPSILON) {
    return weighted.map((entry) => ({
      ...entry,
      authorityMass: entry.uniformMass,
    }));
  }
  return weighted.map((entry, index) => ({
    ...entry,
    authorityMass: rawWeights[index] / rawTotal,
  }));
}

function authorityMass(
  hazardEntries,
  allocationHazardEntries,
  assertedRange,
  baselinePower,
) {
  const horizonStart = Date.parse(hazardEntries[0].start);
  const remainingStart = Math.max(
    horizonStart,
    Date.parse(assertedRange.start),
  );
  const remainingEnd = Date.parse(assertedRange.end);
  const duration = remainingEnd - remainingStart;
  if (!(duration > 0)) {
    return {
      mass: hazardEntries.map(() => 0),
      noReset: 1,
    };
  }
  const uniformMass = durationUniformMass(
    hazardEntries,
    remainingStart,
    remainingEnd,
  );
  const allocationIntervals = completeAllocationIntervals(
    allocationHazardEntries,
    remainingStart,
    remainingEnd,
  );
  if (allocationIntervals === null) {
    const coveredMass = clamp(
      uniformMass.reduce((sum, value) => sum + value, 0),
      0,
      1,
    );
    return {
      mass: uniformMass,
      noReset: clamp(1 - coveredMass, 0, 1),
    };
  }
  const allocationMass = temperedAllocationMass(
    allocationIntervals,
    remainingStart,
    remainingEnd,
    baselinePower,
  );
  const mass = hazardEntries.map((entry) => {
    const output = overlapWithRange(entry, remainingStart, remainingEnd);
    if (output.duration <= 0) return 0;
    return allocationMass.reduce((sum, allocation) => {
      const overlap = Math.max(
        0,
        Math.min(output.end, allocation.end) -
          Math.max(output.start, allocation.start),
      );
      return sum + allocation.authorityMass *
        overlap / allocation.duration;
    }, 0);
  });
  const coveredMass = clamp(
    mass.reduce((sum, value) => sum + value, 0),
    0,
    1,
  );
  return {
    mass,
    noReset: clamp(1 - coveredMass, 0, 1),
  };
}

export function conditionAuthorityTimingHazards({
  hazardEntries,
  allocationHazardEntries = hazardEntries,
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
    throw new TypeError("Authority timing conditioning requires hazard entries");
  }
  const base = firstEventMass(hazardEntries);
  const baseResetProbability = 1 - base.noReset;
  const selected = selectAuthorityTimingSignalAsOf({
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff,
    horizonStart: hazardEntries[0].start,
    asOfMode,
    excludedSourceRecordIds,
    excludedIndependenceGroupIds,
  });
  if (!selected) {
    return {
      hazardEntries,
      metadata: {
        policy_version: AUTHORITY_TIMING_POLICY_VERSION,
        applied: false,
        reliability_basis: AUTHORITY_TIMING_RELIABILITY_BASIS,
        within_window_mass_basis:
          AUTHORITY_TIMING_WITHIN_WINDOW_MASS_BASIS,
        within_window_baseline_power:
          withinWindowBaselinePower(config),
        phase: null,
        prior_reliability: null,
        signal_ref: null,
        asserted_time_range: null,
        base_horizon_probability: baseResetProbability,
        conditioned_horizon_probability: baseResetProbability,
      },
    };
  }

  const authority = authorityMass(
    hazardEntries,
    allocationHazardEntries,
    selected.data.claim.asserted_time_range,
    withinWindowBaselinePower(config),
  );
  const reliability = config.model.authority_timing.phase_reliability[
    selected.data.claim.phase
  ];
  const mixedMass = base.mass.map((value, index) =>
    (1 - reliability) * value + reliability * authority.mass[index]
  );
  const mixedNoReset =
    (1 - reliability) * base.noReset +
    reliability * authority.noReset;
  const conditioned = hazardsFromFirstEventMass(
    hazardEntries,
    mixedMass,
  );
  const reconstructedNoReset = 1 - mixedMass.reduce(
    (sum, value) => sum + value,
    0,
  );
  if (Math.abs(reconstructedNoReset - mixedNoReset) > 1e-9) {
    throw new Error("Authority timing mixture does not sum to one");
  }
  return {
    hazardEntries: conditioned,
    metadata: {
      policy_version: AUTHORITY_TIMING_POLICY_VERSION,
      applied: true,
      reliability_basis: AUTHORITY_TIMING_RELIABILITY_BASIS,
      within_window_mass_basis:
        AUTHORITY_TIMING_WITHIN_WINDOW_MASS_BASIS,
      within_window_baseline_power:
        withinWindowBaselinePower(config),
      phase: selected.data.claim.phase,
      prior_reliability: reliability,
      signal_ref: recordRef(selected),
      asserted_time_range: selected.data.claim.asserted_time_range,
      base_horizon_probability: baseResetProbability,
      conditioned_horizon_probability: 1 - mixedNoReset,
    },
  };
}
