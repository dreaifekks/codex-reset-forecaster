import {
  DEFAULT_TELEGRAM_LOCALE,
  isEnglishTelegramLocale,
  telegramNumberLocale,
  telegramPublicUrl,
  telegramText,
} from "./locale.mjs";

const MESSAGE_LIMIT = 4_096;
const DEFAULT_DISPLAY_TIME_ZONE = "Asia/Tokyo";

function clean(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

export function limitTelegramText(value, maximum = MESSAGE_LIMIT) {
  const text = clean(value);
  const points = [...text];
  if (points.length <= maximum) return text;
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function percentage(value, locale = DEFAULT_TELEGRAM_LOCALE) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1
    ? `${(numeric * 100).toFixed(1)}%`
    : telegramText(locale, "不可用", "Unavailable");
}

function timeZoneOffsetLabel(date, timeZone) {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = String(offset ?? "").match(
    /^(?:GMT|UTC)(?:([+-])(\d{2}):?(\d{2}))?$/,
  );
  if (!match || !match[1]) return "UTC";
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours === 0 && minutes === 0) return "UTC";
  return `UTC${match[1]}${hours}${minutes === 0
    ? ""
    : `:${String(minutes).padStart(2, "0")}`}`;
}

function dateTime(
  value,
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  locale = DEFAULT_TELEGRAM_LOCALE,
) {
  const unknown = telegramText(locale, "未知", "Unknown");
  if (value === null || value === undefined || value === "") return unknown;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return unknown;
  return `${new Intl.DateTimeFormat(telegramNumberLocale(locale), {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date)} ${timeZoneOffsetLabel(date, timeZone)}`;
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function stageLabel(health, prediction, locale = DEFAULT_TELEGRAM_LOCALE) {
  const stage = health?.serving_stage ??
    prediction?.data?.model?.validation_status;
  if (stage === "validated") {
    return telegramText(locale, "已验证", "Validated");
  }
  if (stage === "provisional") {
    return telegramText(
      locale,
      "临时预测（尚未完成正式验证）",
      "Provisional forecast (formal validation pending)",
    );
  }
  return clean(stage || telegramText(locale, "未知", "Unknown"));
}

export function parseTelegramCommand(text, botUsername = null) {
  const match = clean(text).match(
    /^\/([a-z][a-z0-9_]{0,31})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/i,
  );
  if (!match) return null;
  if (
    match[2] &&
    botUsername &&
    match[2].toLowerCase() !== botUsername.toLowerCase()
  ) return null;
  return {
    name: match[1].toLowerCase(),
    argument: clean(match[3] ?? ""),
    addressedBot: Boolean(match[2]),
  };
}

export function formatHelp({
  admin = false,
  group = false,
  locale = DEFAULT_TELEGRAM_LOCALE,
} = {}) {
  const english = isEnglishTelegramLocale(locale);
  const lines = [
    "Codex Reset Forecaster Bot",
    "",
    english
      ? "/forecast  Current 4-hour and 24-hour forecast"
      : "/forecast  当前 4 小时与 24 小时预测",
    english
      ? "/report  Detailed possible-reset report"
      : "/report  详细的可能重置报告",
    english
      ? "/history [1-10]  Recent confirmed resets"
      : "/history [1-10]  最近确认记录",
    english
      ? "/lastreset  Latest confirmed reset"
      : "/lastreset  最近一次确认重置",
  ];
  if (!group) {
    lines.push(...(english
      ? [
          "/subscribe  Subscribe to stable notifications",
          "/subscribe probability 24h 60%  Set a personalized probability alert",
          "/subscribe experimental  Use the compatible 4h/50% rule",
          "/subscription  Show current subscription settings",
          "/unsubscribe  Cancel the dynamic subscription",
        ]
      : [
          "/subscribe  订阅稳定通知",
          "/subscribe probability 24h 60%  设置个性化概率提醒",
          "/subscribe experimental  使用兼容的 4h/50% 概率规则",
          "/subscription  查看当前订阅设置",
          "/unsubscribe  取消动态订阅",
        ]));
  }
  if (admin && !group) {
    lines.push(english
      ? "/traffic  Request, growth, and capacity status (admin only)"
      : "/traffic  请求量、增长与容量状态（仅管理员）");
  }
  lines.push(english ? "/about  About the bot and its data boundaries" : "/about  关于 Bot 与数据边界");
  lines.push(english ? "/help  Show help" : "/help  查看帮助");
  if (group) {
    lines.push(
      "",
      english
        ? "Groups support queries only; open a private chat with the bot to subscribe."
        : "群聊只提供查询；订阅请私聊 Bot。",
    );
  }
  return lines.join("\n");
}

export function formatAbout({
  publicBaseUrl = null,
  locale = DEFAULT_TELEGRAM_LOCALE,
} = {}) {
  const english = isEnglishTelegramLocale(locale);
  const lines = english
    ? [
        "About Codex Reset Forecaster Bot",
        "",
        "This is an independent, experimental Codex reset forecasting and notification tool.",
        "",
        "It provides 4-hour and 24-hour forecasts, configurable 1-168 hour probability alerts, authoritative reset updates, and confirmed reset records that satisfy the current contract.",
        "",
        "A forecast probability is not reset confirmation and does not guarantee a reset. This bot is not an official OpenAI service.",
        "",
        "Privacy: it processes only the commands you send and the Telegram ID needed for delivery. It cannot access your Codex/OpenAI account or quota.",
      ]
    : [
        "关于 Codex Reset Forecaster Bot",
        "",
        "这是一个独立的实验性 Codex 重置预测与通知工具。",
        "",
        "它提供未来 4 小时与 24 小时预测、可配置的 1—168 小时概率提醒、权威重置动态，以及当前合同下可验证的已确认重置记录。",
        "",
        "预测概率不是重置确认，也不保证重置一定发生。本 Bot 非 OpenAI 官方服务。",
        "",
        "隐私：只处理你发给 Bot 的命令及通知投递所需的 Telegram ID；不接触你的 Codex/OpenAI 账户或额度。",
      ];
  let site = null;
  try {
    if (publicBaseUrl) site = telegramPublicUrl(publicBaseUrl, locale, "home");
  } catch {
    site = null;
  }
  if (site) {
    lines.push("", english ? `Project site: ${site}` : `项目站点：${site}`);
  }
  lines.push(
    "",
    english
      ? "/help shows all commands. /info and /about are equivalent."
      : "/help 查看全部命令。/info 与 /about 内容相同。",
  );
  return limitTelegramText(lines.join("\n"));
}

export function formatSubscription(
  subscription,
  { locale = DEFAULT_TELEGRAM_LOCALE } = {},
) {
  const english = isEnglishTelegramLocale(locale);
  if (!subscription) {
    return english
      ? "There is no dynamic subscription. Use /subscribe to enable stable notifications."
      : "当前没有动态订阅。使用 /subscribe 开启稳定通知。";
  }
  const lines = english
    ? ["Current subscription", "Stable notifications: enabled"]
    : ["当前订阅设置", "稳定通知：已开启"];
  const preferences = subscription.probability_preferences;
  if (preferences) {
    lines.push(
      english
        ? `Probability alert: notify when the next ${preferences.horizon_hours}-hour probability is strictly above ${percentage(preferences.probability_threshold, locale)}`
        : `概率提醒：未来 ${preferences.horizon_hours} 小时概率严格超过 ${percentage(preferences.probability_threshold, locale)} 时提醒`,
      english
        ? "A new or changed rule establishes a current baseline and does not replay earlier alerts."
        : "规则新建或修改时只建立当前基线，不补发历史提醒。",
    );
  } else {
    lines.push(english ? "Probability alert: disabled" : "概率提醒：未开启");
  }
  return limitTelegramText(lines.join("\n"));
}

export function formatProbabilityNotification({
  preferences,
  transition,
  input,
}, {
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  publicBaseUrl = null,
  locale = DEFAULT_TELEGRAM_LOCALE,
} = {}) {
  const english = isEnglishTelegramLocale(locale);
  const lines = english
    ? [
        "Personalized probability alert",
        "",
        `The next ${preferences.horizon_hours}-hour reset probability is ${percentage(transition.probability, locale)}, above your ${percentage(preferences.probability_threshold, locale)} threshold.`,
        "This is a model forecast, not a confirmed reset.",
        "",
        `Model issued: ${dateTime(input.issued_at, timeZone, locale)}`,
        `Alert generated: ${dateTime(input.emitted_at, timeZone, locale)}`,
      ]
    : [
        "个性化概率提醒",
        "",
        `未来 ${preferences.horizon_hours} 小时重置概率 ${percentage(transition.probability, locale)}，已超过你设置的 ${percentage(preferences.probability_threshold, locale)}。`,
        "这是模型预测，不是已确认重置。",
        "",
        `模型签发：${dateTime(input.issued_at, timeZone, locale)}`,
        `提醒生成：${dateTime(input.emitted_at, timeZone, locale)}`,
      ];
  let publicUrl = null;
  try {
    if (publicBaseUrl) publicUrl = telegramPublicUrl(publicBaseUrl, locale, "home");
  } catch {
    publicUrl = null;
  }
  if (publicUrl) lines.push(english ? `Details: ${publicUrl}` : `详情：${publicUrl}`);
  return limitTelegramText(lines.join("\n"));
}

function count(value, locale = DEFAULT_TELEGRAM_LOCALE) {
  const unavailable = telegramText(locale, "不可用", "Unavailable");
  if (value === null || value === undefined) return unavailable;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? new Intl.NumberFormat(telegramNumberLocale(locale), {
        maximumFractionDigits: 1,
      }).format(number)
    : unavailable;
}

function signedRatioPercentage(value, locale = DEFAULT_TELEGRAM_LOCALE) {
  const unavailable = telegramText(locale, "不可用", "Unavailable");
  if (value === null || value === undefined) return unavailable;
  const number = Number(value);
  if (!Number.isFinite(number)) return unavailable;
  const normalized = number * 100;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(1)}%`;
}

export function formatTraffic(payload, {
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  botState = null,
  now = () => new Date(),
  locale = DEFAULT_TELEGRAM_LOCALE,
} = {}) {
  const english = isEnglishTelegramLocale(locale);
  const traffic = payload?.traffic ?? payload;
  const current = traffic?.current ?? traffic?.today ?? {};
  const yesterday = traffic?.yesterday ?? {};
  const sevenDays = traffic?.seven_days ?? traffic?.last_7_days ?? {};
  const capacity = traffic?.capacity ?? payload?.capacity ?? {};
  const pressure = clean(
    capacity.level ?? capacity.pressure ?? traffic?.pressure ?? "unknown",
  );
  const currentRequests = count(
    current.requests ?? current.request_count,
    locale,
  );
  const yesterdayRequests = count(
    yesterday.requests ?? yesterday.request_count,
    locale,
  );
  const medianRequests = count(
    sevenDays.requests ?? sevenDays.request_count,
    locale,
  );
  const growth = signedRatioPercentage(
    traffic?.growth?.day_over_day ?? traffic?.day_over_day_growth,
    locale,
  );
  const lines = english
    ? [
        "Request and capacity status (admin)",
        `Current requests: ${currentRequests}`,
        `Yesterday's requests: ${yesterdayRequests}`,
        `Prior 7-day median: ${medianRequests}`,
        `Daily growth: ${growth}`,
        `Capacity pressure: ${pressure || "unknown"}`,
      ]
    : [
        "请求量与容量状态（管理员）",
        `当前请求：${currentRequests}`,
        `昨日请求：${yesterdayRequests}`,
        `此前 7 日中位数：${medianRequests}`,
        `日增长：${growth}`,
        `容量压力：${pressure || "unknown"}`,
      ];
  const utilization = capacity.utilization ?? capacity.utilization_ratio;
  if (Number.isFinite(Number(utilization))) {
    lines.push(english
      ? `Capacity utilization: ${percentage(Number(utilization), locale)}`
      : `容量利用率：${percentage(Number(utilization), locale)}`);
  }
  const observedAt = payload?.observed_at ?? traffic?.observed_at;
  if (observedAt) {
    lines.push(english
      ? `Observed: ${dateTime(observedAt, timeZone, locale)}`
      : `统计时间：${dateTime(observedAt, timeZone, locale)}`);
  }
  const rolling = capacity.rolling_window;
  if (rolling && typeof rolling === "object") {
    lines.push("", ...(english
      ? [
          "Origin, last 5 minutes",
          `Public requests: ${count(rolling.public_requests, locale)} / total arrivals ${count(rolling.requests, locale)}`,
          `Interactive p95: ${count(rolling.interactive_p95_ms, locale)} ms`,
          `Event-loop lag p95: ${count(rolling.event_loop_lag_p95_ms, locale)} ms`,
          `True 5xx responses: ${count(rolling.true_errors, locale)}`,
          `Maximum concurrency: ${count(rolling.max_in_flight, locale)}`,
        ]
      : [
          "源站最近 5 分钟",
          `请求：${count(rolling.public_requests, locale)} / 总到达 ${count(rolling.requests, locale)}`,
          `交互 p95：${count(rolling.interactive_p95_ms, locale)} ms`,
          `事件循环滞后 p95：${count(rolling.event_loop_lag_p95_ms, locale)} ms`,
          `真实 5xx：${count(rolling.true_errors, locale)}`,
          `最大并发：${count(rolling.max_in_flight, locale)}`,
        ]));
    if (Array.isArray(capacity.reasons) && capacity.reasons.length > 0) {
      const reasons = capacity.reasons.map((reason) =>
        runtimeResourceReasonLabel(reason, locale) ?? clean(reason)
      );
      lines.push(english
        ? `Triggers: ${reasons.join(", ")}`
        : `触发信号：${reasons.join("、")}`);
    }
  }
  if (botState && Array.isArray(botState.outbox)) {
    const active = botState.outbox.filter((job) =>
      ["pending", "retry", "sending"].includes(job?.status)
    );
    const expectedDead = new Set([
      "subscription_removed",
      "subscription_changed",
      "forecast_input_cursor_reset",
      "event_expired",
      "operations_alert_expired",
      "recipient_not_authorized",
    ]);
    const unexpectedDead = botState.outbox.filter((job) =>
      job?.status === "dead" && !expectedDead.has(job?.last_error)
    );
    const currentMs = now().getTime();
    const oldestDueMs = active.reduce((oldest, job) => {
      const due = Date.parse(job?.not_before ?? "");
      return Number.isFinite(due) && due <= currentMs
        ? Math.min(oldest, due)
        : oldest;
    }, Number.POSITIVE_INFINITY);
    const waitSeconds = Number.isFinite(oldestDueMs)
      ? Math.max(0, Math.floor((currentMs - oldestDueMs) / 1_000))
      : null;
    lines.push("", ...(english
      ? [
          "Telegram delivery queue",
          `Pending/retrying: ${active.length}`,
          `Unexpected failures: ${unexpectedDead.length}`,
          `Oldest due wait: ${waitSeconds === null ? "None" : `${waitSeconds} seconds`}`,
          `Update poll: ${dateTime(botState.last_update_poll_at, timeZone, locale)}`,
          `Event poll: ${dateTime(botState.last_event_poll_at, timeZone, locale)}`,
          `Forecast-input poll: ${dateTime(botState.last_forecast_input_poll_at, timeZone, locale)}`,
        ]
      : [
          "Telegram 投递队列",
          `待投递/重试：${active.length}`,
          `非预期失败：${unexpectedDead.length}`,
          `最老到期等待：${waitSeconds === null ? "无" : `${waitSeconds} 秒`}`,
          `更新轮询：${dateTime(botState.last_update_poll_at, timeZone, locale)}`,
          `事件轮询：${dateTime(botState.last_event_poll_at, timeZone, locale)}`,
          `概率输入轮询：${dateTime(botState.last_forecast_input_poll_at, timeZone, locale)}`,
        ]));
    if (botState.operations_alert_baseline_initialized) {
      lines.push(
        english
          ? `Operations-alert poll: ${dateTime(botState.last_operations_alert_poll_at, timeZone, locale)}`
          : `运维告警轮询：${dateTime(botState.last_operations_alert_poll_at, timeZone, locale)}`,
      );
    }
  }
  return limitTelegramText(lines.join("\n"));
}

