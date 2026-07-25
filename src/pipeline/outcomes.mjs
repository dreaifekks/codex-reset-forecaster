import { createRecord, producer, recordRef } from "../core/records.mjs";
import { addHours, floorHour, halfOpenRange } from "../core/time.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { extractorContract } from "../core/extractor-contract.mjs";
import { eventTypeFamily } from "../core/event-types.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../core/outcome-contract.mjs";
import { selectCurrentSignals } from "./signal-selection.mjs";
import {
  sameProductScope,
  scopeIncludesProduct,
} from "../core/product-scope.mjs";

export {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
};

function exactRefKey(reference) {
  return `${reference.record_id}@${reference.revision}`;
}

function preserveOutcomeRecordId(record, prior) {
  return prior ? { ...record, record_id: prior.record_id } : record;
}

export function buildOutcomeEligibilityContext({ observations, signals, config = null }) {
  const observationsByExactRef = new Map(
    observations.map((observation) => [exactRefKey(observation), observation]),
  );
  const currentSignalsByObservationId = new Map(
    selectCurrentSignals(signals).flatMap((signal) =>
      signal.data.observation_refs.map((reference) => [reference.record_id, signal])
    ),
  );
  return {
    observationsByExactRef,
    currentSignalsByObservationId,
    expectedExtractor: config ? extractorContract(config) : null,
    target: config?.target ?? null,
  };
}

export function isEligibleConfirmedOutcome(outcome, {
  observationsByExactRef = new Map(),
  currentSignalsByObservationId = new Map(),
  confirmationIdentityIds: allowedConfirmationIds = null,
  expectedExtractor = null,
  target = null,
} = {}) {
  if (
    outcome.data.status !== "confirmed" ||
    !outcome.data.occurred_time_range ||
    !Array.isArray(outcome.data.verification) ||
    outcome.data.verification.length === 0 ||
    outcome.data.label_policy_version !== OUTCOME_LABEL_POLICY_VERSION ||
    typeof outcome.data.event_identity !== "string" ||
    outcome.data.event_identity.length === 0 ||
    !Array.isArray(outcome.data.candidate_refs) ||
    outcome.data.candidate_refs.length === 0 ||
    outcome.producer?.name !== "outcome-adjudicator" ||
    outcome.producer?.version !== OUTCOME_ADJUDICATOR_VERSION ||
    !expectedExtractor
  ) return false;
  if (
    target &&
    (
      outcome.data.scope.vendor !== target.vendor ||
      !scopeIncludesProduct(outcome.data.scope, target.product) ||
      outcome.data.scope.population !== target.population ||
      (target.quota_bucket != null &&
        outcome.data.scope.quota_bucket !== target.quota_bucket)
    )
  ) return false;
  return outcome.data.verification.some((entry) => {
    const observation = observationsByExactRef.get(exactRefKey(entry.observation_ref));
    if (!observation) return false;
    if (
      entry.kind !== "official_confirmation"
    ) return false;
    const signal = currentSignalsByObservationId.get(entry.observation_ref.record_id);
    if (!signal) return false;
    const exactSignalReference = signal.data.observation_refs.some((reference) =>
      reference.record_id === entry.observation_ref.record_id &&
      reference.revision === entry.observation_ref.revision
    );
    if (!exactSignalReference) return false;
    if (
      signal.data.claim.phase !== "completed" ||
      eventTypeFamily(signal.data.claim.event_type) !==
        eventTypeFamily(outcome.data.event_type) ||
      signal.data.claim.scope.population !== "platform" ||
      signal.data.claim.scope.vendor !== outcome.data.scope.vendor ||
      !sameProductScope(signal.data.claim.scope, outcome.data.scope) ||
      signal.data.provenance.derivation !== "primary_statement" ||
      signal.data.provenance.source_role === "aggregator" ||
      observation.data.content.media_type !== "text/plain" ||
      signal.producer?.name !== "rule-claim-extractor" ||
      signal.producer?.version !== expectedExtractor.model_version ||
      signal.data.extraction.model !== expectedExtractor.model ||
      signal.data.extraction.model_version !== expectedExtractor.model_version ||
      signal.data.extraction.prompt_version !== expectedExtractor.prompt_version ||
      signal.data.extraction.semantic_policy_hash !== expectedExtractor.semantic_policy_hash
    ) return false;
    return !allowedConfirmationIds ||
      allowedConfirmationIds.has(signal.data.provenance.source_identity_id);
  });
}

function inferredOccurrenceRange(signal, observation) {
  const asserted = signal.data.claim.asserted_time_range;
  if (asserted && Date.parse(asserted.start) <= Date.parse(signal.data.available_at)) return asserted;
  const anchor = floorHour(observation.data.published_at ?? signal.data.available_at);
  return halfOpenRange(anchor, addHours(anchor, 1), "interval_observed", "official notification-hour adjudication");
}

