import { hashLabel } from "../core/hash.mjs";

const PREFERENCES_SCHEMA_VERSION = "notification-preferences/1";
const WATCH_STATE_SCHEMA_VERSION = "notification-probability-watch-state/2";
const LEGACY_WATCH_STATE_SCHEMA_VERSION =
  "notification-probability-watch-state/1";
const DEFAULT_HORIZON_HOURS = 4;
const DEFAULT_PROBABILITY_THRESHOLD = 0.5;
const DEFAULT_HYSTERESIS_MARGIN = 0.05;
const MAX_HORIZON_HOURS = 168;
const MIN_PROBABILITY_THRESHOLD = 0.01;
const MAX_PROBABILITY_THRESHOLD = 0.99;

const PREFERENCE_FIELDS = new Set([
  "schema_version",
  "horizon_hours",
  "probability_threshold",
]);

function plainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function utcTimestamp(value) {
  return typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value));
}

function recordRef(value) {
  return plainObject(value) &&
    typeof value.record_id === "string" &&
    value.record_id.length > 0 &&
    Number.isInteger(value.revision) &&
    value.revision >= 1;
}

function predictionKey(reference) {
  return `${reference.record_id}@${reference.revision}`;
}

function preferencesHash(preferences) {
  return hashLabel(preferences);
}

export function notificationPreferencesHash(preferences) {
  return preferencesHash(normalizeNotificationPreferences(preferences));
}

