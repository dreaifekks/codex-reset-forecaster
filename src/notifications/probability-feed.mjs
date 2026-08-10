import { hashLabel } from "../core/hash.mjs";
import {
  DEFAULT_HYSTERESIS_MARGIN,
  NOTIFICATION_PREFERENCES_SCHEMA_VERSION,
  normalizeNotificationOutcomeRevisionGate,
  normalizeNotificationPreferences,
  probabilityCloseThreshold,
  transitionProbabilitySubscription,
} from "./subscription-policy.mjs";

const DEFAULT_ENTRY_RETENTION_HOURS = 24;

function xml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}

function percent(value) {
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function emptyOutcomeGate() {
  return {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
  };
}

export function normalizedNotificationPreferences(value, {
  defaultHorizonHours = 4,
  defaultProbabilityThreshold = 0.5,
} = {}) {
  if (value === undefined || value === null) {
    return normalizeNotificationPreferences({
      schema_version: NOTIFICATION_PREFERENCES_SCHEMA_VERSION,
      horizon_hours: defaultHorizonHours,
      probability_threshold: defaultProbabilityThreshold,
    });
  }
  return normalizeNotificationPreferences(value);
}

export function probabilityForPreference(input, preferences) {
  const normalized = normalizedNotificationPreferences(preferences);
  const probability = input?.probabilities?.[normalized.horizon_hours - 1];
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new TypeError("Forecast input does not contain the requested probability");
  }
  return probability;
}

function probabilitySnapshot(input) {
  return {
    schema_version: "notification-probability-snapshot/1",
    prediction_ref: structuredClone(input.prediction_ref),
    issued_at: input.issued_at,
    knowledge_cutoff: input.knowledge_cutoff,
    emitted_at: input.emitted_at,
    expires_at: input.expires_at,
    horizon_probabilities: input.probabilities.map((probability, index) => ({
      horizon_hours: index + 1,
      probability,
    })),
  };
}

export function probabilityCrossings(inputs, preferences, {
  baselineSequence,
  hysteresis = DEFAULT_HYSTERESIS_MARGIN,
  outcomeRevisionGate = null,
} = {}) {
  const normalized = normalizedNotificationPreferences(preferences);
  if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= 1) {
    throw new TypeError("Probability hysteresis must be from 0 up to 1");
  }
  if (!Number.isSafeInteger(baselineSequence) || baselineSequence < 0) {
    throw new TypeError("Probability feed baseline must be a non-negative integer");
  }
  const ordered = [...inputs].sort((left, right) => left.sequence - right.sequence);
  const currentOutcomeGate = normalizeNotificationOutcomeRevisionGate(
    outcomeRevisionGate ??
      ordered.at(-1)?.outcome_revision_gate ??
      emptyOutcomeGate(),
  );
  const tail = ordered.at(-1)?.sequence ?? 0;
  const cursorAhead = baselineSequence > tail;
  const exactBaseline = ordered.find((input) =>
    input.sequence === baselineSequence
  );
  const retentionReset = cursorAhead || (baselineSequence > 0 && !exactBaseline);
  const resetReason = cursorAhead
    ? "cursor_ahead_after_stream_reset"
    : retentionReset
      ? "retention_gap"
      : null;
  const effectiveBaselineSequence = cursorAhead ? 0 : baselineSequence;
  const selected = exactBaseline
    ? ordered.filter((input) => input.sequence >= baselineSequence)
    : cursorAhead
      ? ordered
      : ordered.filter((input) => input.sequence > baselineSequence);
  const closeThreshold = probabilityCloseThreshold(normalized, {
    hysteresisMargin: hysteresis,
  });
  let state = null;
  const crossings = [];
  for (const input of selected) {
    const selectedProbability = probabilityForPreference(input, normalized);
    const inputOutcomeGate = normalizeNotificationOutcomeRevisionGate(
      input.outcome_revision_gate,
    );
    if (
      state === null &&
      retentionReset &&
      selectedProbability > closeThreshold &&
      selectedProbability <= normalized.probability_threshold
    ) {
      // The pruned state may be on either side of the hysteresis latch. Stay
      // fail-closed until an observation is unambiguously active or inactive.
      continue;
    }
    const result = transitionProbabilitySubscription({
      preferences: normalized,
      previousState: state,
      snapshot: probabilitySnapshot(input),
      outcomeRevisionGate: inputOutcomeGate,
      // Atom reconstructs the watch at each input's generation time. Entry
      // visibility has its own retention clock below and must not inherit the
      // short Web Push delivery expiry.
      evaluatedAt: input.emitted_at,
      hysteresisMargin: hysteresis,
    });
    if (!result.accepted) continue;
    state = result.state;
    if (
      input.sequence > effectiveBaselineSequence &&
      result.transition?.kind === "opened" &&
      inputOutcomeGate.revision_token === currentOutcomeGate.revision_token &&
      (
        currentOutcomeGate.latest_known_at === null ||
        Date.parse(input.knowledge_cutoff) >=
          Date.parse(currentOutcomeGate.latest_known_at)
      )
    ) {
      crossings.push({
        input,
        probability: selectedProbability,
        transition: result.transition,
      });
    }
  }
  Object.defineProperty(crossings, "retention_reset", {
    value: retentionReset,
    enumerable: false,
  });
  Object.defineProperty(crossings, "reset_reason", {
    value: resetReason,
    enumerable: false,
  });
  return crossings;
}