function runtimeResourceReasonLabel(
  reason,
  locale = DEFAULT_TELEGRAM_LOCALE,
) {
  const english = isEnglishTelegramLocale(locale);
  const value = clean(reason);
  let match = value.match(/^event_loop_lag_p95_(\d+(?:\.\d+)?)ms$/);
  if (match) {
    return english
      ? `event-loop lag p95: ${count(match[1], locale)} ms`
      : `事件循环滞后 p95：${count(match[1], locale)} 毫秒`;
  }
  match = value.match(/^event_loop_utilization_(\d+(?:\.\d+)?)$/);
  if (match) {
    return english
      ? `event-loop utilization: ${percentage(Number(match[1]), locale)}`
      : `事件循环利用率：${percentage(Number(match[1]), locale)}`;
  }
  match = value.match(/^cgroup_memory_(\d+(?:\.\d+)?)$/);
  if (match) {
    return english
      ? `container memory utilization: ${percentage(Number(match[1]), locale)}`
      : `容器内存使用率：${percentage(Number(match[1]), locale)}`;
  }
  match = value.match(/^node_heap_(\d+(?:\.\d+)?)$/);
  if (match) {
    return english
      ? `Node.js heap utilization: ${percentage(Number(match[1]), locale)}`
      : `Node.js 堆内存使用率：${percentage(Number(match[1]), locale)}`;
  }
  match = value.match(/^in_flight_(\d+)$/);
  if (match) {
    return english
      ? `in-flight requests: ${count(match[1], locale)}`
      : `同时处理中请求：${count(match[1], locale)} 个`;
  }
  const criticalLabels = english
    ? {
        event_loop_lag_critical: "event-loop lag reached the critical threshold",
        event_loop_utilization_critical: "event-loop utilization reached the critical threshold",
        cgroup_memory_critical: "container memory utilization reached the critical threshold",
      }
    : {
        event_loop_lag_critical: "事件循环滞后达到严重阈值",
        event_loop_utilization_critical: "事件循环利用率达到严重阈值",
        cgroup_memory_critical: "容器内存使用率达到严重阈值",
      };
  return criticalLabels[value] ?? null;
}

