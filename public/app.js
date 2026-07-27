const percent = (value, digits = 0) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const displayZone = localZone === "Etc/UTC" ? "UTC" : localZone;
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat("zh-CN", { weekday: "short" });
const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const eventTypeLabels = {
  quota_reset: "额度重置",
  quota_refill: "额度补充",
  limit_policy_change: "限额调整",
  capacity_restore: "容量恢复",
  incident: "服务事件",
  release: "产品发布",
  development_activity: "开发动态",
  competitor_limit_change: "竞品限额调整",
};

const phaseLabels = {
  rumor: "传闻",
  expected: "预期",
  scheduled: "已计划",
  started: "声称开始",
  completed: "声称完成",
  denied: "已否认",
  cancelled: "已取消",
};

const sourceRoleLabels = {
  official: "官方",
  product_lead: "产品负责人",
  product_team_member: "产品团队",
  community: "社区",
  aggregator: "聚合摘要",
  media: "媒体",
  unknown: "角色未知",
};

const publicationBlockerLabels = {
  champion_missing: "模型尚未就绪",
  champion_incompatible: "模型版本需要更新",
  champion_artifact_missing: "模型文件缺失",
  forecast_missing: "尚无预测",
  forecast_stale: "预测已经过期",
  forecast_invalid: "预测时间范围无效",
  forecast_not_validated: "试用模型仍在积累严格验证",
  forecast_model_mismatch: "模型版本需要更新",
  forecast_model_artifact_mismatch: "模型版本需要更新",
  forecast_model_contract_mismatch: "模型版本需要更新",
  forecast_integrity_failed: "预测校验未通过",
  synthetic_only: "当前为合成演示数据",
  real_walk_forward_not_proven: "真实数据评估不足",
  live_evaluation_incompatible: "发布评估需要更新",
  live_evaluation_gate_failed: "发布评估未通过",
  model_evaluation_pending: "正在积累真实评估数据",
  negative_label_coverage_pending: "历史覆盖正在复验",
  negative_label_coverage_missing: "历史覆盖数据不足",
  required_outcome_source_not_fresh: "核心来源更新不及时",
  exact_source_not_fresh: "核心来源更新不及时",
  pipeline_error: "数据更新失败",
};

const publicationBlockerPriority = [
  "negative_label_coverage_pending",
  "negative_label_coverage_missing",
  "required_outcome_source_not_fresh",
  "exact_source_not_fresh",
  "pipeline_error",
  "model_evaluation_pending",
  "champion_missing",
  "champion_incompatible",
];

function primaryPublicationBlocker(blockers = []) {
  return publicationBlockerPriority.find((blocker) => blockers.includes(blocker)) ??
    blockers[0] ??
    null;
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return `${dateFormatter.format(date)} ${weekdayFormatter.format(date)} ${clockFormatter.format(date)}`;
}

function formatCompactTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return `${dateFormatter.format(date)} ${clockFormatter.format(date)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character]);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const externalLinkIcon = `
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 3h7v7M13 3 6.5 9.5M11 8.5V13H3V5h4.5"/>
  </svg>
