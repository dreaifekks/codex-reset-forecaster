import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashLabel } from "../core/hash.mjs";
import { normalizeTelegramId } from "./config.mjs";
import { normalizeTelegramLocale } from "./locale.mjs";
import {
  normalizeNotificationPreferences,
  normalizeProbabilitySubscriptionState,
  notificationPreferencesHash,
} from "../notifications/subscription-policy.mjs";

export const TELEGRAM_STATE_SCHEMA_VERSION = "telegram-bot-state/5";
const LEGACY_STATE_SCHEMA_VERSION = "telegram-bot-state/1";
const PREVIOUS_STATE_SCHEMA_VERSION = "telegram-bot-state/2";
const PREVIOUS_SEMANTIC_DEDUPE_SCHEMA_VERSION = "telegram-bot-state/3";
const PREVIOUS_LOCALELESS_STATE_SCHEMA_VERSION = "telegram-bot-state/4";
const OUTBOX_STATUSES = new Set([
  "pending",
  "sending",
  "retry",
  "delivered",
  "dead",
]);
const DELIVERY_KEY_LIMIT = 16_384;
const TERMINAL_JOB_LIMIT = 256;
const NO_STATE_CHANGE = Symbol("NO_STATE_CHANGE");

function iso(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an RFC 3339 timestamp`);
  }
  return value;
}

function eventCursor(value, name = "event cursor") {
  const text = String(value ?? "");
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(text) ||
    !Number.isSafeInteger(Number(text))
  ) {
    throw new TypeError(`${name} must be a canonical non-negative safe integer`);
  }
  return text;
}

function stableEventMessageText(value) {
  return String(value ?? "").replace(
    /\n\n(?:时间|Time)[：:][^\n]*\n(?:详情|Details)[：:][^\n]*\s*$/u,
    "",
  );
}

function semanticJobDeliveryKey(job) {
  if (job?.kind !== "event") return String(job?.dedupe_key ?? job?.id ?? "");
  return `semantic:event:${hashLabel({
    topic: job.event_topic ?? null,
    chat_id: String(job.chat_id ?? ""),
    message: stableEventMessageText(job.text),
  }).slice("sha256:".length)}`;
}

function rememberJobDelivery(state, job) {
  state.delivery_keys.push(job.id);
  if (job.dedupe_key !== job.id) state.delivery_keys.push(job.dedupe_key);
}

function defaultOutcomeRevisionGate() {
  return {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
  };
}

function outcomeGateEntry(value) {
  const range = value?.occurred_time_range ?? null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.outcome_ref ||
    typeof value.outcome_ref.record_id !== "string" ||
    value.outcome_ref.record_id.length === 0 ||
    !Number.isInteger(value.outcome_ref.revision) ||
    value.outcome_ref.revision < 1 ||
    typeof value.outcome_token !== "string" ||
    value.outcome_token.length === 0 ||
    typeof value.status !== "string" ||
    value.status.length === 0 ||
    iso(value.known_at, "outcome gate known_at") !== value.known_at ||
    !(
      range === null ||
      (
        typeof range === "object" &&
        !Array.isArray(range) &&
        iso(range.start, "outcome gate range start") === range.start &&
        iso(range.end, "outcome gate range end") === range.end &&
        Date.parse(range.end) > Date.parse(range.start)
      )
    )
  ) {
    throw new TypeError("Invalid Telegram forecast outcome gate entry");
  }
  return {
    outcome_ref: {
      record_id: value.outcome_ref.record_id,
      revision: value.outcome_ref.revision,
    },
    outcome_token: value.outcome_token,
    status: value.status,
    known_at: value.known_at,
    occurred_time_range: range === null ? null : {
      start: range.start,
      end: range.end,
    },
  };
}

function outcomeRevisionGate(value) {
  const revisionToken = value?.revision_token ?? null;
  const latestKnownAt = value?.latest_known_at ?? null;
  const currentOutcomes = value?.current_outcomes ?? [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !(
      (revisionToken === null && latestKnownAt === null) ||
      (
        typeof revisionToken === "string" &&
        revisionToken.length > 0 &&
        iso(latestKnownAt, "outcome revision latest_known_at") === latestKnownAt
      )
    ) ||
    typeof value.closes_episode !== "boolean" ||
    !Array.isArray(currentOutcomes)
  ) {
    throw new TypeError("Invalid Telegram forecast outcome revision gate");
  }
  const normalizedOutcomes = currentOutcomes.map(outcomeGateEntry)
    .sort((left, right) =>
      left.outcome_ref.record_id.localeCompare(right.outcome_ref.record_id) ||
      left.outcome_ref.revision - right.outcome_ref.revision ||
      left.outcome_token.localeCompare(right.outcome_token)
    );
  return {
    revision_token: revisionToken,
    latest_known_at: latestKnownAt,
    closes_episode: value.closes_episode,
    current_outcomes: normalizedOutcomes,
  };
}

function defaultState(now) {
  const timestamp = now.toISOString();
  return {
    schema_version: TELEGRAM_STATE_SCHEMA_VERSION,
    created_at: timestamp,
    updated_at: timestamp,
    bot_id: null,
    bot_locale: null,
    heartbeat_at: null,
    next_update_id: null,
    event_cursor: null,
    event_baseline_initialized: false,
    forecast_input_cursor: null,
    forecast_input_baseline_initialized: false,
    forecast_input_outcome_revision_gate: defaultOutcomeRevisionGate(),
    forecast_input_cursor_reset_at: null,
    forecast_input_cursor_reset_reason: null,
    last_update_poll_at: null,
    last_event_poll_at: null,
    last_forecast_input_poll_at: null,
    last_operations_alert_poll_at: null,
    operations_alert_cursor: null,
    operations_alert_baseline_initialized: false,
    operations_alert_generation: 0,
    operations_alert_cursor_reset_at: null,
    operations_alert_cursor_reset_reason: null,
    last_operations_delivery_failure_at: null,
    last_operations_delivery_failure_error: null,
    dynamic_subscriptions: {},
    outbox: [],
    delivery_keys: [],
  };
}

function validateSubscription(chatId, value) {
  const normalizedChatId = normalizeTelegramId(chatId, "subscription chat id");
  if (
    normalizedChatId.startsWith("-") ||
    !value ||
    value.chat_id !== chatId ||
    value.stable !== true ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !(
      value.probability_preferences === null ||
      typeof value.probability_preferences === "object"
    ) ||
    !(
      value.probability_watch === null ||
      typeof value.probability_watch === "object"
    )
  ) {
    throw new TypeError(`Invalid dynamic subscription for chat ${chatId}`);
  }
  if (value.probability_preferences === null) {
    if (value.probability_watch !== null) {
      throw new TypeError(`Stable-only subscription ${chatId} has a probability watch`);
    }
  } else {
    const normalized = normalizeNotificationPreferences(
      value.probability_preferences,
    );
    if (JSON.stringify(normalized) !== JSON.stringify(value.probability_preferences)) {
      throw new TypeError(`Subscription ${chatId} has non-canonical preferences`);
    }
    normalizeProbabilitySubscriptionState(value.probability_watch);
  }
  iso(value.stable_since, "subscription.stable_since");
  iso(value.updated_at, "subscription.updated_at");
}

function validateJob(job) {
  if (
    !job ||
    typeof job.id !== "string" ||
    job.id.length < 1 ||
    job.id.length > 512 ||
    typeof job.dedupe_key !== "string" ||
    job.dedupe_key.length < 1 ||
    job.dedupe_key.length > 512 ||
    ![
      "command",
      "admin_command",
      "event",
      "probability",
      "operations_alert",
    ].includes(
      job.kind,
    ) ||
    typeof job.text !== "string" ||
    job.text.length < 1 ||
    job.text.length > 4_096 ||
    !OUTBOX_STATUSES.has(job.status) ||
    !Number.isInteger(job.attempts) ||
    job.attempts < 0
  ) {
    throw new TypeError("Invalid Telegram outbox job");
  }
  const topicJob = ["event", "probability"].includes(job.kind);
  if (
    typeof job.experimental !== "boolean" ||
    (!topicJob && job.event_topic !== null) ||
    (topicJob && (
      typeof job.event_topic !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(job.event_topic)
    )) ||
    !(
      job.subscription_generation === null ||
      (Number.isSafeInteger(job.subscription_generation) &&
        job.subscription_generation >= 1)
    ) ||
    !(
      job.preferences_hash === null ||
      /^sha256:[a-f0-9]{64}$/.test(job.preferences_hash)
    ) ||
    !(
      job.outcome_revision_token === null ||
      (typeof job.outcome_revision_token === "string" &&
        job.outcome_revision_token.length > 0)
    ) ||
    (
      job.kind === "probability" &&
      (
        job.experimental !== true ||
        job.event_topic !== "experimental_probability" ||
        job.subscription_generation === null ||
        job.preferences_hash === null
      )
    ) ||
    (
      job.kind !== "probability" &&
      (
        job.subscription_generation !== null ||
        job.preferences_hash !== null ||
        job.outcome_revision_token !== null
      )
    )
  ) {
    throw new TypeError("Invalid Telegram outbox event metadata");
  }
  normalizeTelegramId(job.chat_id, "outbox chat id");
  iso(job.created_at, "outbox.created_at");
  iso(job.updated_at, "outbox.updated_at");
  iso(job.not_before, "outbox.not_before");
  if (job.expires_at !== null) iso(job.expires_at, "outbox.expires_at");
}

export function assertTelegramState(state) {
  if (
    !state ||
    state.schema_version !== TELEGRAM_STATE_SCHEMA_VERSION ||
    (state.bot_id !== null && (
      typeof state.bot_id !== "string" ||
      !/^[1-9][0-9]*$/.test(state.bot_id)
    )) ||
    (state.bot_locale !== null && (
      typeof state.bot_locale !== "string" ||
      normalizeTelegramLocale(state.bot_locale) !== state.bot_locale
    )) ||
    (state.next_update_id !== null &&
      (!Number.isSafeInteger(state.next_update_id) || state.next_update_id < 0)) ||
    (state.event_cursor !== null && eventCursor(state.event_cursor) !== state.event_cursor) ||
    typeof state.event_baseline_initialized !== "boolean" ||
    (state.forecast_input_cursor !== null &&
      eventCursor(state.forecast_input_cursor, "forecast input cursor") !==
        state.forecast_input_cursor) ||
    typeof state.forecast_input_baseline_initialized !== "boolean" ||
    (state.forecast_input_cursor_reset_reason !== null &&
      !["ahead_of_tail", "retention_gap"].includes(
        state.forecast_input_cursor_reset_reason,
      )) ||
    (state.operations_alert_cursor !== null &&
      eventCursor(state.operations_alert_cursor, "operations alert cursor") !==
        state.operations_alert_cursor) ||
    typeof state.operations_alert_baseline_initialized !== "boolean" ||
    !Number.isSafeInteger(state.operations_alert_generation) ||
    state.operations_alert_generation < 0 ||
    (state.operations_alert_cursor_reset_reason !== null &&
      !["ahead_of_tail", "retention_gap"].includes(
        state.operations_alert_cursor_reset_reason,
      )) ||
    (state.last_operations_delivery_failure_error !== null && (
      typeof state.last_operations_delivery_failure_error !== "string" ||
      state.last_operations_delivery_failure_error.length > 500
    )) ||
    ((state.last_operations_delivery_failure_at === null) !==
      (state.last_operations_delivery_failure_error === null)) ||
    !state.dynamic_subscriptions ||
    Array.isArray(state.dynamic_subscriptions) ||
    !Array.isArray(state.outbox) ||
    !Array.isArray(state.delivery_keys)
  ) {
    throw new TypeError("Invalid Telegram bot state");
  }
  iso(state.created_at, "state.created_at");
  iso(state.updated_at, "state.updated_at");
  for (const field of [
    "heartbeat_at",
    "last_update_poll_at",
    "last_event_poll_at",
    "last_forecast_input_poll_at",
    "forecast_input_cursor_reset_at",
    "last_operations_alert_poll_at",
    "operations_alert_cursor_reset_at",
    "last_operations_delivery_failure_at",
  ]) {
    if (state[field] !== null) iso(state[field], `state.${field}`);
  }
  outcomeRevisionGate(state.forecast_input_outcome_revision_gate);
  for (const [chatId, value] of Object.entries(state.dynamic_subscriptions)) {
    validateSubscription(chatId, value);
  }
  for (const job of state.outbox) validateJob(job);
  if (
    state.delivery_keys.some((key) =>
      typeof key !== "string" || key.length < 1 || key.length > 512
    )
  ) {
    throw new TypeError("Invalid Telegram delivery key history");
  }
  return state;
}

export async function readTelegramStateFile(filePath) {
  const state = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (state?.schema_version === LEGACY_STATE_SCHEMA_VERSION) {
    state.schema_version = PREVIOUS_STATE_SCHEMA_VERSION;
    state.last_operations_alert_poll_at = null;
    state.operations_alert_cursor = null;
    state.operations_alert_baseline_initialized = false;
  }
  state.operations_alert_cursor_reset_at ??= null;
  state.operations_alert_cursor_reset_reason ??= null;
  state.operations_alert_generation ??= 0;
  state.last_operations_delivery_failure_at ??= null;
  state.last_operations_delivery_failure_error ??= null;
  if (state.schema_version === PREVIOUS_STATE_SCHEMA_VERSION) {
    state.schema_version = PREVIOUS_SEMANTIC_DEDUPE_SCHEMA_VERSION;
    state.forecast_input_cursor = null;
    state.forecast_input_baseline_initialized = false;
    state.forecast_input_outcome_revision_gate = defaultOutcomeRevisionGate();
    state.forecast_input_cursor_reset_at = null;
    state.forecast_input_cursor_reset_reason = null;
    state.last_forecast_input_poll_at = null;
    state.dynamic_subscriptions = Object.fromEntries(
      Object.entries(state.dynamic_subscriptions ?? {}).map(([chatId, value]) => [
        chatId,
        {
          chat_id: chatId,
          stable: true,
          probability_preferences: value?.experimental === true
            ? normalizeNotificationPreferences()
            : null,
          probability_watch: null,
          generation: 1,
          stable_since: value?.updated_at ?? state.updated_at,
          updated_at: value?.updated_at ?? state.updated_at,
        },
      ]),
    );
    for (const job of state.outbox ?? []) {
      job.subscription_generation = null;
      job.preferences_hash = null;
      job.outcome_revision_token = null;
    }
  }
  for (const value of Object.values(state.dynamic_subscriptions ?? {})) {
    value.stable_since ??= value.updated_at ?? state.updated_at;
  }
  if (state.schema_version === PREVIOUS_SEMANTIC_DEDUPE_SCHEMA_VERSION) {
    for (const job of state.outbox ?? []) {
      const previousKey = job.dedupe_key;
      job.dedupe_key = semanticJobDeliveryKey(job);
      if (["delivered", "dead"].includes(job.status)) {
        state.delivery_keys.push(previousKey, job.id, job.dedupe_key);
      }
    }
    state.schema_version = PREVIOUS_LOCALELESS_STATE_SCHEMA_VERSION;
    state.delivery_keys = [...new Set(state.delivery_keys)]
      .slice(-DELIVERY_KEY_LIMIT);
  }
  if (state.schema_version === PREVIOUS_LOCALELESS_STATE_SCHEMA_VERSION) {
    state.schema_version = TELEGRAM_STATE_SCHEMA_VERSION;
    state.bot_locale = null;
  }
  return assertTelegramState(state);
}

function pruneState(state) {
  const terminal = state.outbox
    .filter((job) => ["delivered", "dead"].includes(job.status))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const keepTerminal = new Set(
    terminal.slice(0, TERMINAL_JOB_LIMIT).map((job) => job.id),
  );
  state.outbox = state.outbox.filter((job) =>
    !["delivered", "dead"].includes(job.status) || keepTerminal.has(job.id)
  );
  state.delivery_keys = [...new Set(state.delivery_keys)]
    .slice(-DELIVERY_KEY_LIMIT);
}

function addJobs(state, jobs, now) {
  const known = new Set([
    ...state.delivery_keys,
    ...state.outbox.map((job) => job.id),
    ...state.outbox.map((job) => job.dedupe_key),
  ]);
  let added = 0;
  for (const input of jobs ?? []) {
    const timestamp = now.toISOString();
    const topicJob = ["event", "probability"].includes(input.kind);
    const eventTopic = topicJob &&
        typeof input.eventTopic === "string"
      ? input.eventTopic.trim().toLowerCase()
      : null;
    const draftJob = {
      id: String(input.id),
      dedupe_key: String(input.id),
      kind: input.kind,
      event_topic: eventTopic,
      experimental: topicJob && input.experimental === true,
      subscription_generation: input.kind === "probability"
        ? input.subscriptionGeneration
        : null,
      preferences_hash: input.kind === "probability"
        ? input.preferencesHash
        : null,
      outcome_revision_token: input.kind === "probability"
        ? input.outcomeRevisionToken ?? null
        : null,
      chat_id: normalizeTelegramId(input.chatId, "outbox chat id"),
      text: String(input.text),
      status: "pending",
      attempts: 0,
      not_before: timestamp,
      expires_at: input.expiresAt ?? null,
      created_at: timestamp,
      updated_at: timestamp,
      last_error: null,
      telegram_message_id: null,
    };
    const job = {
      ...draftJob,
      dedupe_key: semanticJobDeliveryKey(draftJob),
    };
    if (known.has(job.id) || known.has(job.dedupe_key)) continue;
    validateJob(job);
    state.outbox.push(job);
    known.add(job.id);
    known.add(job.dedupe_key);
    added += 1;
  }
  return added;
}

export class TelegramStateStore {
  #state = null;
  #chain = Promise.resolve();

  constructor({ directory, now = () => new Date() }) {
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, "state.json");
    this.now = now;
  }

  async #write(state) {
    assertTelegramState(state);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.#state = await readTelegramStateFile(this.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.#state = defaultState(this.now());
      await this.#write(this.#state);
    }
    const recovered = structuredClone(this.#state);
    let changed = false;
    for (const job of recovered.outbox) {
      if (job.status !== "sending") continue;
      job.status = "retry";
      job.not_before = this.now().toISOString();
      job.updated_at = job.not_before;
      job.last_error = "recovered_after_restart";
      changed = true;
    }
    if (changed) {
      recovered.updated_at = this.now().toISOString();
      await this.#write(recovered);
      this.#state = recovered;
    }
    return this;
  }

  async read() {
    await this.#chain;
    if (!this.#state) throw new Error("TelegramStateStore is not initialized");
    return structuredClone(this.#state);
  }

  async #mutate(mutator) {
    const operation = async () => {
      if (!this.#state) throw new Error("TelegramStateStore is not initialized");
      const draft = structuredClone(this.#state);
      const result = await mutator(draft);
      if (result === NO_STATE_CHANGE) return null;
      draft.updated_at = this.now().toISOString();
      pruneState(draft);
      assertTelegramState(draft);
      await this.#write(draft);
      this.#state = draft;
      return result;
    };
    const result = this.#chain.then(operation, operation);
    this.#chain = result.catch(() => {});
    return result;
  }

  commitUpdateBatch({ nextUpdateId, jobs = [], subscriptionChanges = [] }) {
    return this.#mutate((state) => {
      if (!Number.isSafeInteger(nextUpdateId) || nextUpdateId < 0) {
        throw new TypeError("nextUpdateId must be a non-negative safe integer");
      }
      addJobs(state, jobs, this.now());
      for (const change of subscriptionChanges) {
        const chatId = normalizeTelegramId(change.chatId, "subscription chat id");
        if (change.value === null) {
          delete state.dynamic_subscriptions[chatId];
          const cancelledAt = this.now().toISOString();
          for (const job of state.outbox) {
            if (
              job.chat_id !== chatId ||
              !["pending", "retry"].includes(job.status) ||
              !(
                job.kind === "probability" ||
                (job.kind === "event" && change.cancelPendingEvents !== false)
              )
            ) continue;
            job.status = "dead";
            job.last_error = "subscription_removed";
            job.updated_at = cancelledAt;
            rememberJobDelivery(state, job);
          }
        } else {
          const probabilityPreferences = change.value.probability_preferences !==
                undefined
            ? (
                change.value.probability_preferences === null
                  ? null
                  : normalizeNotificationPreferences(
                      change.value.probability_preferences,
                    )
              )
            : change.value.experimental === true
              ? normalizeNotificationPreferences()
              : null;
          const previous = state.dynamic_subscriptions[chatId] ?? null;
          const previousHash = previous?.probability_preferences
            ? notificationPreferencesHash(previous.probability_preferences)
            : null;
          const nextHash = probabilityPreferences
            ? notificationPreferencesHash(probabilityPreferences)
            : null;
          const preferencesChanged = previous !== null && previousHash !== nextHash;
          const generation = previous === null
            ? 1
            : preferencesChanged
              ? previous.generation + 1
              : previous.generation;
          if (preferencesChanged) {
            const cancelledAt = this.now().toISOString();
            for (const job of state.outbox) {
              if (
                job.kind !== "probability" ||
                job.chat_id !== chatId ||
                !["pending", "retry"].includes(job.status)
              ) continue;
              job.status = "dead";
              job.last_error = "subscription_changed";
              job.updated_at = cancelledAt;
              rememberJobDelivery(state, job);
            }
          }
          const updatedAt = this.now().toISOString();
          state.dynamic_subscriptions[chatId] = {
            chat_id: chatId,
            stable: true,
            probability_preferences: probabilityPreferences,
            probability_watch: preferencesChanged
              ? null
              : previous?.probability_watch ?? null,
            generation,
            stable_since: previous?.stable_since ?? updatedAt,
            updated_at: updatedAt,
          };
        }
      }
      state.next_update_id = Math.max(
        state.next_update_id ?? 0,
        nextUpdateId,
      );
      state.last_update_poll_at = this.now().toISOString();
    });
  }

  bindBotIdentity(value, locale) {
    const botId = normalizeTelegramId(value, "Telegram bot id");
    if (botId.startsWith("-")) {
      throw new TypeError("Telegram bot id must be positive");
    }
    if (typeof locale !== "string" || !locale.trim()) {
      throw new TypeError("Telegram bot locale is required");
    }
    const botLocale = normalizeTelegramLocale(locale);
    return this.#mutate((state) => {
      if (state.bot_id !== null && state.bot_id !== botId) {
        throw new Error(
          `Telegram state belongs to bot ${state.bot_id}, not bot ${botId}`,
        );
      }
      if (state.bot_locale !== null && state.bot_locale !== botLocale) {
        throw new Error(
          `Telegram state belongs to locale ${state.bot_locale}, not ${botLocale}`,
        );
      }
      if (state.bot_id === botId && state.bot_locale === botLocale) {
        return NO_STATE_CHANGE;
      }
      state.bot_id = botId;
      state.bot_locale = botLocale;
    });
  }

  recordUpdatePoll() {
    return this.#mutate((state) => {
      state.last_update_poll_at = this.now().toISOString();
    });
  }

  baselineEvents(cursor) {
    return this.#mutate((state) => {
      state.event_cursor = eventCursor(cursor);
      state.event_baseline_initialized = true;
      state.last_event_poll_at = this.now().toISOString();
    });
  }

  commitEvents({ cursor, jobs = [], buildJobs = null }) {
    return this.#mutate((state) => {
      const resolvedJobs = typeof buildJobs === "function"
        ? buildJobs({
            dynamic_subscriptions: structuredClone(
              state.dynamic_subscriptions,
            ),
          })
        : jobs;
      if (!Array.isArray(resolvedJobs)) {
        throw new TypeError("Telegram event job builder must return an array");
      }
      const added = addJobs(state, resolvedJobs, this.now());
      const nextCursor = eventCursor(cursor);
      if (
        state.event_cursor !== null &&
        Number(nextCursor) < Number(state.event_cursor)
      ) {
        throw new RangeError("Telegram event cursor cannot move backwards");
      }
      state.event_cursor = nextCursor;
      state.event_baseline_initialized = true;
      state.last_event_poll_at = this.now().toISOString();
      return added;
    });
  }

  recordEventPoll() {
    return this.#mutate((state) => {
      state.last_event_poll_at = this.now().toISOString();
    });
  }

  baselineForecastInputs({ cursor, outcomeRevisionGate: gate }) {
    return this.#mutate((state) => {
      state.forecast_input_cursor = eventCursor(
        cursor,
        "forecast input cursor",
      );
      state.forecast_input_baseline_initialized = true;
      state.forecast_input_outcome_revision_gate = outcomeRevisionGate(gate);
      state.last_forecast_input_poll_at = this.now().toISOString();
      for (const subscription of Object.values(state.dynamic_subscriptions)) {
        subscription.probability_watch = null;
      }
    });
  }

  resetForecastInputBaseline({ cursor, reason, outcomeRevisionGate: gate }) {
    return this.#mutate((state) => {
      if (!["ahead_of_tail", "retention_gap"].includes(reason)) {
        throw new TypeError("Telegram forecast input reset reason is invalid");
      }
      const resetAt = this.now().toISOString();
      state.forecast_input_cursor = eventCursor(
        cursor,
        "forecast input cursor",
      );
      state.forecast_input_baseline_initialized = true;
      state.forecast_input_outcome_revision_gate = outcomeRevisionGate(gate);
      state.forecast_input_cursor_reset_at = resetAt;
      state.forecast_input_cursor_reset_reason = reason;
      state.last_forecast_input_poll_at = resetAt;
      for (const subscription of Object.values(state.dynamic_subscriptions)) {
        subscription.probability_watch = null;
      }
      for (const job of state.outbox) {
        if (
          job.kind !== "probability" ||
          !["pending", "retry"].includes(job.status)
        ) continue;
        job.status = "dead";
        job.last_error = "forecast_input_cursor_reset";
        job.updated_at = resetAt;
        rememberJobDelivery(state, job);
      }
    });
  }

  commitForecastInputs({
    cursor,
    outcomeRevisionGate: gate,
    buildUpdates,
  }) {
    return this.#mutate((state) => {
      if (typeof buildUpdates !== "function") {
        throw new TypeError("Telegram forecast input update builder is required");
      }
      const normalizedGate = outcomeRevisionGate(gate);
      const result = buildUpdates({
        dynamic_subscriptions: structuredClone(state.dynamic_subscriptions),
        outcome_revision_gate: structuredClone(normalizedGate),
      });
      if (
        !result ||
        !Array.isArray(result.jobs) ||
        !Array.isArray(result.watch_updates)
      ) {
        throw new TypeError("Telegram forecast input update builder is invalid");
      }
      for (const update of result.watch_updates) {
        const chatId = normalizeTelegramId(
          update?.chatId,
          "probability watch chat id",
        );
        const subscription = state.dynamic_subscriptions[chatId];
        if (!subscription || subscription.generation !== update.generation) {
          continue;
        }
        subscription.probability_watch = normalizeProbabilitySubscriptionState(
          update.watch,
        );
      }
      const added = addJobs(state, result.jobs, this.now());
      const nextCursor = eventCursor(cursor, "forecast input cursor");
      if (
        state.forecast_input_cursor !== null &&
        Number(nextCursor) < Number(state.forecast_input_cursor)
      ) {
        throw new RangeError("Telegram forecast input cursor cannot move backwards");
      }
      state.forecast_input_cursor = nextCursor;
      state.forecast_input_baseline_initialized = true;
      state.forecast_input_outcome_revision_gate = normalizedGate;
      state.last_forecast_input_poll_at = this.now().toISOString();
      return added;
    });
  }

  baselineOperationsAlerts(cursor) {
    return this.#mutate((state) => {
      state.operations_alert_cursor = eventCursor(
        cursor,
        "operations alert cursor",
      );
      state.operations_alert_baseline_initialized = true;
      state.last_operations_alert_poll_at = this.now().toISOString();
    });
  }

  resetOperationsAlertBaseline({ cursor, reason, generation, jobs = [] }) {
    return this.#mutate((state) => {
      if (!["ahead_of_tail", "retention_gap"].includes(reason)) {
        throw new TypeError("Telegram operations alert reset reason is invalid");
      }
      if (generation !== state.operations_alert_generation + 1) {
        throw new RangeError("Telegram operations alert generation is invalid");
      }
      for (const job of jobs) {
        if (job?.kind !== "operations_alert") {
          throw new TypeError(
            "Telegram operations reset batches may contain only operations_alert jobs",
          );
        }
      }
      state.operations_alert_generation = generation;
      const added = addJobs(state, jobs, this.now());
      state.operations_alert_cursor = eventCursor(
        cursor,
        "operations alert reset cursor",
      );
      state.operations_alert_baseline_initialized = true;
      state.operations_alert_cursor_reset_at = this.now().toISOString();
      state.operations_alert_cursor_reset_reason = reason;
      state.last_operations_alert_poll_at = this.now().toISOString();
      return added;
    });
  }

  commitOperationsAlerts({ cursor, jobs = [] }) {
    return this.#mutate((state) => {
      for (const job of jobs) {
        if (job?.kind !== "operations_alert") {
          throw new TypeError(
            "Telegram operations alert batches may contain only operations_alert jobs",
          );
        }
      }
      const added = addJobs(state, jobs, this.now());
      const nextCursor = eventCursor(cursor, "operations alert cursor");
      if (
        state.operations_alert_cursor !== null &&
        Number(nextCursor) < Number(state.operations_alert_cursor)
      ) {
        throw new RangeError(
          "Telegram operations alert cursor cannot move backwards",
        );
      }
      state.operations_alert_cursor = nextCursor;
      state.operations_alert_baseline_initialized = true;
      state.last_operations_alert_poll_at = this.now().toISOString();
      return added;
    });
  }

  recordOperationsAlertPoll() {
    return this.#mutate((state) => {
      state.last_operations_alert_poll_at = this.now().toISOString();
    });
  }

  heartbeat() {
    return this.#mutate((state) => {
      state.heartbeat_at = this.now().toISOString();
    });
  }

  claimDueJob({ authorize = null } = {}) {
    let claimed = null;
    return this.#mutate((state) => {
      const nowIso = this.now().toISOString();
      const job = state.outbox
        .filter((item) =>
          ["pending", "retry"].includes(item.status) &&
          item.not_before <= nowIso
        )
        .sort((left, right) =>
          (right.kind === "operations_alert" ? 1 : 0) -
            (left.kind === "operations_alert" ? 1 : 0) ||
          left.not_before.localeCompare(right.not_before) ||
          left.created_at.localeCompare(right.created_at) ||
          left.id.localeCompare(right.id)
        )[0];
      if (!job) return NO_STATE_CHANGE;
      if (
        typeof authorize === "function" &&
        !authorize(structuredClone(job), {
          dynamic_subscriptions: structuredClone(state.dynamic_subscriptions),
          forecast_input_outcome_revision_gate: structuredClone(
            state.forecast_input_outcome_revision_gate,
          ),
        })
      ) {
        job.status = "dead";
        job.last_error = "recipient_not_authorized";
        job.updated_at = nowIso;
        rememberJobDelivery(state, job);
        claimed = structuredClone(job);
        return;
      }
      job.status = "sending";
      job.attempts += 1;
      job.updated_at = nowIso;
      claimed = structuredClone(job);
    }).then(() => claimed);
  }

  markDelivered(id, telegramMessageId = null) {
    return this.#mutate((state) => {
      const job = state.outbox.find((item) => item.id === id);
      if (!job) throw new Error(`Unknown Telegram outbox job ${id}`);
      job.status = "delivered";
      job.telegram_message_id = telegramMessageId;
      job.last_error = null;
      job.updated_at = this.now().toISOString();
      rememberJobDelivery(state, job);
    });
  }

  markRetry(id, { notBefore, error }) {
    return this.#mutate((state) => {
      const job = state.outbox.find((item) => item.id === id);
      if (!job) throw new Error(`Unknown Telegram outbox job ${id}`);
      job.status = "retry";
      job.not_before = iso(notBefore, "retry.not_before");
      job.last_error = String(error ?? "delivery_failed").slice(0, 500);
      job.updated_at = this.now().toISOString();
    });
  }

  markDead(id, error) {
    return this.#mutate((state) => {
      const job = state.outbox.find((item) => item.id === id);
      if (!job) throw new Error(`Unknown Telegram outbox job ${id}`);
      const errorText = String(error ?? "delivery_failed").slice(0, 500);
      const updatedAt = this.now().toISOString();
      job.status = "dead";
      job.last_error = errorText;
      job.updated_at = updatedAt;
      if (
        job.kind === "operations_alert" &&
        !["recipient_not_authorized", "subscription_removed"].includes(errorText)
      ) {
        state.last_operations_delivery_failure_at = updatedAt;
        state.last_operations_delivery_failure_error = errorText;
      }
      rememberJobDelivery(state, job);
    });
  }
}