export function formatOperationsAlert(
  alert,
  {
    timeZone = DEFAULT_DISPLAY_TIME_ZONE,
    locale = DEFAULT_TELEGRAM_LOCALE,
  } = {},
) {
  const english = isEnglishTelegramLocale(locale);
  const level = clean(alert?.level ?? alert?.severity ?? "warning");
  const reasons = Array.isArray(alert?.reasons)
    ? alert.reasons.map((reason) => runtimeResourceReasonLabel(reason, locale))
    : [];
  const runtimeResourceOnly = reasons.length > 0 && reasons.every(Boolean);
  if (runtimeResourceOnly) {
    const lines = english
      ? [
          "Origin runtime alert (admin only)",
          `Origin main thread remains blocked [${level}]`,
          "",
          "This is not a request-growth alert.",
          `Runtime metrics: ${reasons.join(", ")}`,
        ]
      : [
          "源站运行时提醒（仅管理员）",
          `源站主线程持续阻塞 [${level}]`,
          "",
          "这不是请求量增长告警。",
          `运行时指标：${reasons.join("、")}`,
        ];
    const observedAt = alert?.observed_at ?? alert?.emitted_at;
    if (observedAt) {
      lines.push(
        "",
        english
          ? `Time: ${dateTime(observedAt, timeZone, locale)}`
          : `时间：${dateTime(observedAt, timeZone, locale)}`,
      );
    }
    return limitTelegramText(lines.join("\n"));
  }
  const title = english
    ? alert?.alert_type === "capacity.policy_superseded"
      ? "Origin capacity policy updated"
      : alert?.alert_type === "capacity.recovered"
        ? "Origin capacity pressure recovered"
        : level === "critical"
          ? "Origin capacity entered critical pressure"
          : "Origin capacity is becoming strained"
    : clean(alert?.title ?? "容量状态发生变化");
  const summary = english
    ? Array.isArray(alert?.reasons) && alert.reasons.length > 0
      ? `Triggers: ${alert.reasons.map((reason) =>
          runtimeResourceReasonLabel(reason, locale) ?? clean(reason)
        ).join(", ")}`
      : "Sustained healthy windows met the recovery condition."
    : clean(
        alert?.summary ?? alert?.message ?? "请求量或容量压力触发了运维阈值。",
      );
  const lines = [
    english ? "Capacity operations alert (admin only)" : "容量运维提醒（仅管理员）",
    `${title} [${level}]`,
    "",
    summary,
  ];
  const observedAt = alert?.observed_at ?? alert?.emitted_at;
  if (observedAt) {
    lines.push(
      "",
      english
        ? `Time: ${dateTime(observedAt, timeZone, locale)}`
        : `时间：${dateTime(observedAt, timeZone, locale)}`,
    );
  }
  return limitTelegramText(lines.join("\n"));
}

