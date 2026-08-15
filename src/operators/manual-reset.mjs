import { hashLabel } from "../core/hash.mjs";
import {
  OPERATOR_CONFIRMATION_KIND,
  OPERATOR_CONFIRMATION_POLICY_VERSION,
  OPERATOR_CONFIRMATION_PROVIDER,
  OPERATOR_CONFIRMATION_PROVIDER_VERSION,
} from "../core/operator-confirmation.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../core/outcome-contract.mjs";
import { createRecord, producer, recordRef } from "../core/records.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { halfOpenRange, toUtcIso } from "../core/time.mjs";
import {
  extractorContract,
  matchesExtractorContract,
} from "../core/extractor-contract.mjs";
import { scopeIncludesProduct } from "../core/product-scope.mjs";
import { outcomeAdjudicationContract } from "../pipeline/outcomes.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  appendRawObservationRevision,
  xStatusIdentity,
} from "../providers/raw.mjs";

const MINUTE_MS = 60_000;

function exactRefKey(reference) {
  return `${reference.record_id}@${reference.revision}`;
}

function operatorId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(normalized)) {
    throw new TypeError(
      "Manual confirmation actor must use 1-64 letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

function operatorNote(value) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > 500) {
    throw new RangeError("Manual confirmation note must not exceed 500 characters");
  }
  return normalized;
}

function minuteOccurrenceRange(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("Manual confirmation effective time is invalid");
  }
  timestamp.setUTCSeconds(0, 0);
  return halfOpenRange(
    timestamp,
    new Date(timestamp.getTime() + MINUTE_MS),
    "minute",
    "authenticated operator-reported effective minute",
  );
}

function matchingAuthorityPlan({ observations, signals, candidates, config, sourceStatus }) {
  const statusId = xStatusIdentity(sourceStatus);
  if (!statusId) {
    throw new TypeError("Manual confirmation requires an exact X status ID or URL");
  }
  const matchingObservationIds = new Set(observations
    .filter((observation) =>
      xStatusIdentity(observation.data.provider_item_id) === statusId ||
      xStatusIdentity(observation.data.canonical_url) === statusId
    )
    .map((observation) => observation.record_id));
  const extractor = extractorContract(config);
  const confirmationIds = confirmationIdentityIds(config);
  const eligibleSignals = selectCurrentSignals(signals)
    .filter((signal) => matchesExtractorContract(signal, extractor))
    .filter((signal) => signal.data.observation_refs.some((reference) =>
      matchingObservationIds.has(reference.record_id)
    ))
    .filter((signal) =>
      ["scheduled", "expected", "started", "completed"].includes(
        signal.data.claim.phase,
      ) &&
      ["quota_reset", "quota_refill"].includes(signal.data.claim.event_type) &&
      signal.data.claim.scope.population === "platform" &&
      signal.data.claim.scope.vendor === config.target.vendor &&
      scopeIncludesProduct(signal.data.claim.scope, config.target.product) &&
      confirmationIds.has(signal.data.provenance.source_identity_id) &&
      signal.data.provenance.source_role !== "aggregator" &&
      signal.data.provenance.derivation === "primary_statement"
    );
  const signalByRef = new Map(eligibleSignals.map((signal) => [
    exactRefKey(signal),
    signal,
  ]));
  const matches = candidates
    .flatMap((candidate) => candidate.data.evidence
      .map((entry) => ({
        candidate,
        signal: signalByRef.get(exactRefKey(entry.signal_ref)),
      })))
    .filter((entry) => entry.signal)
    .filter(({ candidate, signal }) =>
      candidate.data.event_type === signal.data.claim.event_type &&
      candidate.data.scope.population === "platform" &&
      candidate.data.scope.vendor === config.target.vendor &&
      scopeIncludesProduct(candidate.data.scope, config.target.product)
    )
    .sort((left, right) =>
      right.candidate.data.as_of.localeCompare(left.candidate.data.as_of) ||
      right.candidate.revision - left.candidate.revision ||
      left.candidate.record_id.localeCompare(right.candidate.record_id)
    );
  if (matches.length === 0) {
    throw new Error(
      `No current configured-authority platform reset candidate resolves to X status ${statusId}`,
    );
  }
  return { ...matches[0], statusId };
}

