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

function percentage(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1
    ? `${(numeric * 100).toFixed(1)}%`
    : "不可用";
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

function dateTime(value, timeZone = DEFAULT_DISPLAY_TIME_ZONE) {
  if (value === null || value === undefined || value === "") return "未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return `${new Intl.DateTimeFormat("zh-CN", {
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

function stageLabel(health, prediction) {
  const stage = health?.serving_stage ??
    prediction?.data?.model?.validation_status;
  if (stage === "validated") return "已验证";
  if (stage === "provisional") return "临时预测（尚未完成正式验证）";
  return clean(stage || "未知");
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

export function formatHelp({ admin = false, group = false } = {}) {
  const lines = [
    "Codex Reset Forecaster Bot",
    "",
    "/forecast  当前 4 小时与 24 小时预测",
    "/report  详细的可能重置报告",
    "/history [1-10]  最近确认记录",
    "/lastreset  最近一次确认重置",
  ];
  if (!group) {
    lines.push(
      "/subscribe  订阅稳定通知",
      "/subscribe probability 24h 60%  设置个性化概率提醒",
      "/subscribe experimental  使用兼容的 4h/50% 概率规则",
      "/subscription  查看当前订阅设置",
      "/unsubscribe  取消动态订阅",
    );
  }
  if (admin && !group) {
    lines.push("/traffic  请求量、增长与容量状态（仅管理员）");
  }
  lines.push("/about  关于 Bot 与数据边界");
  lines.push("/help  查看帮助");
  if (group) lines.push("", "群聊只提供查询；订阅请私聊 Bot。");
  return lines.join("\n");
}

export function formatAbout({ publicBaseUrl = null } = {}) {
  const lines = [
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
  const site = safeUrl(publicBaseUrl);
  if (site) lines.push("", `项目站点：${site}`);
  lines.push("", "/help 查看全部命令。/info 与 /about 内容相同。");
  return limitTelegramText(lines.join("\n"));
}

export function formatSubscription(subscription) {
  if (!subscription) return "当前没有动态订阅。使用 /subscribe 开启稳定通知。";
  const lines = ["当前订阅设置", "稳定通知：已开启"];
  const preferences = subscription.probability_preferences;
  if (preferences) {
    lines.push(
      `概率提醒：未来 ${preferences.horizon_hours} 小时概率严格超过 ${percentage(preferences.probability_threshold)} 时提醒`,
      "规则新建或修改时只建立当前基线，不补发历史提醒。",
    );
  } else {
    lines.push("概率提醒：未开启");
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
} = {}) {
  const lines = [
    "个性化概率提醒",
    "",
    `未来 ${preferences.horizon_hours} 小时重置概率 ${percentage(transition.probability)}，已超过你设置的 ${percentage(preferences.probability_threshold)}。`,
    "这是模型预测，不是已确认重置。",
    "",
    `模型签发：${dateTime(input.issued_at, timeZone)}`,
    `提醒生成：${dateTime(input.emitted_at, timeZone)}`,
  ];
  const publicUrl = publicBaseUrl ? safeUrl(publicBaseUrl) : null;
  if (publicUrl) lines.push(`详情：${publicUrl}`);
  return limitTelegramText(lines.join("\n"));
}

function count(value) {
  if (value === null || value === undefined) return "不可用";
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(number)
    : "不可用";
}

function signedRatioPercentage(value) {
  if (value === null || value === undefined) return "不可用";
  const number = Number(value);
  if (!Number.isFinite(number)) return "不可用";
  const normalized = number * 100;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(1)}%`;
}

export function formatTraffic(payload, {
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  botState = null,
  now = () => new Date(),
} = {}) {
  const traffic = payload?.traffic ?? payload;
  const current = traffic?.current ?? traffic?.today ?? {};
  const yesterday = traffic?.yesterday ?? {};
  const sevenDays = traffic?.seven_days ?? traffic?.last_7_days ?? {};
  const capacity = traffic?.capacity ?? payload?.capacity ?? {};
  const pressure = clean(
    capacity.level ?? capacity.pressure ?? traffic?.pressure ?? "unknown",
  );
  const lines = [
    "请求量与容量状态（管理员）",
    `当前请求：${count(current.requests ?? current.request_count)}`,
    `昨日请求：${count(yesterday.requests ?? yesterday.request_count)}`,
    `此前 7 日中位数：${count(sevenDays.requests ?? sevenDays.request_count)}`,
    `日增长：${signedRatioPercentage(
      traffic?.growth?.day_over_day ?? traffic?.day_over_day_growth,
    )}`,
    `容量压力：${pressure || "unknown"}`,
  ];
  const utilization = capacity.utilization ?? capacity.utilization_ratio;
  if (Number.isFinite(Number(utilization))) {
    lines.push(`容量利用率：${percentage(Number(utilization))}`);
  }
  const observedAt = payload?.observed_at ?? traffic?.observed_at;
  if (observedAt) lines.push(`统计时间：${dateTime(observedAt, timeZone)}`);
  const rolling = capacity.rolling_window;
  if (rolling && typeof rolling === "object") {
    lines.push(
      "",
      "源站最近 5 分钟",
      `请求：${count(rolling.public_requests)} / 总到达 ${count(rolling.requests)}`,
      `交互 p95：${count(rolling.interactive_p95_ms)} ms`,
      `事件循环滞后 p95：${count(rolling.event_loop_lag_p95_ms)} ms`,
      `真实 5xx：${count(rolling.true_errors)}`,
      `最大并发：${count(rolling.max_in_flight)}`,
    );
    if (Array.isArray(capacity.reasons) && capacity.reasons.length > 0) {
      lines.push(`触发信号：${capacity.reasons.map(clean).join("、")}`);
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
    lines.push(
      "",
      "Telegram 投递队列",
      `待投递/重试：${active.length}`,
      `非预期失败：${unexpectedDead.length}`,
      `最老到期等待：${Number.isFinite(oldestDueMs)
        ? `${Math.max(0, Math.floor((currentMs - oldestDueMs) / 1_000))} 秒`
        : "无"}`,
      `更新轮询：${dateTime(botState.last_update_poll_at, timeZone)}`,
      `事件轮询：${dateTime(botState.last_event_poll_at, timeZone)}`,
      `概率输入轮询：${dateTime(
        botState.last_forecast_input_poll_at,
        timeZone,
      )}`,
    );
    if (botState.operations_alert_baseline_initialized) {
      lines.push(
        `运维告警轮询：${dateTime(
          botState.last_operations_alert_poll_at,
          timeZone,
        )}`,
      );
    }
  }
  return limitTelegramText(lines.join("\n"));
}

function runtimeResourceReasonLabel(reason) {
  const value = clean(reason);
  let match = value.match(/^event_loop_lag_p95_(\d+(?:\.\d+)?)ms$/);
  if (match) return `事件循环滞后 p95：${count(match[1])} 毫秒`;
  match = value.match(/^event_loop_utilization_(\d+(?:\.\d+)?)$/);
  if (match) return `事件循环利用率：${percentage(Number(match[1]))}`;
  match = value.match(/^cgroup_memory_(\d+(?:\.\d+)?)$/);
  if (match) return `容器内存使用率：${percentage(Number(match[1]))}`;
  match = value.match(/^node_heap_(\d+(?:\.\d+)?)$/);
  if (match) return `Node.js 堆内存使用率：${percentage(Number(match[1]))}`;
  match = value.match(/^in_flight_(\d+)$/);
  if (match) return `同时处理中请求：${count(match[1])} 个`;
  const criticalLabels = {
    event_loop_lag_critical: "事件循环滞后达到严重阈值",
    event_loop_utilization_critical: "事件循环利用率达到严重阈值",
    cgroup_memory_critical: "容器内存使用率达到严重阈值",
  };
  return criticalLabels[value] ?? null;
}

export function formatOperationsAlert(
  alert,
  { timeZone = DEFAULT_DISPLAY_TIME_ZONE } = {},
) {
  const level = clean(alert?.level ?? alert?.severity ?? "warning");
  const reasons = Array.isArray(alert?.reasons)
    ? alert.reasons.map(runtimeResourceReasonLabel)
    : [];
  const runtimeResourceOnly = reasons.length > 0 && reasons.every(Boolean);
  if (runtimeResourceOnly) {
    const lines = [
      "源站运行时提醒（仅管理员）",
      `源站主线程持续阻塞 [${level}]`,
      "",
      "这不是请求量增长告警。",
      `运行时指标：${reasons.join("、")}`,
    ];
    const observedAt = alert?.observed_at ?? alert?.emitted_at;
    if (observedAt) lines.push("", `时间：${dateTime(observedAt, timeZone)}`);
    return limitTelegramText(lines.join("\n"));
  }
  const title = clean(alert?.title ?? "容量状态发生变化");
  const summary = clean(
    alert?.summary ?? alert?.message ?? "请求量或容量压力触发了运维阈值。",
  );
  const lines = [
    "容量运维提醒（仅管理员）",
    `${title} [${level}]`,
    "",
    summary,
  ];
  const observedAt = alert?.observed_at ?? alert?.emitted_at;
  if (observedAt) lines.push("", `时间：${dateTime(observedAt, timeZone)}`);
  return limitTelegramText(lines.join("\n"));
}

export function formatUnavailableForecast(health) {
  const blockers = Array.isArray(health?.serving_blockers)
    ? health.serving_blockers.join(", ")
    : "forecast_not_ready";
  return limitTelegramText([
    "当前没有可安全展示的预测。",
    `服务状态：${clean(health?.status ?? "unavailable")}`,
    `流水线状态：${clean(health?.pipeline_status ?? "unknown")}`,
    `阻塞原因：${clean(blockers)}`,
  ].join("\n"));
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
}) {
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
  const lines = [
    detailed ? "可能到来的 Codex 重置报告" : "Codex 重置预测",
    `模型状态：${stageLabel(health, prediction)}`,
    `未来 4 小时：${percentage(fourHour)}`,
    `未来 24 小时：${percentage(twentyFourHour)}`,
  ];
  if (detailed && rolling) {
    lines.push(
      `七日内最高条件 4 小时窗口：${percentage(rolling.slot.rolling_4h_probability)}`,
      `窗口：${dateTime(rolling.slot.start, timeZone)} — ${dateTime(slots[rolling.index + 3].end, timeZone)}`,
    );
    const conditioning = prediction.data.authority_conditioning;
    lines.push(
      `权威时间条件：${conditioning?.applied ? "已应用" : "未应用"}`,
      `重置后抑制：${prediction.data.post_outcome_refractory?.applied ? "已应用" : "未应用"}`,
    );
  }
  lines.push(
    `签发时间：${dateTime(prediction.data.issued_at, timeZone)}`,
    `知识截止：${dateTime(prediction.data.knowledge_cutoff, timeZone)}`,
  );
  const publicUrl = publicBaseUrl ? safeUrl(publicBaseUrl) : null;
  if (publicUrl) lines.push(`网站：${publicUrl}`);
  return limitTelegramText(lines.join("\n"));
}

function historyRow(result, index, timeZone) {
  const range = result?.occurred_time_range;
  const source = result?.source;
  const lines = [
    `${index}. 已确认重置`,
    `发生：${dateTime(range?.start, timeZone)} — ${dateTime(range?.end, timeZone)}`,
  ];
  if (range?.precision) lines.push(`精度：${clean(range.precision)}`);
  if (source?.published_at) {
    lines.push(`官方来源发布：${dateTime(source.published_at, timeZone)}`);
  }
  const url = safeUrl(source?.canonical_url);
  if (url) lines.push(`来源：${url}`);
  return lines.join("\n");
}

export function formatHistory(results, {
  limit = 5,
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
} = {}) {
  const selected = Array.isArray(results) ? results.slice(0, limit) : [];
  if (selected.length === 0) return "当前没有符合现行合同的确认重置记录。";
  return limitTelegramText([
    `最近 ${selected.length} 次确认重置`,
    "",
    ...selected.flatMap((result, index) => [
      historyRow(result, index + 1, timeZone),
      "",
    ]),
  ].join("\n"));
}

export function formatLastReset(
  results,
  { timeZone = DEFAULT_DISPLAY_TIME_ZONE } = {},
) {
  if (!Array.isArray(results) || results.length === 0) {
    return "当前没有符合现行合同的确认重置记录。";
  }
  return limitTelegramText([
    "最近一次确认重置",
    "",
    historyRow(results[0], 1, timeZone).replace(/^1\. /, ""),
  ].join("\n"));
}

function outcomeEventSummary(event, timeZone) {
  const report = event?.report;
  const row = report?.outcome;
  const range = row?.occurred_time_range;
  if (!range?.start || !range?.end) return null;
  const rangeText = `${dateTime(range.start, timeZone)} 至 ${
    dateTime(range.end, timeZone)
  }`;
  const kind = report.correction_kind;
  if (kind === "retracted") {
    return `先前发布的重置记录（${rangeText}）已被新的 canonical revision 撤回。`;
  }
  if (kind === "verification_withdrawn") {
    return `先前记录（${rangeText}）当前不再满足官方来源验证合同；这不等同于断言重置未发生。`;
  }
  if (kind === "corrected") {
    return `确认记录已更新为 ${rangeText}，请以最新 revision 和官方来源为准。`;
  }
  if (kind === "confirmed") {
    return `当前 outcome 合同确认发生时间为 ${rangeText}。`;
  }
  return null;
}

function authorityEventSummary(event, timeZone) {
  const forecast = event?.report?.forecast;
  const range = forecast?.authority_conditioning?.asserted_time_range;
  if (!range?.start || !range?.end) return null;
  return `权威来源提到 ${dateTime(range.start, timeZone)} 至 ${
    dateTime(range.end, timeZone)
  } 的未来重置时间窗；当前 4 小时概率 ${
    percentage(forecast?.probabilities?.next_4h)
  }。这不是已确认重置。`;
}

export function formatNotificationEvent(event, {
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  publicBaseUrl = null,
} = {}) {
  const report = event?.report ?? {};
  const notification = event?.notification ?? {};
  const title = clean(
    report.title ?? notification.title ?? event?.title ?? event?.topic ??
      "Codex 重置通知",
  );
  const summary = clean(
    outcomeEventSummary(event, timeZone) ??
      authorityEventSummary(event, timeZone) ?? report.summary ??
      notification.body ?? event?.summary ?? event?.text ??
      event?.message ?? event?.data?.summary ?? "",
  );
  const occurredAt = event?.emitted_at ?? event?.occurred_at ?? event?.created_at ??
    event?.published_at;
  const lines = [title];
  if (summary) lines.push("", summary);
  if (occurredAt) lines.push("", `时间：${dateTime(occurredAt, timeZone)}`);
  const eventUrl = safeUrl(
    report.public_url ?? report.source_url ?? notification.url ?? event?.url ??
      event?.data?.url,
  );
  const fallbackUrl = publicBaseUrl ? safeUrl(publicBaseUrl) : null;
  if (eventUrl ?? fallbackUrl) lines.push(`详情：${eventUrl ?? fallbackUrl}`);
  if (event?.experimental === true) lines.unshift("实验性通知");
  return limitTelegramText(lines.join("\n"));
}