export function formatUnavailableForecast(
  health,
  { locale = DEFAULT_TELEGRAM_LOCALE } = {},
) {
  const blockers = Array.isArray(health?.serving_blockers)
    ? health.serving_blockers.join(", ")
    : "forecast_not_ready";
  const english = isEnglishTelegramLocale(locale);
  return limitTelegramText((english
    ? [
        "There is no forecast that can be shown safely right now.",
        `Service status: ${clean(health?.status ?? "unavailable")}`,
        `Pipeline status: ${clean(health?.pipeline_status ?? "unknown")}`,
        `Blockers: ${clean(blockers)}`,
      ]
    : [
        "当前没有可安全展示的预测。",
        `服务状态：${clean(health?.status ?? "unavailable")}`,
        `流水线状态：${clean(health?.pipeline_status ?? "unknown")}`,
        `阻塞原因：${clean(blockers)}`,
      ]).join("\n"));
}

function assertExactPrediction(health, prediction) {
  const reference = health?.current_prediction_ref;
  if (
    !reference ||
    prediction?.record_id !== reference.record_id ||
    prediction?.revision !== reference.revision ||
    !Array.isArray(prediction?.data?.slots) ||
    prediction.data.slots.length < 24
  ) {
    throw new TypeError("Forecast snapshot does not match the current exact reference");
  }
}

