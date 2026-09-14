import { pendingResetReviewRanges } from "../semantic-assistance/reset-review.mjs";
import { createRecord, producer, recordRef } from "../core/records.mjs";
import { hashLabel } from "../core/hash.mjs";
import { floorHour, halfOpenRange } from "../core/time.mjs";
import { normalizeCoverageIntervals } from "../pipeline/coverage.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
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

function overlaps(start, end, range) {
  return Date.parse(start) < Date.parse(range.end) && Date.parse(end) > Date.parse(range.start);
}

function covered(start, end, intervals) {
  return intervals.some((interval) =>
    Date.parse(interval.start) <= Date.parse(start) && Date.parse(interval.end) >= Date.parse(end),
  );
}

function sameDecision(previous, nextData) {
  return previous &&
    previous.data.status === nextData.status &&
    previous.data.coverage.complete === nextData.coverage.complete &&
    previous.data.coverage_as_of_mode === nextData.coverage_as_of_mode &&
    previous.data.outcome_as_of_mode === nextData.outcome_as_of_mode &&
    previous.data.coverage_assertion_snapshot_hash ===
      nextData.coverage_assertion_snapshot_hash &&
    JSON.stringify(previous.data.coverage_assertion_refs) ===
      JSON.stringify(nextData.coverage_assertion_refs) &&
    JSON.stringify(previous.data.outcome_refs) === JSON.stringify(nextData.outcome_refs);
}

export async function settleIssuedPredictions(store, config, {
  settlementCutoff = floorHour(new Date()),
} = {}) {
  const cutoff = floorHour(settlementCutoff);
  const [
    predictions,
    outcomeRevisions,
    signals,
    observations,
    coverageAssertionRecords,
    existing,
  ] = await Promise.all([
    store.all("prediction"),
    store.all("reset_outcome", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    coverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
    store.all("prediction_settlement"),
  ]);
  const currentCoverageAssertions = adequateCoverageAssertionsAsOf(
    coverageAssertionRecords,
    cutoff,
    config.model.outcome_coverage_providers,
    COVERAGE_AS_OF_MODE.LIVE,
  );
  const currentSignals = selectCurrentSignals(latestSignalsAsOf(
    signals,
    cutoff,
    AS_OF_MODE.LIVE,
  ));
  const pendingReviewRanges = pendingResetReviewRanges(latestSignalsAsOf(signals, cutoff, AS_OF_MODE.LIVE), config);
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
  const priorByPrediction = new Map(
    existing.map((settlement) => [settlement.data.prediction_ref.record_id, settlement]),
  );
  const records = [];

  for (const prediction of predictions) {
    if (prediction.data.slots.length < 4) continue;
    const start = prediction.data.slots[0].start;
    const end = prediction.data.slots[3].end;
    const matchingOutcomes = outcomes.filter((outcome) =>
      overlaps(start, end, outcome.data.occurred_time_range),
    );
    const matchingAmbiguousOutcomes = ambiguousOutcomes.filter((outcome) =>
      overlaps(start, end, outcome.data.occurred_time_range),
    );
    const matchingCoverageAssertions = currentCoverageAssertions
      .filter((assertion) => overlaps(start, end, assertion))
      .sort((left, right) =>
        left.assertion_id.localeCompare(right.assertion_id) ||
        left.revision - right.revision,
      );
    const coverageComplete = covered(
      start,
      end,
      normalizeCoverageIntervals(matchingCoverageAssertions),
    );
    let status;
    let reason;
    if (Date.parse(end) > cutoff.getTime()) {
      status = "pending";
      reason = "issued four-hour window has not matured";
    } else if (matchingOutcomes.length > 0) {
      status = "positive";
      reason = "confirmed outcome overlaps the issued four-hour window";
    } else if (matchingAmbiguousOutcomes.length > 0) {
      status = "censored";
      reason = "window overlaps an outcome record that does not satisfy the current label policy";
    } else if (pendingReviewRanges.some((range) => overlaps(start, end, range))) {
      status = "censored";
      reason = "window overlaps an unresolved authority reset review";
    } else if (coverageComplete) {
      status = "negative";
      reason = "window matured with complete confirmation-source coverage and no outcome";
    } else {
      status = "censored";
      reason = "window matured without complete confirmation-source coverage";
    }
    const data = {
      prediction_ref: recordRef(prediction),
      slot_index: 0,
      window: halfOpenRange(start, end, "hour"),
      display_horizon: "PT4H",
      status,
      settled_at: cutoff.toISOString(),
      outcome_as_of_mode: AS_OF_MODE.LIVE,
      coverage_as_of_mode: COVERAGE_AS_OF_MODE.LIVE,
      outcome_refs: matchingOutcomes.map(recordRef),
      coverage_assertion_refs: matchingCoverageAssertions.map((assertion) => ({
        assertion_id: assertion.assertion_id,
        revision: assertion.revision,
      })),
      coverage_assertion_snapshot_hash: hashLabel(
        matchingCoverageAssertions,
      ),
      coverage: {
        complete: coverageComplete,
        providers: [...config.model.outcome_coverage_providers],
      },
      reason,
    };
    const prior = priorByPrediction.get(prediction.record_id);
    if (sameDecision(prior, data)) continue;
    records.push(createRecord({
      recordType: "prediction_settlement",
      naturalKey: `${prediction.record_id}:slot-0:PT4H`,
      createdAt: cutoff,
      revision: prior ? prior.revision + 1 : 1,
      supersedes: prior ? recordRef(prior) : null,
      producer: producer("prediction-settler", "0.2.0", {
        outcome_coverage_providers: config.model.outcome_coverage_providers,
      }),
      data,
    }));
  }
  const results = await store.appendMany(records);
  return {
    inserted: results.filter((result) => result.inserted).length,
    records,
  };
}