function probability(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite probability from 0 through 1`);
  }
  return value;
}

/**
 * Normalize the public, channel-neutral subscription preference contract.
 * Missing preferences intentionally preserve the original global 4h/50% watch.
 */
export function normalizeNotificationPreferences(value = undefined) {
  if (value === undefined) {
    return {
      schema_version: PREFERENCES_SCHEMA_VERSION,
      horizon_hours: DEFAULT_HORIZON_HOURS,
      probability_threshold: DEFAULT_PROBABILITY_THRESHOLD,
    };
  }
  if (!plainObject(value)) {
    throw new TypeError("notification preferences must be an object");
  }
  const unknown = Object.keys(value).filter((field) => !PREFERENCE_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new TypeError(`notification preferences contain unsupported fields: ${unknown.join(", ")}`);
  }
  if (value.schema_version !== PREFERENCES_SCHEMA_VERSION) {
    throw new TypeError(`notification preferences must use ${PREFERENCES_SCHEMA_VERSION}`);
  }
  if (
    !Number.isInteger(value.horizon_hours) ||
    value.horizon_hours < 1 ||
    value.horizon_hours > MAX_HORIZON_HOURS
  ) {
    throw new TypeError(
      `notification preferences horizon_hours must be an integer from 1 through ${MAX_HORIZON_HOURS}`,
    );
  }
  if (
    !Number.isFinite(value.probability_threshold) ||
    value.probability_threshold < MIN_PROBABILITY_THRESHOLD ||
    value.probability_threshold > MAX_PROBABILITY_THRESHOLD
  ) {
    throw new TypeError(
      `notification preferences probability_threshold must be from ${MIN_PROBABILITY_THRESHOLD} through ${MAX_PROBABILITY_THRESHOLD}`,
    );
  }
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    horizon_hours: value.horizon_hours,
    probability_threshold: value.probability_threshold,
  };
}

function assertHourlySlots(slots, maximumHours) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new TypeError("horizon probability curve requires at least one hourly slot");
  }
  if (
    !Number.isInteger(maximumHours) ||
    maximumHours < 1 ||
    maximumHours > MAX_HORIZON_HOURS
  ) {
    throw new TypeError(
      `maximumHours must be an integer from 1 through ${MAX_HORIZON_HOURS}`,
    );
  }
  let previousEnd = null;
  for (const [index, slot] of slots.slice(0, maximumHours).entries()) {
    if (!plainObject(slot)) {
      throw new TypeError(`forecast slot ${index + 1} must be an object`);
    }
    probability(slot.hazard, `forecast slot ${index + 1} hazard`);
    if (!utcTimestamp(slot.start) || !utcTimestamp(slot.end)) {
      throw new TypeError(`forecast slot ${index + 1} must have RFC 3339 UTC bounds`);
    }
    if (Date.parse(slot.end) - Date.parse(slot.start) !== 3_600_000) {
      throw new TypeError(`forecast slot ${index + 1} must span exactly one hour`);
    }
    if (previousEnd !== null && Date.parse(slot.start) !== previousEnd) {
      throw new TypeError("forecast slots must form one contiguous hourly horizon");
    }
    previousEnd = Date.parse(slot.end);
  }
}

/**
 * Convert conditional hourly hazards into cumulative first-reset probabilities.
 */
export function buildHorizonCumulativeCurve(slots, {
  maximumHours = MAX_HORIZON_HOURS,
} = {}) {
  assertHourlySlots(slots, maximumHours);
  const selected = slots.slice(0, maximumHours);
  let logSurvival = 0;
  return selected.map((slot, index) => {
    if (slot.hazard === 1 || logSurvival === -Infinity) {
      logSurvival = -Infinity;
    } else {
      logSurvival += Math.log1p(-slot.hazard);
    }
    const cumulative = logSurvival === -Infinity
      ? 1
      : Math.min(1, Math.max(0, -Math.expm1(logSurvival)));
    return {
      horizon_hours: index + 1,
      probability: cumulative,
    };
  });
}

function normalizeCurve(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HORIZON_HOURS) {
    throw new TypeError(
      `horizon_probabilities must contain 1 through ${MAX_HORIZON_HOURS} points`,
    );
  }
  let previous = -Infinity;
  return value.map((point, index) => {
    if (
      !plainObject(point) ||
      point.horizon_hours !== index + 1
    ) {
      throw new TypeError("horizon_probabilities must have consecutive one-hour points");
    }
    const current = probability(
      point.probability,
      `horizon probability at ${point.horizon_hours} hours`,
    );
    if (current < previous) {
      throw new TypeError("horizon cumulative probabilities must not decrease");
    }
    previous = current;
    return { horizon_hours: point.horizon_hours, probability: current };
  });
}

function normalizeSparseCurve(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HORIZON_HOURS) {
    throw new TypeError(
      `horizon_probabilities must contain 1 through ${MAX_HORIZON_HOURS} points`,
    );
  }
  let previousHorizon = 0;
  let previousProbability = -Infinity;
  return value.map((point) => {
    if (
      !plainObject(point) ||
      !Number.isInteger(point.horizon_hours) ||
      point.horizon_hours < 1 ||
      point.horizon_hours > MAX_HORIZON_HOURS ||
      point.horizon_hours <= previousHorizon
    ) {
      throw new TypeError(
        "sparse horizon_probabilities must have strictly increasing hour points",
      );
    }
    const current = probability(
      point.probability,
      `horizon probability at ${point.horizon_hours} hours`,
    );
    if (current < previousProbability) {
      throw new TypeError("horizon cumulative probabilities must not decrease");
    }
    previousHorizon = point.horizon_hours;
    previousProbability = current;
    return { horizon_hours: point.horizon_hours, probability: current };
  });
}

function probabilityAtSparseHorizon(curve, horizonHours) {
  const point = curve.find((candidate) =>
    candidate.horizon_hours === horizonHours
  );
  if (!point) {
    throw new RangeError("requested horizon is outside the available probability projection");
  }
  return point.probability;
}

export function probabilityAtHorizon(curve, horizonHours) {
  const normalized = normalizeCurve(curve);
  if (
    !Number.isInteger(horizonHours) ||
    horizonHours < 1 ||
    horizonHours > normalized.length
  ) {
    throw new RangeError("requested horizon is outside the available probability curve");
  }
  return normalized[horizonHours - 1].probability;
}

function normalizeSnapshot(value) {
  const sparse = value?.schema_version === "notification-probability-snapshot/2";
  if (
    !plainObject(value) ||
    ![
      "notification-probability-snapshot/1",
      "notification-probability-snapshot/2",
    ].includes(value.schema_version) ||
    !recordRef(value.prediction_ref) ||
    !utcTimestamp(value.issued_at) ||
    !utcTimestamp(value.knowledge_cutoff) ||
    !utcTimestamp(value.emitted_at) ||
    !utcTimestamp(value.expires_at)
  ) {
    throw new TypeError("probability subscription snapshot is invalid");
  }
  if (
    Date.parse(value.knowledge_cutoff) > Date.parse(value.issued_at) ||
    Date.parse(value.issued_at) > Date.parse(value.emitted_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.emitted_at)
  ) {
    throw new TypeError("probability subscription snapshot clocks are inconsistent");
  }
  return {
    schema_version: value.schema_version,
    prediction_ref: {
      record_id: value.prediction_ref.record_id,
      revision: value.prediction_ref.revision,
    },
    issued_at: value.issued_at,
    knowledge_cutoff: value.knowledge_cutoff,
    emitted_at: value.emitted_at,
    expires_at: value.expires_at,
    horizon_probabilities: sparse
      ? normalizeSparseCurve(value.horizon_probabilities)
      : normalizeCurve(value.horizon_probabilities),
  };
}

export function normalizeNotificationOutcomeRevisionGate(value) {
  if (!plainObject(value)) {
    throw new TypeError("outcomeRevisionGate is required");
  }
  const revisionToken = value.revision_token ?? null;
  const latestKnownAt = value.latest_known_at ?? null;
  const currentOutcomes = value.current_outcomes ?? [];
  if (
    !(
      (revisionToken === null && latestKnownAt === null) ||
      (
        typeof revisionToken === "string" &&
        revisionToken.length > 0 &&
        utcTimestamp(latestKnownAt)
      )
    ) ||
    typeof value.closes_episode !== "boolean" ||
    !Array.isArray(currentOutcomes)
  ) {
    throw new TypeError("outcomeRevisionGate must bind a revision token to latest_known_at");
  }
  const normalizedOutcomes = currentOutcomes.map((entry) => {
    if (
      !plainObject(entry) ||
      !recordRef(entry.outcome_ref) ||
      typeof entry.outcome_token !== "string" ||
      entry.outcome_token.length === 0 ||
      typeof entry.status !== "string" ||
      entry.status.length === 0 ||
      !utcTimestamp(entry.known_at) ||
      !(
        entry.occurred_time_range === null ||
        (
          plainObject(entry.occurred_time_range) &&
          utcTimestamp(entry.occurred_time_range.start) &&
          utcTimestamp(entry.occurred_time_range.end) &&
          Date.parse(entry.occurred_time_range.end) >
            Date.parse(entry.occurred_time_range.start)
        )
      )
    ) {
      throw new TypeError("outcomeRevisionGate contains an invalid current outcome");
    }
    return {
      outcome_ref: {
        record_id: entry.outcome_ref.record_id,
        revision: entry.outcome_ref.revision,
      },
      outcome_token: entry.outcome_token,
      status: entry.status,
      known_at: entry.known_at,
      occurred_time_range: entry.occurred_time_range === null
        ? null
        : {
            start: entry.occurred_time_range.start,
            end: entry.occurred_time_range.end,
          },
    };
  }).sort((left, right) =>
    left.outcome_ref.record_id.localeCompare(right.outcome_ref.record_id) ||
    left.outcome_ref.revision - right.outcome_ref.revision
  );
  return {
    revision_token: revisionToken,
    latest_known_at: latestKnownAt,
    closes_episode: value.closes_episode,
    current_outcomes: normalizedOutcomes,
  };
}

function evaluationTimestamp(value) {
  if (!utcTimestamp(value)) {
    throw new TypeError("evaluatedAt must be an RFC 3339 UTC timestamp");
  }
  return value;
}

export function probabilityCloseThreshold(preferences, {
  hysteresisMargin = DEFAULT_HYSTERESIS_MARGIN,
} = {}) {
  const normalized = normalizeNotificationPreferences(preferences);
  probability(hysteresisMargin, "hysteresisMargin");
  if (hysteresisMargin >= 1) {
    throw new TypeError("hysteresisMargin must be less than 1");
  }
  return Math.max(0, normalized.probability_threshold - hysteresisMargin);
}

function validatePreviousState(value) {
  if (value === null || value === undefined) return null;
  const legacy = value?.schema_version === LEGACY_WATCH_STATE_SCHEMA_VERSION;
  const candidate = legacy ? {
    ...structuredClone(value),
    schema_version: WATCH_STATE_SCHEMA_VERSION,
    episode_opened_at: value.active ? value.last_snapshot_emitted_at : null,
    outcome_gate_entries: [],
  } : value;
  if (
    !plainObject(candidate) ||
    candidate.schema_version !== WATCH_STATE_SCHEMA_VERSION ||
    !utcTimestamp(candidate.initialized_at) ||
    !utcTimestamp(candidate.updated_at) ||
    typeof candidate.preferences_hash !== "string" ||
    typeof candidate.active !== "boolean" ||
    typeof candidate.open_notification_emitted !== "boolean" ||
    typeof candidate.last_prediction_key !== "string" ||
    !utcTimestamp(candidate.last_prediction_issued_at) ||
    !utcTimestamp(candidate.last_snapshot_emitted_at) ||
    !utcTimestamp(candidate.last_knowledge_cutoff) ||
    !Number.isFinite(candidate.last_probability) ||
    candidate.last_probability < 0 ||
    candidate.last_probability > 1 ||
    !(
      candidate.outcome_revision_token === null ||
      typeof candidate.outcome_revision_token === "string"
    ) ||
    !(
      candidate.episode_id === null ||
      typeof candidate.episode_id === "string"
    ) ||
    !(
      candidate.episode_opened_at === null ||
      utcTimestamp(candidate.episode_opened_at)
    ) ||
    !Array.isArray(candidate.outcome_gate_entries) ||
    (!candidate.active && candidate.open_notification_emitted) ||
    (!candidate.active && candidate.episode_opened_at !== null) ||
    (candidate.active && candidate.episode_opened_at === null) ||
    (candidate.open_notification_emitted && candidate.episode_id === null) ||
    (!candidate.open_notification_emitted && candidate.episode_id !== null)
  ) {
    throw new TypeError("stored probability subscription state is invalid");
  }
  const entriesLatestKnownAt = candidate.outcome_gate_entries.reduce(
    (latest, entry) =>
      latest === null || Date.parse(entry.known_at) > Date.parse(latest)
        ? entry.known_at
        : latest,
    null,
  );
  const normalizedGate = normalizeNotificationOutcomeRevisionGate({
    revision_token: entriesLatestKnownAt === null
      ? null
      : candidate.outcome_revision_token ?? "migrated_outcome_gate",
    latest_known_at: entriesLatestKnownAt,
    closes_episode: false,
    current_outcomes: candidate.outcome_gate_entries,
  });
  return {
    ...structuredClone(candidate),
    outcome_gate_entries: normalizedGate.current_outcomes,
  };
}

export function normalizeProbabilitySubscriptionState(value) {
  return validatePreviousState(value);
}

function nextState({
  previous,
  preferences,
  snapshot,
  gate,
  selectedProbability,
  evaluatedAt,
  active,
  openNotificationEmitted,
  episodeId,
  episodeOpenedAt,
}) {
  return {
    schema_version: WATCH_STATE_SCHEMA_VERSION,
    initialized_at: previous?.initialized_at ?? evaluatedAt,
    updated_at: evaluatedAt,
    preferences_hash: preferencesHash(preferences),
    active,
    open_notification_emitted: openNotificationEmitted,
    episode_id: episodeId,
    episode_opened_at: episodeOpenedAt,
    last_prediction_key: predictionKey(snapshot.prediction_ref),
    last_prediction_issued_at: snapshot.issued_at,
    last_snapshot_emitted_at: snapshot.emitted_at,
    last_knowledge_cutoff: snapshot.knowledge_cutoff,
    last_probability: selectedProbability,
    outcome_revision_token: gate.revision_token,
    outcome_gate_entries: structuredClone(gate.current_outcomes),
  };
}

function currentEpisodeOutcomeChanged(previous, gate) {
  if (
    !previous.active ||
    previous.episode_opened_at === null ||
    !gate.closes_episode ||
    gate.revision_token === previous.outcome_revision_token
  ) return false;
  const previousByRecord = new Map(previous.outcome_gate_entries.map((entry) => [
    entry.outcome_ref.record_id,
    entry,
  ]));
  const openedAt = Date.parse(previous.episode_opened_at);
  return gate.current_outcomes.some((entry) => {
    if (entry.status !== "eligible_confirmed") return false;
    const prior = previousByRecord.get(entry.outcome_ref.record_id);
    if (prior?.status === "eligible_confirmed") return false;
    if (entry.occurred_time_range === null) return false;
    return Date.parse(entry.occurred_time_range.end) > openedAt;
  });
}

function ignored(previous, reason) {
  return {
    accepted: false,
    reason,
    baseline: false,
    state: previous === null ? null : structuredClone(previous),
    transition: null,
  };
}

/**
 * Advance one subscription watch from one eligible forecast snapshot.
 *
 * A missing state always creates a silent baseline. Callers must establish that
 * baseline from their current trigger cursor before evaluating later snapshots.
 * outcomeRevisionGate.revision_token must deterministically identify the full set
 * of latest outcome revisions visible to the caller; latest_known_at prevents a
 * forecast produced before any member of that set from opening a watch.
 */
export function transitionProbabilitySubscription({
  preferences: inputPreferences,
  previousState = null,
  snapshot: inputSnapshot,
  outcomeRevisionGate: inputGate,
  evaluatedAt,
  hysteresisMargin = DEFAULT_HYSTERESIS_MARGIN,
} = {}) {
  const preferences = normalizeNotificationPreferences(inputPreferences);
  const previous = validatePreviousState(previousState);
  const snapshot = normalizeSnapshot(inputSnapshot);
  const gate = normalizeNotificationOutcomeRevisionGate(inputGate);
  const evaluated = evaluationTimestamp(evaluatedAt);
  const selectedProbability = snapshot.schema_version ===
      "notification-probability-snapshot/2"
    ? probabilityAtSparseHorizon(
        snapshot.horizon_probabilities,
        preferences.horizon_hours,
      )
    : probabilityAtHorizon(
        snapshot.horizon_probabilities,
        preferences.horizon_hours,
      );
  const thresholdToClose = probabilityCloseThreshold(preferences, {
    hysteresisMargin,
  });

  if (Date.parse(snapshot.emitted_at) > Date.parse(evaluated)) {
    return ignored(previous, "snapshot_from_future");
  }
  if (Date.parse(snapshot.expires_at) <= Date.parse(evaluated)) {
    return ignored(previous, "snapshot_expired");
  }
  if (
    gate.latest_known_at !== null &&
    Date.parse(snapshot.knowledge_cutoff) < Date.parse(gate.latest_known_at)
  ) {
    return ignored(previous, "outcome_revision_not_in_knowledge_cutoff");
  }

  const currentPreferencesHash = preferencesHash(preferences);
  if (previous === null || previous.preferences_hash !== currentPreferencesHash) {
    const state = nextState({
      previous: null,
      preferences,
      snapshot,
      gate,
      selectedProbability,
      evaluatedAt: evaluated,
      active: selectedProbability > preferences.probability_threshold,
      openNotificationEmitted: false,
      episodeId: null,
      episodeOpenedAt: selectedProbability > preferences.probability_threshold
        ? snapshot.emitted_at
        : null,
    });
    return {
      accepted: true,
      reason: previous === null ? "baseline_initialized" : "preferences_rebaselined",
      baseline: true,
      state,
      transition: null,
    };
  }

  const currentPredictionKey = predictionKey(snapshot.prediction_ref);
  if (currentPredictionKey === previous.last_prediction_key) {
    return ignored(previous, "duplicate_prediction");
  }
  if (
    Date.parse(snapshot.issued_at) < Date.parse(previous.last_prediction_issued_at) ||
    Date.parse(snapshot.emitted_at) <= Date.parse(previous.last_snapshot_emitted_at)
  ) {
    return ignored(previous, "historical_prediction");
  }

  const closesForOutcome = currentEpisodeOutcomeChanged(previous, gate);
  if (closesForOutcome) {
    const transition = previous.active && previous.open_notification_emitted
      ? {
          kind: "closed",
          reason: "outcome_revision_closed_episode",
          episode_id: previous.episode_id,
          prediction_ref: snapshot.prediction_ref,
          horizon_hours: preferences.horizon_hours,
          probability: selectedProbability,
          open_threshold: preferences.probability_threshold,
          close_threshold: thresholdToClose,
        }
      : null;
    return {
      accepted: true,
      reason: "outcome_revision_closed_episode",
      baseline: false,
      state: nextState({
        previous,
        preferences,
        snapshot,
        gate,
        selectedProbability,
        evaluatedAt: evaluated,
        active: false,
        openNotificationEmitted: false,
        episodeId: null,
        episodeOpenedAt: null,
      }),
      transition,
    };
  }

  let active = previous.active;
  let openNotificationEmitted = previous.open_notification_emitted;
  let episodeId = previous.episode_id;
  let episodeOpenedAt = previous.episode_opened_at;
  let transition = null;
  if (!active && selectedProbability > preferences.probability_threshold) {
    episodeId = `subscription_watch_${hashLabel({
      preferences,
      prediction_ref: snapshot.prediction_ref,
      outcome_revision_token: gate.revision_token,
    }).slice("sha256:".length)}`;
    active = true;
    openNotificationEmitted = true;
    episodeOpenedAt = snapshot.emitted_at;
    transition = {
      kind: "opened",
      reason: "probability_above_threshold",
      episode_id: episodeId,
      prediction_ref: snapshot.prediction_ref,
      horizon_hours: preferences.horizon_hours,
      probability: selectedProbability,
      open_threshold: preferences.probability_threshold,
      close_threshold: thresholdToClose,
    };
  } else if (active && selectedProbability <= thresholdToClose) {
    if (openNotificationEmitted) {
      transition = {
        kind: "closed",
        reason: "probability_below_hysteresis_threshold",
        episode_id: episodeId,
        prediction_ref: snapshot.prediction_ref,
        horizon_hours: preferences.horizon_hours,
        probability: selectedProbability,
        open_threshold: preferences.probability_threshold,
        close_threshold: thresholdToClose,
      };
    }
    active = false;
    openNotificationEmitted = false;
    episodeId = null;
    episodeOpenedAt = null;
  }

  return {
    accepted: true,
    reason: transition?.reason ?? "watch_unchanged",
    baseline: false,
    state: nextState({
      previous,
      preferences,
      snapshot,
      gate,
      selectedProbability,
      evaluatedAt: evaluated,
      active,
      openNotificationEmitted,
      episodeId,
      episodeOpenedAt,
    }),
    transition,
  };
}

export {
  DEFAULT_HORIZON_HOURS,
  DEFAULT_HYSTERESIS_MARGIN,
  DEFAULT_PROBABILITY_THRESHOLD,
  MAX_PROBABILITY_THRESHOLD,
  MAX_HORIZON_HOURS,
  MIN_PROBABILITY_THRESHOLD,
  PREFERENCES_SCHEMA_VERSION as NOTIFICATION_PREFERENCES_SCHEMA_VERSION,
  WATCH_STATE_SCHEMA_VERSION as NOTIFICATION_PROBABILITY_WATCH_STATE_SCHEMA_VERSION,
};