`;

const signalDialog = document.querySelector("#signal-dialog");
const signalDialogClose = document.querySelector("#signal-dialog-close");
let signalDialogTrigger = null;
let signalDialogTriggerKey = null;

function addSignalDialogBadge(target, text, className = "") {
  const badge = document.createElement("span");
  badge.className = `signal-badge${className ? ` ${className}` : ""}`;
  badge.textContent = text;
  target.append(badge);
}

function openSignalDialog(item, trigger) {
  if (!signalDialog) return;
  const source = item.source ?? {};
  const sourceUrl = safeExternalUrl(source.canonical_url);
  const sourceName = source.display_handle ?? "来源不可用";
  const eventType = eventTypeLabels[item.event_type] ?? "其他信号";
  const phase = phaseLabels[item.phase] ?? "状态未知";
  const role = sourceRoleLabels[item.source_role] ?? item.source_role ?? "角色未知";
  const badges = document.querySelector("#signal-dialog-badges");
  const sourceLink = document.querySelector("#signal-dialog-source-link");

  document.querySelector("#signal-dialog-title").textContent = eventType;
  document.querySelector("#signal-dialog-text").textContent = source.text ?? "暂无原始文本";
  document.querySelector("#signal-dialog-published-at").textContent = source.published_at
    ? formatTime(source.published_at)
    : "时间未知";
  document.querySelector("#signal-dialog-available-at").textContent = item.available_at
    ? formatTime(item.available_at)
    : "时间未知";
  document.querySelector("#signal-dialog-source").textContent = `${sourceName} · ${phase}`;

  badges.replaceChildren();
  addSignalDialogBadge(badges, eventType);
  addSignalDialogBadge(badges, role, "secondary");
  if (item.pending_next_forecast) {
    addSignalDialogBadge(badges, "待下一轮纳入", "pending");
  }

  if (sourceUrl) {
    sourceLink.href = sourceUrl;
    sourceLink.hidden = false;
    sourceLink.setAttribute("aria-label", `在新窗口打开 ${sourceName} 的原文`);
  } else {
    sourceLink.removeAttribute("href");
    sourceLink.hidden = true;
    sourceLink.removeAttribute("aria-label");
  }

  signalDialogTrigger = trigger;
  signalDialogTriggerKey = trigger?.dataset.signalKey ?? null;
  document.body.classList.add("signal-dialog-open");
  if (typeof signalDialog.showModal === "function") {
    signalDialog.showModal();
  } else {
    signalDialog.setAttribute("open", "");
  }
}

function restoreSignalDialogFocus() {
  let target = signalDialogTrigger?.isConnected ? signalDialogTrigger : null;
  if (!target && signalDialogTriggerKey) {
    target = [...document.querySelectorAll(".signal-preview")].find(
      (preview) => preview.dataset.signalKey === signalDialogTriggerKey,
    ) ?? null;
  }
  (target ?? document.querySelector(".signal-grid"))?.focus();
  signalDialogTrigger = null;
  signalDialogTriggerKey = null;
}

function closeSignalDialog() {
  if (!signalDialog?.open) return;
  if (typeof signalDialog.close === "function") {
    signalDialog.close();
  } else {
    signalDialog.removeAttribute("open");
    document.body.classList.remove("signal-dialog-open");
    restoreSignalDialogFocus();
  }
}

signalDialogClose?.addEventListener("click", closeSignalDialog);
signalDialog?.addEventListener("click", (event) => {
  if (event.target === signalDialog) closeSignalDialog();
});
signalDialog?.addEventListener("close", () => {
  document.body.classList.remove("signal-dialog-open");
  restoreSignalDialogFocus();
});

function cumulative(slots) {
  if (!Array.isArray(slots) || slots.length === 0 || slots.some((slot) => !Number.isFinite(slot.hazard))) {
    return null;
  }
  return 1 - slots.reduce((survival, slot) => survival * (1 - slot.hazard), 1);
}

function cumulativeInterval(forecast, key) {
  const intervals = forecast.data?.cumulative_epistemic_intervals_80 ??
    forecast.data?.epistemic_intervals_80 ??
    {};
  const aliases = {
    four_hours: ["four_hours", "next_4h", "PT4H"],
    twenty_four_hours: ["twenty_four_hours", "next_24h", "PT24H"],
    horizon: ["horizon", "next_168h", "PT168H"],
  };
  const value = aliases[key].map((alias) => intervals[alias]).find(Array.isArray);
  return value?.length === 2 && value.every(Number.isFinite) ? value : null;
}

function intervalText(interval) {
  return interval
    ? `大致范围（80%）：${percent(interval[0], 1)}–${percent(interval[1], 1)}`
    : "大致范围（80%）：暂无";
}

function coverageFreshnessTier(value) {
  if (!Number.isFinite(value)) return "不可用";
  if (value >= 0.99) return "新鲜";
  if (value >= 0.79) return "轻微延迟";
  if (value >= 0.39) return "陈旧";
  return "严重缺失";
}

function levelForProbability(probability, maximum) {
  if (probability <= 0 || maximum <= 0) return 0;
  const relative = Math.sqrt(probability / maximum);
  if (relative < 0.35) return 1;
  if (relative < 0.58) return 2;
  if (relative < 0.82) return 3;
  return 4;
}

function slotUncertainty(slot) {
  const interval = slot.epistemic_interval_80;
  return Array.isArray(interval) && interval.length === 2 && interval.every(Number.isFinite)
    ? `${percent(interval[0], 2)}–${percent(interval[1], 2)}`
    : "不可用";
}

function rollingFourHourText(slot) {
  return Number.isFinite(slot.rolling_4h_probability)
    ? percent(slot.rolling_4h_probability, 2)
    : "窗口超出预测范围";
}

function describeSlot(slot) {
  return `${formatTime(slot.start)}，首次重置 ${percent(slot.first_reset_probability, 2)}，80% 区间 ${slotUncertainty(slot)}，未来 4 小时 ${rollingFourHourText(slot)}`;
}

function showSlotDetail(slot, button = null) {
  const detail = document.querySelector("#heat-detail");
  detail.innerHTML = `<strong>${escapeHtml(percent(slot.first_reset_probability, 2))}</strong><div><span>该小时首次重置 · 80% 区间 ${escapeHtml(slotUncertainty(slot))} · 未来 4 小时 ${escapeHtml(rollingFourHourText(slot))}</span><time>${escapeHtml(formatTime(slot.start))}</time></div>`;
  if (button) {
    document.querySelectorAll(".contribution-cell[aria-pressed='true']")
      .forEach((item) => item.setAttribute("aria-pressed", "false"));
    button.setAttribute("aria-pressed", "true");
    focusCell(button);
  }
}

function focusCell(button) {
  document.querySelectorAll(".contribution-cell").forEach((item) => {
    item.tabIndex = item === button ? 0 : -1;
  });
}

function cell(slot, maximum, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "contribution-cell";
  button.dataset.level = String(levelForProbability(slot.first_reset_probability, maximum));
  button.dataset.index = String(index);
  button.setAttribute("aria-rowindex", String((index % 12) + 1));
  button.setAttribute("aria-colindex", String(Math.floor(index / 12) + 1));
  button.tabIndex = index === 0 ? 0 : -1;
  const label = describeSlot(slot);
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  button.title = label;
  button.addEventListener("mouseenter", () => showSlotDetail(slot));
  button.addEventListener("focus", () => {
    focusCell(button);
    showSlotDetail(slot);
  });
  button.addEventListener("click", () => showSlotDetail(slot, button));
  button.addEventListener("keydown", (event) => {
    const row = index % 12;
    const destinations = {
      ArrowLeft: index - 12,
      ArrowRight: index + 12,
      ArrowUp: row > 0 ? index - 1 : -1,
      ArrowDown: row < 11 ? index + 1 : -1,
      Home: row,
      End: 156 + row,
    };
    if (!(event.key in destinations)) return;
    const next = document.querySelector(
      `.contribution-cell[data-index="${destinations[event.key]}"]`,
    );
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  return button;
}

function dayBlock(slots, offset, maximum) {
  const block = document.createElement("section");
  block.className = "forecast-day";
  const label = document.createElement("time");
  label.className = "day-label";
  label.dateTime = slots[0].start;
  label.textContent = `${dateFormatter.format(new Date(slots[0].start))}起`;
  label.title = `${formatTime(slots[0].start)} 至 ${formatTime(slots.at(-1).end)}`;
  const cells = document.createElement("div");
  cells.className = "day-cells";
  slots.forEach((slot, index) => cells.append(cell(slot, maximum, offset + index)));
  block.append(label, cells);
  return block;
}

function renderHeatmap(slots) {
  const target = document.querySelector("#heatmap");
  target.replaceChildren();
  target.className = "heatmap week-view";
  target.setAttribute("role", "grid");
  target.setAttribute("aria-label", "从预测起点开始的 168 个连续小时");
  target.setAttribute("aria-rowcount", "12");
  target.setAttribute("aria-colcount", "14");
  const visible = slots.slice(0, 168);
  const maximum = Math.max(...visible.map((slot) => slot.first_reset_probability), 0);
  const peak = visible.reduce((best, slot) => (
    !best || slot.first_reset_probability > best.first_reset_probability ? slot : best
  ), null);
  for (let day = 0; day < 7; day += 1) {
    const offset = day * 24;
    const daySlots = visible.slice(offset, offset + 24);
    if (daySlots.length > 0) target.append(dayBlock(daySlots, offset, maximum));
  }
  if (peak) {
    const peakButton = target.querySelector(
      `.contribution-cell[data-index="${visible.indexOf(peak)}"]`,
    );
    showSlotDetail(peak, peakButton);
  }
}

function setListMessage(targetSelector, text, kind = "empty") {
  const target = document.querySelector(targetSelector);
  target.replaceChildren();
  const row = document.createElement("li");
  row.className = kind === "error" ? "signal-error" : "signal-empty";
  row.textContent = text;
  target.append(row);
}

function renderEvidence(targetSelector, items, emptyText, tier) {
  const target = document.querySelector(targetSelector);
  target.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    setListMessage(targetSelector, emptyText);
    return;
  }
  for (const item of items.slice(0, 4)) {
    const row = document.createElement("li");
    row.dataset.signalTier = tier;
    row.dataset.sourceRole = item.source_role ?? "unknown";
    const source = item.source;
    const sourceUrl = safeExternalUrl(source?.canonical_url);
    const sourceDisplayName = source?.display_handle ?? "来源不可用";
    const sourceName = escapeHtml(sourceDisplayName);
    const sourceLabel = `<span>${sourceName}</span>`;
    const eventType = eventTypeLabels[item.event_type] ?? "其他信号";
    const phase = phaseLabels[item.phase] ?? "状态未知";
    const role = sourceRoleLabels[item.source_role] ?? item.source_role ?? "角色未知";
    const signalTime = source?.published_at ?? item.available_at;
    const pending = item.pending_next_forecast
      ? "<span class=\"signal-badge pending\">待下一轮纳入</span>"
      : "";
    const preview = document.createElement("button");
    preview.className = "signal-preview";
    preview.type = "button";
    preview.dataset.signalKey = item.signal_ref?.record_id ??
      sourceUrl ??
      `${tier}:${target.children.length}`;
    preview.setAttribute("aria-haspopup", "dialog");
    preview.setAttribute(
      "aria-label",
      `查看 ${sourceDisplayName} ${formatCompactTime(signalTime)} 的${eventType}完整动态`,
    );
    preview.title = "点击查看完整内容";
    preview.innerHTML = `<span class="signal-head"><span class="signal-badges"><span class="signal-badge">${escapeHtml(eventType)}</span><span class="signal-badge secondary">${escapeHtml(role)}</span>${pending}</span><time title="系统可用于模型的时间：${escapeHtml(formatCompactTime(item.available_at))}">${escapeHtml(formatCompactTime(signalTime))}</time></span><span class="signal-card-text">${escapeHtml(source?.text ?? "暂无原始文本")}</span>`;
    preview.addEventListener("click", () => openSignalDialog(item, preview));
    row.append(preview);

    const footer = document.createElement("div");
    footer.className = "signal-footer";
    footer.innerHTML = `<small>${sourceLabel} · ${escapeHtml(phase)}</small>${sourceUrl
      ? `<a class="signal-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="在新窗口打开 ${sourceName} 的原文" title="查看原文"><span>原文</span>${externalLinkIcon}</a>`
      : ""}`;
    row.append(footer);
    target.append(row);
  }
}

function isCoreEvidence(item) {
  if (
    item.source_role === "aggregator" ||
    (item.derivation && item.derivation !== "primary_statement")
  ) return false;
  const identity = item.source_identity_id;
  const handle = String(item.source?.display_handle ?? "").replace(/^@/, "").toLowerCase();
  if (identity === "person_tibo_sottiaux" || handle === "thsottiaux") return true;
  const authoritative = ["official", "product_lead", "product_team_member"]
    .includes(item.source_role);
  const productEvent = ["release", "incident", "capacity_restore"].includes(item.event_type);
  const scopeMatches = item.scope?.vendor === "openai" &&
    ["codex", "chatgpt", "chatgpt_work"].includes(item.scope?.product);
  return authoritative && productEvent && scopeMatches &&
    /\b(?:codex|chatgpt(?:\s+work)?)\b/i.test(item.source?.text ?? "");
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    let data = null;
    try {
      data = await response.json();
    } catch {
      return { ok: false, status: response.status, data: null, error: "响应不是 JSON" };
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? null : data.message ?? data.error ?? `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error.message };
  }
}

