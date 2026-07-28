import { latestRevisionsAsOf } from "../core/revisions.mjs";
import { timestampMillis } from "../core/time.mjs";

export const AS_OF_MODE = Object.freeze({
  LIVE: "live",
  ARCHIVE_REPLAY: "archive_replay",
  SYNTHETIC_REPLAY: "synthetic_replay",
});

export function assertAsOfMode(mode) {
  if (!Object.values(AS_OF_MODE).includes(mode)) {
    throw new TypeError(`Unsupported model as-of mode: ${mode}`);
  }
}

function latestByAvailability(records, cutoff, availableAt) {
  const cutoffMs = timestampMillis(cutoff);
  const selected = new Map();
  for (const record of records) {
    const available = availableAt(record);
    if (!available || timestampMillis(available) > cutoffMs) continue;
    const previous = selected.get(record.record_id);
    if (!previous || record.revision > previous.revision) {
      selected.set(record.record_id, record);
    }
  }
  return [...selected.values()];
}

export function outcomeAvailableAt(outcome, mode = AS_OF_MODE.LIVE) {
  assertAsOfMode(mode);
  // Only an initial adjudication may use an attested historical replay clock.
  // Corrections and policy/config/extractor-driven revisions become available
  // when that revision was actually adjudicated, even if they retain a stale
  // replay_available_at from an older record or import.
  if (outcome.revision !== 1 || outcome.supersedes !== null) {
    return outcome.data.known_at;
  }
  if (mode === AS_OF_MODE.ARCHIVE_REPLAY) {
    return outcome.data.replay_available_at ?? outcome.data.known_at;
  }
  if (mode === AS_OF_MODE.SYNTHETIC_REPLAY) {
    return outcome.data.replay_available_at ??
      outcome.data.occurred_time_range?.end ??
      outcome.data.known_at;
  }
  return outcome.data.known_at;
}

export function latestOutcomesAsOf(records, cutoff, mode = AS_OF_MODE.LIVE) {
  assertAsOfMode(mode);
  if (mode === AS_OF_MODE.LIVE) {
    return latestRevisionsAsOf(records, cutoff, (outcome) => outcome.data.known_at);
  }
  return latestByAvailability(
    records,
    cutoff,
    (outcome) => outcomeAvailableAt(outcome, mode),
  );
}

export function latestSignalsAsOf(records, cutoff, mode = AS_OF_MODE.LIVE) {
  assertAsOfMode(mode);
  if (mode === AS_OF_MODE.LIVE) {
    return latestRevisionsAsOf(records, cutoff, (signal) => signal.data.available_at);
  }
  // The archive importer may attest the first normalized revision to an earlier
  // model-usable time while retaining the real canonical created_at. Later
  // corrections carry their real correction time in available_at.
  return latestByAvailability(records, cutoff, (signal) => signal.data.available_at);
}

export function latestObservationsAsOf(records, cutoff, mode = AS_OF_MODE.LIVE) {
  assertAsOfMode(mode);
  if (mode === AS_OF_MODE.LIVE) {
    return latestRevisionsAsOf(
      records,
      cutoff,
      (observation) => observation.data.first_seen_at,
    );
  }
  return latestByAvailability(records, cutoff, (observation) => {
    if (mode === AS_OF_MODE.SYNTHETIC_REPLAY) {
      return observation.data.first_seen_at;
    }
    if (observation.revision === 1) {
      return observation.data.availability_attestation?.available_at ??
        observation.data.first_seen_at;
    }
    return observation.data.fetched_at ?? observation.created_at;
  });
}

export function asOfModeForEvidence(observations, outcomeCoverageProviders) {
  const providers = new Set(outcomeCoverageProviders);
  const hasVerifiedArchiveEvidence = observations.some((observation) => {
    if (providers.size > 0 && !providers.has(observation.data.ingest_provider)) return false;
    const attestation = observation.data.availability_attestation;
    return attestation &&
      Date.parse(attestation.available_at) < Date.parse(observation.data.first_seen_at);
  });
  return hasVerifiedArchiveEvidence ? AS_OF_MODE.ARCHIVE_REPLAY : AS_OF_MODE.LIVE;
}