export function renderProbabilityAtom(inputs, preferences, {
  publicBaseUrl,
  now = new Date(),
  limit = 50,
  baselineSequence,
  outcomeRevisionGate = emptyOutcomeGate(),
  entryRetentionHours = DEFAULT_ENTRY_RETENTION_HOURS,
} = {}) {
  const normalized = normalizedNotificationPreferences(preferences);
  const origin = new URL(publicBaseUrl).origin;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Atom render time is invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("Probability feed limit must be from 1 through 500");
  }
  if (
    !Number.isFinite(entryRetentionHours) ||
    entryRetentionHours <= 0 ||
    entryRetentionHours > 168
  ) {
    throw new TypeError(
      "Probability feed entry retention must be greater than zero and at most 168 hours",
    );
  }
  if (!Number.isSafeInteger(baselineSequence) || baselineSequence < 0) {
    throw new TypeError("Probability feed baseline must be a non-negative integer");
  }

  const params = new URLSearchParams({
    horizon_hours: String(normalized.horizon_hours),
    probability_threshold: String(normalized.probability_threshold),
    after: String(baselineSequence),
  });
  const feedUrl = new URL(`/feeds/probability.xml?${params}`, origin);
  const allCrossings = probabilityCrossings(inputs, normalized, {
    baselineSequence,
    outcomeRevisionGate,
  });
  const feedIdentity = {
    rule: normalized,
    baseline_sequence: baselineSequence,
    reset_marker: allCrossings.reset_reason,
  };
  const ruleHash = hashLabel(feedIdentity).slice("sha256:".length);
  const retentionMs = entryRetentionHours * 3_600_000;
  const crossings = allCrossings
    .filter(({ input }) => Date.parse(input.emitted_at) + retentionMs > nowMs)
    .sort((left, right) => right.input.sequence - left.input.sequence)
    .slice(0, limit);
  const exactBaselineInput = inputs.find((input) =>
    input.sequence === baselineSequence
  );
  const reconstructionBaselineInput = allCrossings.retention_reset
    ? [...inputs].sort((left, right) => left.sequence - right.sequence)[0]
    : null;
  const latestVisibleUpdate = allCrossings.reduce((latest, crossing) =>
    Date.parse(crossing.input.emitted_at) > Date.parse(latest)
      ? crossing.input.emitted_at
      : latest,
  exactBaselineInput?.emitted_at ??
    reconstructionBaselineInput?.emitted_at ??
    "1970-01-01T00:00:00.000Z");
  const lastExpiryUpdate = allCrossings
    .map(({ input }) => Date.parse(input.emitted_at) + retentionMs)
    .filter((timestamp) => timestamp <= nowMs)
    .sort((left, right) => right - left)[0];
  const updated = Number.isFinite(lastExpiryUpdate) &&
      lastExpiryUpdate > Date.parse(latestVisibleUpdate)
    ? new Date(lastExpiryUpdate).toISOString()
    : latestVisibleUpdate;
  const entries = crossings.map(({ input, probability }) => {
    const eventId = `probability_${hashLabel({
      ...feedIdentity,
      input_id: input.input_id,
    }).slice("sha256:".length)}`;
    const summary = [
      `未来 ${normalized.horizon_hours} 小时重置概率为 ${percent(probability)}`,
      `，严格超过订阅阈值 ${percent(normalized.probability_threshold)}。`,
      "这是模型预测，不是已确认重置。",
      `预测签发时间：${input.issued_at}；提醒生成时间：${input.emitted_at}。`,
    ].join("");
    return [
      "  <entry>",
      `    <id>urn:codex-reset-forecaster:probability:${eventId}</id>`,
      `    <title>${xml(`未来 ${normalized.horizon_hours} 小时概率超过阈值`)}</title>`,
      `    <link rel="alternate" href="${xml(new URL("/", origin).href)}"/>`,
      `    <published>${xml(input.emitted_at)}</published>`,
      `    <updated>${xml(input.emitted_at)}</updated>`,
      "    <category term=\"experimental_probability\"/>",
      `    <summary type="text">${xml(summary)}</summary>`,
      "  </entry>",
    ].join("\n");
  }).join("\n");
  const resetNotice = allCrossings.retention_reset
    ? "；订阅基线已超出保留范围，已安全重建，下一次明确回落后才会重新触发"
    : "";
  const document = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<feed xmlns=\"http://www.w3.org/2005/Atom\">",
    `  <id>urn:codex-reset-forecaster:alerts:probability:${ruleHash}</id>`,
    `  <title>${xml(`Codex 重置概率提醒 · ${normalized.horizon_hours} 小时`)}</title>`,
    `  <subtitle>${xml(`仅当未来 ${normalized.horizon_hours} 小时概率严格超过 ${percent(normalized.probability_threshold)} 时产生条目；这是实验预测${resetNotice}。`)}</subtitle>`,
    `  <link rel="self" href="${xml(feedUrl.href)}"/>`,
    `  <link rel="alternate" href="${xml(new URL("/", origin).href)}"/>`,
    `  <updated>${xml(updated)}</updated>`,
    entries,
    "</feed>",
    "",
  ].filter((line) => line !== "").join("\n");
  return {
    body: document,
    etag: `"${hashLabel(document).slice("sha256:".length)}"`,
    event_count: crossings.length,
    latest_sequence: crossings[0]?.input.sequence ?? 0,
    preferences: normalized,
    baseline_sequence: baselineSequence,
    retention_reset: allCrossings.retention_reset,
    reset_reason: allCrossings.reset_reason,
  };
}

export {
  DEFAULT_ENTRY_RETENTION_HOURS,
  NOTIFICATION_PREFERENCES_SCHEMA_VERSION,
};