export function formatForecast({
  health,
  prediction,
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  publicBaseUrl = null,
  detailed = false,
  locale = DEFAULT_TELEGRAM_LOCALE,
}) {
  const english = isEnglishTelegramLocale(locale);
  assertExactPrediction(health, prediction);
  const slots = prediction.data.slots;
  const fourHour = slots[0].rolling_4h_probability;
  const twentyFourHour = slots[23].reset_by_end_probability;
  const rolling = slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot, index }) =>
      Number.isFinite(slot.rolling_4h_probability) && index + 3 < slots.length
    )
    .sort((left, right) =>
      right.slot.rolling_4h_probability - left.slot.rolling_4h_probability ||
      left.index - right.index
    )[0];
  const lines = english
    ? [
        detailed ? "Possible upcoming Codex reset report" : "Codex reset forecast",
        `Model status: ${stageLabel(health, prediction, locale)}`,
        `Next 4 hours: ${percentage(fourHour, locale)}`,
        `Next 24 hours: ${percentage(twentyFourHour, locale)}`,
      ]
    : [
        detailed ? "可能到来的 Codex 重置报告" : "Codex 重置预测",
        `模型状态：${stageLabel(health, prediction, locale)}`,
        `未来 4 小时：${percentage(fourHour, locale)}`,
        `未来 24 小时：${percentage(twentyFourHour, locale)}`,
      ];
  if (detailed && rolling) {
    lines.push(...(english
      ? [
          `Highest conditional 4-hour window in 7 days: ${percentage(rolling.slot.rolling_4h_probability, locale)}`,
          `Window: ${dateTime(rolling.slot.start, timeZone, locale)} — ${dateTime(slots[rolling.index + 3].end, timeZone, locale)}`,
        ]
      : [
          `七日内最高条件 4 小时窗口：${percentage(rolling.slot.rolling_4h_probability, locale)}`,
          `窗口：${dateTime(rolling.slot.start, timeZone, locale)} — ${dateTime(slots[rolling.index + 3].end, timeZone, locale)}`,
        ]));
    const conditioning = prediction.data.authority_conditioning;
    const applied = telegramText(locale, "已应用", "Applied");
    const notApplied = telegramText(locale, "未应用", "Not applied");
    lines.push(...(english
      ? [
          `Authoritative timing condition: ${conditioning?.applied ? applied : notApplied}`,
          `Post-reset suppression: ${prediction.data.post_outcome_refractory?.applied ? applied : notApplied}`,
        ]
      : [
          `权威时间条件：${conditioning?.applied ? applied : notApplied}`,
          `重置后抑制：${prediction.data.post_outcome_refractory?.applied ? applied : notApplied}`,
        ]));
  }
  lines.push(...(english
    ? [
        `Issued: ${dateTime(prediction.data.issued_at, timeZone, locale)}`,
        `Knowledge cutoff: ${dateTime(prediction.data.knowledge_cutoff, timeZone, locale)}`,
      ]
    : [
        `签发时间：${dateTime(prediction.data.issued_at, timeZone, locale)}`,
        `知识截止：${dateTime(prediction.data.knowledge_cutoff, timeZone, locale)}`,
      ]));
  let publicUrl = null;
  try {
    if (publicBaseUrl) publicUrl = telegramPublicUrl(publicBaseUrl, locale, "home");
  } catch {
    publicUrl = null;
  }
  if (publicUrl) lines.push(english ? `Website: ${publicUrl}` : `网站：${publicUrl}`);
  return limitTelegramText(lines.join("\n"));
}

