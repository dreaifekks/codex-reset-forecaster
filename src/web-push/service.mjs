import { createHash } from "node:crypto";
import {
  DEFAULT_HORIZON_HOURS,
  DEFAULT_PROBABILITY_THRESHOLD,
  MAX_HORIZON_HOURS,
  MAX_PROBABILITY_THRESHOLD,
  MIN_PROBABILITY_THRESHOLD,
  NOTIFICATION_PREFERENCES_SCHEMA_VERSION,
  notificationPreferencesHash,
  normalizeNotificationPreferences,
  transitionProbabilitySubscription,
} from "../notifications/subscription-policy.mjs";
import { normalizeTopics, normalizeWebPushConfig } from "./config.mjs";
import { createQueuedStateStore } from "./state-store.mjs";

const SUBSCRIPTION_SCHEMA_VERSION = "web-push-subscription/1";
const NOTIFICATION_SCHEMA_VERSION = "reset-notification/1";

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestSize(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    throw serviceError("invalid_subscription", "Subscription payload is not JSON serializable");
  }
}

function decodeBase64Url(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
  ) {
    throw serviceError("invalid_subscription", `${label} must be base64url`);
  }
  try {
    return Buffer.from(
      value.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
  } catch {
    throw serviceError("invalid_subscription", `${label} must be base64url`);
  }
}

function normalizedHttpsEndpoint(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw serviceError("invalid_subscription", "Push endpoint is missing or too long");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw serviceError("invalid_subscription", "Push endpoint must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  ) {
    throw serviceError("invalid_subscription", "Push endpoint must use standard HTTPS without credentials or a fragment");
  }
  return url.href;
}

function normalizedEndpoint(value, config) {
  const endpoint = normalizedHttpsEndpoint(value);
  const url = new URL(endpoint);
  const allowed = config.allowedEndpointHosts.some((rule) =>
    rule.startsWith(".")
      ? url.hostname.endsWith(rule) && url.hostname.length > rule.length
      : url.hostname === rule
  );
  if (!allowed) {
    throw serviceError(
      "endpoint_not_allowed",
      "Push endpoint is not a supported browser push service",
    );
  }
  return endpoint;
}

function normalizedSubscription(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw serviceError("invalid_subscription", "Subscription payload must be an object");
  }
  if (requestSize(payload) > config.maxRequestBytes) {
    throw serviceError("payload_too_large", "Subscription payload exceeds 16 KiB");
  }
  const endpoint = normalizedEndpoint(payload.endpoint, config);
  const p256dh = payload.keys?.p256dh;
  const auth = payload.keys?.auth;
  const p256dhBytes = decodeBase64Url(p256dh, "Subscription p256dh key");
  const authBytes = decodeBase64Url(auth, "Subscription auth key");
  if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) {
    throw serviceError("invalid_subscription", "Subscription p256dh key must be an uncompressed P-256 key");
  }
  if (authBytes.length !== 16) {
    throw serviceError("invalid_subscription", "Subscription auth key must contain 16 bytes");
  }
  let preferences;
  try {
    preferences = normalizeNotificationPreferences(payload.preferences);
  } catch (error) {
    throw serviceError("invalid_subscription", error.message);
  }
  return {
    endpoint,
    keys: { p256dh, auth },
    topics: normalizeTopics(payload.topics),
    preferences,
  };
}

function subscriptionId(endpoint) {
  return createHash("sha256").update(endpoint).digest("hex");
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Web push clock returned an invalid time");
  return date.toISOString();
}

function assertRequestOrigin(config, origin) {
  if (!config.siteOrigin) return;
  let normalized;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw serviceError("origin_not_allowed", "A valid request Origin is required");
  }
  if (normalized !== config.siteOrigin) {
    throw serviceError("origin_not_allowed", "Request Origin is not allowed");
  }
}

function assertCursor(value, label = "publication cursor") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function eventTopic(event) {
  return typeof event?.topic === "string" ? event.topic : null;
}