function challengerReady(readiness) {
  return readiness?.model?.challenger?.ready === true;
}

function modelPreparationState(readiness) {
  if (challengerReady(readiness) && readiness.evaluation_waiting) return "fitted";
  if (readiness?.pipeline_status === "running") return "running";
  return null;
}

function isProvisionalServing(forecast, readiness = {}) {
  const serving = forecast?.serving ?? {};
  return (
    serving.status === "provisional" ||
    serving.stage === "provisional" ||
    serving.serving_stage === "provisional" ||
    readiness.serving_stage === "provisional"
  );
}

function forecastErrorText(result, readiness = {}) {
  const preparation = modelPreparationState(readiness);
  if (preparation === "fitted") {
    return "模型已完成拟合，正在生成首版 7 天试用预测。";
  }
  if (preparation === "running") {
    return "模型正在更新，首版可用结果生成后立即显示。";
  }
  const blocker = primaryPublicationBlocker(
    result.data?.serving?.publication_blockers,
  );
  if (blocker && publicationBlockerLabels[blocker]) {
    return `${publicationBlockerLabels[blocker]}。`;
  }
  const labels = {
    forecast_incompatible: "模型版本需要更新。",
    forecast_not_publishable: "当前数据还不支持发布预测。",
    forecast_stale: "预测已过期，等待更新。",
    forecast_not_ready: "预测尚未生成。",
  };
  if (result.status === 0) return "暂时无法连接预测服务。";
  return labels[result.data?.error] ?? "预测暂不可用，请稍后再试。";
}