function historyRow(result, index, timeZone, locale) {
  const english = isEnglishTelegramLocale(locale);
  const range = result?.occurred_time_range;
  const source = result?.source;
  const operatorConfirmed = result?.label_grade === "silver";
  const lines = english
    ? [
        `${index}. ${operatorConfirmed ? "Operator-confirmed reset (silver)" : "Confirmed reset"}`,
        `Occurred: ${dateTime(range?.start, timeZone, locale)} — ${dateTime(range?.end, timeZone, locale)}`,
      ]
    : [
        `${index}. ${operatorConfirmed ? "人工确认重置（silver）" : "已确认重置"}`,
        `发生：${dateTime(range?.start, timeZone, locale)} — ${dateTime(range?.end, timeZone, locale)}`,
      ];
  if (range?.precision) {
    lines.push(english
      ? `Precision: ${clean(range.precision)}`
      : `精度：${clean(range.precision)}`);
  }
  if (source?.published_at) {
    lines.push(
      english
        ? `${operatorConfirmed ? "Operator confirmation" : "Official source published"}: ${dateTime(source.published_at, timeZone, locale)}`
        : `${operatorConfirmed ? "人工确认时间" : "官方来源发布"}：${dateTime(source.published_at, timeZone, locale)}`,
    );
  }
  const url = safeUrl(source?.canonical_url);
  if (url) lines.push(english ? `Source: ${url}` : `来源：${url}`);
  return lines.join("\n");
}

export function formatHistory(results, {
  limit = 5,
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  locale = DEFAULT_TELEGRAM_LOCALE,
} = {}) {
  const english = isEnglishTelegramLocale(locale);
  const selected = Array.isArray(results) ? results.slice(0, limit) : [];
  if (selected.length === 0) {
    return english
      ? "There are no confirmed reset records that satisfy the current contract."
      : "当前没有符合现行合同的确认重置记录。";
  }
  return limitTelegramText([
    english
      ? `${selected.length} most recent confirmed reset${selected.length === 1 ? "" : "s"}`
      : `最近 ${selected.length} 次确认重置`,
    "",
    ...selected.flatMap((result, index) => [
      historyRow(result, index + 1, timeZone, locale),
      "",
    ]),
  ].join("\n"));
}