function observationPreference(observation) {
  if (observation.data.ingest_provider === "x") return 0;
  if (observation.data.ingest_provider === "historical_monitor") return 1;
  if (observation.data.ingest_provider.startsWith("x_search_gateway_socialdata")) return 2;
  return 3;
}

export async function adjudicateOutcomes(store, config, { knownAt = null, now = new Date() } = {}) {
  const signals = selectCurrentSignals(await store.all("normalized_signal"));
  const observations = new Map(
    (await store.all("raw_observation", { latestOnly: false })).map((observation) => [
      `${observation.record_id}@${observation.revision}`,
      observation,
    ]),
  );
  const candidates = [...Map.groupBy(
    await store.all("event_candidate"),
    (candidate) => candidate.data.event_cluster_id,
  ).values()].map((versions) =>
    [...versions].sort((left, right) =>
      right.data.as_of.localeCompare(left.data.as_of) ||
      right.revision - left.revision ||
      right.created_at.localeCompare(left.created_at)
    )[0]
  );
  const existing = await store.all("reset_outcome");
  const confirmationIds = confirmationIdentityIds(config);
  const records = [];
  const confirmedEventIdentities = new Set();

  const signalsById = new Map(signals.map((signal) => [signal.record_id, signal]));
  for (const candidate of candidates) {
    if (!["quota_reset", "quota_refill"].includes(candidate.data.event_type)) continue;
    const directCompleted = candidate.data.evidence
      .map((entry) => signalsById.get(entry.signal_ref.record_id))
      .filter(Boolean)
      .filter((signal) => {
        const claim = signal.data.claim;
        if (claim.phase !== "completed" || claim.scope.population !== "platform") return false;
        if (
          claim.scope.vendor !== config.target.vendor ||
          !scopeIncludesProduct(claim.scope, config.target.product)
        ) return false;
        if (!confirmationIds.has(signal.data.provenance.source_identity_id)) return false;
        if (signal.data.provenance.source_role === "aggregator") return false;
        if (signal.data.provenance.derivation !== "primary_statement") return false;
        const reference = signal.data.observation_refs[0];
        const observation = observations.get(`${reference.record_id}@${reference.revision}`);
        return observation?.data.content.media_type === "text/plain";
      })
      .map((signal) => {
        const reference = signal.data.observation_refs[0];
        return {
          signal,
          observation: observations.get(`${reference.record_id}@${reference.revision}`),
        };
      });
    if (directCompleted.length === 0) continue;

    const verificationByRoot = new Map();
    for (const entry of directCompleted) {
      const root = entry.signal.data.provenance.independence_group_id;
      const previous = verificationByRoot.get(root);
      if (
        !previous ||
        observationPreference(entry.observation) < observationPreference(previous.observation) ||
        (
          observationPreference(entry.observation) === observationPreference(previous.observation) &&
          entry.signal.data.available_at < previous.signal.data.available_at
        )
      ) {
        verificationByRoot.set(root, entry);
      }
    }
    const verificationEntries = [...verificationByRoot.values()]
      .sort((left, right) =>
        left.signal.data.available_at.localeCompare(right.signal.data.available_at) ||
        left.observation.record_id.localeCompare(right.observation.record_id)
      );
    const primary = verificationEntries[0];
    const occurrence = inferredOccurrenceRange(primary.signal, primary.observation);
    const attestedAvailability = primary.observation.data.availability_attestation?.available_at;
    const replayAvailableAt = attestedAvailability &&
        Date.parse(attestedAvailability) < Date.parse(primary.observation.data.first_seen_at)
      ? new Date(attestedAvailability).toISOString()
      : null;
    const verificationObservationIds = new Set(
      verificationEntries.map(({ observation }) => observation.record_id),
    );
    const verificationGroups = new Set(
      verificationEntries.map(({ signal }) => signal.data.provenance.independence_group_id),
    );
    const prior = existing.find((outcome) =>
      outcome.data.event_identity === candidate.data.event_cluster_id ||
      outcome.data.candidate_refs?.some((reference) => reference.record_id === candidate.record_id) ||
      outcome.data.verification?.some((entry) =>
        verificationObservationIds.has(entry.observation_ref.record_id) ||
        verificationGroups.has(entry.independence_group_id)
      )
    ) ?? null;
    const eventIdentity = prior?.data.event_identity ?? candidate.data.event_cluster_id;
    confirmedEventIdentities.add(eventIdentity);
    const verification = verificationEntries.map(({ signal, observation }) => ({
      kind: "official_confirmation",
      observation_ref: recordRef(observation),
      independence_group_id: signal.data.provenance.independence_group_id,
    }));
    const desiredSignature = JSON.stringify({
      event_identity: eventIdentity,
      label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
      event_type: primary.signal.data.claim.event_type,
      scope: candidate.data.scope,
      occurred_time_range: occurrence,
      replay_available_at: replayAvailableAt,
      verification,
      candidate_ref: recordRef(candidate),
    });
    const priorSignature = prior ? JSON.stringify({
      event_identity: prior.data.event_identity,
      label_policy_version: prior.data.label_policy_version,
      event_type: prior.data.event_type,
      scope: prior.data.scope,
      occurred_time_range: prior.data.occurred_time_range,
      replay_available_at: prior.data.replay_available_at ?? null,
      verification: prior.data.verification,
      candidate_ref: prior.data.candidate_refs?.[0] ?? null,
    }) : null;
    if (desiredSignature === priorSignature) continue;
    const outcomeKnownAt = knownAt ?? now;
    records.push(preserveOutcomeRecordId(createRecord({
      recordType: "reset_outcome",
      naturalKey: `official-completed-event:${eventIdentity}`,
      createdAt: outcomeKnownAt,
      revision: prior ? prior.revision + 1 : 1,
      supersedes: prior ? recordRef(prior) : null,
      producer: producer("outcome-adjudicator", OUTCOME_ADJUDICATOR_VERSION, {
        confirmation_policy: OUTCOME_LABEL_POLICY_VERSION,
      }),
      data: {
        status: "confirmed",
        label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
        event_identity: eventIdentity,
        event_type: primary.signal.data.claim.event_type,
        scope: candidate.data.scope,
        occurred_time_range: occurrence,
        known_at: new Date(outcomeKnownAt).toISOString(),
        replay_available_at: replayAvailableAt,
        label_grade: "gold",
        verification,
        candidate_refs: [recordRef(candidate)],
      },
    }), prior));
  }

  for (const prior of existing) {
    const eventIdentity = prior.data.event_identity;
    if (
      !eventIdentity ||
      prior.data.status !== "confirmed" ||
      confirmedEventIdentities.has(eventIdentity)
    ) continue;
    const candidate = candidates.find((item) => item.data.event_cluster_id === eventIdentity);
    if (!candidate) continue;
    const priorObservationIds = new Set(
      prior.data.verification.map((entry) => entry.observation_ref.record_id),
    );
    const correction = candidate.data.evidence
      .map((entry) => signalsById.get(entry.signal_ref.record_id))
      .filter(Boolean)
      .filter((signal) =>
        ["denied", "cancelled"].includes(signal.data.claim.phase) &&
        eventTypeFamily(signal.data.claim.event_type) ===
          eventTypeFamily(prior.data.event_type) &&
        signal.data.claim.scope.population === "platform" &&
        confirmationIds.has(signal.data.provenance.source_identity_id) &&
        signal.data.provenance.source_role !== "aggregator" &&
        signal.data.provenance.derivation === "primary_statement" &&
        signal.data.observation_refs.some((reference) =>
          priorObservationIds.has(reference.record_id)
        )
      )
      .map((signal) => {
        const reference = signal.data.observation_refs[0];
        return {
          signal,
          observation: observations.get(`${reference.record_id}@${reference.revision}`),
        };
      })
      .filter((entry) => entry.observation)
      .sort((left, right) =>
        right.signal.data.available_at.localeCompare(left.signal.data.available_at)
      )[0];
    if (!correction) continue;
    const outcomeKnownAt = knownAt ?? now;
    records.push(preserveOutcomeRecordId(createRecord({
      recordType: "reset_outcome",
      naturalKey: `official-completed-event:${eventIdentity}`,
      createdAt: outcomeKnownAt,
      revision: prior.revision + 1,
      supersedes: recordRef(prior),
      producer: producer("outcome-adjudicator", OUTCOME_ADJUDICATOR_VERSION, {
        confirmation_policy: OUTCOME_LABEL_POLICY_VERSION,
      }),
      data: {
        status: correction.signal.data.claim.phase === "cancelled"
          ? "cancelled"
          : "rejected",
        label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
        event_identity: eventIdentity,
        event_type: prior.data.event_type,
        scope: prior.data.scope,
        occurred_time_range: null,
        known_at: new Date(outcomeKnownAt).toISOString(),
        replay_available_at: null,
        label_grade: "gold",
        verification: [{
          kind: "official_confirmation",
          observation_ref: recordRef(correction.observation),
          independence_group_id: correction.signal.data.provenance.independence_group_id,
        }],
        candidate_refs: [recordRef(candidate)],
      },
    }), prior));
  }
  const results = await store.appendMany(records);
  return { adjudicated: results.filter((result) => result.inserted).length, records };
}