function setStatus(kind, text) {
  const status = document.querySelector("#source-status");
  status.classList.remove("ok", "warning", "error");
  status.classList.add(kind);
  status.innerHTML = `<span aria-hidden="true"></span>${escapeHtml(text)}`;
}

function renderForecast(forecast) {
  const slots = Array.isArray(forecast.data.slots) ? forecast.data.slots : [];
  if (slots.length === 0) throw new Error("预测没有小时数据");
  const provisional = isProvisionalServing(forecast);
  const probability4h = Number.isFinite(slots[0]?.rolling_4h_probability)
    ? slots[0].rolling_4h_probability
    : null;
  const probability24h = slots.length >= 24 ? cumulative(slots.slice(0, 24)) : null;
  const probability168h = Number.isFinite(forecast.data.no_reset_probability)
    ? 1 - forecast.data.no_reset_probability
    : slots.length >= 168
      ? cumulative(slots.slice(0, 168))
      : null;
  document.querySelector("#probability-4h").textContent = probability4h === null
    ? "窗口不足"
    : percent(probability4h, 2);
  document.querySelector("#probability-24h").textContent = percent(probability24h, 1);
  document.querySelector("#probability-7d").textContent = percent(probability168h, 1);
  document.querySelector("#data-quality-label").textContent =
    provisional ? "数据状态 · 试用模型" : "数据状态";
  document.querySelector("#interval-4h").textContent = probability4h === null
    ? "滚动 4 小时窗口超出预测范围"
    : intervalText(cumulativeInterval(forecast, "four_hours"));
  document.querySelector("#interval-24h").textContent =
    intervalText(cumulativeInterval(forecast, "twenty_four_hours"));
  document.querySelector("#interval-7d").textContent =
    intervalText(cumulativeInterval(forecast, "horizon"));
  document.querySelector("#data-quality").textContent =
    percent(forecast.data.data_quality?.score, 0);
  const coverageFreshness = forecast.data.data_quality?.provider_coverage;
  const outcomeSampleCount = forecast.data.data_quality?.outcome_sample_count;
  const sampleSufficiency = forecast.data.data_quality?.sample_sufficiency;
  document.querySelector("#coverage").textContent =
    `覆盖时效：${coverageFreshnessTier(coverageFreshness)}` +
    `${Number.isInteger(outcomeSampleCount) ? ` · 历史事件：${outcomeSampleCount} 个` : ""}` +
    ` · 样本充分度：${percent(sampleSufficiency, 0)}`;
  document.querySelector("#forecast-window").textContent =
    `${formatTime(slots[0].start)} → ${formatTime(slots.at(-1).end)}`;
  const conditioning = forecast.data.authority_conditioning;
  document.querySelector("#authority-window").textContent =
    conditioning?.applied
      ? [
          `权威时间条件：${phaseLabels[conditioning.phase] ?? conditioning.phase}`,
          `${percent(conditioning.prior_reliability, 0)} 版本化先验`,
          conditioning.asserted_time_range
            ? `${formatCompactTime(conditioning.asserted_time_range.start)} → ${formatCompactTime(conditioning.asserted_time_range.end)}`
            : null,
        ].filter(Boolean).join(" · ")
      : "权威时间条件：当前未触发";
  const recurrenceAnchor = forecast.data.recurrence_anchor;
  document.querySelector("#recurrence-anchor").textContent =
    recurrenceAnchor?.occurred_time_range
      ? `重置周期锚点：${formatCompactTime(recurrenceAnchor.occurred_time_range.start)} 已确认重置`
      : "重置周期锚点：暂无已确认事件";
  document.querySelector("#heatmap-legend").hidden = false;
  document.querySelector("#heat-detail").hidden = false;
  renderHeatmap(slots);
}