export function formatLastReset(
  results,
  {
    timeZone = DEFAULT_DISPLAY_TIME_ZONE,
    locale = DEFAULT_TELEGRAM_LOCALE,
  } = {},
) {
  const english = isEnglishTelegramLocale(locale);
  if (!Array.isArray(results) || results.length === 0) {
    return english
      ? "There are no confirmed reset records that satisfy the current contract."
      : "当前没有符合现行合同的确认重置记录。";
  }
  return limitTelegramText([
    english ? "Latest confirmed reset" : "最近一次确认重置",
    "",
    historyRow(results[0], 1, timeZone, locale).replace(/^1\. /, ""),
  ].join("\n"));
}

function outcomeEventSummary(event, timeZone, locale) {
  const english = isEnglishTelegramLocale(locale);
  const report = event?.report;
  const row = report?.outcome;
  const range = row?.occurred_time_range;
  if (!range?.start || !range?.end) return null;
  const rangeText = `${dateTime(range.start, timeZone, locale)} ${
    english ? "to" : "至"
  } ${
    dateTime(range.end, timeZone, locale)
  }`;
  const kind = outcomeCorrectionKind(event);
  const operatorConfirmed = row?.label_grade === "silver";
  const verificationBasis = operatorConfirmed
    ? telegramText(locale, "人工确认", "operator confirmation")
    : telegramText(locale, "官方来源", "official-source");
  if (kind === "retracted") {
    return english
      ? `The previously published reset record (${rangeText}) was retracted by a new canonical revision.`
      : `先前发布的重置记录（${rangeText}）已被新的 canonical revision 撤回。`;
  }
  if (kind === "verification_withdrawn") {
    return english
      ? `The earlier record (${rangeText}) no longer satisfies the ${verificationBasis} verification contract. This does not assert that the reset did not occur.`
      : `先前记录（${rangeText}）当前不再满足${verificationBasis}验证合同；这不等同于断言重置未发生。`;
  }
  if (kind === "corrected") {
    return english
      ? `The confirmed record was updated to ${rangeText}; use the latest revision and ${verificationBasis} evidence.`
      : `确认记录已更新为 ${rangeText}，请以最新 revision 和${verificationBasis}为准。`;
  }
  if (kind === "confirmed") {
    if (operatorConfirmed) {
      return english
        ? `An operator confirmed the occurrence window as ${rangeText} at silver grade. This is not an official completion statement.`
        : `操作员以 silver 级别确认发生时间为 ${rangeText}；这不是官方完成声明。`;
    }
    return english
      ? `The current outcome contract confirms the occurrence window as ${rangeText}.`
      : `当前 outcome 合同确认发生时间为 ${rangeText}。`;
  }
  return null;
}

function authorityEventSummary(event, timeZone, locale) {
  const english = isEnglishTelegramLocale(locale);
  const forecast = event?.report?.forecast;
  const range = forecast?.authority_conditioning?.asserted_time_range;
  if (!range?.start || !range?.end) return null;
  return english
    ? `An authoritative source mentioned a future reset window from ${dateTime(range.start, timeZone, locale)} to ${dateTime(range.end, timeZone, locale)}. The current 4-hour probability is ${percentage(forecast?.probabilities?.next_4h, locale)}. This is not a confirmed reset.`
    : `权威来源提到 ${dateTime(range.start, timeZone, locale)} 至 ${dateTime(range.end, timeZone, locale)} 的未来重置时间窗；当前 4 小时概率 ${percentage(forecast?.probabilities?.next_4h, locale)}。这不是已确认重置。`;
}

function probabilityEventSummary(event, locale) {
  const english = isEnglishTelegramLocale(locale);
  const forecast = event?.report?.forecast;
  if (!forecast) return null;
  const probability = percentage(forecast?.probabilities?.next_4h, locale);
  if (event?.event_type === "forecast.reset_watch.opened.v1") {
    return english
      ? `The model's current next-4-hour probability is ${probability}; model stage is ${clean(forecast.serving_stage ?? "unknown")}. This is an experimental forecast, not a reset confirmation.`
      : null;
  }
  if (event?.event_type === "forecast.reset_watch.closed.v1") {
    return english
      ? `The next-4-hour probability has fallen to ${probability}, or a new confirmed result ended this watch.`
      : null;
  }
  return null;
}

function outcomeCorrectionKind(event) {
  const explicit = event?.report?.correction_kind;
  if ([
    "confirmed",
    "corrected",
    "retracted",
    "verification_withdrawn",
  ].includes(explicit)) return explicit;
  return {
    "outcome.reset_confirmed.v1": "confirmed",
    "outcome.reset_corrected.v1": "corrected",
    "outcome.reset_retracted.v1": "retracted",
    "outcome.verification_withdrawn.v1": "verification_withdrawn",
  }[event?.event_type] ?? null;
}