function outcomeCore(record) {
  if (!record) return null;
  return {
    status: record.data.status,
    label_policy_version: record.data.label_policy_version,
    event_identity: record.data.event_identity,
    event_type: record.data.event_type,
    scope: record.data.scope,
    occurred_time_range: record.data.occurred_time_range,
    label_grade: record.data.label_grade,
    verification: record.data.verification,
    candidate_refs: record.data.candidate_refs,
  };
}

export async function confirmManualPlatformReset(store, config, {
  sourceStatus,
  effectiveAt,
  actor,
  note = "",
  knownAt = new Date(),
} = {}) {
  const assertedAt = new Date(knownAt);
  if (!Number.isFinite(assertedAt.getTime())) {
    throw new TypeError("Manual confirmation known time is invalid");
  }
  const occurredRange = minuteOccurrenceRange(effectiveAt);
  if (Date.parse(occurredRange.end) > assertedAt.getTime()) {
    throw new RangeError("Manual confirmation effective interval cannot end in the future");
  }
  const normalizedActor = operatorId(actor);
  const normalizedNote = operatorNote(note);
  const [observations, signals, candidates, outcomes] = await Promise.all([
    store.all("raw_observation", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
    store.all("event_candidate"),
    store.all("reset_outcome"),
  ]);
  const plan = matchingAuthorityPlan({
    observations,
    signals,
    candidates,
    config,
    sourceStatus,
  });
  const sourceObservation = observations
    .filter((observation) => plan.signal.data.observation_refs.some((reference) =>
      reference.record_id === observation.record_id &&
      reference.revision === observation.revision
    ))
    .filter((observation) =>
      xStatusIdentity(observation.data.provider_item_id) === plan.statusId ||
      xStatusIdentity(observation.data.canonical_url) === plan.statusId
    )
    .sort((left, right) => right.revision - left.revision)[0];
  if (!sourceObservation) {
    throw new Error("Manual confirmation source observation is unavailable");
  }
  if (
    sourceObservation.data.published_at &&
    Date.parse(occurredRange.start) < Date.parse(sourceObservation.data.published_at)
  ) {
    throw new RangeError("Manual confirmation cannot precede its authority plan");
  }

  const eventIdentity = plan.candidate.data.event_cluster_id;
  const prior = outcomes.find((outcome) =>
    outcome.data.event_identity === eventIdentity ||
    outcome.data.candidate_refs?.some((reference) =>
      reference.record_id === plan.candidate.record_id
    )
  ) ?? null;
  if (
    prior?.data.status === "confirmed" &&
    prior.data.label_grade === "gold"
  ) {
    const priorVerification = prior.data.verification?.[0]?.observation_ref;
    const priorObservation = priorVerification
      ? observations.find((observation) =>
          exactRefKey(observation) === exactRefKey(priorVerification)
        ) ?? sourceObservation
      : sourceObservation;
    return {
      inserted: false,
      unchanged: true,
      reason: "already_officially_confirmed",
      outcome: prior,
      observation: priorObservation,
      candidate: plan.candidate,
    };
  }
  if (prior && ["rejected", "cancelled"].includes(prior.data.status)) {
    throw new Error("An official correction already rejects or cancels this reset event");
  }
  const assertionIdentity = {
    policy_version: OPERATOR_CONFIRMATION_POLICY_VERSION,
    event_identity: eventIdentity,
    occurred_time_range: occurredRange,
    actor: normalizedActor,
  };
  const assertionId = hashLabel(assertionIdentity).slice("sha256:".length);
  const sourceUrl = sourceObservation.data.canonical_url ??
    `https://x.com/i/status/${plan.statusId}`;
  const text = [
    `人工确认（silver）：操作员 ${normalizedActor} 确认该 Codex 平台重置已于 ${occurredRange.start} 生效。`,
    `关联权威动态：${sourceUrl}。`,
    normalizedNote ? `备注：${normalizedNote}` : null,
  ].filter(Boolean).join(" ");
  const manualItem = {
    provider_item_id: `operator-confirmation-${assertionId}`,
    canonical_url: null,
    published_at: assertedAt,
    author: {
      provider_author_id: normalizedActor,
      identity_id: `operator:${normalizedActor}`,
      display_handle: `人工确认 · ${normalizedActor}`,
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text,
      language: "zh",
    },
    selection_context: {
      feature_eligible: false,
      outcome_conditioned: false,
      selection_method: "authenticated_operator_platform_confirmation",
      linked_from: [sourceObservation.record_id],
    },
    source_timing: {
      source_published_at: toUtcIso(assertedAt),
      provider_observed_at: toUtcIso(assertedAt),
      availability_basis: "authenticated_operator_submission",
    },
    raw: {
      schema_version: "operator-platform-confirmation/1",
      assertion_id: assertionId,
      actor: normalizedActor,
      note: normalizedNote || null,
      source_observation_ref: recordRef(sourceObservation),
      source_signal_ref: recordRef(plan.signal),
      candidate_ref: recordRef(plan.candidate),
      occurred_time_range: occurredRange,
      asserted_at: toUtcIso(assertedAt),
    },
  };
  const priorManualObservation = observations
    .filter((observation) =>
      observation.data.ingest_provider === OPERATOR_CONFIRMATION_PROVIDER &&
      observation.data.provider_item_id === manualItem.provider_item_id
    )
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
  const manualObservation = priorManualObservation ?? (
    await appendRawObservationRevision(
      store,
      manualItem,
      {
        providerName: OPERATOR_CONFIRMATION_PROVIDER,
        providerVersion: OPERATOR_CONFIRMATION_PROVIDER_VERSION,
        config: { policy_version: OPERATOR_CONFIRMATION_POLICY_VERSION },
        firstSeenAt: assertedAt,
        fetchedAt: assertedAt,
        rawPayload: manualItem.raw,
      },
    )
  ).record;
  const verification = [{
    kind: OPERATOR_CONFIRMATION_KIND,
    observation_ref: recordRef(manualObservation),
    independence_group_id: `ind_operator_${assertionId.slice(0, 24)}`,
  }];
  const desiredCore = {
    status: "confirmed",
    label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
    event_identity: eventIdentity,
    event_type: plan.candidate.data.event_type,
    scope: plan.candidate.data.scope,
    occurred_time_range: occurredRange,
    label_grade: "silver",
    verification,
    candidate_refs: [recordRef(plan.candidate)],
  };
  if (JSON.stringify(outcomeCore(prior)) === JSON.stringify(desiredCore)) {
    return {
      inserted: false,
      unchanged: true,
      reason: "identical_operator_confirmation",
      outcome: prior,
      observation: manualObservation,
      candidate: plan.candidate,
    };
  }
  const adjudicationProducer = producer(
    "outcome-adjudicator",
    OUTCOME_ADJUDICATOR_VERSION,
    outcomeAdjudicationContract(config),
  );
  const created = createRecord({
    recordType: "reset_outcome",
    naturalKey: `operator-completed-event:${eventIdentity}`,
    createdAt: assertedAt,
    revision: prior ? prior.revision + 1 : 1,
    supersedes: prior ? recordRef(prior) : null,
    producer: adjudicationProducer,
    data: {
      ...desiredCore,
      known_at: toUtcIso(assertedAt),
      replay_available_at: null,
    },
  });
  const outcome = prior ? { ...created, record_id: prior.record_id } : created;
  const appended = await store.append(outcome);
  return {
    inserted: appended.inserted,
    unchanged: !appended.inserted,
    reason: appended.inserted ? "operator_confirmation_appended" : "idempotent_append",
    outcome: appended.record,
    observation: manualObservation,
    candidate: plan.candidate,
  };
}
