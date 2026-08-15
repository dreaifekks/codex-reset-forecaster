import {
  ForecasterApiError,
  TelegramApiError,
  redactSecrets,
} from "./client.mjs";
import { normalizeTelegramId } from "./config.mjs";
import {
  normalizeNotificationPreferences,
  normalizeNotificationOutcomeRevisionGate,
  notificationPreferencesHash,
  transitionProbabilitySubscription,
} from "../notifications/subscription-policy.mjs";
import {
  formatAbout,
  formatForecast,
  formatHelp,
  formatHistory,
  formatLastReset,
  formatNotificationEvent,
  formatOperationsAlert,
  formatProbabilityNotification,
  formatSubscription,
  formatTraffic,
  formatUnavailableForecast,
  parseTelegramCommand,
} from "./format.mjs";
import {
  normalizeTelegramLocale,
  telegramCommandMenus,
  telegramText,
} from "./locale.mjs";

function parseProbabilitySubscription(argument) {
  const normalized = String(argument ?? "").trim().toLowerCase();
  if (normalized === "experimental") {
    return normalizeNotificationPreferences();
  }
  const match = normalized.match(
    /^probability\s+([1-9][0-9]{0,2})h\s+([0-9]{1,2}(?:\.[0-9]{1,2})?)%$/,
  );
  if (!match) return null;
  return normalizeNotificationPreferences({
    schema_version: "notification-preferences/1",
    horizon_hours: Number(match[1]),
    probability_threshold: Number(match[2]) / 100,
  });
}

function probabilitySnapshot(input, horizonHours) {
  const points = input?.horizon_probabilities;
  const selectedPoint = Array.isArray(points)
    ? points.find((point) => point?.horizon_hours === horizonHours)
    : null;
  if (
    !selectedPoint
  ) {
    throw new TypeError(
      `Telegram forecast input is missing the ${horizonHours}h probability`,
    );
  }
  return {
    schema_version: "notification-probability-snapshot/2",
    prediction_ref: structuredClone(input.prediction_ref),
    issued_at: input.issued_at,
    knowledge_cutoff: input.knowledge_cutoff,
    emitted_at: input.emitted_at,
    expires_at: input.expires_at,
    horizon_probabilities: [structuredClone(selectedPoint)],
  };
}

function probabilityRequestFor(state) {
  const subscriptions = new Map();
  const horizons = new Set();
  for (const subscription of Object.values(state.dynamic_subscriptions ?? {})) {
    const preferences = subscription.probability_preferences;
    if (!preferences) continue;
    const preferencesHash = notificationPreferencesHash(preferences);
    subscriptions.set(subscription.chat_id, {
      generation: subscription.generation,
      preferences_hash: preferencesHash,
      horizon_hours: preferences.horizon_hours,
    });
    horizons.add(preferences.horizon_hours);
  }
  return {
    subscriptions,
    horizons: [...horizons].sort((left, right) => left - right),
  };
}

function inputSequence(input) {
  if (!Number.isSafeInteger(input?.sequence) || input.sequence < 1) {
    throw new TypeError("Telegram forecast input sequence is invalid");
  }
  return input.sequence;
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function safeMessage(error, secrets = []) {
  return redactSecrets(error?.message ?? error, secrets).slice(0, 500);
}

function updateId(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    throw new TypeError("Telegram update has an invalid update_id");
  }
  return update.update_id;
}

function eventIdentity(event) {
  const value = event?.event_id ?? event?.id;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._:@/-]+$/.test(value)
  ) {
    throw new TypeError("Notification event has an invalid event id");
  }
  return value;
}

function eventTopic(event) {
  return String(event?.topic ?? event?.type ?? "general")
    .trim()
    .toLowerCase();
}

function operationsAlertIdentity(alert) {
  const value = alert?.alert_id ?? alert?.id;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._:@/-]+$/.test(value)
  ) {
    throw new TypeError("Operations alert has an invalid alert id");
  }
  return value;
}

function assertDeliverableEvent(event) {
  eventIdentity(event);
  const topic = eventTopic(event);
  if (!["authority", "outcome", "experimental_probability"].includes(topic)) {
    throw new TypeError("Notification event has an unsupported topic");
  }
  const experimental = topic === "experimental_probability";
  if (
    event?.experimental !== experimental ||
    event?.report?.default_delivery !== !experimental
  ) {
    throw new TypeError("Notification event delivery class is inconsistent");
  }
  if (!Number.isFinite(Date.parse(event?.expires_at ?? ""))) {
    throw new TypeError("Notification event has an invalid expires_at");
  }
  return { topic, experimental };
}