function renderForecastError(message, readiness = {}) {
  const preparation = modelPreparationState(readiness);
  const preparing = preparation !== null;
  const fitted = preparation === "fitted";
  for (const selector of [
    "#probability-4h",
    "#probability-24h",
    "#probability-7d",
  ]) {
    document.querySelector(selector).textContent = preparing
      ? fitted ? "生成中" : "训练中"
      : "—";
  }
  document.querySelector("#interval-4h").textContent =
    preparing ? "首版试用预测生成后显示" : "当前预测不可用";
  document.querySelector("#interval-24h").textContent =
    preparing ? "首版试用预测生成后显示" : "当前预测不可用";
  document.querySelector("#interval-7d").textContent =
    preparing ? "首版试用预测生成后显示" : "当前预测不可用";
  document.querySelector("#data-quality-label").textContent =
    preparing ? "模型状态" : "数据状态";
  document.querySelector("#data-quality").textContent =
    preparing ? fitted ? "已完成拟合" : "更新中" : "—";
  const coverageDays = Number.isFinite(readiness.outcome_coverage?.hours)
    ? Math.round(readiness.outcome_coverage.hours / 24)
    : null;
  const confirmedOutcomes = readiness.canonical_records?.confirmed_outcomes;
  document.querySelector("#coverage").textContent = preparing
    ? [
        Number.isInteger(coverageDays) ? `${coverageDays} 天历史覆盖` : null,
        Number.isInteger(confirmedOutcomes) ? `${confirmedOutcomes} 次确认重置` : null,
      ].filter(Boolean).join(" · ") || "正在积累真实评估数据"
    : "数据覆盖暂不可用";
  document.querySelector("#forecast-window").textContent = preparing
    ? "正在生成试用预测"
    : "当前预测区间不可用";
  document.querySelector("#authority-window").textContent =
    "权威时间条件：等待预测";
  document.querySelector("#recurrence-anchor").textContent =
    "重置周期锚点：等待预测";
  document.querySelector("#heatmap-legend").hidden = true;
  document.querySelector("#heat-detail").hidden = true;
  document.querySelector("#heatmap").innerHTML =
    `<div class="empty-state${preparing ? "" : " error-state"}"><strong>${preparing ? "首版试用预测生成后显示每小时概率" : "预测尚未就绪"}</strong><p>${escapeHtml(message)}</p></div>`;
  document.querySelector("#heat-detail").innerHTML =
    preparing
      ? `<strong>—</strong><div><span>首版试用预测生成后显示每小时概率</span><time>${fitted ? "生成中" : "训练中"}</time></div>`
      : "<strong>—</strong><div><span>当前预测不可用</span><time>等待新预测</time></div>";
}