function sameOriginPath(value, siteOrigin) {
  if (typeof value !== "string" || !siteOrigin) return "/";
  try {
    const url = new URL(value, siteOrigin);
    return url.origin === siteOrigin
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function notificationPayload(event, config) {
  const source = event?.notification && typeof event.notification === "object"
    ? event.notification
    : event ?? {};
  const sequence = assertCursor(event?.sequence, "publication event sequence");
  const eventId = String(event?.event_id ?? event?.id ?? `publication-${sequence}`);
  const topic = eventTopic(event);
  const title = String(source.title ?? "Codex 重置预测更新").slice(0, 120);
  const body = String(source.body ?? source.summary ?? "预测状态已有更新。")
    .slice(0, 600);
  const url = sameOriginPath(source.url ?? event?.url ?? "/", config.siteOrigin);
  const payload = {
    schema_version: NOTIFICATION_SCHEMA_VERSION,
    event_id: eventId,
    sequence,
    topic,
    title,
    body,
    url,
    tag: String(source.tag ?? `${topic ?? "update"}-${eventId}`).slice(0, 120),
    emitted_at: event?.emitted_at ?? event?.available_at ?? null,
    expires_at: event?.expires_at ?? null,
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > config.maxPayloadBytes) {
    throw new TypeError("Web push notification payload is too large");
  }
  return serialized;
}

function probabilitySnapshot(input) {
  if (
    !input ||
    !Array.isArray(input.probabilities) ||
    input.probabilities.length !== 168
  ) {
    throw new TypeError("Forecast input does not contain a 168-hour probability curve");
  }
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

function probabilityOutcomeGate(source) {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return structuredClone(source);
  }
  return {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
  };
}

function openingMatchesCurrentOutcomeGate(input, inputGate, currentGate) {
  if (inputGate.revision_token !== currentGate.revision_token) return false;
  if (currentGate.latest_known_at === null) return true;
  const latestKnownAt = Date.parse(currentGate.latest_known_at ?? "");
  const knowledgeCutoff = Date.parse(input?.knowledge_cutoff ?? "");
  return Number.isFinite(latestKnownAt) &&
    Number.isFinite(knowledgeCutoff) &&
    knowledgeCutoff >= latestKnownAt;
}

function personalizedProbabilityPayload(input, preferences, transition, config) {
  const probability = transition.probability;
  const threshold = transition.open_threshold;
  const percent = (value) => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
  const payload = {
    schema_version: NOTIFICATION_SCHEMA_VERSION,
    event_id: transition.episode_id,
    topic: "experimental_probability",
    title: `未来 ${preferences.horizon_hours} 小时概率超过阈值`,
    body: [
      `当前模型给出的未来 ${preferences.horizon_hours} 小时重置概率为 ${percent(probability)}`,
      `，超过你设置的 ${percent(threshold)}。`,
      "这是实验预测，不是已确认重置。",
    ].join(""),
    url: "/",
    tag: `personalized-probability-${preferences.horizon_hours}h`,
    emitted_at: input.emitted_at,
    expires_at: input.expires_at,
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > config.maxPayloadBytes) {
    throw new TypeError("Personalized web push payload is too large");
  }
  return serialized;
}

function statusCodeFor(error) {
  const value = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(value) ? value : null;
}

function retryAfterMs(error, nowMs) {
  const headers = error?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function retryDecision(error, previousAttempts, config, nowMs) {
  const statusCode = statusCodeFor(error);
  if (statusCode === 404 || statusCode === 410) {
    return { action: "delete", statusCode };
  }
  if (
    statusCode === null ||
    [401, 403, 408, 425, 429].includes(statusCode) ||
    statusCode >= 500
  ) {
    const attempts = previousAttempts + 1;
    const exponential = Math.min(
      config.retryMaxMs,
      config.retryBaseMs * (2 ** Math.min(attempts - 1, 10)),
    );
    return {
      action: "retry",
      attempts,
      statusCode,
      delayMs: Math.max(exponential, retryAfterMs(error, nowMs) ?? 0),
    };
  }
  return { action: "disable", statusCode };
}

function pushSubscriptionFor(record) {
  return {
    endpoint: record.endpoint,
    expirationTime: null,
    keys: structuredClone(record.keys),
  };
}

function publicSubscription(record) {
  return {
    subscription_id: record.subscription_id,
    topics: [...record.topics],
    preferences: normalizeNotificationPreferences(record.preferences),
    cursor: record.cursor,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function recordGeneration(record) {
  return Number.isSafeInteger(record?.generation) && record.generation >= 0
    ? record.generation
    : 0;
}

export function createWebPushService({
  config: inputConfig = {},
  stateAdapter,
  publicationLedger,
  forecastInputStream = null,
  sendNotification,
  clock = () => new Date(),
  timers = globalThis,
  logger = console,
} = {}) {
  const config = normalizeWebPushConfig(inputConfig);
  if (
    typeof publicationLedger?.getCursor !== "function" ||
    typeof publicationLedger?.listAfter !== "function"
  ) {
    throw new TypeError("A publicationLedger with getCursor/listAfter is required");
  }
  if (typeof sendNotification !== "function") {
    throw new TypeError("A sendNotification function is required");
  }
  if (
    forecastInputStream !== null &&
    (
      typeof forecastInputStream.listAfter !== "function" ||
      !(
        typeof forecastInputStream.tail === "function" ||
        (
          typeof forecastInputStream.getCursor === "function" &&
          typeof forecastInputStream.latest === "function"
        )
      )
    )
  ) {
    throw new TypeError(
      "forecastInputStream must provide listAfter and an atomic tail or getCursor/latest",
    );
  }
  const state = createQueuedStateStore(stateAdapter);
  let interval = null;
  let dispatchInFlight = null;
  let stopping = false;

  function boundedSend(subscription, payload, options) {
    let timeout = null;
    const deadline = new Promise((_, reject) => {
      timeout = timers.setTimeout(() => {
        const error = new Error("Web push request exceeded its absolute deadline");
        error.code = "WEB_PUSH_TIMEOUT";
        reject(error);
      }, config.requestTimeoutMs);
    });
    return Promise.race([
      Promise.resolve().then(() => sendNotification(subscription, payload, {
        ...options,
        timeout: config.requestTimeoutMs,
      })),
      deadline,
    ]).finally(() => timers.clearTimeout(timeout));
  }

  function getPublicConfig() {
    return {
      enabled: config.enabled,
      application_server_key: config.enabled ? config.publicKey : null,
      default_topics: ["authority", "outcome"],
      optional_topics: ["experimental_probability"],
      notification_preferences: {
        schema_version: NOTIFICATION_PREFERENCES_SCHEMA_VERSION,
        horizon_hours: {
          minimum: 1,
          maximum: MAX_HORIZON_HOURS,
          default: DEFAULT_HORIZON_HOURS,
        },
        probability_threshold: {
          minimum: MIN_PROBABILITY_THRESHOLD,
          maximum: MAX_PROBABILITY_THRESHOLD,
          default: DEFAULT_PROBABILITY_THRESHOLD,
        },
      },
    };
  }

  async function forecastTail() {
    if (!forecastInputStream) return { cursor: 0, input: null };
    if (typeof forecastInputStream.tail === "function") {
      const result = await forecastInputStream.tail();
      return {
        cursor: assertCursor(result?.cursor, "forecast input cursor"),
        input: result?.input ?? null,
        outcome_revision_gate: probabilityOutcomeGate(
          result?.outcome_revision_gate,
        ),
      };
    }
    const [cursor, input] = await Promise.all([
      forecastInputStream.getCursor(),
      forecastInputStream.latest(),
    ]);
    return {
      cursor: assertCursor(cursor, "forecast input cursor"),
      input,
      outcome_revision_gate: probabilityOutcomeGate(null),
    };
  }

  function baselineProbabilityWatch(
    input,
    preferences,
    evaluatedAt,
    outcomeRevisionGate,
  ) {
    if (!input) return null;
    const result = transitionProbabilitySubscription({
      preferences,
      previousState: null,
      snapshot: probabilitySnapshot(input),
      outcomeRevisionGate: probabilityOutcomeGate(outcomeRevisionGate),
      evaluatedAt,
    });
    return result.accepted ? result.state : null;
  }

  async function subscribe(payload, { origin } = {}) {
    if (!config.enabled) throw serviceError("web_push_disabled", "Web push is disabled");
    assertRequestOrigin(config, origin);
    const candidate = normalizedSubscription(payload, config);
    const [publicationCursor, inputTail] = await Promise.all([
      publicationLedger.getCursor(),
      forecastTail(),
    ]);
    const cursor = assertCursor(publicationCursor);
    const now = timestamp(clock);
    const id = subscriptionId(candidate.endpoint);
    return state.mutate((draft) => {
      const previous = draft.subscriptions[id];
      if (
        !previous &&
        Object.keys(draft.subscriptions).length >= config.maxSubscriptions
      ) {
        throw serviceError(
          "subscription_limit_reached",
          "Web push subscription limit has been reached",
        );
      }
      const previousExperimental =
        previous?.topics?.includes("experimental_probability") === true;
      const nextExperimental =
        candidate.topics.includes("experimental_probability");
      const preferencesChanged = previous
        ? notificationPreferencesHash(previous.preferences) !==
          notificationPreferencesHash(candidate.preferences)
        : true;
      const probabilityStateMissing = previous &&
        (!Number.isSafeInteger(previous.forecast_input_cursor) ||
          previous.forecast_input_cursor < 0);
      const rebaselineProbability = !previous ||
        preferencesChanged ||
        (!previousExperimental && nextExperimental) ||
        probabilityStateMissing;
      const record = {
        schema_version: SUBSCRIPTION_SCHEMA_VERSION,
        subscription_id: id,
        endpoint: candidate.endpoint,
        keys: candidate.keys,
        topics: candidate.topics,
        preferences: candidate.preferences,
        cursor: previous?.cursor ?? cursor,
        forecast_input_cursor: rebaselineProbability
          ? inputTail.cursor
          : previous.forecast_input_cursor,
        probability_watch: rebaselineProbability
          ? baselineProbabilityWatch(
              inputTail.input,
              candidate.preferences,
              now,
              inputTail.outcome_revision_gate,
            )
          : structuredClone(previous.probability_watch),
        probability_retry: rebaselineProbability
          ? null
          : structuredClone(previous.probability_retry),
        created_at: previous?.created_at ?? now,
        updated_at: now,
        generation: recordGeneration(previous) + 1,
        retry: previous?.retry ?? null,
        disabled: null,
      };
      draft.subscriptions[id] = record;
      return publicSubscription(record);
    });
  }

  async function unsubscribe(payload, { origin } = {}) {
    if (!config.enabled) throw serviceError("web_push_disabled", "Web push is disabled");
    assertRequestOrigin(config, origin);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw serviceError("invalid_subscription", "Unsubscribe payload must be an object");
    }
    if (requestSize(payload) > config.maxRequestBytes) {
      throw serviceError("payload_too_large", "Unsubscribe payload exceeds 16 KiB");
    }
    const endpoint = normalizedHttpsEndpoint(payload.endpoint);
    const id = subscriptionId(endpoint);
    return state.mutate((draft) => {
      const existed = Boolean(draft.subscriptions[id]);
      delete draft.subscriptions[id];
      return { removed: existed };
    });
  }

  async function updateSubscription(id, callback) {
    return state.mutate((draft) => {
      const record = draft.subscriptions[id];
      if (!record) return null;
      return callback(record, draft);
    });
  }

  async function updateCurrentDelivery(initial, callback) {
    return updateSubscription(initial.subscription_id, (record, draft) => {
      if (
        recordGeneration(record) !== recordGeneration(initial) ||
        record.endpoint !== initial.endpoint
      ) {
        return false;
      }
      callback(record, draft);
      return true;
    });
  }


  async function currentDeliveryRecord(initial, summary) {
    const snapshot = await state.read();
    const record = snapshot.subscriptions[initial.subscription_id];
    if (!record || recordGeneration(record) !== recordGeneration(initial)) {
      return null;
    }
    try {
      normalizedEndpoint(record.endpoint, config);
    } catch (error) {
      if (!["invalid_subscription", "endpoint_not_allowed"].includes(error?.code)) {
        throw error;
      }
      const removed = await updateCurrentDelivery(
        initial,
        (_current, draft) => {
          delete draft.subscriptions[initial.subscription_id];
        },
      );
      if (removed) summary.removed += 1;
      return null;
    }
    return record;
  }

  function recordForecastCursor(record) {
    return Number.isSafeInteger(record?.forecast_input_cursor) &&
        record.forecast_input_cursor >= 0
      ? record.forecast_input_cursor
      : null;
  }

  async function rebaselineProbabilitySubscription(initial, summary) {
    let current = await currentDeliveryRecord(initial, summary);
    if (
      !current ||
      current.disabled ||
      !current.topics.includes("experimental_probability")
    ) return false;
    const tail = await forecastTail();
    current = await currentDeliveryRecord(initial, summary);
    if (
      !current ||
      current.disabled ||
      !current.topics.includes("experimental_probability")
    ) return false;
    const evaluatedAt = timestamp(clock);
    const preferences = normalizeNotificationPreferences(current.preferences);
    const watch = baselineProbabilityWatch(
      tail.input,
      preferences,
      evaluatedAt,
      tail.outcome_revision_gate,
    );
    const applied = await updateCurrentDelivery(initial, (record) => {
      record.forecast_input_cursor = tail.cursor;
      record.probability_watch = watch;
      record.probability_retry = null;
      record.updated_at = timestamp(clock);
    });
    if (applied) summary.personalized_rebased += 1;
    return applied;
  }

  async function dispatchSubscription(initial, summary) {
    let current = await currentDeliveryRecord(initial, summary);
    if (!current) return;
    if (current.disabled) {
      summary.disabled += 1;
      return;
    }
    const retryAt = Date.parse(current.retry?.next_attempt_at ?? "");
    const nowMs = Date.parse(timestamp(clock));
    if (Number.isFinite(retryAt) && retryAt > nowMs) {
      summary.deferred += 1;
      return;
    }
    const publicationTopics = forecastInputStream
      ? current.topics.filter((topic) => topic !== "experimental_probability")
      : [...current.topics];
    const page = await publicationLedger.listAfter(current.cursor, {
      limit: config.batchSize,
      topics: publicationTopics,
    });
    if (!page || !Array.isArray(page.events)) {
      throw new TypeError("publicationLedger.listAfter returned an invalid page");
    }
    const pageCursor = assertCursor(page.cursor);
    if (pageCursor < current.cursor) {
      throw new TypeError("publication ledger cursor moved backwards");
    }
    let currentCursor = current.cursor;
    for (const event of page.events) {
      if (stopping) return;
      const eventNowMs = Date.parse(timestamp(clock));
      const sequence = assertCursor(event?.sequence, "publication event sequence");
      if (sequence <= currentCursor || sequence > pageCursor) {
        throw new TypeError("publication ledger returned an out-of-order event");
      }
      const expiresAt = Date.parse(event?.expires_at ?? "");
      if (!Number.isFinite(expiresAt)) {
        throw new TypeError("publication event expires_at is invalid");
      }
      if (expiresAt <= eventNowMs) {
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.cursor = Math.max(record.cursor, sequence);
          record.updated_at = timestamp(clock);
          record.retry = null;
        });
        if (!applied) return;
        summary.expired += 1;
        continue;
      }
      const topic = eventTopic(event);
      if (!current.topics.includes(topic)) {
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.cursor = Math.max(record.cursor, sequence);
          record.updated_at = timestamp(clock);
          record.retry = null;
        });
        if (!applied) return;
        continue;
      }
      try {
        current = await currentDeliveryRecord(initial, summary);
        if (!current) return;
        const ttlSeconds = Math.min(
          config.ttlSeconds,
          Math.max(0, Math.floor((expiresAt - eventNowMs) / 1_000)),
        );
        await boundedSend(
          pushSubscriptionFor(current),
          notificationPayload(event, config),
          { TTL: ttlSeconds, urgency: topic === "outcome" ? "high" : "normal" },
        );
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.cursor = Math.max(record.cursor, sequence);
          record.updated_at = timestamp(clock);
          record.retry = null;
          record.disabled = null;
        });
        summary.sent += 1;
        if (!applied) return;
      } catch (error) {
        const previousAttempts = current.retry?.event_sequence === sequence
          ? Number(current.retry.attempts ?? 0)
          : 0;
        const decision = retryDecision(error, previousAttempts, config, eventNowMs);
        if (decision.action === "delete") {
          const applied = await updateCurrentDelivery(initial, (_record, draft) => {
            delete draft.subscriptions[initial.subscription_id];
          });
          if (applied) summary.removed += 1;
          return;
        }
        if (decision.action === "retry") {
          const applied = await updateCurrentDelivery(initial, (record) => {
            record.retry = {
              event_sequence: sequence,
              attempts: decision.attempts,
              next_attempt_at: new Date(eventNowMs + decision.delayMs).toISOString(),
              status_code: decision.statusCode,
              last_error: String(error?.message ?? error).slice(0, 500),
            };
            record.updated_at = timestamp(clock);
          });
          if (applied) summary.retried += 1;
          return;
        }
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.disabled = {
            at: timestamp(clock),
            status_code: decision.statusCode,
            reason: String(error?.message ?? error).slice(0, 500),
          };
          record.updated_at = timestamp(clock);
        });
        if (applied) summary.disabled += 1;
        return;
      }
    }
    if (currentCursor < pageCursor) {
      await updateCurrentDelivery(initial, (record) => {
        record.cursor = Math.max(record.cursor, pageCursor);
        record.updated_at = timestamp(clock);
        record.retry = null;
      });
    }
    if (page.has_more) summary.has_more = true;
  }

  async function dispatchProbabilitySubscription(initial, summary) {
    if (!forecastInputStream) return;
    let current = await currentDeliveryRecord(initial, summary);
    if (
      !current ||
      current.disabled ||
      !current.topics.includes("experimental_probability")
    ) return;

    let currentCursor = recordForecastCursor(current);
    if (currentCursor === null) {
      await rebaselineProbabilitySubscription(initial, summary);
      return;
    }

    let page;
    try {
      page = await forecastInputStream.listAfter(currentCursor, {
        limit: config.batchSize,
      });
    } catch (error) {
      if (error?.code !== "forecast_input_cursor_reset_required") throw error;
      await rebaselineProbabilitySubscription(initial, summary);
      return;
    }
    if (!page || !Array.isArray(page.inputs)) {
      throw new TypeError("forecastInputStream.listAfter returned an invalid page");
    }
    const pageCursor = assertCursor(page.cursor, "forecast input page cursor");
    if (pageCursor < currentCursor) {
      throw new TypeError("forecast input cursor moved backwards");
    }
    const expectedPageCursor = page.inputs.at(-1)?.sequence ?? currentCursor;
    if (pageCursor !== expectedPageCursor) {
      throw new TypeError("forecast input page cursor does not match its inputs");
    }
    const currentOutcomeGate = probabilityOutcomeGate(
      page.outcome_revision_gate,
    );

    for (const input of page.inputs) {
      if (stopping) return;
      const evaluatedAt = timestamp(clock);
      const inputNowMs = Date.parse(evaluatedAt);
      const sequence = assertCursor(input?.sequence, "forecast input sequence");
      if (sequence <= currentCursor || sequence > pageCursor) {
        throw new TypeError("forecast input stream returned an out-of-order input");
      }

      current = await currentDeliveryRecord(initial, summary);
      if (
        !current ||
        current.disabled ||
        !current.topics.includes("experimental_probability")
      ) return;
      const preferences = normalizeNotificationPreferences(current.preferences);
      const inputOutcomeGate = probabilityOutcomeGate(
        input.outcome_revision_gate,
      );
      const result = transitionProbabilitySubscription({
        preferences,
        previousState: current.probability_watch ?? null,
        snapshot: probabilitySnapshot(input),
        outcomeRevisionGate: inputOutcomeGate,
        evaluatedAt,
      });

      if (!result.accepted) {
        if (result.reason === "snapshot_from_future") {
          summary.deferred += 1;
          summary.personalized_deferred += 1;
          return;
        }
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.forecast_input_cursor = Math.max(
            recordForecastCursor(record) ?? 0,
            sequence,
          );
          record.probability_watch = result.state;
          record.probability_retry = null;
          record.updated_at = timestamp(clock);
        });
        if (!applied) return;
        if (result.reason === "snapshot_expired") {
          summary.expired += 1;
          summary.personalized_expired += 1;
        }
        continue;
      }

      if (
        result.transition?.kind !== "opened" ||
        !openingMatchesCurrentOutcomeGate(
          input,
          inputOutcomeGate,
          currentOutcomeGate,
        )
      ) {
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.forecast_input_cursor = Math.max(
            recordForecastCursor(record) ?? 0,
            sequence,
          );
          record.probability_watch = result.state;
          record.probability_retry = null;
          record.updated_at = timestamp(clock);
        });
        if (!applied) return;
        continue;
      }

      const expiresAt = Date.parse(input.expires_at);
      if (!Number.isFinite(expiresAt)) {
        throw new TypeError("forecast input expires_at is invalid");
      }
      if (expiresAt <= inputNowMs) {
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.forecast_input_cursor = Math.max(
            recordForecastCursor(record) ?? 0,
            sequence,
          );
          record.probability_retry = null;
          record.updated_at = timestamp(clock);
        });
        if (!applied) return;
        summary.expired += 1;
        summary.personalized_expired += 1;
        continue;
      }

      const retryAt = Date.parse(current.probability_retry?.next_attempt_at ?? "");
      if (
        current.probability_retry?.input_sequence === sequence &&
        Number.isFinite(retryAt) &&
        retryAt > inputNowMs
      ) {
        summary.deferred += 1;
        summary.personalized_deferred += 1;
        return;
      }

      try {
        const ttlSeconds = Math.min(
          config.ttlSeconds,
          Math.max(0, Math.floor((expiresAt - inputNowMs) / 1_000)),
        );
        await boundedSend(
          pushSubscriptionFor(current),
          personalizedProbabilityPayload(input, preferences, result.transition, config),
          { TTL: ttlSeconds, urgency: "normal" },
        );
        currentCursor = sequence;
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.forecast_input_cursor = Math.max(
            recordForecastCursor(record) ?? 0,
            sequence,
          );
          record.probability_watch = result.state;
          record.probability_retry = null;
          record.updated_at = timestamp(clock);
          record.disabled = null;
        });
        summary.sent += 1;
        summary.personalized_sent += 1;
        if (!applied) return;
      } catch (error) {
        const previousAttempts =
          current.probability_retry?.input_sequence === sequence
            ? Number(current.probability_retry.attempts ?? 0)
            : 0;
        const decision = retryDecision(error, previousAttempts, config, inputNowMs);
        if (decision.action === "delete") {
          const applied = await updateCurrentDelivery(initial, (_record, draft) => {
            delete draft.subscriptions[initial.subscription_id];
          });
          if (applied) summary.removed += 1;
          return;
        }
        if (decision.action === "retry") {
          const applied = await updateCurrentDelivery(initial, (record) => {
            record.probability_retry = {
              input_sequence: sequence,
              attempts: decision.attempts,
              next_attempt_at: new Date(
                inputNowMs + decision.delayMs,
              ).toISOString(),
              status_code: decision.statusCode,
              last_error: String(error?.message ?? error).slice(0, 500),
            };
            record.updated_at = timestamp(clock);
          });
          if (applied) {
            summary.retried += 1;
            summary.personalized_retried += 1;
          }
          return;
        }
        const applied = await updateCurrentDelivery(initial, (record) => {
          record.disabled = {
            at: timestamp(clock),
            status_code: decision.statusCode,
            reason: String(error?.message ?? error).slice(0, 500),
          };
          record.updated_at = timestamp(clock);
        });
        if (applied) summary.disabled += 1;
        return;
      }
    }
    if (page.has_more) summary.has_more = true;
  }

  async function performDispatch() {
    const summary = {
      subscriptions: 0,
      sent: 0,
      removed: 0,
      retried: 0,
      deferred: 0,
      disabled: 0,
      expired: 0,
      errors: 0,
      has_more: false,
      personalized_sent: 0,
      personalized_retried: 0,
      personalized_deferred: 0,
      personalized_expired: 0,
      personalized_rebased: 0,
    };
    if (!config.enabled || stopping) return summary;
    try {
      const snapshot = await state.read();
      const subscriptions = Object.values(snapshot.subscriptions);
      summary.subscriptions = subscriptions.length;
      for (const subscription of subscriptions) {
        if (stopping) break;
        try {
          await dispatchSubscription(subscription, summary);
        } catch (error) {
          summary.errors += 1;
          logger.error?.(`web push dispatch failed: ${error.stack ?? error.message}`);
        }
        if (stopping) break;
        try {
          await dispatchProbabilitySubscription(subscription, summary);
        } catch (error) {
          summary.errors += 1;
          logger.error?.(
            `personalized web push dispatch failed: ${error.stack ?? error.message}`,
          );
        }
      }
    } catch (error) {
      summary.errors += 1;
      logger.error?.(`web push dispatcher failed: ${error.stack ?? error.message}`);
    }
    return summary;
  }

  function dispatchNow() {
    if (!dispatchInFlight) {
      dispatchInFlight = performDispatch().finally(() => {
        dispatchInFlight = null;
      });
    }
    return dispatchInFlight;
  }

  function start() {
    if (!config.enabled || interval) return false;
    stopping = false;
    interval = timers.setInterval(() => {
      void dispatchNow();
    }, config.dispatchIntervalMs);
    interval?.unref?.();
    void dispatchNow();
    return true;
  }

  function stop() {
    stopping = true;
    const wasRunning = Boolean(interval || dispatchInFlight);
    if (interval) timers.clearInterval(interval);
    interval = null;
    return wasRunning;
  }

  async function waitForIdle() {
    await dispatchInFlight;
  }

  return {
    getPublicConfig,
    subscribe,
    unsubscribe,
    start,
    stop,
    waitForIdle,
    dispatchNow,
  };
}

export {
  NOTIFICATION_SCHEMA_VERSION,
  SUBSCRIPTION_SCHEMA_VERSION,
};
