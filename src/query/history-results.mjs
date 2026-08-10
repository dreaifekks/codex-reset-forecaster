import { confirmationIdentityIds } from "../core/sources.mjs";
import {
  buildOutcomeEligibilityContext,
  eligibleConfirmedOutcomeVerifications,
} from "../pipeline/outcomes.mjs";

export function exactRecordKey(recordOrRef) {
  return `${recordOrRef.record_id}@${recordOrRef.revision}`;
}

export function latestOutcomeRevisions(outcomes) {
  return [...Map.groupBy(outcomes, (item) => item.record_id).values()]
    .map((revisions) => [...revisions]
      .sort((left, right) => left.revision - right.revision)
      .at(-1));
}

export function projectLatestOutcomeEligibility({
  outcomes,
  observations,
  signals,
  config,
}) {
  const context = {
    ...buildOutcomeEligibilityContext({ observations, signals, config }),
    confirmationIdentityIds: confirmationIdentityIds(config),
  };
  const observationsByRef = new Map(
    observations.map((item) => [exactRecordKey(item), item]),
  );
  return latestOutcomeRevisions(outcomes).map((outcome) => {
    const verification = eligibleConfirmedOutcomeVerifications(
      outcome,
      context,
    )[0] ?? null;
    const verificationRef = verification?.observation_ref ?? null;
    return {
      outcome,
      verification,
      source: verificationRef
        ? observationsByRef.get(exactRecordKey(verificationRef)) ?? null
        : null,
    };
  });
}

export function latestEligibleConfirmedOutcomes(input) {
  return projectLatestOutcomeEligibility(input).filter((item) => item.verification);
}

export function confirmedOutcomeHistoryRow(
  outcome,
  sourceOrObservationMap = null,
  verification = null,
) {
  const verificationRef = verification?.observation_ref ??
    outcome.data.verification?.[0]?.observation_ref ?? null;
  const source = sourceOrObservationMap instanceof Map && verificationRef
    ? sourceOrObservationMap.get(exactRecordKey(verificationRef)) ?? null
    : sourceOrObservationMap;
  return {
    outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
    status: "confirmed",
    occurred_time_range: outcome.data.occurred_time_range,
    known_at: outcome.data.known_at,
    label_grade: outcome.data.label_grade,
    source: source ? {
      observation_ref: verificationRef,
      canonical_url: source.data.canonical_url,
      display_handle: source.data.author?.display_handle ?? null,
      text: source.data.content?.text ?? null,
      published_at: source.data.published_at,
    } : null,
  };
}

export async function loadOutcomePublicationProjection(store, config) {
  const [outcomes, signals] = await Promise.all([
    store.all("reset_outcome", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
  ]);
  const verificationRefs = [
    ...new Map(
      outcomes
        .flatMap((outcome) => outcome.data.verification ?? [])
        .map((entry) => entry.observation_ref)
        .filter(Boolean)
        .map((reference) => [exactRecordKey(reference), reference]),
    ).values(),
  ];
  const observations = await store.allByRefs(
    "raw_observation",
    verificationRefs,
  );
  return projectLatestOutcomeEligibility({
    outcomes,
    observations,
    signals,
    config,
  });
}

export async function loadConfirmedHistoryResults(store, config) {
  return (await loadOutcomePublicationProjection(store, config))
    .filter((item) => item.verification)
    .sort((left, right) =>
      right.outcome.data.occurred_time_range.start.localeCompare(
        left.outcome.data.occurred_time_range.start,
      ) ||
      right.outcome.data.known_at.localeCompare(left.outcome.data.known_at) ||
      left.outcome.record_id.localeCompare(right.outcome.record_id) ||
      right.outcome.revision - left.outcome.revision
    )
    .map(({ outcome, source, verification }) =>
      confirmedOutcomeHistoryRow(outcome, source, verification)
    );
}