function renderPublicationWarning(forecastResult, readinessResult) {
  const target = document.querySelector("#publication-warning");
  const readiness = readinessResult.data ?? {};
  const serving = forecastResult.data?.serving ?? {};
  const blockers = serving.publication_blockers ?? readiness.publication_blockers ?? [];
  const syntheticDemo = serving.synthetic_demo === true || readiness.synthetic_only === true;
  const provisional = isProvisionalServing(forecastResult.data, readiness);
  if (provisional) {
    target.hidden = false;
    target.classList.remove("synthetic");
    target.textContent = "试用模型：当前概率已开放试用，严格验证仍在积累中。";
    return;
  }
  if (
    (readiness.publication_ready === true && !syntheticDemo) ||
    (challengerReady(readiness) && readiness.evaluation_waiting)
  ) {
    target.hidden = true;
    target.textContent = "";
    return;
  }
  const primaryBlocker = primaryPublicationBlocker(blockers);
  const label = publicationBlockerLabels[primaryBlocker] ?? "数据仍在准备中";
  target.hidden = false;
  target.classList.toggle("synthetic", syntheticDemo);
  target.textContent = syntheticDemo
    ? "合成数据演示，仅用于查看页面和模型流程。"
    : `预测尚未达到发布条件：${label}。`;
}