function genericEnglishEventSummary(event) {
  switch (event?.event_type) {
    case "forecast.authority_window.opened.v1":
      return "An authoritative reset-timing update was published. This is not a confirmed reset.";
    case "forecast.reset_watch.opened.v1":
      return "The experimental reset-probability watch opened. This is a model forecast, not a reset confirmation.";
    case "forecast.reset_watch.closed.v1":
      return "The experimental reset-probability watch closed.";
    case "outcome.reset_confirmed.v1":
      return "A confirmed reset record was published. See the latest record for its verified timing and evidence.";
    case "outcome.reset_corrected.v1":
      return "A previously confirmed reset record was corrected. See the latest revision for verified timing and evidence.";
    case "outcome.reset_retracted.v1":
      return "A previously published reset record was retracted by a new canonical revision.";
    case "outcome.verification_withdrawn.v1":
      return "A reset record no longer meets the current verification contract. This does not assert that the reset did not occur.";
    default:
      return event?.topic === "authority"
        ? "An authoritative reset-timing update was published. This is not a confirmed reset."
        : event?.topic === "experimental_probability"
          ? "An experimental reset-probability update was published. This is a model forecast, not a reset confirmation."
          : event?.topic === "outcome"
            ? "A confirmed-reset record update was published. See the latest record for verified details."
            : "A Codex reset update was published. See the linked details.";
  }
}

function localizedNotificationTitle(event, locale) {
  if (!isEnglishTelegramLocale(locale)) return null;
  if (event?.topic === "authority") return "New authoritative reset window";
  if (event?.topic === "experimental_probability") {
    return event?.event_type === "forecast.reset_watch.closed.v1"
      ? "Experimental probability alert cleared"
      : "Experimental probability alert: 4-hour risk increased";
  }
  if (event?.topic === "outcome") {
    const kind = outcomeCorrectionKind(event);
    if (kind === "retracted") return "Confirmed reset record retracted";
    if (kind === "verification_withdrawn") {
      return "Reset record verification withdrawn";
    }
    if (kind === "corrected") return "Confirmed reset record corrected";
    return event?.report?.outcome?.label_grade === "silver"
      ? "Codex reset operator-confirmed"
      : "Codex reset confirmed";
  }
  return null;
}

function localizedEventUrl(value, publicBaseUrl, locale) {
  const candidate = safeUrl(value);
  const base = safeUrl(publicBaseUrl);
  if (!candidate || !base) return candidate;
  const candidateUrl = new URL(candidate);
  const baseUrl = new URL(base);
  if (candidateUrl.origin !== baseUrl.origin) return candidate;
  const path = candidateUrl.pathname.replace(/\/$/, "") || "/";
  const page = ["/accuracy", "/en/accuracy"].includes(path)
    ? "accuracy"
    : ["/", "/en"].includes(path)
      ? "home"
      : null;
  return page ? telegramPublicUrl(base, locale, page) : candidate;
}

export function formatNotificationEvent(event, {
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  publicBaseUrl = null,
  locale = DEFAULT_TELEGRAM_LOCALE,
} = {}) {
  const english = isEnglishTelegramLocale(locale);
  const report = event?.report ?? {};
  const notification = event?.notification ?? {};
  const title = clean(english
    ? localizedNotificationTitle(event, locale) ?? "Codex reset notification"
    : report.title ?? notification.title ?? event?.title ?? event?.topic ??
      "Codex 重置通知");
  const structuredSummary = outcomeEventSummary(event, timeZone, locale) ??
    authorityEventSummary(event, timeZone, locale) ??
    probabilityEventSummary(event, locale);
  const summary = clean(english
    ? structuredSummary ?? genericEnglishEventSummary(event)
    : structuredSummary ?? report.summary ?? notification.body ??
      event?.summary ?? event?.text ?? event?.message ??
      event?.data?.summary ?? "");
  const occurredAt = event?.emitted_at ?? event?.occurred_at ?? event?.created_at ??
    event?.published_at;
  const lines = [title];
  if (summary) lines.push("", summary);
  if (occurredAt) {
    lines.push(
      "",
      english
        ? `Time: ${dateTime(occurredAt, timeZone, locale)}`
        : `时间：${dateTime(occurredAt, timeZone, locale)}`,
    );
  }
  const eventUrl = localizedEventUrl(
    report.public_url ?? report.source_url ?? notification.url ?? event?.url ??
      event?.data?.url,
    publicBaseUrl,
    locale,
  );
  let fallbackUrl = null;
  try {
    if (publicBaseUrl) {
      fallbackUrl = telegramPublicUrl(publicBaseUrl, locale, "home");
    }
  } catch {
    fallbackUrl = null;
  }
  if (eventUrl ?? fallbackUrl) {
    lines.push(english
      ? `Details: ${eventUrl ?? fallbackUrl}`
      : `详情：${eventUrl ?? fallbackUrl}`);
  }
  if (event?.experimental === true) {
    lines.unshift(english ? "Experimental notification" : "实验性通知");
  }
  return limitTelegramText(lines.join("\n"));
}