export class TelegramBotRuntime {
  #controller = null;
  #loops = [];
  #initialized = false;
  #rateLimits = new Map();

  constructor({
    telegram,
    forecaster,
    stateStore,
    config,
    logger = console,
    now = () => new Date(),
    random = Math.random,
    sleep = wait,
  }) {
    this.telegram = telegram;
    this.forecaster = forecaster;
    this.stateStore = stateStore;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    this.botLocale = normalizeTelegramLocale(config.botLocale);
    this.botUsername = null;
  }

  #tr(chinese, english) {
    return telegramText(this.botLocale, chinese, english);
  }

  async #registerCommandMenus(signal) {
    if (typeof this.telegram.setMyCommands !== "function") return;
    for (const { scope, commands } of telegramCommandMenus(this.botLocale)) {
      try {
        await this.telegram.setMyCommands({ commands, scope, signal });
      } catch (error) {
        if (error?.code === "ABORTED" && signal?.aborted) throw error;
        this.logger.warn?.(
          `telegram command menu registration failed (${scope.type}): ${safeMessage(
            error,
            [this.config.token, this.config.operationsToken],
          )}`,
        );
      }
    }
  }

  async initialize({ signal = null } = {}) {
    if (this.#initialized) return;
    await this.stateStore.init();
    const webhook = await this.telegram.getWebhookInfo({ signal });
    if (String(webhook?.url ?? "").trim()) {
      throw new Error(
        "Telegram webhook is configured; remove it explicitly before using long polling",
      );
    }
    const me = await this.telegram.getMe({ signal });
    await this.stateStore.bindBotIdentity(me?.id, this.botLocale);
    this.botUsername = typeof me?.username === "string" ? me.username : null;
    await this.#registerCommandMenus(signal);
    await this.stateStore.heartbeat();
    this.#initialized = true;
  }

  #authorized(message) {
    try {
      if (message?.from?.is_bot === true) return null;
      const userId = normalizeTelegramId(message?.from?.id, "message.from.id");
      const chatId = normalizeTelegramId(message?.chat?.id, "message.chat.id");
      if (userId.startsWith("-") || this.config.blockedUserIds.has(userId)) {
        return null;
      }
      const chatType = String(message?.chat?.type ?? "");
      if (chatType === "private" && chatId === userId) {
        return {
          userId,
          chatId,
          scope: "private",
          admin: this.config.adminUserIds.has(userId),
        };
      }
      if (
        ["group", "supergroup"].includes(chatType) &&
        this.config.allowedGroupChatIds.has(chatId)
      ) {
        return {
          userId,
          chatId,
          scope: "group",
          admin: this.config.adminUserIds.has(userId),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  #consumeRateLimit(userId, admin) {
    if (admin) return { allowed: true, warn: false };
    const now = this.now().getTime();
    const windowMs = this.config.commandRateWindowSeconds * 1_000;
    let entry = this.#rateLimits.get(userId);
    if (!entry || now - entry.startedAt >= windowMs) {
      entry = { startedAt: now, count: 0, warned: false };
    }
    entry.count += 1;
    const allowed = entry.count <= this.config.commandRateLimit;
    const warn = !allowed && !entry.warned;
    if (warn) entry.warned = true;
    this.#rateLimits.delete(userId);
    this.#rateLimits.set(userId, entry);
    while (this.#rateLimits.size > 10_000) {
      this.#rateLimits.delete(this.#rateLimits.keys().next().value);
    }
    return { allowed, warn };
  }

  async #currentForecastText(detailed, signal) {
    try {
      const health = await this.forecaster.getHealth({ signal });
      if (
        health.serving_ready !== true ||
        health.synthetic_only === true ||
        !health.current_prediction_ref?.snapshot_url
      ) return formatUnavailableForecast(health, { locale: this.botLocale });
      const prediction = await this.forecaster.getExactSnapshot(
        health.current_prediction_ref.snapshot_url,
        { signal },
      );
      return formatForecast({
        health,
        prediction,
        detailed,
        timeZone: this.config.displayTimeZone,
        publicBaseUrl: this.config.forecasterPublicBaseUrl,
        locale: this.botLocale,
      });
    } catch (error) {
      if (error?.code === "ABORTED") throw error;
      return this.#tr(
        "暂时无法读取当前预测，请稍后再试。",
        "The current forecast is temporarily unavailable. Please try again later.",
      );
    }
  }

  async #currentTrafficText(signal) {
    if (!this.config.operationsToken) {
      return this.#tr(
        "运维监控尚未配置，无法读取请求量与容量状态。",
        "Operations monitoring is not configured, so request and capacity status is unavailable.",
      );
    }
    try {
      const [traffic, botState] = await Promise.all([
        this.forecaster.getTraffic({ signal }),
        this.stateStore.read(),
      ]);
      return formatTraffic(traffic, {
        timeZone: this.config.displayTimeZone,
        botState,
        now: this.now,
        locale: this.botLocale,
      });
    } catch (error) {
      if (error?.code === "ABORTED") throw error;
      return this.#tr(
        "暂时无法读取请求量与容量状态，请稍后再试。",
        "Request and capacity status is temporarily unavailable. Please try again later.",
      );
    }
  }

  async #commandAction(update, signal) {
    const message = update.message;
    const authorization = this.#authorized(message);
    if (!authorization || typeof message?.text !== "string") return null;
    const command = parseTelegramCommand(message.text, this.botUsername);
    if (!command) return null;
    if (authorization.scope === "group" && !command.addressedBot) return null;
    const rate = this.#consumeRateLimit(
      authorization.userId,
      authorization.admin,
    );
    if (!rate.allowed) {
      return rate.warn
        ? {
            job: {
              id: `command:${update.update_id}`,
              kind: "command",
              chatId: authorization.chatId,
              text: this.#tr(
                `请求过于频繁，请在 ${this.config.commandRateWindowSeconds} 秒后再试。`,
                `Too many requests. Please try again after ${this.config.commandRateWindowSeconds} seconds.`,
              ),
            },
            subscriptionChange: null,
          }
        : null;
    }
    const { chatId } = authorization;
    let text;
    let subscriptionChange = null;
    let adminOnlyReply = false;
    if (command.name === "forecast" || command.name === "report") {
      if (command.argument) {
        text = this.#tr(
          `用法：/${command.name}`,
          `Usage: /${command.name}`,
        );
      } else {
        text = await this.#currentForecastText(
          command.name === "report",
          signal,
        );
      }
    } else if (command.name === "history") {
      const limit = command.argument === "" ? 5 : Number(command.argument);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        text = this.#tr("用法：/history [1-10]", "Usage: /history [1-10]");
      } else {
        try {
          text = formatHistory(await this.forecaster.getHistory({ signal }), {
            limit,
            timeZone: this.config.displayTimeZone,
            locale: this.botLocale,
          });
        } catch (error) {
          if (error?.code === "ABORTED") throw error;
          text = this.#tr(
            "暂时无法读取历史记录，请稍后再试。",
            "Reset history is temporarily unavailable. Please try again later.",
          );
        }
      }
    } else if (command.name === "lastreset") {
      if (command.argument) {
        text = this.#tr("用法：/lastreset", "Usage: /lastreset");
      } else {
        try {
          text = formatLastReset(await this.forecaster.getHistory({ signal }), {
            timeZone: this.config.displayTimeZone,
            locale: this.botLocale,
          });
        } catch (error) {
          if (error?.code === "ABORTED") throw error;
          text = this.#tr(
            "暂时无法读取最近重置记录，请稍后再试。",
            "The latest reset record is temporarily unavailable. Please try again later.",
          );
        }
      }
    } else if (command.name === "subscribe") {
      if (authorization.scope !== "private") {
        text = this.#tr(
          "订阅只属于你的私聊，请打开 Bot 私聊后再使用 /subscribe。",
          "Subscriptions belong to your private chat. Open a private chat with the bot and use /subscribe there.",
        );
      } else {
        let preferences = null;
        try {
          preferences = command.argument === ""
            ? null
            : parseProbabilitySubscription(command.argument);
        } catch {
          preferences = null;
        }
        if (command.argument !== "" && preferences === null) {
          text = this.#tr(
            "用法：/subscribe 或 /subscribe probability 24h 60%（范围 1—168h、1%—99%）",
            "Usage: /subscribe or /subscribe probability 24h 60% (range: 1-168h and 1%-99%)",
          );
        } else {
          subscriptionChange = {
            chatId,
            value: { probability_preferences: preferences },
          };
          if (preferences === null) {
            text = this.#tr(
              "已订阅稳定通知；概率提醒未开启。使用 /subscribe probability 24h 60% 可设置规则。",
              "Stable notifications are enabled; probability alerts are off. Use /subscribe probability 24h 60% to set a rule.",
            );
          } else {
            const threshold = `${(preferences.probability_threshold * 100).toFixed(
              Number.isInteger(preferences.probability_threshold * 100) ? 0 : 1,
            )}%`;
            const legacy = command.argument.toLowerCase() === "experimental";
            text = this.botLocale === "en"
              ? [
                  "Stable notifications and a personalized probability alert are enabled.",
                  `Rule: notify when the next ${preferences.horizon_hours}-hour probability is strictly above ${threshold}.`,
                  "The current value establishes a silent baseline; earlier alerts are not replayed.",
                  ...(legacy
                    ? ["/subscribe experimental is a compatibility alias for the default 4h/50% rule."]
                    : []),
                ].join("\n")
              : [
                  "已订阅稳定通知并设置个性化概率提醒。",
                  `规则：未来 ${preferences.horizon_hours} 小时概率严格超过 ${threshold} 时提醒。`,
                  "当前值只建立静默基线，不补发历史提醒。",
                  ...(legacy
                    ? ["/subscribe experimental 是兼容别名，对应默认 4h/50% 规则。"]
                    : []),
                ].join("\n");
          }
        }
      }
    } else if (command.name === "subscription") {
      if (authorization.scope !== "private") {
        text = this.#tr(
          "订阅设置只在你的 Bot 私聊中显示。",
          "Subscription settings are available only in your private chat with the bot.",
        );
      } else if (command.argument) {
        text = this.#tr("用法：/subscription", "Usage: /subscription");
      } else {
        const state = await this.stateStore.read();
        text = formatSubscription(state.dynamic_subscriptions[chatId] ?? null, {
          locale: this.botLocale,
        });
      }
    } else if (command.name === "unsubscribe") {
      if (authorization.scope !== "private") {
        text = this.#tr(
          "订阅只属于你的私聊，请打开 Bot 私聊后再使用 /unsubscribe。",
          "Subscriptions belong to your private chat. Open a private chat with the bot and use /unsubscribe there.",
        );
      } else if (command.argument) {
        text = this.#tr("用法：/unsubscribe", "Usage: /unsubscribe");
      } else {
        const staticallySubscribed =
          this.config.staticNotificationChatIds.has(chatId) ||
          this.config.staticExperimentalChatIds.has(chatId);
        subscriptionChange = {
          chatId,
          value: null,
          cancelPendingEvents: !staticallySubscribed,
        };
        text = this.config.staticNotificationChatIds.has(chatId) ||
            this.config.staticExperimentalChatIds.has(chatId)
          ? this.#tr(
              "已取消动态订阅；此聊天仍有静态配置的通知。",
              "The dynamic subscription was cancelled; this chat still has statically configured notifications.",
            )
          : this.#tr(
              "已取消动态订阅。",
              "The dynamic subscription was cancelled.",
            );
      }
    } else if (["traffic", "capacity"].includes(command.name)) {
      if (
        authorization.scope !== "private" ||
        authorization.admin !== true
      ) {
        text = this.#tr(
          "此运维命令只对管理员私聊开放。",
          "This operations command is available only in an administrator's private chat.",
        );
      } else if (command.argument) {
        text = this.#tr(
          `用法：/${command.name}`,
          `Usage: /${command.name}`,
        );
      } else {
        adminOnlyReply = true;
        text = await this.#currentTrafficText(signal);
      }
    } else if (["about", "info"].includes(command.name)) {
      text = command.argument
        ? this.#tr(`用法：/${command.name}`, `Usage: /${command.name}`)
        : formatAbout({
            publicBaseUrl: this.config.forecasterPublicBaseUrl,
            locale: this.botLocale,
          });
    } else if (["help", "start"].includes(command.name)) {
      text = formatHelp({
        admin: authorization.admin,
        group: authorization.scope === "group",
        locale: this.botLocale,
      });
    } else {
      text = formatHelp({
        admin: authorization.admin,
        group: authorization.scope === "group",
        locale: this.botLocale,
      });
    }
    return {
      job: {
        id: `command:${update.update_id}`,
        kind: adminOnlyReply ? "admin_command" : "command",
        chatId,
        text,
      },
      subscriptionChange,
    };
  }

  async pollUpdatesOnce({ signal = null } = {}) {
    const state = await this.stateStore.read();
    const updates = await this.telegram.getUpdates({
      offset: state.next_update_id,
      timeout: this.config.longPollTimeoutSeconds,
      signal,
    });
    if (!Array.isArray(updates)) {
      throw new TypeError("Telegram getUpdates did not return an array");
    }
    const ordered = [...updates].sort((left, right) =>
      updateId(left) - updateId(right)
    );
    const fresh = ordered.filter((update) =>
      state.next_update_id === null || updateId(update) >= state.next_update_id
    );
    if (fresh.length === 0) {
      await this.stateStore.recordUpdatePoll();
      return { updates: 0, jobs: 0 };
    }
    const jobs = [];
    const subscriptionChanges = [];
    for (const update of fresh) {
      const action = await this.#commandAction(update, signal);
      if (action?.job) jobs.push(action.job);
      if (action?.subscriptionChange) {
        subscriptionChanges.push(action.subscriptionChange);
      }
    }
    const nextUpdateId = updateId(fresh.at(-1)) + 1;
    if (!Number.isSafeInteger(nextUpdateId)) {
      throw new RangeError("Telegram next update id is unsafe");
    }
    await this.stateStore.commitUpdateBatch({
      nextUpdateId,
      jobs,
      subscriptionChanges,
    });
    return { updates: fresh.length, jobs: jobs.length };
  }

  #eventRecipients(event, state) {
    const topic = eventTopic(event);
    const experimental = topic === "experimental_probability";
    const recipients = new Set(experimental
      ? this.config.staticExperimentalChatIds
      : [
          ...this.config.staticNotificationChatIds,
          ...this.config.staticExperimentalChatIds,
        ]);
    for (const subscription of Object.values(state.dynamic_subscriptions)) {
      if (
        !experimental &&
        Date.parse(event.emitted_at) > Date.parse(subscription.stable_since)
      ) {
        recipients.add(subscription.chat_id);
      }
    }
    return {
      experimental,
      recipients: [...recipients].filter((chatId) =>
        this.#notificationRecipientAllowed(chatId, state)
      ),
    };
  }

  #notificationRecipientAllowed(chatId, state) {
    if (chatId.startsWith("-")) {
      return this.config.allowedGroupChatIds.has(chatId);
    }
    if (this.config.blockedUserIds.has(chatId)) return false;
    return this.config.adminUserIds.has(chatId) ||
      Boolean(state.dynamic_subscriptions?.[chatId]);
  }

  async pollEventsOnce({ signal = null } = {}) {
    const state = await this.stateStore.read();
    const result = await this.forecaster.getNotificationEvents(
      state.event_baseline_initialized ? state.event_cursor : null,
      { signal },
    );
    if (!state.event_baseline_initialized) {
      await this.stateStore.baselineEvents(result.cursor);
      return { baseline: true, events: result.events.length, jobs: 0 };
    }
    const jobCount = await this.stateStore.commitEvents({
      cursor: result.cursor,
      buildJobs: (currentState) => {
        const jobs = [];
        for (const event of result.events) {
          const eventId = eventIdentity(event);
          assertDeliverableEvent(event);
          const { experimental, recipients } = this.#eventRecipients(
            event,
            currentState,
          );
          const expiresAt = Date.parse(event.expires_at);
          if (expiresAt <= this.now().getTime()) {
            continue;
          }
          if (!experimental && event?.report?.default_delivery !== true) continue;
          const normalizedEvent = experimental && event.experimental !== true
            ? { ...event, experimental: true }
            : event;
          for (const chatId of recipients) {
            jobs.push({
              id: `event:${eventId}:${chatId}`,
              kind: "event",
              chatId,
              eventTopic: eventTopic(event),
              experimental,
              expiresAt: event.expires_at ?? null,
              text: formatNotificationEvent(normalizedEvent, {
                timeZone: this.config.displayTimeZone,
                publicBaseUrl: this.config.forecasterPublicBaseUrl,
                locale: this.botLocale,
              }),
            });
          }
        }
        return jobs;
      },
    });
    return { baseline: false, events: result.events.length, jobs: jobCount };
  }

  async pollForecastInputsOnce({ signal = null } = {}) {
    const state = await this.stateStore.read();
    const request = probabilityRequestFor(state);
    if (request.horizons.length === 0) {
      const tail = await this.forecaster.getForecastInputs(null, {
        horizonHours: [],
        signal,
      });
      await this.stateStore.baselineForecastInputs({
        cursor: tail.cursor,
        outcomeRevisionGate: tail.outcomeRevisionGate,
      });
      return { baseline: true, reset: false, inputs: 0, jobs: 0 };
    }
    const result = await this.forecaster.getForecastInputs(
      state.forecast_input_baseline_initialized
        ? state.forecast_input_cursor
        : null,
      { horizonHours: request.horizons, signal },
    );
    if (!state.forecast_input_baseline_initialized) {
      await this.stateStore.baselineForecastInputs({
        cursor: result.cursor,
        outcomeRevisionGate: result.outcomeRevisionGate,
      });
      return { baseline: true, reset: false, inputs: 0, jobs: 0 };
    }
    if (result.resetRequired) {
      await this.stateStore.resetForecastInputBaseline({
        cursor: result.cursor,
        reason: result.resetReason,
        outcomeRevisionGate: result.outcomeRevisionGate,
      });
      return { baseline: true, reset: true, inputs: 0, jobs: 0 };
    }
    const currentOutcomeGate = normalizeNotificationOutcomeRevisionGate(
      result.outcomeRevisionGate,
    );
    const evaluatedAt = this.now().toISOString();
    const jobCount = await this.stateStore.commitForecastInputs({
      cursor: result.cursor,
      outcomeRevisionGate: currentOutcomeGate,
      buildUpdates: ({ dynamic_subscriptions: subscriptions }) => {
        const jobs = [];
        const watchUpdates = [];
        for (const subscription of Object.values(subscriptions)) {
          const preferences = subscription.probability_preferences;
          if (!preferences) continue;
          const requested = request.subscriptions.get(subscription.chat_id);
          if (
            !requested ||
            requested.generation !== subscription.generation ||
            requested.preferences_hash !==
              notificationPreferencesHash(preferences) ||
            requested.horizon_hours !== preferences.horizon_hours
          ) {
            // A rule created or changed while this HTTP page was in flight must
            // wait for the next requested projection and establish its own
            // silent baseline there.
            continue;
          }
          let watch = subscription.probability_watch;
          for (const input of result.inputs) {
            const sequence = inputSequence(input);
            const inputOutcomeGate = normalizeNotificationOutcomeRevisionGate(
              input.outcome_revision_gate,
            );
            const transition = transitionProbabilitySubscription({
              preferences,
              previousState: watch,
              snapshot: probabilitySnapshot(input, preferences.horizon_hours),
              outcomeRevisionGate: inputOutcomeGate,
              evaluatedAt,
            });
            if (!transition.accepted) {
              if (transition.reason === "snapshot_from_future") {
                throw new Error(
                  `Forecast input ${sequence} is from the future`,
                );
              }
              continue;
            }
            watch = transition.state;
            if (transition.transition?.kind !== "opened") continue;
            if (
              inputOutcomeGate.revision_token !==
                currentOutcomeGate.revision_token ||
              (
                currentOutcomeGate.latest_known_at !== null &&
                Date.parse(input.knowledge_cutoff) <
                  Date.parse(currentOutcomeGate.latest_known_at)
              )
            ) {
              continue;
            }
            jobs.push({
              id: [
                "probability",
                transition.transition.episode_id,
                `g${subscription.generation}`,
                subscription.chat_id,
              ].join(":"),
              kind: "probability",
              chatId: subscription.chat_id,
              eventTopic: "experimental_probability",
              experimental: true,
              expiresAt: input.expires_at,
              subscriptionGeneration: subscription.generation,
              preferencesHash: notificationPreferencesHash(preferences),
              outcomeRevisionToken:
                currentOutcomeGate.revision_token,
              text: formatProbabilityNotification({
                preferences,
                transition: transition.transition,
                input,
              }, {
                timeZone: this.config.displayTimeZone,
                publicBaseUrl: this.config.forecasterPublicBaseUrl,
                locale: this.botLocale,
              }),
            });
          }
          watchUpdates.push({
            chatId: subscription.chat_id,
            generation: subscription.generation,
            watch,
          });
        }
        return { jobs, watch_updates: watchUpdates };
      },
    });
    return {
      baseline: false,
      reset: false,
      inputs: result.inputs.length,
      jobs: jobCount,
      hasMore: result.hasMore,
    };
  }

  async pollOperationsAlertsOnce({ signal = null } = {}) {
    if (!this.config.operationsAlertsEnabled) {
      return { disabled: true, alerts: 0, jobs: 0 };
    }
    let state = await this.stateStore.read();
    let cursor = state.operations_alert_baseline_initialized
      ? state.operations_alert_cursor
      : null;
    let totalAlerts = 0;
    let totalJobs = 0;
    let resetOccurred = false;
    for (let page = 0; page < 5; page += 1) {
      const result = await this.forecaster.getOperationsAlerts(cursor, { signal });
      if (!state.operations_alert_baseline_initialized) {
        await this.stateStore.baselineOperationsAlerts(result.cursor);
        return { baseline: true, alerts: result.alerts.length, jobs: 0 };
      }
      if (result.resetRequired) {
        const resetAt = this.now();
        const generation = state.operations_alert_generation + 1;
        const expiresAt = new Date(resetAt.getTime() + 24 * 60 * 60 * 1_000)
          .toISOString();
        const priorCursor = state.operations_alert_cursor ?? "none";
        const jobs = [...this.config.adminUserIds].map((chatId) => ({
          id: [
            "operations:cursor-reset",
            `g${generation}`,
            result.resetReason,
            priorCursor,
            result.cursor,
            resetAt.toISOString(),
            chatId,
          ].join(":"),
          kind: "operations_alert",
          chatId,
          expiresAt,
          text: this.botLocale === "en"
            ? [
                "Capacity operations alert (admin only)",
                "Operations-alert cursor safely rebuilt [warning]",
                "",
                result.resetReason === "retention_gap"
                  ? "The bot fell behind the origin's retention range. The gap was recorded, and replay continues from the earliest retained alert."
                  : "The origin alert state moved backward. The gap was recorded, and polling continues from the current tail.",
              ].join("\n")
            : [
                "容量运维提醒（仅管理员）",
                "运维告警游标已安全重建 [warning]",
                "",
                result.resetReason === "retention_gap"
                  ? "Bot 落后于源站保留范围；已记录缺口并从仍保留的最早告警继续回放。"
                  : "源站告警状态发生回退；已记录缺口并从当前尾部继续。",
              ].join("\n"),
        }));
        totalJobs += await this.stateStore.resetOperationsAlertBaseline({
          cursor: result.cursor,
          reason: result.resetReason,
          generation,
          jobs,
        });
        this.logger.error?.(
          `operations alert cursor reset: ${result.resetReason}`,
        );
        resetOccurred = true;
        state = await this.stateStore.read();
        cursor = state.operations_alert_cursor;
        if (result.resetReason === "retention_gap") continue;
        return {
          baseline: true,
          reset: true,
          alerts: totalAlerts,
          jobs: totalJobs,
        };
      }
      const jobs = [];
      for (const alert of result.alerts) {
        const alertId = operationsAlertIdentity(alert);
        const expiresAt = Date.parse(alert?.expires_at ?? "");
        if (!Number.isFinite(expiresAt)) {
          throw new TypeError("Operations alert has an invalid expires_at");
        }
        if (expiresAt <= this.now().getTime()) continue;
        for (const chatId of this.config.adminUserIds) {
          jobs.push({
            id: [
              "operations",
              `g${state.operations_alert_generation}`,
              alertId,
              chatId,
            ].join(":"),
            kind: "operations_alert",
            chatId,
            expiresAt: alert.expires_at,
            text: formatOperationsAlert(alert, {
              timeZone: this.config.displayTimeZone,
              locale: this.botLocale,
            }),
          });
        }
      }
      totalAlerts += result.alerts.length;
      totalJobs += await this.stateStore.commitOperationsAlerts({
        cursor: result.cursor,
        jobs,
      });
      cursor = result.cursor;
      if (!result.hasMore) {
        return {
          baseline: resetOccurred,
          ...(resetOccurred ? { reset: true } : {}),
          alerts: totalAlerts,
          jobs: totalJobs,
        };
      }
    }
    throw new Error("Operations alert pagination exceeded the safe page limit");
  }

  #jobAuthorized(job, state) {
    if (job.kind === "admin_command") {
      return this.config.adminUserIds.has(job.chat_id);
    }
    if (job.kind === "command") {
      if (job.chat_id.startsWith("-")) {
        return this.config.allowedGroupChatIds.has(job.chat_id);
      }
      return !this.config.blockedUserIds.has(job.chat_id);
    }
    if (job.kind === "operations_alert") {
      return this.config.operationsAlertsEnabled &&
        this.config.adminUserIds.has(job.chat_id);
    }
    if (!this.#notificationRecipientAllowed(job.chat_id, state)) return false;
    const dynamic = state.dynamic_subscriptions[job.chat_id] ?? null;
    if (job.kind === "probability") {
      return Boolean(
        dynamic?.probability_preferences &&
        dynamic.generation === job.subscription_generation &&
        notificationPreferencesHash(dynamic.probability_preferences) ===
          job.preferences_hash &&
        state.forecast_input_outcome_revision_gate?.revision_token ===
          job.outcome_revision_token,
      );
    }
    if (job.experimental) {
      return this.config.staticExperimentalChatIds.has(job.chat_id);
    }
    return this.config.staticNotificationChatIds.has(job.chat_id) ||
      this.config.staticExperimentalChatIds.has(job.chat_id) ||
      dynamic?.stable === true;
  }

  async dispatchOnce({ signal = null } = {}) {
    const job = await this.stateStore.claimDueJob({
      authorize: (candidate, state) => this.#jobAuthorized(candidate, state),
    });
    if (!job) return false;
    if (job.status === "dead") return true;
    const expiresAt = Date.parse(job.expires_at ?? "");
    if (Number.isFinite(expiresAt) && expiresAt <= this.now().getTime()) {
      await this.stateStore.markDead(
        job.id,
        job.kind === "operations_alert"
          ? "operations_alert_expired"
          : "event_expired",
      );
      return true;
    }
    try {
      const sent = await this.telegram.sendMessage({
        chatId: job.chat_id,
        text: job.text,
        signal,
      });
      await this.stateStore.markDelivered(job.id, sent?.message_id ?? null);
    } catch (error) {
      if (error?.code === "ABORTED" && signal?.aborted) {
        const retryAt = this.now().toISOString();
        await this.stateStore.markRetry(job.id, {
          notBefore: retryAt,
          error: "delivery_aborted",
        });
        return false;
      }
      const errorText = safeMessage(error, [
        this.config.token,
        this.config.operationsToken,
      ]);
      const terminalStatus = error instanceof TelegramApiError &&
        [400, 403].includes(error.status);
      if (
        terminalStatus ||
        job.attempts >= this.config.maximumOutboxAttempts ||
        (error instanceof TelegramApiError && !error.retryable)
      ) {
        await this.stateStore.markDead(job.id, errorText);
      } else {
        const retryMs = error instanceof TelegramApiError &&
            error.status === 429 && Number.isInteger(error.retryAfter)
          ? Math.max(1, error.retryAfter) * 1_000
          : Math.min(
            3_600_000,
            (2 ** Math.min(job.attempts, 10)) * 1_000,
          ) * (1 + this.random() * 0.25);
        const retryAt = new Date(this.now().getTime() + retryMs);
        if (
          Number.isFinite(expiresAt) &&
          retryAt.getTime() >= expiresAt
        ) {
          await this.stateStore.markDead(
            job.id,
            job.kind === "operations_alert"
              ? "operations_alert_expired"
              : "event_expired",
          );
        } else {
          await this.stateStore.markRetry(job.id, {
            notBefore: retryAt.toISOString(),
            error: errorText,
          });
        }
      }
    }
    return true;
  }

  async #loop(name, operation, intervalMs, signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await operation();
        failures = 0;
        if (intervalMs > 0) await this.sleep(intervalMs, signal);
      } catch (error) {
        if (signal.aborted || error?.code === "ABORTED") break;
        failures += 1;
        this.logger.error?.(
          `telegram ${name} failed: ${safeMessage(error, [
            this.config.token,
            this.config.operationsToken,
          ])}`,
        );
        const backoff = Math.min(60_000, 1_000 * (2 ** Math.min(failures, 6)));
        await this.sleep(backoff, signal);
      }
    }
  }

  async start() {
    if (this.#controller) return;
    this.#controller = new AbortController();
    await this.initialize({ signal: this.#controller.signal });
    const signal = this.#controller.signal;
    this.#loops = [
      this.#loop(
        "update polling",
        () => this.pollUpdatesOnce({ signal }),
        0,
        signal,
      ),
      this.#loop(
        "event polling",
        () => this.pollEventsOnce({ signal }),
        this.config.eventPollIntervalMs,
        signal,
      ),
      this.#loop(
        "forecast input polling",
        () => this.pollForecastInputsOnce({ signal }),
        this.config.forecastInputPollIntervalMs,
        signal,
      ),
      this.#loop(
        "outbox dispatch",
        () => this.dispatchOnce({ signal }),
        this.config.dispatchIntervalMs,
        signal,
      ),
      this.#loop(
        "heartbeat",
        () => this.stateStore.heartbeat(),
        this.config.heartbeatIntervalMs,
        signal,
      ),
    ];
    if (this.config.operationsAlertsEnabled) {
      this.#loops.push(this.#loop(
        "operations alert polling",
        () => this.pollOperationsAlertsOnce({ signal }),
        this.config.operationsAlertPollIntervalMs,
        signal,
      ));
    }
  }

  async stop() {
    if (!this.#controller) return;
    this.#controller.abort();
    await Promise.allSettled(this.#loops);
    this.#loops = [];
    this.#controller = null;
  }
}

export { ForecasterApiError, TelegramApiError };