function renderHealth(forecastResult, healthResult, readinessResult) {
  const health = healthResult.data ?? {};
  const readiness = readinessResult.data ?? {};
  const forecast = forecastResult.data;
  const exact = health.provider_freshness?.exact ?? readiness.provider_freshness?.groups?.exact;
  const exactLastSuccess = exact?.last_success_at;
  const synthetic = Boolean(
    readiness.synthetic_only || forecast?.serving?.synthetic_demo,
  );
  const servingStatus = forecast?.serving?.status ?? readiness.current_forecast?.status;
  const provisional = isProvisionalServing(forecast, readiness);
  const coverageWaiting = readiness.coverage_waiting ?? health.coverage_waiting;
  const evaluationWaiting =
    readiness.evaluation_waiting ?? health.evaluation_waiting;
  if (provisional) {
    setStatus("warning", "试用模型 · 严格验证积累中");
  } else if (coverageWaiting || evaluationWaiting) {
    setStatus(
      "warning",
      coverageWaiting
        ? `历史覆盖复验中 · 最早 ${formatCompactTime(coverageWaiting.earliest_recheck_at)}`
        : challengerReady(readiness)
          ? "模型已训练 · 评估中"
          : "模型评估中",
    );
  } else if (!forecast?.data) {
    setStatus("error", "预测暂不可用");
  } else if (["stale", "invalid"].includes(servingStatus) || health.status === "stale") {
    setStatus("error", `预测已过期 · 发布于 ${formatCompactTime(forecast.data.issued_at)}`);
  } else if (synthetic) {
    setStatus("warning", "合成数据演示");
  } else if (
    servingStatus === "degraded" ||
    health.status === "degraded" ||
    exact?.status !== "fresh" ||
    !readiness.publication_ready
  ) {
    setStatus(
      "warning",
      exactLastSuccess
        ? `状态降级 · 核心来源更新于 ${formatCompactTime(exactLastSuccess)}`
        : "状态降级 · 核心来源更新不及时",
    );
  } else {
    setStatus(
      "ok",
      exactLastSuccess
        ? `核心来源更新于 ${formatCompactTime(exactLastSuccess)}`
        : `预测生成于 ${formatCompactTime(forecast.data.issued_at)}`,
    );
  }
}

function renderEvidenceResponse(result) {
  if (!result.ok || !result.data) {
    setListMessage("#core-signal-list", `核心信号加载失败：${result.error}`, "error");
    setListMessage("#community-signal-list", `社区参考加载失败：${result.error}`, "error");
    setListMessage("#pending-signal-list", `待纳入信号加载失败：${result.error}`, "error");
    return;
  }
  const evidence = result.data;
  const currentItems = Array.isArray(evidence.items) ? evidence.items : [];
  const core = evidence.core ?? currentItems.filter(isCoreEvidence);
  const community = evidence.community ?? currentItems.filter((item) => !isCoreEvidence(item));
  const pending = evidence.pending_next_forecast?.items ?? evidence.post_cutoff?.items ?? [];
  document.querySelector("#evidence-cutoff").textContent =
    `仅显示信息截止 ${formatCompactTime(evidence.knowledge_cutoff)} 前已知的信号。`;
  renderEvidence("#core-signal-list", core, "截止时间前暂无新的精确官方核心信号", "core");
  renderEvidence("#community-signal-list", community, "截止时间前暂无新的社区参考", "community");
  renderEvidence("#pending-signal-list", pending, "当前没有晚于截止时间的新信号", "pending");
}

let refreshTimer = null;
let loading = false;
let lastLoadedAt = 0;
let latestForecastCutoff = null;

function scheduleHourlyRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const current = new Date();
  const currentHour = new Date(current);
  currentHour.setMinutes(0, 0, 0);
  const cutoffMs = Date.parse(latestForecastCutoff);
  const waitingForCurrentHour = (
    current.getMinutes() < 10 &&
    Number.isFinite(cutoffMs) &&
    cutoffMs < currentHour.getTime()
  );
  if (waitingForCurrentHour) {
    refreshTimer = setTimeout(() => {
      void load();
    }, 45_000);
    return;
  }
  const next = new Date(current);
  next.setMinutes(0, 12, 0);
  next.setHours(next.getHours() + 1);
  refreshTimer = setTimeout(() => {
    void load();
  }, Math.max(1_000, next.getTime() - current.getTime()));
}

async function load() {
  if (loading) return;
  loading = true;
  document.querySelector("#timezone-display").textContent = `时区 · ${displayZone}`;
  let readinessResult = { ok: true, status: 200, data: {} };
  const evidencePromise = fetchJson("/api/evidence/recent").then((result) => {
    renderEvidenceResponse(result);
    return result;
  });
  try {
    const forecastResult = await fetchJson("/api/forecast/current");
    const forecastCutoff = forecastResult.data?.data?.knowledge_cutoff ??
      forecastResult.data?.saved_prediction_ref?.knowledge_cutoff;
    if (Number.isFinite(Date.parse(forecastCutoff))) {
      latestForecastCutoff = forecastCutoff;
    }
    const servingStatus = forecastResult.data?.serving?.status;
    const forecastAvailable = (
      forecastResult.ok &&
      forecastResult.data?.data &&
      !["stale", "invalid"].includes(servingStatus)
    );
    if (forecastAvailable) {
      renderForecast(forecastResult.data);
      renderPublicationWarning(forecastResult, readinessResult);
      setStatus(
        "warning",
        isProvisionalServing(forecastResult.data)
          ? "试用模型 · 严格验证积累中"
          : "预测已加载 · 状态检查中",
      );
    } else {
      readinessResult = await fetchJson("/api/readiness");
      renderForecastError(
        forecastErrorText(forecastResult, readinessResult.data),
        readinessResult.data,
      );
    }
    const healthResult = await fetchJson("/api/health");
    if (Number.isFinite(Date.parse(healthResult.data?.knowledge_cutoff))) {
      latestForecastCutoff = healthResult.data.knowledge_cutoff;
    }
    if (forecastAvailable) {
      readinessResult = {
        ok: healthResult.ok,
        status: healthResult.status,
        data: healthResult.data ?? {},
      };
    }
    renderPublicationWarning(forecastResult, readinessResult);
    renderHealth(forecastResult, healthResult, readinessResult);
    await evidencePromise;
  } catch (error) {
    console.error(error);
    renderForecastError(error.message, readinessResult.data);
    setStatus("error", "预测渲染失败");
  } finally {
    lastLoadedAt = Date.now();
    loading = false;
    scheduleHourlyRefresh();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastLoadedAt > 60_000) {
    void load();
  }
});
window.addEventListener("online", () => void load());

void load();
