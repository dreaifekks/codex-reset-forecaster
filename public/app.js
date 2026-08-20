import {
  NOTIFICATION_HORIZON_HOURS,
  calibrationAt,
  createNotificationCalibrationCache,
  formatNotificationHorizon,
  nearestHorizonIndex,
  normalizeCalibrationPayload,
} from "./notification-preferences.js?v=seo-i18n-1";
import { tr, uiLocale } from "./i18n.js?v=seo-i18n-1";

const percent = (value, digits = 0) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const displayZone = localZone === "Etc/UTC" ? "UTC" : localZone;
const dateFormatter = new Intl.DateTimeFormat(uiLocale, { month: "long", day: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat(uiLocale, { weekday: "short" });
const clockFormatter = new Intl.DateTimeFormat(uiLocale, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const eventTypeLabels = {
  quota_reset: tr("额度重置", "Quota reset"),
  quota_refill: tr("额度补充", "Quota refill"),
  limit_policy_change: tr("限额调整", "Limit policy change"),
  capacity_restore: tr("容量恢复", "Capacity restoration"),
  incident: tr("服务事件", "Service incident"),
  release: tr("产品发布", "Product release"),
  development_activity: tr("开发动态", "Development update"),
  competitor_limit_change: tr("竞品限额调整", "Competitor limit change"),
  competitor_model_release: tr("竞争模型发布", "Competing model release"),
  experience_issue: tr("体验问题", "Experience issue"),
  experience_recovery: tr("体验恢复", "Experience recovery"),
};

const phaseLabels = {
  rumor: tr("传闻", "Rumor"),
  expected: tr("预期", "Expected"),
  scheduled: tr("已计划", "Scheduled"),
  started: tr("声称开始", "Reported started"),
  completed: tr("声称完成", "Reported complete"),
  denied: tr("已否认", "Denied"),
  cancelled: tr("已取消", "Cancelled"),
};

const sourceRoleLabels = {
  official: tr("官方", "Official"),
  product_lead: tr("产品负责人", "Product lead"),
  product_team_member: tr("产品团队", "Product team"),
  community: tr("用户报告", "User report"),
  aggregator: tr("聚合摘要", "Aggregator"),
  media: tr("媒体", "Media"),
  unknown: tr("角色未知", "Unknown role"),
};

const impactSeverityLabels = {
  critical: tr("严重级 · S1", "Severity · S1"),
  high: tr("严重级 · S2", "Severity · S2"),
  medium: tr("严重级 · S3", "Severity · S3"),
  low: tr("严重级 · S4", "Severity · S4"),
  unknown: tr("严重级待确认", "Severity pending"),
};

const timelineRelevanceLabels = {
  relevant: tr("相关信号", "Relevant signal"),
  irrelevant: tr("已筛除", "Filtered out"),
  pending_context: tr("等待上下文", "Awaiting context"),
  unclassified: tr("未形成信号", "Not classified as signal"),
};

const episodeStateLabels = {
  active: tr("持续中", "Active"),
  investigating: tr("调查中", "Investigating"),
  mitigating: tr("缓解中", "Mitigating"),
  resolved: tr("已缓解", "Resolved"),
  reopened: tr("再次出现", "Reopened"),
  unknown: tr("状态待确认", "State pending"),
};

const episodeTrendLabels = {
  rising: tr("升温", "Rising"),
  stable: tr("持平", "Stable"),
  falling: tr("降温", "Falling"),
  resolved: tr("已解决", "Resolved"),
  unknown: tr("趋势待确认", "Trend pending"),
};

const impactCategoryLabels = {
  availability: tr("可用性", "Availability"),
  performance: tr("性能", "Performance"),
  correctness: tr("正确性", "Correctness"),
  tool_execution: tr("工具执行", "Tool execution"),
  session_state: tr("会话状态", "Session state"),
  quota_accounting: tr("额度计量", "Quota accounting"),
  auth: tr("认证", "Authentication"),
  client_ux: tr("客户端体验", "Client UX"),
  security_privacy: tr("安全与隐私", "Security and privacy"),
  data_integrity: tr("数据完整性", "Data integrity"),
  compatibility: tr("兼容性", "Compatibility"),
  other: tr("其他问题", "Other issue"),
};

const impactScopeLabels = {
  individual: tr("单个用户", "Individual user"),
  multiple_users: tr("多个用户", "Multiple users"),
  platform: tr("平台范围", "Platform-wide"),
  unknown: tr("范围待确认", "Scope pending"),
};

const publicationBlockerLabels = {
  champion_missing: tr("模型尚未就绪", "Model is not ready"),
  champion_incompatible: tr("模型版本需要更新", "Model version needs an update"),
  champion_artifact_missing: tr("模型文件缺失", "Model artifact is missing"),
  forecast_missing: tr("尚无预测", "No forecast yet"),
  forecast_stale: tr("预测已经过期", "Forecast has expired"),
  forecast_invalid: tr("预测时间范围无效", "Forecast time range is invalid"),
  forecast_not_validated: tr("试用模型仍在积累严格验证", "Trial model is still accumulating strict validation"),
  forecast_model_mismatch: tr("模型版本需要更新", "Model version needs an update"),
  forecast_model_artifact_mismatch: tr("模型版本需要更新", "Model version needs an update"),
  forecast_model_contract_mismatch: tr("模型版本需要更新", "Model version needs an update"),
  forecast_integrity_failed: tr("预测校验未通过", "Forecast integrity check failed"),
  synthetic_only: tr("当前为合成演示数据", "Currently showing synthetic demo data"),
  real_walk_forward_not_proven: tr("真实数据评估不足", "Insufficient real-data evaluation"),
  live_evaluation_incompatible: tr("发布评估需要更新", "Publication evaluation needs an update"),
  live_evaluation_gate_failed: tr("发布评估未通过", "Publication evaluation gate failed"),
  model_evaluation_pending: tr("正在积累真实评估数据", "Accumulating real evaluation data"),
  negative_label_coverage_pending: tr("历史覆盖正在复验", "Historical coverage is being revalidated"),
  negative_label_coverage_missing: tr("历史覆盖数据不足", "Historical coverage is insufficient"),
  required_outcome_source_not_fresh: tr("核心来源更新不及时", "Core source is not fresh"),
  exact_source_not_fresh: tr("核心来源更新不及时", "Core source is not fresh"),
  pipeline_error: tr("数据更新失败", "Data refresh failed"),
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
  if (Number.isNaN(date.getTime())) return tr("时间未知", "Unknown time");
  return `${dateFormatter.format(date)} ${weekdayFormatter.format(date)} ${clockFormatter.format(date)}`;
}

function formatCompactTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return tr("时间未知", "Unknown time");
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
  const sourceName = source.display_handle ?? tr("来源不可用", "Source unavailable");
  const eventType = eventTypeLabels[item.event_type] ?? tr("其他信号", "Other signal");
  const phase = phaseLabels[item.phase] ?? tr("状态未知", "Unknown state");
  const role = sourceRoleLabels[item.source_role] ?? item.source_role ?? tr("角色未知", "Unknown role");
  const badges = document.querySelector("#signal-dialog-badges");
  const sourceLink = document.querySelector("#signal-dialog-source-link");

  document.querySelector("#signal-dialog-title").textContent = eventType;
  document.querySelector("#signal-dialog-text").textContent = source.text ?? tr("暂无原始文本", "No source text");
  document.querySelector("#signal-dialog-published-at").textContent = source.published_at
    ? formatTime(source.published_at)
    : tr("时间未知", "Unknown time");
  document.querySelector("#signal-dialog-available-at").textContent = item.available_at
    ? formatTime(item.available_at)
    : tr("时间未知", "Unknown time");
  document.querySelector("#signal-dialog-source").textContent = `${sourceName} · ${phase}`;

  badges.replaceChildren();
  addSignalDialogBadge(badges, eventType);
  addSignalDialogBadge(badges, role, "secondary");
  if (item.pending_next_forecast) {
    addSignalDialogBadge(badges, tr("待下一轮纳入", "Pending next run"), "pending");
  }

  if (sourceUrl) {
    sourceLink.href = sourceUrl;
    sourceLink.hidden = false;
    sourceLink.setAttribute("aria-label", tr(
      `在新窗口打开 ${sourceName} 的原文`,
      `Open the original post from ${sourceName} in a new window`,
    ));
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
    ? tr(
      `大致范围（80%）：${percent(interval[0], 1)}–${percent(interval[1], 1)}`,
      `Approximate 80% range: ${percent(interval[0], 1)}–${percent(interval[1], 1)}`,
    )
    : tr("大致范围（80%）：暂无", "Approximate 80% range: unavailable");
}

function levelForProbability(probability, maximum) {
  if (probability <= 0 || maximum <= 0) return 0;
  const relative = probability / maximum;
  if (relative < 0.35) return 1;
  if (relative < 0.58) return 2;
  if (relative < 0.82) return 3;
  return 4;
}

function cumulativeToSlot(slot, slots, index) {
  if (Number.isFinite(slot.reset_by_end_probability)) {
    return slot.reset_by_end_probability;
  }
  return cumulative(slots.slice(0, index + 1));
}

function formatSlotRange(slot) {
  return `${formatTime(slot.start)}–${clockFormatter.format(new Date(slot.end))}`;
}

function describeSlot(slot, cumulativeProbability) {
  return [
    formatSlotRange(slot),
    tr(
      `该小时发生首次重置的概率：${percent(slot.first_reset_probability, 2)}`,
      `Probability of a first reset in this hour: ${percent(slot.first_reset_probability, 2)}`,
    ),
    tr(
      `从现在到该小时结束的累计重置概率：${percent(cumulativeProbability, 2)}`,
      `Cumulative probability through this hour: ${percent(cumulativeProbability, 2)}`,
    ),
  ].join("\n");
}

const heatTooltip = document.querySelector("#heat-tooltip");
let heatTooltipTrigger = null;
let selectedSlotDetail = null;

function showHeatTooltip(trigger, lines) {
  if (!heatTooltip) return;
  heatTooltip.replaceChildren(...lines.map((line, index) => {
    const item = document.createElement(index === 0 ? "strong" : "span");
    item.textContent = line;
    return item;
  }));
  heatTooltip.hidden = false;
  heatTooltip.style.visibility = "hidden";
  heatTooltip.style.left = "0";
  heatTooltip.style.top = "0";
  const triggerRect = trigger.getBoundingClientRect();
  const tooltipRect = heatTooltip.getBoundingClientRect();
  const viewportPadding = 12;
  const preferredLeft = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
  const left = Math.min(
    Math.max(viewportPadding, preferredLeft),
    window.innerWidth - tooltipRect.width - viewportPadding,
  );
  const above = triggerRect.top - tooltipRect.height - 10;
  const top = above >= viewportPadding
    ? above
    : Math.min(
        triggerRect.bottom + 10,
        window.innerHeight - tooltipRect.height - viewportPadding,
      );
  heatTooltip.style.left = `${Math.round(left)}px`;
  heatTooltip.style.top = `${Math.round(top)}px`;
  heatTooltip.style.visibility = "";
  heatTooltipTrigger?.removeAttribute("aria-describedby");
  heatTooltipTrigger = trigger;
  trigger.setAttribute("aria-describedby", "heat-tooltip");
}

function hideHeatTooltip(trigger = null) {
  if (!heatTooltip || (trigger && trigger !== heatTooltipTrigger)) return;
  heatTooltipTrigger?.removeAttribute("aria-describedby");
  heatTooltipTrigger = null;
  heatTooltip.hidden = true;
  heatTooltip.replaceChildren();
}

document.querySelector(".heatmap-scroll")?.addEventListener(
  "scroll",
  () => {
    hideHeatTooltip();
    restoreSlotDetail();
  },
  { passive: true },
);

function showHourlySlotDetail(slot, cumulativeProbability) {
  const detail = document.querySelector("#heat-detail");
  detail.dataset.mode = "hourly";
  detail.innerHTML = `<strong>${escapeHtml(percent(slot.first_reset_probability, 2))}</strong><div><time>${escapeHtml(formatSlotRange(slot))}</time><span>${tr("该小时发生首次重置的概率", "Probability of a first reset in this hour")}: ${escapeHtml(percent(slot.first_reset_probability, 2))}</span><span>${tr("从现在到该小时结束的累计重置概率", "Cumulative probability through this hour")}: ${escapeHtml(percent(cumulativeProbability, 2))}</span></div>`;
}

function showSelectedSlotDetail(slot, cumulativeProbability) {
  const detail = document.querySelector("#heat-detail");
  detail.dataset.mode = "cumulative";
  detail.innerHTML = `<strong>${escapeHtml(percent(cumulativeProbability, 2))}</strong><div><time>${escapeHtml(formatSlotRange(slot))} · ${tr("已选累计区间", "Selected cumulative window")}</time><span>${tr("所选结束小时的首次重置概率", "First-reset probability in the selected end hour")}: ${escapeHtml(percent(slot.first_reset_probability, 2))}</span><span>${tr("从现在到所选小时结束的累计重置概率", "Cumulative probability through the selected hour")}: ${escapeHtml(percent(cumulativeProbability, 2))}</span></div>`;
}

function resetSlotDetail() {
  const detail = document.querySelector("#heat-detail");
  detail.dataset.mode = "empty";
  detail.innerHTML = tr(
    "<strong>—</strong><div><time>悬停格子查看该小时，点击可固定累计区间</time><span>该小时发生首次重置的概率：—</span><span>从现在到该小时结束的累计重置概率：—</span></div>",
    "<strong>—</strong><div><time>Hover for an hour; click to pin a cumulative window</time><span>Probability of a first reset in this hour: —</span><span>Cumulative probability through this hour: —</span></div>",
  );
}

function restoreSlotDetail() {
  if (selectedSlotDetail) {
    showSelectedSlotDetail(
      selectedSlotDetail.slot,
      selectedSlotDetail.cumulativeProbability,
    );
    return;
  }
  resetSlotDetail();
}

const svgNamespace = "http://www.w3.org/2000/svg";

function createRangeBackdrop(target) {
  const backdrop = document.createElementNS(svgNamespace, "svg");
  backdrop.id = "range-backdrop";
  backdrop.classList.add("range-backdrop");
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.hidden = true;
  target.prepend(backdrop);
}

function boxWithin(element, ancestor) {
  let left = 0;
  let top = 0;
  let current = element;
  while (current && current !== ancestor) {
    left += current.offsetLeft;
    top += current.offsetTop;
    current = current.offsetParent;
  }
  return {
    left,
    top,
    right: left + element.offsetWidth,
    bottom: top + element.offsetHeight,
  };
}

function roundedPolygonPath(points, radius = 7) {
  const corners = points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const before = Math.hypot(previous.x - point.x, previous.y - point.y);
    const after = Math.hypot(next.x - point.x, next.y - point.y);
    const cornerRadius = Math.min(radius, before / 2, after / 2);
    return {
      point,
      start: {
        x: point.x + ((previous.x - point.x) / before) * cornerRadius,
        y: point.y + ((previous.y - point.y) / before) * cornerRadius,
      },
      end: {
        x: point.x + ((next.x - point.x) / after) * cornerRadius,
        y: point.y + ((next.y - point.y) / after) * cornerRadius,
      },
    };
  });
  const coordinate = (point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  const commands = [`M ${coordinate(corners[0].start)}`];
  corners.forEach((corner, index) => {
    if (index > 0) commands.push(`L ${coordinate(corner.start)}`);
    commands.push(
      `Q ${coordinate(corner.point)} ${coordinate(corner.end)}`,
    );
  });
  commands.push("Z");
  return commands.join(" ");
}

function hideRangeBackdrop() {
  const backdrop = document.querySelector("#range-backdrop");
  if (!backdrop) return;
  backdrop.replaceChildren();
  backdrop.hidden = true;
}

function updateRangeBackdrop(selectedIndex) {
  const target = document.querySelector("#heatmap");
  const backdrop = document.querySelector("#range-backdrop");
  const first = target?.querySelector('.contribution-cell[data-index="0"]');
  const endpoint = target?.querySelector(
    `.contribution-cell[data-index="${selectedIndex}"]`,
  );
  if (!target || !backdrop || !first || !endpoint) return;

  backdrop.setAttribute(
    "viewBox",
    `0 0 ${target.offsetWidth} ${target.offsetHeight}`,
  );
  backdrop.replaceChildren();
  const padding = 3;
  const firstBox = boxWithin(first, target);
  const endpointBox = boxWithin(endpoint, target);
  const column = Math.floor(selectedIndex / 12);
  const row = selectedIndex % 12;
  const left = firstBox.left - padding;
  const top = firstBox.top - padding;
  const right = endpointBox.right + padding;
  const endpointBottom = endpointBox.bottom + padding;
  let points = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: endpointBottom },
    { x: left, y: endpointBottom },
  ];

  if (column > 0 && row < 11) {
    const previousColumnLast = target.querySelector(
      `.contribution-cell[data-index="${column * 12 - 1}"]`,
    );
    const previousBox = boxWithin(previousColumnLast, target);
    const notchX = previousBox.right + padding;
    points = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: endpointBottom },
      { x: notchX, y: endpointBottom },
      {
        x: notchX,
        y: previousBox.bottom + padding,
      },
      { x: left, y: previousBox.bottom + padding },
    ];
  }
  const path = document.createElementNS(svgNamespace, "path");
  path.classList.add("range-backdrop-path");
  path.setAttribute("d", roundedPolygonPath(points));
  backdrop.append(path);
  backdrop.hidden = false;
}

function clearSlotSelection({ resetDetail = true } = {}) {
  selectedSlotDetail = null;
  document.querySelectorAll(".contribution-cell").forEach((item) => {
    item.classList.remove("range-selected", "range-end");
    item.setAttribute("aria-pressed", "false");
  });
  hideRangeBackdrop();
  if (resetDetail) resetSlotDetail();
}

function selectSlot(slot, cumulativeProbability, button) {
  clearSlotSelection({ resetDetail: false });
  const selectedIndex = Number(button.dataset.index);
  selectedSlotDetail = { slot, cumulativeProbability, index: selectedIndex };
  document.querySelectorAll(".contribution-cell").forEach((item) => {
    if (Number(item.dataset.index) > selectedIndex) return;
    item.classList.add("range-selected");
    item.setAttribute("aria-pressed", "true");
  });
  button.classList.add("range-end");
  updateRangeBackdrop(selectedIndex);
  focusCell(button);
  showSelectedSlotDetail(slot, cumulativeProbability);
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".contribution-cell")) return;
  if (!event.target.closest(".day-label")) hideHeatTooltip();
  clearSlotSelection();
});

function focusCell(button) {
  document.querySelectorAll(".contribution-cell").forEach((item) => {
    item.tabIndex = item === button ? 0 : -1;
  });
}

function cell(slot, maximum, index, visibleSlots) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "contribution-cell";
  button.dataset.level = String(levelForProbability(slot.first_reset_probability, maximum));
  button.dataset.index = String(index);
  button.setAttribute("aria-rowindex", String((index % 12) + 1));
  button.setAttribute("aria-colindex", String(Math.floor(index / 12) + 1));
  button.tabIndex = index === 0 ? 0 : -1;
  const cumulativeProbability = cumulativeToSlot(slot, visibleSlots, index);
  const label = describeSlot(slot, cumulativeProbability);
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("mouseenter", () => {
    showHeatTooltip(button, label.split("\n"));
    showHourlySlotDetail(slot, cumulativeProbability);
  });
  button.addEventListener("mouseleave", () => {
    if (!button.matches(":focus-visible")) hideHeatTooltip(button);
    if (!button.matches(":focus-visible")) restoreSlotDetail();
  });
  button.addEventListener("focus", () => {
    focusCell(button);
    showHeatTooltip(button, label.split("\n"));
    showHourlySlotDetail(slot, cumulativeProbability);
  });
  button.addEventListener("blur", () => {
    hideHeatTooltip(button);
    restoreSlotDetail();
  });
  button.addEventListener(
    "click",
    () => selectSlot(slot, cumulativeProbability, button),
  );
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

function dayBlock(slots, offset, maximum, visibleSlots, dayIndex) {
  const block = document.createElement("section");
  block.className = "forecast-day";
  const label = document.createElement("time");
  label.className = "day-label";
  label.dateTime = slots[0].start;
  label.textContent = dateFormatter.format(new Date(slots[0].start));
  label.tabIndex = 0;
  const dayNames = ["一", "两", "三", "四", "五", "六", "七"];
  const dayProbability = cumulativeToSlot(
    slots.at(-1),
    visibleSlots,
    offset + slots.length - 1,
  );
  const dayCount = dayIndex + 1;
  const dayMessage = tr(
    `未来${dayNames[dayIndex]}天内重置概率：${percent(dayProbability, 1)}`,
    `Reset probability within ${dayCount} ${dayCount === 1 ? "day" : "days"}: ${percent(dayProbability, 1)}`,
  );
  label.setAttribute(
    "aria-label",
    tr(
      `${dateFormatter.format(new Date(slots[0].start))}，${dayMessage}`,
      `${dateFormatter.format(new Date(slots[0].start))}, ${dayMessage}`,
    ),
  );
  label.addEventListener("mouseenter", () => showHeatTooltip(label, [dayMessage]));
  label.addEventListener("mouseleave", () => {
    if (!label.matches(":focus-visible")) hideHeatTooltip(label);
  });
  label.addEventListener("focus", () => showHeatTooltip(label, [dayMessage]));
  label.addEventListener("blur", () => hideHeatTooltip(label));
  const cells = document.createElement("div");
  cells.className = "day-cells";
  slots.forEach((slot, index) => {
    cells.append(cell(slot, maximum, offset + index, visibleSlots));
  });
  block.append(label, cells);
  return block;
}

function renderHeatmap(slots) {
  const target = document.querySelector("#heatmap");
  target.replaceChildren();
  target.className = "heatmap week-view";
  target.setAttribute("role", "grid");
  target.setAttribute(
    "aria-label",
    tr("从预测起点开始的 168 个连续小时", "168 continuous hours from the forecast origin"),
  );
  target.setAttribute("aria-rowcount", "12");
  target.setAttribute("aria-colcount", "14");
  target.setAttribute("aria-multiselectable", "true");
  createRangeBackdrop(target);
  const visible = slots.slice(0, 168);
  const maximum = Math.max(...visible.map((slot) => slot.first_reset_probability), 0);
  hideHeatTooltip();
  selectedSlotDetail = null;
  resetSlotDetail();
  for (let day = 0; day < 7; day += 1) {
    const offset = day * 24;
    const daySlots = visible.slice(offset, offset + 24);
    if (daySlots.length > 0) {
      target.append(dayBlock(daySlots, offset, maximum, visible, day));
    }
  }
}

window.addEventListener("resize", () => {
  if (!selectedSlotDetail) return;
  window.requestAnimationFrame(() => {
    updateRangeBackdrop(selectedSlotDetail.index);
  });
});

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
    const sourceDisplayName = source?.display_handle ?? tr("来源不可用", "Source unavailable");
    const sourceName = escapeHtml(sourceDisplayName);
    const sourceLabel = `<span>${sourceName}</span>`;
    const eventType = eventTypeLabels[item.event_type] ?? tr("其他信号", "Other signal");
    const phase = phaseLabels[item.phase] ?? tr("状态未知", "Unknown state");
    const role = sourceRoleLabels[item.source_role] ?? item.source_role ?? tr("角色未知", "Unknown role");
    const signalTime = source?.published_at ?? item.available_at;
    const pending = item.pending_next_forecast
      ? `<span class="signal-badge pending">${tr("待下一轮纳入", "Pending next run")}</span>`
      : "";
    const impact = item.impact?.severity
      ? `<span class="signal-badge severity-${escapeHtml(item.impact.severity)}">${escapeHtml(
          impactSeverityLabels[item.impact.severity] ?? tr("严重级待确认", "Severity pending"),
        )}</span>`
      : "";
    const competitionStage = item.competitive_context?.stage
      ? `<span class="signal-badge secondary">${escapeHtml(
          item.competitive_context.stage === "rolled_out"
            ? tr("已发布", "Released")
            : item.competitive_context.stage === "general_availability"
              ? tr("正式可用", "Generally available")
              : item.competitive_context.stage === "preview"
                ? tr("预览", "Preview")
                : item.competitive_context.stage === "rumor"
                  ? tr("传闻", "Rumor")
                  : tr("已宣布", "Announced"),
        )}</span>`
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
      tr(
        `查看 ${sourceDisplayName} ${formatCompactTime(signalTime)} 的${eventType}完整动态`,
        `View the full ${eventType} update from ${sourceDisplayName} at ${formatCompactTime(signalTime)}`,
      ),
    );
    preview.title = tr("点击查看完整内容", "Click to view full content");
    preview.innerHTML = `<span class="signal-head"><span class="signal-badges"><span class="signal-badge">${escapeHtml(eventType)}</span><span class="signal-badge secondary">${escapeHtml(role)}</span>${impact}${competitionStage}${pending}</span><time title="${tr("系统首次获取并可用于分析的时间", "First available to the system for analysis")}: ${escapeHtml(formatCompactTime(item.available_at))}">${escapeHtml(formatCompactTime(signalTime))}</time></span><span class="signal-card-text">${escapeHtml(source?.text ?? tr("暂无原始文本", "No source text"))}</span>`;
    preview.addEventListener("click", () => openSignalDialog(item, preview));
    row.append(preview);

    const footer = document.createElement("div");
    footer.className = "signal-footer";
    footer.innerHTML = `<small>${sourceLabel} · ${escapeHtml(phase)}</small>${sourceUrl
      ? `<a class="signal-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${tr(`在新窗口打开 ${sourceDisplayName} 的原文`, `Open the original post from ${sourceDisplayName} in a new window`)}" title="${tr("查看原文", "View source")}"><span>${tr("原文", "Source")}</span>${externalLinkIcon}</a>`
      : ""}`;
    row.append(footer);
    target.append(row);
  }
}

function renderTimeline(items) {
  const targetSelector = "#tibo-timeline-list";
  const target = document.querySelector(targetSelector);
  target.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    setListMessage(targetSelector, tr("暂无可展示的 Tibo 精确动态", "No exact Tibo updates to show"));
    return;
  }
  for (const item of items.slice(0, 12)) {
    const row = document.createElement("li");
    row.className = "timeline-item";
    const sourceUrl = safeExternalUrl(item.canonical_url);
    const eventType = item.event_type
      ? eventTypeLabels[item.event_type] ?? item.event_type
      : tr("未匹配信号", "Unmatched signal");
    const relevance = timelineRelevanceLabels[item.relevance] ??
      item.relevance ??
      tr("状态未知", "Unknown state");
    const featureStatus = item.quarantined_relation
      ? tr("已安全隔离", "Safely quarantined")
      : item.matched_signal
        ? item.forecast_feature_eligible
          ? tr("可进入预测特征", "Eligible for forecast features")
          : tr("仅展示", "Display only")
        : tr("未抽取", "Not extracted");
    const publishedAt = item.published_at ?? item.first_seen_at;
    const firstSeenTitle = item.first_seen_at
      ? tr(
        `系统首次获取：${formatCompactTime(item.first_seen_at)}`,
        `First seen by the system: ${formatCompactTime(item.first_seen_at)}`,
      )
      : tr("首次获取时间不可用", "First-seen time unavailable");
    row.innerHTML = `
      <div class="signal-head">
        <span class="signal-badges">
          <span class="signal-badge">${escapeHtml(eventType)}</span>
          <span class="signal-badge secondary">${escapeHtml(relevance)}</span>
          <span class="signal-badge ${item.forecast_feature_eligible ? "" : "muted"}">${escapeHtml(featureStatus)}</span>
        </span>
        <time title="${escapeHtml(firstSeenTitle)}">${escapeHtml(formatCompactTime(publishedAt))}</time>
      </div>
      <p class="signal-card-text">${escapeHtml(item.text ?? tr("暂无原始文本", "No source text"))}</p>
      <div class="signal-footer">
        <small>${escapeHtml(item.display_handle ?? "@thsottiaux")} · ${escapeHtml(item.ingest_provider ?? "exact source")}</small>
        ${sourceUrl
          ? `<a class="signal-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${tr("在新窗口打开 Tibo 原文", "Open the original Tibo post in a new window")}"><span>${tr("原文", "Source")}</span>${externalLinkIcon}</a>`
          : ""}
      </div>
    `;
    if (String(item.text ?? "").length > 180) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "timeline-expand";
      toggle.textContent = tr("展开完整内容", "Show full content");
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const expanded = row.classList.toggle("expanded");
        toggle.textContent = expanded
          ? tr("收起内容", "Collapse content")
          : tr("展开完整内容", "Show full content");
        toggle.setAttribute("aria-expanded", String(expanded));
      });
      row.querySelector(".signal-footer")?.before(toggle);
    }
    target.append(row);
  }
}

function pressureScore(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "—";
}

function impactSummary(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return tr("当前影响尚待补充", "Current impact pending");
  if (typeof value.summary === "string" && value.summary.trim()) {
    return value.summary.trim();
  }
  if (typeof value.description === "string" && value.description.trim()) {
    return value.description.trim();
  }
  const fields = [
    value.severity ? impactSeverityLabels[value.severity] ?? value.severity : null,
    value.category
      ? impactCategoryLabels[value.category] ?? value.category
      : null,
    value.lifecycle
      ? episodeStateLabels[value.lifecycle] ?? value.lifecycle
      : null,
    value.affected_scope
      ? impactScopeLabels[value.affected_scope] ?? value.affected_scope
      : null,
  ].filter(Boolean);
  return fields.length > 0 ? fields.join(" · ") : tr("当前影响尚待补充", "Current impact pending");
}

function renderImpactEpisodes(items, tracking = {}) {
  const targetSelector = "#impact-episode-list";
  const target = document.querySelector(targetSelector);
  target.replaceChildren();
  if (tracking.enabled === false) {
    setListMessage(targetSelector, tr("问题发酵追踪当前已关闭", "Issue-momentum tracking is disabled"));
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    setListMessage(targetSelector, tr("暂无形成持续发酵的问题", "No sustained issue momentum yet"));
    return;
  }
  for (const item of items.slice(0, 8)) {
    const row = document.createElement("li");
    row.className = "impact-episode-item";
    const current = Number(item.current_pressure);
    const peak = Number(item.peak_pressure);
    const denominator = Number.isFinite(peak) && peak > 0
      ? peak
      : Number.isFinite(current) && current > 0
        ? current
        : 1;
    const relativeWidth = Number.isFinite(current)
      ? Math.max(0, Math.min(100, (current / denominator) * 100))
      : 0;
    const state = episodeStateLabels[item.state] ?? item.state ?? tr("状态未知", "Unknown state");
    const trend = episodeTrendLabels[item.trend] ?? item.trend ?? tr("趋势未知", "Unknown trend");
    const category = impactCategoryLabels[item.category] ??
      String(item.category ?? tr("其他问题", "Other issue")).replaceAll("_", " ");
    const evidenceCount = Array.isArray(item.evidence)
      ? item.evidence.length
      : item.evidence && typeof item.evidence === "object"
        ? Object.keys(item.evidence).length
        : 0;
    const lastUpdate = item.last_independent_update_at
      ? formatCompactTime(item.last_independent_update_at)
      : tr("更新时间未知", "Update time unknown");
    const firstObserved = item.first_observed_at
      ? formatCompactTime(item.first_observed_at)
      : tr("时间未知", "Unknown time");
    const computedAt = item.as_of
      ? formatCompactTime(item.as_of)
      : tr("计算时间未知", "Calculation time unknown");
    row.innerHTML = `
      <div class="episode-heading">
        <div>
          <span class="episode-category">${escapeHtml(category)}</span>
          <span class="signal-badge secondary">${escapeHtml(state)}</span>
          <span class="signal-badge trend-${escapeHtml(String(item.trend ?? "unknown"))}">${escapeHtml(trend)}</span>
        </div>
        <time>${escapeHtml(lastUpdate)}</time>
      </div>
      <p class="episode-impact">${escapeHtml(impactSummary(item.current_impact))}</p>
      <div class="pressure-row">
        <span>${tr("当前压力", "Current pressure")} <strong>${escapeHtml(pressureScore(item.current_pressure))}</strong></span>
        <span>${tr("峰值", "Peak")} ${escapeHtml(pressureScore(item.peak_pressure))}</span>
      </div>
      <div class="pressure-track" aria-hidden="true"><i style="width:${relativeWidth.toFixed(1)}%"></i></div>
      <small>${tr("首次观察", "First observed")} ${escapeHtml(firstObserved)} · ${evidenceCount} ${tr("条独立证据", evidenceCount === 1 ? "independent evidence item" : "independent evidence items")} · ${tr("压力计算于", "pressure calculated at")} ${escapeHtml(computedAt)}</small>
    `;
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

async function fetchJson(url, { timeoutMs = null, cache = "no-store" } = {}) {
  try {
    const response = await fetch(url, {
      cache,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: tr("响应不是 JSON", "Response was not JSON"),
      };
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
  const blocker = primaryPublicationBlocker(
    [
      ...(result.data?.serving?.serving_blockers ?? []),
      ...(readiness.serving_blockers ?? []),
      ...(result.data?.serving?.publication_blockers ?? []),
      ...(readiness.publication_blockers ?? []),
    ],
  );
  if (blocker && publicationBlockerLabels[blocker]) {
    return tr(
      `${publicationBlockerLabels[blocker]}。`,
      `${publicationBlockerLabels[blocker]}.`,
    );
  }
  const preparation = modelPreparationState(readiness);
  if (preparation === "fitted") {
    return tr(
      "模型已完成拟合，正在生成首版 7 天试用预测。",
      "The model is fitted and is generating the first 7-day trial forecast.",
    );
  }
  if (preparation === "running") {
    return tr(
      "模型正在更新，首版可用结果生成后立即显示。",
      "The model is updating. The first usable result will appear when ready.",
    );
  }
  const labels = {
    forecast_incompatible: tr("模型版本需要更新。", "The model version needs an update."),
    forecast_not_publishable: tr("当前数据还不支持发布预测。", "Current data does not yet support publishing a forecast."),
    forecast_stale: tr("预测已过期，等待更新。", "The forecast has expired and is awaiting an update."),
    forecast_not_ready: tr("预测尚未生成。", "The forecast has not been generated yet."),
    forecast_warming: tr("预测数据正在预热。", "Forecast data is warming up."),
  };
  if (result.status === 0) {
    return tr("暂时无法连接预测服务。", "The forecast service is temporarily unreachable.");
  }
  return labels[result.data?.error] ?? tr(
    "预测暂不可用，请稍后再试。",
    "The forecast is temporarily unavailable. Please try again later.",
  );
}

function setStatus(kind, text) {
  const status = document.querySelector("#source-status");
  status.classList.remove("ok", "warning", "error");
  status.classList.add(kind);
  status.querySelector(".status-text").textContent = text;
  status.setAttribute("aria-label", tr(`${text}。查看数据状态`, `${text}. View data status`));
  document.querySelector("#status-announcement").textContent = text;
}

const statusPopover = document.querySelector(".status-popover");
const sourceStatus = document.querySelector("#source-status");

function closeStatusTooltip() {
  statusPopover?.classList.remove("open");
  sourceStatus?.setAttribute("aria-expanded", "false");
}

sourceStatus?.addEventListener("click", () => {
  const open = !statusPopover.classList.contains("open");
  statusPopover.classList.toggle("open", open);
  sourceStatus.setAttribute("aria-expanded", String(open));
});
sourceStatus?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeStatusTooltip();
  sourceStatus.focus();
});
document.addEventListener("click", (event) => {
  if (!statusPopover?.contains(event.target)) closeStatusTooltip();
});

function renderForecast(forecast) {
  const slots = Array.isArray(forecast.data.slots) ? forecast.data.slots : [];
  if (slots.length === 0) throw new Error(tr("预测没有小时数据", "Forecast contains no hourly data"));
  const provisional = isProvisionalServing(forecast);
  const probability4h = Number.isFinite(slots[0]?.rolling_4h_probability)
    ? slots[0].rolling_4h_probability
    : null;
  const probability24h = slots.length >= 24 ? cumulative(slots.slice(0, 24)) : null;
  const probability72h = slots.length >= 72
    ? cumulativeToSlot(slots[71], slots, 71)
    : null;
  const probability168h = Number.isFinite(forecast.data.no_reset_probability)
    ? 1 - forecast.data.no_reset_probability
    : slots.length >= 168
      ? cumulative(slots.slice(0, 168))
      : null;
  document.querySelector("#probability-4h").textContent = probability4h === null
    ? tr("窗口不足", "Insufficient window")
    : percent(probability4h, 2);
  document.querySelector("#probability-24h").textContent = percent(probability24h, 1);
  document.querySelector("#probability-72h").textContent = probability72h === null
    ? tr("窗口不足", "Insufficient window")
    : percent(probability72h, 1);
  document.querySelector("#probability-7d").textContent = percent(probability168h, 1);
  document.querySelector("#data-quality-label").textContent =
    provisional
      ? tr("数据状态 · 试用模型", "Data status · Trial model")
      : tr("数据状态", "Data status");
  document.querySelector("#interval-4h").textContent = probability4h === null
    ? tr("滚动 4 小时窗口超出预测范围", "The rolling 4-hour window exceeds the forecast range")
    : intervalText(cumulativeInterval(forecast, "four_hours"));
  document.querySelector("#interval-24h").textContent =
    intervalText(cumulativeInterval(forecast, "twenty_four_hours"));
  document.querySelector("#interval-72h").textContent =
    tr("未来 72 小时内发生重置的可能性", "Probability of a reset within the next 72 hours");
  document.querySelector("#interval-7d").textContent =
    intervalText(cumulativeInterval(forecast, "horizon"));
  document.querySelector("#data-quality").textContent = tr("实时来源检查中", "Checking live sources");
  const outcomeSampleCount = forecast.data.data_quality?.outcome_sample_count;
  const sampleSufficiency = forecast.data.data_quality?.sample_sufficiency;
  document.querySelector("#coverage").textContent =
    [
      Number.isInteger(outcomeSampleCount)
        ? tr(`历史事件：${outcomeSampleCount} 个`, `Historical events: ${outcomeSampleCount}`)
        : null,
      Number.isFinite(sampleSufficiency)
        ? tr(`样本充分度：${percent(sampleSufficiency, 0)}`, `Sample sufficiency: ${percent(sampleSufficiency, 0)}`)
        : null,
      tr("负标签按审计延迟成熟", "Negative labels mature after an audit delay"),
    ].filter(Boolean).join(" · ");
  document.querySelector("#forecast-window").textContent =
    `${formatTime(slots[0].start)} → ${formatTime(slots.at(-1).end)}`;
  const conditioning = forecast.data.authority_conditioning;
  document.querySelector("#authority-window").textContent =
    conditioning?.applied
      ? [
          tr(
            `权威时间条件：${phaseLabels[conditioning.phase] ?? conditioning.phase}`,
            `Authority condition: ${phaseLabels[conditioning.phase] ?? conditioning.phase}`,
          ),
          tr(
            `${percent(conditioning.prior_reliability, 0)} 版本化先验`,
            `${percent(conditioning.prior_reliability, 0)} versioned prior`,
          ),
          conditioning.asserted_time_range
            ? `${formatCompactTime(conditioning.asserted_time_range.start)} → ${formatCompactTime(conditioning.asserted_time_range.end)}`
            : null,
        ].filter(Boolean).join(" · ")
      : tr("权威时间条件：当前未触发", "Authority condition: not currently triggered");
  const recurrenceAnchor = forecast.data.recurrence_anchor;
  document.querySelector("#recurrence-anchor").textContent =
    recurrenceAnchor?.occurred_time_range
      ? tr(
        `重置周期锚点：${formatCompactTime(recurrenceAnchor.occurred_time_range.start)} 已确认重置`,
        `Reset-cycle anchor: confirmed reset at ${formatCompactTime(recurrenceAnchor.occurred_time_range.start)}`,
      )
      : tr("重置周期锚点：暂无已确认事件", "Reset-cycle anchor: no confirmed event yet");
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
    "#probability-72h",
    "#probability-7d",
  ]) {
    document.querySelector(selector).textContent = preparing
      ? fitted ? tr("生成中", "Generating") : tr("训练中", "Training")
      : "—";
  }
  document.querySelector("#interval-4h").textContent =
    preparing
      ? tr("首版试用预测生成后显示", "Shown after the first trial forecast is generated")
      : tr("当前预测不可用", "Current forecast unavailable");
  document.querySelector("#interval-24h").textContent =
    preparing
      ? tr("首版试用预测生成后显示", "Shown after the first trial forecast is generated")
      : tr("当前预测不可用", "Current forecast unavailable");
  document.querySelector("#interval-72h").textContent =
    preparing
      ? tr("首版试用预测生成后显示", "Shown after the first trial forecast is generated")
      : tr("当前预测不可用", "Current forecast unavailable");
  document.querySelector("#interval-7d").textContent =
    preparing
      ? tr("首版试用预测生成后显示", "Shown after the first trial forecast is generated")
      : tr("当前预测不可用", "Current forecast unavailable");
  document.querySelector("#data-quality-label").textContent =
    preparing ? tr("模型状态", "Model status") : tr("数据状态", "Data status");
  document.querySelector("#data-quality").textContent =
    preparing ? fitted ? tr("已完成拟合", "Fitted") : tr("更新中", "Updating") : "—";
  const coverageDays = Number.isFinite(readiness.outcome_coverage?.hours)
    ? Math.round(readiness.outcome_coverage.hours / 24)
    : null;
  const confirmedOutcomes = readiness.canonical_records?.confirmed_outcomes;
  document.querySelector("#coverage").textContent = preparing
    ? [
        Number.isInteger(coverageDays)
          ? tr(`${coverageDays} 天历史覆盖`, `${coverageDays} days of historical coverage`)
          : null,
        Number.isInteger(confirmedOutcomes)
          ? tr(`${confirmedOutcomes} 次确认重置`, `${confirmedOutcomes} confirmed resets`)
          : null,
      ].filter(Boolean).join(" · ") || tr("正在积累真实评估数据", "Accumulating real evaluation data")
    : tr("数据覆盖暂不可用", "Coverage is not available yet");
  document.querySelector("#forecast-window").textContent = preparing
    ? tr("正在生成试用预测", "Generating trial forecast")
    : tr("当前预测区间不可用", "Current forecast window unavailable");
  document.querySelector("#authority-window").textContent =
    tr("权威时间条件：等待预测", "Authority condition: waiting for forecast");
  document.querySelector("#recurrence-anchor").textContent =
    tr("重置周期锚点：等待预测", "Reset-cycle anchor: waiting for forecast");
  document.querySelector("#heatmap-legend").hidden = true;
  document.querySelector("#heat-detail").hidden = true;
  document.querySelector("#heatmap").innerHTML =
    `<div class="empty-state${preparing ? "" : " error-state"}"><strong>${preparing ? tr("首版试用预测生成后显示每小时概率", "Hourly probabilities appear after the first trial forecast") : tr("预测尚未就绪", "Forecast is not ready")}</strong><p>${escapeHtml(message)}</p></div>`;
  document.querySelector("#heat-detail").innerHTML =
    preparing
      ? `<strong>—</strong><div><span>${tr("首版试用预测生成后显示每小时概率", "Hourly probabilities appear after the first trial forecast")}</span><time>${fitted ? tr("生成中", "Generating") : tr("训练中", "Training")}</time></div>`
      : tr(
        "<strong>—</strong><div><span>当前预测不可用</span><time>等待新预测</time></div>",
        "<strong>—</strong><div><span>Current forecast unavailable</span><time>Waiting for a new forecast</time></div>",
      );
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
    target.textContent = tr(
      "试用模型：当前概率已开放试用，严格验证仍在积累中。",
      "Trial model: probabilities are available while strict validation continues to accumulate.",
    );
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
  const label = publicationBlockerLabels[primaryBlocker] ?? tr("数据仍在准备中", "Data is still being prepared");
  target.hidden = false;
  target.classList.toggle("synthetic", syntheticDemo);
  target.textContent = syntheticDemo
    ? tr("合成数据演示，仅用于查看页面和模型流程。", "Synthetic data demo for viewing the page and model flow only.")
    : tr(`预测尚未达到发布条件：${label}。`, `The forecast has not met publication requirements: ${label}.`);
}

function renderDataStatus(forecast, health, readiness) {
  if (!forecast?.data?.data_quality) return;
  const groups = health.provider_freshness ?? readiness.provider_freshness?.groups ?? {};
  const sourcesFresh = Boolean(
    groups.required_outcome &&
    groups.exact &&
    groups.required_outcome.status === "fresh" &&
    groups.exact.status === "fresh",
  );
  const quality = forecast.data.data_quality;
  const outcomeSampleCount = Number.isInteger(quality.outcome_sample_count)
    ? quality.outcome_sample_count
    : readiness.canonical_records?.confirmed_outcomes;
  const sampleSufficiency = quality.sample_sufficiency;
  document.querySelector("#data-quality-label").textContent =
    isProvisionalServing(forecast, readiness)
      ? tr("数据状态 · 试用模型", "Data status · Trial model")
      : tr("数据状态", "Data status");
  document.querySelector("#data-quality").textContent = sourcesFresh
    ? tr("实时来源正常", "Live sources are fresh")
    : tr("实时来源待更新", "Live sources need an update");
  document.querySelector("#coverage").textContent = [
    Number.isInteger(outcomeSampleCount)
      ? tr(`历史事件：${outcomeSampleCount} 个`, `Historical events: ${outcomeSampleCount}`)
      : null,
    Number.isFinite(sampleSufficiency)
      ? tr(`样本充分度：${percent(sampleSufficiency, 0)}`, `Sample sufficiency: ${percent(sampleSufficiency, 0)}`)
      : null,
    tr("负标签按审计延迟成熟", "Negative labels mature after an audit delay"),
  ].filter(Boolean).join(" · ");
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
  const servingBlockers = [
    ...(forecast?.serving?.serving_blockers ?? []),
    ...(readiness.serving_blockers ?? []),
    ...(health.serving_blockers ?? []),
  ];
  const sourceFreshnessBlocked = servingBlockers.some((blocker) =>
    [
      "required_outcome_source_not_fresh",
      "exact_source_not_fresh",
    ].includes(blocker)
  );
  if (sourceFreshnessBlocked) {
    setStatus("error", tr("核心来源异常 · 预测已暂停", "Core source issue · Forecast paused"));
  } else if (provisional) {
    setStatus("warning", tr("试用模型 · 严格验证积累中", "Trial model · Strict validation accumulating"));
  } else if (coverageWaiting || evaluationWaiting) {
    setStatus(
      "warning",
      coverageWaiting
        ? tr(
          `历史覆盖复验中 · 最早 ${formatCompactTime(coverageWaiting.earliest_recheck_at)}`,
          `Historical coverage is being revalidated · Earliest ${formatCompactTime(coverageWaiting.earliest_recheck_at)}`,
        )
        : challengerReady(readiness)
          ? tr("模型已训练 · 评估中", "Model trained · Evaluating")
          : tr("模型评估中", "Evaluating model"),
    );
  } else if (!forecast?.data) {
    setStatus("error", tr("预测暂不可用", "Forecast unavailable"));
  } else if (["stale", "invalid"].includes(servingStatus) || health.status === "stale") {
    setStatus("error", tr(
      `预测已过期 · 发布于 ${formatCompactTime(forecast.data.issued_at)}`,
      `Forecast expired · Issued ${formatCompactTime(forecast.data.issued_at)}`,
    ));
  } else if (synthetic) {
    setStatus("warning", tr("合成数据演示", "Synthetic data demo"));
  } else if (
    servingStatus === "degraded" ||
    health.status === "degraded" ||
    exact?.status !== "fresh" ||
    !readiness.publication_ready
  ) {
    setStatus(
      "warning",
      exactLastSuccess
        ? tr(
          `状态降级 · 核心来源更新于 ${formatCompactTime(exactLastSuccess)}`,
          `Degraded · Core source updated ${formatCompactTime(exactLastSuccess)}`,
        )
        : tr("状态降级 · 核心来源更新不及时", "Degraded · Core source is not fresh"),
    );
  } else {
    setStatus(
      "ok",
      exactLastSuccess
        ? tr(
          `核心来源更新于 ${formatCompactTime(exactLastSuccess)}`,
          `Core source updated ${formatCompactTime(exactLastSuccess)}`,
        )
        : tr(
          `预测生成于 ${formatCompactTime(forecast.data.issued_at)}`,
          `Forecast generated ${formatCompactTime(forecast.data.issued_at)}`,
        ),
    );
  }
  renderDataStatus(forecast, health, readiness);
}

function renderEvidenceResponse(result) {
  if (!result.ok || !result.data) {
    setListMessage("#core-signal-list", tr(`核心信号加载失败：${result.error}`, `Core signals failed to load: ${result.error}`), "error");
    setListMessage("#experience-signal-list", tr(`体验问题加载失败：${result.error}`, `Experience issues failed to load: ${result.error}`), "error");
    setListMessage("#competition-signal-list", tr(`竞争动态加载失败：${result.error}`, `Competing releases failed to load: ${result.error}`), "error");
    setListMessage("#pending-signal-list", tr(`待纳入信号加载失败：${result.error}`, `Pending signals failed to load: ${result.error}`), "error");
    setListMessage("#tibo-timeline-list", tr(`Tibo 动态加载失败：${result.error}`, `Tibo updates failed to load: ${result.error}`), "error");
    setListMessage("#impact-episode-list", tr(`问题追踪加载失败：${result.error}`, `Issue tracking failed to load: ${result.error}`), "error");
    return;
  }
  const evidence = result.data;
  const currentItems = Array.isArray(evidence.items) ? evidence.items : [];
  const core = evidence.core ?? currentItems.filter(isCoreEvidence);
  const experience = evidence.experience ??
    currentItems.filter((item) => item.category === "experience");
  const competition = evidence.competition ??
    currentItems.filter((item) => item.category === "competition");
  const pending = evidence.pending_next_forecast?.items ?? evidence.post_cutoff?.items ?? [];
  document.querySelector("#evidence-cutoff").textContent =
    tr(
      `仅显示信息截止 ${formatCompactTime(evidence.knowledge_cutoff)} 前已知的信号。`,
      `Only signals known by the ${formatCompactTime(evidence.knowledge_cutoff)} knowledge cutoff are shown.`,
    );
  renderEvidence("#core-signal-list", core, tr("截止时间前暂无新的精确官方核心信号", "No new exact official core signals before the cutoff"), "core");
  renderEvidence("#experience-signal-list", experience, tr("截止时间前暂无新的 Codex 体验问题", "No new Codex experience issues before the cutoff"), "experience");
  renderEvidence("#competition-signal-list", competition, tr("截止时间前暂无新的竞争模型发布", "No new competing model releases before the cutoff"), "competition");
  renderEvidence("#pending-signal-list", pending, tr("当前没有晚于截止时间的新信号", "No new signals after the cutoff"), "pending");
  renderTimeline(evidence.timeline);
  renderImpactEpisodes(evidence.impact_episodes, evidence.impact_tracking);
}

let refreshTimer = null;
let evidenceRequest = null;
let lastEvidenceSignature = null;
let loading = false;
let lastLoadedAt = 0;
let latestForecastCutoff = null;
let cachedForecast = null;
let cachedForecastKey = null;
let forecastRequest = null;
let evidenceVisible = false;
let evidenceLoadedForKey = null;

function evidenceSignature(result) {
  return result.ok && result.data
    ? JSON.stringify(result.data)
    : `error:${result.status}:${result.error ?? "unknown"}`;
}

function predictionRefKey(reference) {
  return typeof reference?.record_id === "string" &&
      Number.isInteger(reference?.revision)
    ? `${reference.record_id}@${reference.revision}`
    : null;
}

function safeSnapshotUrl(reference) {
  if (typeof reference?.snapshot_url !== "string") return null;
  try {
    const url = new URL(reference.snapshot_url, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/api/forecast/snapshots/")
    ) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function loadForecastSnapshot(reference) {
  const key = predictionRefKey(reference);
  const url = safeSnapshotUrl(reference);
  if (!key || !url) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: tr("当前预测快照地址无效", "The current forecast snapshot URL is invalid"),
    };
  }
  if (cachedForecastKey === key && cachedForecast) {
    return { ok: true, status: 200, data: cachedForecast, error: null };
  }
  if (forecastRequest?.key === key) return forecastRequest.promise;
  const promise = (async () => {
    const result = await fetchJson(url, {
      timeoutMs: 15_000,
      cache: "default",
    });
    if (!result.ok || !result.data) return result;
    if (
      result.data.record_type !== "prediction" ||
      predictionRefKey(result.data) !== key
    ) {
      return {
        ok: false,
        status: result.status,
        data: null,
        error: tr("预测快照与当前版本不一致", "The forecast snapshot does not match the current version"),
      };
    }
    cachedForecast = result.data;
    cachedForecastKey = key;
    return result;
  })();
  forecastRequest = { key, promise };
  try {
    return await promise;
  } finally {
    if (forecastRequest?.promise === promise) forecastRequest = null;
  }
}

function forecastWithServing(snapshot, health) {
  const provisional = health.serving_stage === "provisional";
  const synthetic = health.synthetic_only === true;
  return {
    ...snapshot,
    serving: {
      ...(snapshot.serving ?? {}),
      status: provisional
        ? "provisional"
        : synthetic
          ? "synthetic_demo"
          : health.forecast?.status ?? "fresh",
      ready: health.serving_ready === true || synthetic,
      serving_ready: health.serving_ready === true || synthetic,
      stage: health.serving_stage,
      serving_stage: health.serving_stage,
      blockers: health.serving_blockers ?? [],
      serving_blockers: health.serving_blockers ?? [],
      publication_ready: health.publication_ready === true,
      publication_blockers: health.publication_blockers ?? [],
      provisional_model: health.provisional_model ?? null,
      synthetic_demo: synthetic,
    },
  };
}

async function loadEvidence() {
  if (!evidenceVisible || !cachedForecastKey) return null;
  if (evidenceLoadedForKey === cachedForecastKey) return null;
  if (evidenceRequest) return evidenceRequest;
  const requestedKey = cachedForecastKey;
  const requestedCutoff = latestForecastCutoff;
  evidenceRequest = (async () => {
    const result = await fetchJson("/api/evidence/recent", {
      timeoutMs: 20_000,
    });
    const signature = evidenceSignature(result);
    const responseCutoff = result.data?.knowledge_cutoff ?? null;
    const cutoffsMatch = Number.isFinite(Date.parse(requestedCutoff)) &&
      Number.isFinite(Date.parse(responseCutoff)) &&
      requestedCutoff === responseCutoff;
    const stillCurrent = requestedKey === cachedForecastKey &&
      cutoffsMatch;
    if (stillCurrent && signature !== lastEvidenceSignature) {
      lastEvidenceSignature = signature;
      renderEvidenceResponse(result);
    }
    if (stillCurrent && result.ok) evidenceLoadedForKey = requestedKey;
    return result;
  })();
  try {
    return await evidenceRequest;
  } finally {
    evidenceRequest = null;
    if (
      evidenceVisible &&
      requestedKey !== cachedForecastKey &&
      evidenceLoadedForKey !== cachedForecastKey
    ) {
      void loadEvidence();
    }
  }
}

function scheduleCadenceRefresh({ retrySoon = false } = {}) {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (retrySoon) {
    refreshTimer = setTimeout(() => {
      void load();
    }, 30_000);
    return;
  }
  const currentMs = Date.now();
  const cadenceMs = 10 * 60_000;
  const currentCadenceMs = Math.floor(currentMs / cadenceMs) * cadenceMs;
  const cutoffMs = Date.parse(latestForecastCutoff);
  const waitingForCurrentCadence = (
    currentMs - currentCadenceMs < 2 * 60_000 &&
    Number.isFinite(cutoffMs) &&
    cutoffMs < currentCadenceMs
  );
  if (waitingForCurrentCadence) {
    refreshTimer = setTimeout(() => {
      void load();
    }, 45_000);
    return;
  }
  const nextCadenceMs = currentCadenceMs + cadenceMs + 12_000;
  refreshTimer = setTimeout(() => {
    void load();
  }, Math.max(1_000, nextCadenceMs - currentMs));
}

async function load() {
  if (loading) return;
  loading = true;
  let retrySoon = false;
  document.querySelector("#timezone-display").textContent = tr(
    `时区 · ${displayZone}`,
    `Time zone · ${displayZone}`,
  );
  let healthResult = {
    ok: false,
    status: 0,
    data: null,
    error: tr("尚未检查状态", "Status not checked yet"),
  };
  try {
    healthResult = await fetchJson("/api/health", { timeoutMs: 15_000 });
    const health = healthResult.data ?? {};
    const reference = health.current_prediction_ref;
    const forecastCutoff = reference?.knowledge_cutoff ?? health.knowledge_cutoff;
    if (Number.isFinite(Date.parse(forecastCutoff))) latestForecastCutoff = forecastCutoff;
    const canDisplay = predictionRefKey(reference) && (
      health.display_available === true ||
      health.serving_ready === true ||
      health.synthetic_only === true
    );
    if (!canDisplay) {
      retrySoon = true;
      renderForecastError(
        forecastErrorText(healthResult, health),
        health,
      );
      renderPublicationWarning(healthResult, healthResult);
      renderHealth({ ok: false, status: healthResult.status, data: null }, healthResult, healthResult);
      return;
    }
    const previousKey = cachedForecastKey;
    const snapshotResult = await loadForecastSnapshot(reference);
    if (!snapshotResult.ok || !snapshotResult.data) {
      retrySoon = true;
      renderForecastError(
        tr(
          `当前预测快照加载失败：${snapshotResult.error}`,
          `Current forecast snapshot failed to load: ${snapshotResult.error}`,
        ),
        health,
      );
      renderPublicationWarning(snapshotResult, healthResult);
      renderHealth(snapshotResult, healthResult, healthResult);
      setStatus("error", tr("预测快照加载失败", "Forecast snapshot failed to load"));
      return;
    }
    const forecast = forecastWithServing(snapshotResult.data, health);
    const forecastResult = {
      ok: true,
      status: 200,
      data: forecast,
      error: null,
    };
    renderForecast(forecast);
    renderPublicationWarning(forecastResult, healthResult);
    renderHealth(forecastResult, healthResult, healthResult);
    if (previousKey !== cachedForecastKey) evidenceLoadedForKey = null;
    if (evidenceVisible) void loadEvidence();
  } catch (error) {
    retrySoon = true;
    console.error(error);
    renderForecastError(error.message, healthResult.data ?? {});
    setStatus("error", tr("预测渲染失败", "Forecast rendering failed"));
  } finally {
    lastLoadedAt = Date.now();
    loading = false;
    scheduleCadenceRefresh({ retrySoon });
  }
}

const evidenceSections = document.querySelectorAll(
  ".signal-grid, .context-grid, .pending-panel",
);
if ("IntersectionObserver" in window) {
  const visibleEvidenceSections = new Set();
  const evidenceObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleEvidenceSections.add(entry.target);
      else visibleEvidenceSections.delete(entry.target);
    }
    evidenceVisible = visibleEvidenceSections.size > 0;
    if (evidenceVisible) void loadEvidence();
  }, { rootMargin: "200px 0px" });
  for (const section of evidenceSections) evidenceObserver.observe(section);
} else {
  evidenceVisible = true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (Date.now() - lastLoadedAt > 60_000) {
      void load();
    } else if (evidenceVisible) {
      void loadEvidence();
    }
  }
});
window.addEventListener("online", () => void load());

const notificationOpen = document.querySelector("#notification-open");
const notificationDialog = document.querySelector("#notification-dialog");
const notificationClose = document.querySelector("#notification-close");
const notificationCancel = document.querySelector("#notification-cancel");
const notificationEnable = document.querySelector("#notification-enable");
const notificationDisable = document.querySelector("#notification-disable");
const notificationStatus = document.querySelector("#notification-status");
const notificationProbabilityTopic = document.querySelector(
  "#notification-topic-probability",
);
const notificationProbabilityRule = document.querySelector(
  "#notification-probability-rule",
);
const notificationHorizon = document.querySelector("#notification-horizon");
const notificationHorizonValue = document.querySelector(
  "#notification-horizon-value",
);
const notificationHorizonTicks = document.querySelector(
  "#notification-horizon-ticks",
);
const notificationThreshold = document.querySelector("#notification-threshold");
const notificationThresholdValue = document.querySelector(
  "#notification-threshold-value",
);
const calibrationPlot = document.querySelector("#calibration-plot");
const calibrationArea = document.querySelector("#calibration-area");
const calibrationCurve = document.querySelector("#calibration-curve");
const calibrationCrosshair = document.querySelector("#calibration-crosshair");
const calibrationMarker = document.querySelector("#calibration-marker");
const calibrationThresholdRange = document.querySelector(
  "#calibration-threshold-range",
);
const calibrationHitArea = document.querySelector("#calibration-hit-area");
const calibrationThresholdPin = document.querySelector(
  "#calibration-threshold-pin",
);
const calibrationTooltip = document.querySelector("#calibration-tooltip");
const calibrationState = document.querySelector("#calibration-state");
const calibrationSample = document.querySelector("#calibration-sample");
const calibrationAxisLower = document.querySelector("#calibration-axis-lower");
const calibrationAxisUpper = document.querySelector("#calibration-axis-upper");
const calibrationRangeNote = document.querySelector("#calibration-range-note");
const calibrationSummary = document.querySelector("#calibration-summary");
const personalizedFeedUrl = document.querySelector("#personalized-feed-url");
const personalizedFeedCopy = document.querySelector("#personalized-feed-copy");
const personalizedFeedOpen = document.querySelector("#personalized-feed-open");
const personalizedFeedStatus = document.querySelector(
  "#personalized-feed-status",
);
const NOTIFICATION_PREFERENCES_STORAGE_KEY =
  "codex-reset-notification-preferences/1";
let notificationRegistration = null;
let notificationPublicConfig = null;
let notificationCalibration = null;
const notificationCalibrationCache = createNotificationCalibrationCache();
const notificationCalibrationRequests = new Map();
let notificationCalibrationTimer = null;
let notificationCalibrationGeneration = 0;
let notificationThresholdPristine = true;
let notificationThresholdHasProfileSuggestion = false;
let notificationDialogTrigger = null;
let notificationFeedBaselineCursor = null;
let notificationFeedBaselineRequest = null;
let notificationControlsBusy = false;
let calibrationThresholdDragging = false;
let calibrationThresholdPointerId = null;

function supportsWebPush() {
  return typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined";
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(base64);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

function selectedNotificationTopics() {
  return [
    ["#notification-topic-authority", "authority"],
    ["#notification-topic-outcome", "outcome"],
    ["#notification-topic-probability", "experimental_probability"],
  ].filter(([selector]) => document.querySelector(selector)?.checked)
    .map(([, topic]) => topic);
}

function selectedNotificationPreferences() {
  const index = Math.min(
    NOTIFICATION_HORIZON_HOURS.length - 1,
    Math.max(0, Number(notificationHorizon?.value) || 0),
  );
  return {
    schema_version: "notification-preferences/1",
    horizon_hours: NOTIFICATION_HORIZON_HOURS[index],
    probability_threshold: Math.min(
      0.99,
      Math.max(0.01, (Number(notificationThreshold?.value) || 0) / 100),
    ),
  };
}

function saveLocalNotificationPreferences({
  topics = selectedNotificationTopics(),
  preferences = selectedNotificationPreferences(),
} = {}) {
  notificationThresholdPristine = false;
  try {
    localStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      topics,
      preferences,
    }));
  } catch {
    // Local persistence is a convenience; the server remains authoritative.
  }
}

function restoreLocalNotificationPreferences() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY) ?? "null",
    );
    const topics = Array.isArray(saved?.topics) ? new Set(saved.topics) : null;
    if (topics) {
      for (const [selector, topic] of [
        ["#notification-topic-authority", "authority"],
        ["#notification-topic-outcome", "outcome"],
        ["#notification-topic-probability", "experimental_probability"],
      ]) {
        const input = document.querySelector(selector);
        if (input) input.checked = topics.has(topic);
      }
    }
    const preferences = saved?.preferences;
    if (preferences?.schema_version === "notification-preferences/1") {
      notificationHorizon.value = String(
        nearestHorizonIndex(preferences.horizon_hours),
      );
      const threshold = Number(preferences.probability_threshold);
      if (Number.isFinite(threshold) && threshold >= 0.01 && threshold <= 0.99) {
        notificationThreshold.value = String(Math.round(threshold * 100));
        notificationThresholdPristine = false;
        return true;
      }
      return false;
    }
  } catch {
    // Ignore unavailable or malformed browser storage.
  }
  return false;
}

function applyPublicNotificationDefaults(config) {
  const preferences = config?.notification_preferences;
  if (preferences?.schema_version !== "notification-preferences/1") return;
  const defaultHorizon = Number(preferences.horizon_hours?.default);
  const defaultThreshold = Number(preferences.probability_threshold?.default);
  if (Number.isSafeInteger(defaultHorizon)) {
    notificationHorizon.value = String(nearestHorizonIndex(defaultHorizon));
  }
  if (
    notificationThresholdPristine &&
    !notificationThresholdHasProfileSuggestion &&
    Number.isFinite(defaultThreshold) &&
    defaultThreshold >= 0.01 &&
    defaultThreshold <= 0.99
  ) {
    notificationThreshold.value = String(Math.round(defaultThreshold * 100));
  }
}

function horizonHours() {
  const index = Math.min(
    NOTIFICATION_HORIZON_HOURS.length - 1,
    Math.max(0, Number(notificationHorizon.value) || 0),
  );
  return NOTIFICATION_HORIZON_HOURS[index];
}

function renderHorizonTicks() {
  const labelled = new Set([1, 4, 8, 12, 24, 48, 72, 96, 120, 144, 168]);
  notificationHorizonTicks.replaceChildren(
    ...NOTIFICATION_HORIZON_HOURS.map((hours) => {
      const tick = document.createElement("span");
      tick.dataset.label = labelled.has(hours)
        ? hours >= 24 && hours % 24 === 0
          ? `${hours / 24}d`
          : `${hours}h`
        : "";
      return tick;
    }),
  );
}

function renderNotificationValues() {
  const hours = horizonHours();
  notificationHorizonValue.textContent = formatNotificationHorizon(hours);
  notificationHorizon.setAttribute(
    "aria-valuetext",
    formatNotificationHorizon(hours),
  );
  const threshold = Number(notificationThreshold.value) || 0;
  notificationThresholdValue.textContent = `${threshold}%`;
  notificationThreshold.setAttribute("aria-valuetext", `${threshold}%`);
  const preference = selectedNotificationPreferences();
  const thresholdParameter = preference.probability_threshold
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  if (!Number.isSafeInteger(notificationFeedBaselineCursor)) {
    personalizedFeedUrl.value = "";
    personalizedFeedCopy.disabled = true;
    personalizedFeedOpen.removeAttribute("href");
    personalizedFeedOpen.setAttribute("aria-disabled", "true");
    return;
  }
  const feedPath = "/feeds/probability.xml" +
    `?horizon_hours=${preference.horizon_hours}` +
    `&probability_threshold=${thresholdParameter}` +
    `&after=${notificationFeedBaselineCursor}`;
  personalizedFeedUrl.value = new URL(feedPath, window.location.href).href;
  personalizedFeedCopy.disabled = false;
  personalizedFeedOpen.href = feedPath;
  personalizedFeedOpen.removeAttribute("aria-disabled");
  personalizedFeedOpen.setAttribute(
    "aria-label",
    tr(
      `打开 ${formatNotificationHorizon(preference.horizon_hours)}、${threshold}% 门槛的个性化 Atom`,
      `Open the personalized Atom feed for a ${formatNotificationHorizon(preference.horizon_hours)} window and ${threshold}% threshold`,
    ),
  );
}

async function refreshPersonalizedFeedBaseline() {
  if (!notificationDialog.open || !notificationProbabilityTopic.checked) return;
  notificationFeedBaselineRequest?.abort();
  const controller = new AbortController();
  let timedOut = false;
  notificationFeedBaselineRequest = controller;
  notificationFeedBaselineCursor = null;
  personalizedFeedStatus.textContent = tr(
    "正在从当前预测建立订阅基线…",
    "Building a subscription baseline from the current forecast…",
  );
  renderNotificationValues();
  try {
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8_000);
    const response = await fetch("/api/notification-preferences/baseline", {
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
    }
    if (
      payload?.schema_version !== "notification-feed-baseline/1" ||
      !Number.isSafeInteger(payload.cursor) ||
      payload.cursor < 0
    ) {
      throw new TypeError(tr("订阅基线响应无效", "The subscription baseline response is invalid"));
    }
    if (
      controller.signal.aborted ||
      !notificationDialog.open ||
      !notificationProbabilityTopic.checked
    ) return;
    notificationFeedBaselineCursor = payload.cursor;
    personalizedFeedStatus.textContent = tr(
      "链接只会评估建立基线之后的新预测，不会回放过去的提醒。",
      "The link evaluates only forecasts issued after this baseline and does not replay past alerts.",
    );
    renderNotificationValues();
  } catch (error) {
    if (
      notificationFeedBaselineRequest !== controller ||
      !notificationDialog.open ||
      !notificationProbabilityTopic.checked ||
      (controller.signal.aborted && !timedOut)
    ) return;
    notificationFeedBaselineCursor = null;
    renderNotificationValues();
    personalizedFeedStatus.textContent = tr(
      `暂时无法建立安全基线，个性化 Atom 链接不可用：${timedOut ? "请求超时" : error.message}`,
      `A safe baseline could not be established, so the personalized Atom link is unavailable: ${timedOut ? "request timed out" : error.message}`,
    );
  } finally {
    if (notificationFeedBaselineRequest === controller) {
      notificationFeedBaselineRequest = null;
    }
  }
}

function setCalibrationSvgHidden(element, hidden) {
  element.hidden = hidden;
  if (hidden) element.setAttribute("hidden", "");
  else element.removeAttribute("hidden");
}

function clearCalibrationGraphic() {
  calibrationArea.removeAttribute("d");
  calibrationCurve.removeAttribute("d");
  setCalibrationSvgHidden(calibrationCrosshair, true);
  delete calibrationCrosshair.dataset.outside;
  setCalibrationSvgHidden(calibrationMarker, true);
  setCalibrationSvgHidden(calibrationThresholdRange, true);
  calibrationThresholdRange.setAttribute("width", "0");
  delete calibrationThresholdRange.dataset.outside;
  calibrationThresholdPin.hidden = true;
  delete calibrationThresholdPin.dataset.outside;
  delete calibrationThresholdPin.dataset.side;
  calibrationTooltip.hidden = true;
}

function calibrationDisplayRange(calibration = notificationCalibration) {
  const lower = calibration?.distribution_summary?.display_range?.lower;
  const upper = calibration?.distribution_summary?.display_range?.upper;
  return Number.isFinite(lower) &&
      Number.isFinite(upper) &&
      lower >= 0 &&
      upper <= 1 &&
      lower < upper
    ? { lower, upper }
    : { lower: 0, upper: 1 };
}

function calibrationAxisPercent(value) {
  const percentage = value * 100;
  return `${Math.abs(percentage - Math.round(percentage)) < 1e-9
    ? Math.round(percentage)
    : percentage.toFixed(1)}%`;
}

function renderCalibrationRange(calibration = null) {
  const profile = calibration?.distribution_summary;
  const range = calibrationDisplayRange(calibration);
  calibrationAxisLower.textContent = calibrationAxisPercent(range.lower);
  calibrationAxisUpper.textContent = calibrationAxisPercent(range.upper);
  if (!Number.isFinite(profile?.mean_probability)) {
    calibrationRangeNote.textContent = calibration
      ? tr(
        "当前时间窗没有可用的分布档案，图表暂按完整 0%–100% 范围显示。",
        "No distribution profile is available for this window, so the chart temporarily uses the full 0%–100% range.",
      )
      : tr(
        "加载分布档案后，图表会保留均值 ±4σ，并从画面中裁掉区间外的离群窗口。",
        "After the distribution profile loads, the chart keeps mean ±4σ and clips outlying windows outside that range.",
      );
    return;
  }
  const clippedBelow = profile.display_range.clipped_below;
  const clippedAbove = profile.display_range.clipped_above;
  const clippedTotal = clippedBelow + clippedAbove;
  const rangeText = `${calibrationAxisPercent(range.lower)}–${calibrationAxisPercent(range.upper)}`;
  calibrationRangeNote.textContent = clippedTotal > 0
    ? tr(
      `显示均值 ±4σ（${rangeText}）；已从图像裁掉 ${clippedTotal} 个区间外离群窗口（低端 ${clippedBelow} / 高端 ${clippedAbove}）。`,
      `Showing mean ±4σ (${rangeText}); ${clippedTotal} outlying windows were clipped from the chart (${clippedBelow} low / ${clippedAbove} high).`,
    )
    : tr(
      `显示均值 ±4σ（${rangeText}）；当前没有区间外离群窗口需要裁掉。`,
      `Showing mean ±4σ (${rangeText}); no outlying windows currently need clipping.`,
    );
}

function clearCalibrationRefreshState() {
  delete calibrationPlot.dataset.refreshState;
  calibrationPlot.removeAttribute("aria-busy");
}

function setCalibrationRefreshState(targetHours, phase = "updating", detail = "") {
  if (!notificationCalibration || calibrationPlot.dataset.state !== "ready") {
    return false;
  }
  const displayedHours = notificationCalibration.horizon_hours;
  calibrationPlot.dataset.refreshState = phase;
  if (phase === "error") calibrationPlot.removeAttribute("aria-busy");
  else calibrationPlot.setAttribute("aria-busy", "true");
  setCalibrationSvgHidden(calibrationMarker, true);
  calibrationTooltip.hidden = true;

  const displayed = formatNotificationHorizon(displayedHours);
  const target = formatNotificationHorizon(targetHours);
  if (phase === "warming") {
    calibrationSample.textContent = tr(
      `仍显示 ${displayed} · ${target} 后台预热中`,
      `Still showing ${displayed} · ${target} warming in background`,
    );
    calibrationSummary.textContent = tr(
      "目标时间窗的历史档案仍在后台生成；完成前保留当前图表。",
      "The target window's historical profile is still being generated; the current chart remains until it is ready.",
    );
  } else if (phase === "error") {
    calibrationSample.textContent = tr(
      `${target} 加载失败 · 仍显示 ${displayed}`,
      `${target} failed to load · Still showing ${displayed}`,
    );
    calibrationSummary.textContent = tr(
      `目标时间窗暂时加载失败${detail ? `：${detail}` : ""}；当前图表未被替换。`,
      `The target window temporarily failed to load${detail ? `: ${detail}` : ""}; the current chart was not replaced.`,
    );
  } else if (displayedHours === targetHours) {
    calibrationSample.textContent = tr(
      `仍显示 ${displayed} · 正在刷新`,
      `Still showing ${displayed} · Refreshing`,
    );
    calibrationSummary.textContent = tr(
      "正在刷新当前时间窗；旧图会保留到新数据就绪。",
      "Refreshing the current window; the old chart remains until new data is ready.",
    );
  } else {
    calibrationSample.textContent = tr(
      `仍显示 ${displayed} · 正在切换到 ${target}`,
      `Still showing ${displayed} · Switching to ${target}`,
    );
    calibrationSummary.textContent = tr(
      "正在读取目标时间窗；旧图仅作暂时参考，新数据就绪后会一次替换。",
      "Loading the target window; the old chart is temporary and will be replaced when new data is ready.",
    );
  }
  return true;
}

function setCalibrationState(
  state,
  message,
  sampleText = tr("等待历史数据", "Waiting for history"),
) {
  clearCalibrationRefreshState();
  calibrationPlot.dataset.state = state;
  calibrationState.textContent = message;
  calibrationSample.textContent = sampleText;
  if (state !== "ready") {
    clearCalibrationGraphic();
    renderCalibrationRange();
  }
}

function calibrationCoordinates(calibration) {
  const range = calibrationDisplayRange(calibration);
  const points = calibration.points.filter((point) =>
    point.probability >= range.lower - 1e-12 &&
    point.probability <= range.upper + 1e-12
  );
  const maximumDensity = Math.max(...points.map((point) => point.density), 0);
  if (!(maximumDensity > 0)) return [];
  return points.map((point) => ({
    ...point,
    x: 20 + ((point.probability - range.lower) /
      (range.upper - range.lower)) * 560,
    y: 165 - (point.density / maximumDensity) * 132,
  }));
}

function applySuggestedNotificationThreshold(calibration) {
  const suggested = calibration?.distribution_summary
    ?.suggested_threshold?.probability;
  if (!notificationThresholdPristine || !Number.isFinite(suggested)) {
    return false;
  }
  const percentage = Math.min(99, Math.max(1, Math.round(suggested * 100)));
  notificationThreshold.value = String(percentage);
  notificationThresholdHasProfileSuggestion = true;
  renderNotificationValues();
  return true;
}

function renderCalibrationGraphic(calibration) {
  renderCalibrationRange(calibration);
  const coordinates = calibrationCoordinates(calibration);
  if (coordinates.length < 2) {
    setCalibrationState(
      "insufficient",
      tr(
        "当前时间窗的历史样本不足，无法判断门槛可靠度。",
        "This window has too little history to assess threshold reliability.",
      ),
      tr(
        `${calibration.sample_count} 个窗口 · ${calibration.event_count} 次重置`,
        `${calibration.sample_count} windows · ${calibration.event_count} resets`,
      ),
    );
    renderCalibrationRange(calibration);
    calibrationSummary.textContent = tr(
      "样本不足，当前不能判断哪个概率门槛更可靠。",
      "There is not enough data to determine which probability threshold is more reliable.",
    );
    return;
  }
  const line = coordinates
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const first = coordinates[0];
  const last = coordinates.at(-1);
  calibrationCurve.setAttribute("d", line);
  calibrationArea.setAttribute(
    "d",
    `M ${first.x.toFixed(2)} 165 ${line.replace(/^M/, "L")} L ${last.x.toFixed(2)} 165 Z`,
  );
  calibrationPlot.dataset.state = "ready";
  calibrationState.textContent = "";
  calibrationSample.textContent = calibration.status === "preliminary"
    ? tr(
      `初步 · ${calibration.sample_count}/${calibration.min_sample_count} 窗口 · ${calibration.event_count}/${calibration.min_event_count} 次重置`,
      `Preliminary · ${calibration.sample_count}/${calibration.min_sample_count} windows · ${calibration.event_count}/${calibration.min_event_count} resets`,
    )
    : tr(
      `${calibration.sample_count} 窗口 / ${calibration.event_count} 次重置`,
      `${calibration.sample_count} windows / ${calibration.event_count} resets`,
    );
  showCalibrationPoint((Number(notificationThreshold.value) || 0) / 100);
}

function calibrationCopy(point, threshold) {
  const selectedThreshold = point?.probability ?? threshold;
  const thresholdText = `${Math.round(selectedThreshold * 100)}%`;
  const pointGate = point?.point_sample_gate;
  if (
    !point ||
    pointGate?.passed !== true ||
    !Number.isFinite(point.confidence_above)
  ) {
    const evaluated = Number.isFinite(pointGate?.evaluated_windows)
      ? pointGate.evaluated_windows
      : point?.sample_count_above ?? 0;
    const minimum = Number.isFinite(pointGate?.minimum_windows)
      ? pointGate.minimum_windows
      : 20;
    return {
      detail: tr(
        `概率 > ${thresholdText} · 样本 ${evaluated}/${minimum}`,
        `Probability > ${thresholdText} · Samples ${evaluated}/${minimum}`,
      ),
      summary: tr(
        "该真实 1% 门槛点尚未通过样本门槛，暂不显示历史命中率。",
        "This exact 1% threshold point has not passed the sample gate, so historical hit rate is not shown.",
      ),
    };
  }
  const hitRate = percent(point.confidence_above);
  const samples = Number.isFinite(point.sample_count_above)
    ? tr(
      `${point.sample_count_above} 个门槛以上样本`,
      `${point.sample_count_above} samples above threshold`,
    )
    : tr("样本量未提供", "Sample count unavailable");
  const prefix = notificationCalibration?.status === "preliminary"
    ? tr("初步历史命中率", "Preliminary historical hit rate")
    : tr("历史命中率", "Historical hit rate");
  const interval = point.confidence_interval;
  const intervalText = interval &&
      Number.isFinite(interval.lower) &&
      Number.isFinite(interval.upper)
    ? tr(
      ` · 95% Wilson 区间 ${percent(interval.lower)}–${percent(interval.upper)}`,
      ` · 95% Wilson interval ${percent(interval.lower)}–${percent(interval.upper)}`,
    )
    : "";
  return {
    detail: tr(
      `概率 > ${thresholdText} · ${prefix} ${hitRate}${intervalText}`,
      `Probability > ${thresholdText} · ${prefix} ${hitRate}${intervalText}`,
    ),
    summary: tr(
      `${prefix} ${hitRate}${intervalText}，基于${samples}；仅用于辅助选择门槛。`,
      `${prefix} ${hitRate}${intervalText}, based on ${samples}; use only as an aid when choosing a threshold.`,
    ),
  };
}

function showCalibrationThresholdPin(threshold, range, x = null) {
  const below = threshold < range.lower - 1e-12;
  const above = threshold > range.upper + 1e-12;
  const outside = below || above;
  const pinX = outside
    ? below ? 20 : 580
    : x ?? 20 + ((threshold - range.lower) / (range.upper - range.lower)) * 560;
  calibrationThresholdPin.style.left = `${(pinX / 600) * 100}%`;
  calibrationThresholdPin.textContent = outside
    ? tr(
      `触发阈值 · ${calibrationAxisPercent(threshold)} · 图外`,
      `Trigger · ${calibrationAxisPercent(threshold)} · Outside chart`,
    )
    : tr(
      `触发阈值 · ${calibrationAxisPercent(threshold)}`,
      `Trigger · ${calibrationAxisPercent(threshold)}`,
    );
  calibrationThresholdPin.hidden = false;
  if (outside) {
    calibrationThresholdPin.dataset.outside = "true";
    calibrationThresholdPin.dataset.side = below ? "lower" : "upper";
  } else {
    delete calibrationThresholdPin.dataset.outside;
    delete calibrationThresholdPin.dataset.side;
  }
}

function showCalibrationThresholdRange(x, { outside = false } = {}) {
  const boundedX = Math.min(580, Math.max(20, Number(x) || 20));
  calibrationThresholdRange.setAttribute("width", (boundedX - 20).toFixed(2));
  setCalibrationSvgHidden(calibrationThresholdRange, false);
  if (outside) calibrationThresholdRange.dataset.outside = "true";
  else delete calibrationThresholdRange.dataset.outside;
}

function showCalibrationPoint(threshold) {
  if (
    !notificationProbabilityTopic.checked ||
    !notificationCalibration ||
    calibrationPlot.dataset.state !== "ready" ||
    calibrationPlot.dataset.refreshState ||
    notificationCalibration.horizon_hours !== horizonHours()
  ) return;
  const selectedThreshold = Math.min(1, Math.max(0, Number(threshold) || 0));
  const range = calibrationDisplayRange(notificationCalibration);
  if (
    selectedThreshold < range.lower - 1e-12 ||
    selectedThreshold > range.upper + 1e-12
  ) {
    const boundaryX = selectedThreshold < range.lower ? 20 : 580;
    calibrationCrosshair.setAttribute("x1", boundaryX.toFixed(2));
    calibrationCrosshair.setAttribute("x2", boundaryX.toFixed(2));
    calibrationCrosshair.dataset.outside = "true";
    setCalibrationSvgHidden(calibrationCrosshair, false);
    setCalibrationSvgHidden(calibrationMarker, true);
    calibrationTooltip.hidden = true;
    showCalibrationThresholdRange(boundaryX, { outside: true });
    showCalibrationThresholdPin(selectedThreshold, range);
    calibrationSummary.textContent = tr(
      `当前门槛 ${calibrationAxisPercent(selectedThreshold)} 位于图表显示区间 ` +
        `${calibrationAxisPercent(range.lower)}–${calibrationAxisPercent(range.upper)} 之外；` +
        `通知仍按 ${calibrationAxisPercent(selectedThreshold)} 触发。`,
      `The current ${calibrationAxisPercent(selectedThreshold)} threshold is outside the chart's ` +
        `${calibrationAxisPercent(range.lower)}–${calibrationAxisPercent(range.upper)} display range; ` +
        `notifications still trigger at ${calibrationAxisPercent(selectedThreshold)}.`,
    );
    return;
  }
  const coordinates = calibrationCoordinates(notificationCalibration);
  const point = calibrationAt(coordinates, selectedThreshold);
  if (!point) return;
  const x = point.x;
  const y = point.y;
  delete calibrationCrosshair.dataset.outside;
  showCalibrationThresholdRange(x);
  showCalibrationThresholdPin(selectedThreshold, range, x);
  calibrationCrosshair.setAttribute("x1", x.toFixed(2));
  calibrationCrosshair.setAttribute("x2", x.toFixed(2));
  setCalibrationSvgHidden(calibrationCrosshair, false);
  calibrationMarker.setAttribute("cx", x.toFixed(2));
  calibrationMarker.setAttribute("cy", y.toFixed(2));
  setCalibrationSvgHidden(calibrationMarker, false);
  const copy = calibrationCopy(point, point.probability);
  calibrationTooltip.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = copy.detail;
  const sample = document.createElement("span");
  sample.textContent = Number.isFinite(point.sample_count_above)
    ? tr(
      `${point.sample_count_above} 个门槛以上样本`,
      `${point.sample_count_above} samples above threshold`,
    )
    : tr("样本量暂不可用", "Sample count temporarily unavailable");
  calibrationTooltip.append(title, sample);
  calibrationTooltip.style.left = `${(x / 600) * 100}%`;
  calibrationTooltip.style.top = `${Math.max(34, (y / 190) * 174)}px`;
  calibrationTooltip.hidden = false;
  calibrationSummary.textContent = copy.summary;
}

function calibrationThresholdForEvent(event) {
  if (
    !notificationProbabilityTopic.checked ||
    notificationThreshold.disabled ||
    !notificationCalibration ||
    calibrationPlot.dataset.state !== "ready" ||
    calibrationPlot.dataset.refreshState ||
    notificationCalibration.horizon_hours !== horizonHours()
  ) {
    return null;
  }
  const bounds = calibrationHitArea.getBoundingClientRect();
  if (!(bounds.width > 0)) return null;
  const ratio = Math.min(
    1,
    Math.max(0, (event.clientX - bounds.left) / bounds.width),
  );
  const range = calibrationDisplayRange(notificationCalibration);
  return range.lower + ratio * (range.upper - range.lower);
}

function updateThresholdFromCalibrationEvent(event) {
  const selected = calibrationThresholdForEvent(event);
  if (selected === null) return false;
  const point = calibrationAt(
    calibrationCoordinates(notificationCalibration),
    selected,
  );
  const threshold = Math.min(0.99, Math.max(0.01, point?.probability ?? selected));
  notificationThresholdPristine = false;
  notificationThreshold.value = String(Math.round(threshold * 100));
  renderNotificationValues();
  showCalibrationPoint((Number(notificationThreshold.value) || 0) / 100);
  return true;
}

function stopCalibrationThresholdDrag() {
  if (
    calibrationThresholdPointerId !== null &&
    calibrationHitArea.hasPointerCapture?.(calibrationThresholdPointerId)
  ) {
    calibrationHitArea.releasePointerCapture?.(calibrationThresholdPointerId);
  }
  calibrationThresholdDragging = false;
  calibrationThresholdPointerId = null;
}

function renderNotificationCalibration(calibration) {
  clearCalibrationRefreshState();
  notificationCalibration = calibration;
  applySuggestedNotificationThreshold(calibration);
  if (calibration.status === "insufficient") {
    setCalibrationState(
      "insufficient",
      tr(
        "当前时间窗的历史样本不足，无法判断哪个概率门槛更可靠。",
        "This window has too little history to determine which probability threshold is more reliable.",
      ),
      tr(
        `${calibration.sample_count} 窗口 / ${calibration.event_count} 次重置`,
        `${calibration.sample_count} windows / ${calibration.event_count} resets`,
      ),
    );
    renderCalibrationRange(calibration);
    calibrationSummary.textContent = tr(
      "样本不足，当前不可判断历史命中率。",
      "There is not enough data to assess historical hit rate.",
    );
    return;
  }
  renderCalibrationGraphic(calibration);
}

function notificationCalibrationMatchesSelection(hours, generation) {
  return notificationDialog.open &&
    notificationProbabilityTopic.checked &&
    generation === notificationCalibrationGeneration &&
    horizonHours() === hours;
}

function requestNotificationCalibration(hours) {
  const inFlight = notificationCalibrationRequests.get(hours);
  if (inFlight) return inFlight.promise;

  const controller = new AbortController();
  const request = { controller, promise: null };
  notificationCalibrationRequests.set(hours, request);
  request.promise = (async () => {
    let timedOut = false;
    try {
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
      const response = await fetch(
        `/api/notification-preferences/calibration?horizon_hours=${hours}&view=compact`,
        {
          cache: "default",
          signal: controller.signal,
        },
      ).finally(() => clearTimeout(timeout));
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(
          payload?.message ?? payload?.error ?? `HTTP ${response.status}`,
        );
        error.code = payload?.error ?? null;
        const retryAfterSeconds = Number(
          response.headers?.get?.("retry-after"),
        );
        if (
          response.status === 503 &&
          Number.isFinite(retryAfterSeconds) &&
          retryAfterSeconds > 0
        ) {
          error.retryAfterMs = Math.min(
            10_000,
            Math.max(1_000, retryAfterSeconds * 1_000),
          );
        }
        throw error;
      }
      const calibration = normalizeCalibrationPayload(payload, hours);
      // Cache by the response's exact horizon even when the user has moved on
      // or closed the dialog. A later visit can then render immediately.
      notificationCalibrationCache.set(hours, calibration);
      return calibration;
    } catch (error) {
      if (timedOut) throw new Error(tr("请求超时", "Request timed out"));
      throw error;
    } finally {
      if (notificationCalibrationRequests.get(hours) === request) {
        notificationCalibrationRequests.delete(hours);
      }
    }
  })();
  return request.promise;
}

async function loadNotificationCalibration(
  hours = horizonHours(),
  generation = notificationCalibrationGeneration,
  { warmRetry = 0 } = {},
) {
  if (!notificationCalibrationMatchesSelection(hours, generation)) return null;
  const cached = notificationCalibrationCache.get(hours);
  if (cached) {
    renderNotificationCalibration(cached);
    return cached;
  }
  if (!setCalibrationRefreshState(hours)) {
    notificationCalibration = null;
    setCalibrationState(
      "loading",
      tr("正在读取该时间窗的历史预测与重置记录…", "Loading historical forecasts and reset records for this window…"),
    );
    calibrationSummary.textContent = tr(
      "历史可靠度仅用于辅助选择门槛，不是模型置信度。",
      "Historical reliability helps choose a threshold; it is not model confidence.",
    );
  }
  try {
    const calibration = await requestNotificationCalibration(hours);
    if (!notificationCalibrationMatchesSelection(hours, generation)) return null;
    renderNotificationCalibration(calibration);
    return calibration;
  } catch (error) {
    if (!notificationCalibrationMatchesSelection(hours, generation)) return null;
    if (
      notificationDialog.open &&
      notificationProbabilityTopic.checked &&
      Number.isFinite(error.retryAfterMs) &&
      warmRetry < 24
    ) {
      if (!setCalibrationRefreshState(hours, "warming")) {
        setCalibrationState(
          "loading",
          tr("历史可靠度正在后台预热，完成后会自动显示…", "Historical reliability is warming in the background and will appear automatically…"),
          tr("后台预热中", "Warming in background"),
        );
        calibrationSummary.textContent = tr(
          "首次冷启动不会阻塞页面；正在等待后台历史档案。",
          "The initial cold start does not block the page; waiting for the background history profile.",
        );
      }
      notificationCalibrationTimer = setTimeout(() => {
        notificationCalibrationTimer = null;
        if (!notificationCalibrationMatchesSelection(hours, generation)) return;
        void loadNotificationCalibration(hours, generation, {
          warmRetry: warmRetry + 1,
        });
      }, error.retryAfterMs);
      return null;
    }
    if (!setCalibrationRefreshState(hours, "error", error.message)) {
      setCalibrationState(
        "error",
        tr(
          `历史可靠度暂时加载失败：${error.message}`,
          `Historical reliability temporarily failed to load: ${error.message}`,
        ),
        tr("加载失败", "Load failed"),
      );
      calibrationSummary.textContent = tr(
        "无法读取历史记录，仍可手动设置通知门槛。",
        "History could not be read, but you can still set a notification threshold manually.",
      );
    }
    return null;
  }
}

function scheduleNotificationCalibration({ immediate = false } = {}) {
  if (!notificationDialog.open || !notificationProbabilityTopic.checked) return;
  clearTimeout(notificationCalibrationTimer);
  notificationCalibrationTimer = null;
  const hours = horizonHours();
  const generation = ++notificationCalibrationGeneration;
  const cached = notificationCalibrationCache.get(hours);
  if (cached) {
    renderNotificationCalibration(cached);
    return;
  }
  if (!setCalibrationRefreshState(hours)) {
    notificationCalibration = null;
    setCalibrationState(
      "loading",
      immediate
        ? tr("正在读取该时间窗的历史预测与重置记录…", "Loading historical forecasts and reset records for this window…")
        : tr("选择停稳后加载该时间窗的历史记录…", "History for this window loads after the selection settles…"),
    );
    calibrationSummary.textContent = tr(
      "历史可靠度仅用于辅助选择门槛，不是模型置信度。",
      "Historical reliability helps choose a threshold; it is not model confidence.",
    );
  }
  if (immediate) {
    void loadNotificationCalibration(hours, generation);
    return;
  }
  notificationCalibrationTimer = setTimeout(
    () => {
      notificationCalibrationTimer = null;
      if (!notificationCalibrationMatchesSelection(hours, generation)) return;
      void loadNotificationCalibration(hours, generation);
    },
    220,
  );
}

function syncProbabilityRuleControls() {
  const enabled = notificationProbabilityTopic.checked;
  notificationProbabilityTopic.setAttribute("aria-expanded", String(enabled));
  notificationProbabilityRule.hidden = !enabled;
  notificationProbabilityRule.inert = !enabled;
  notificationProbabilityRule.dataset.enabled = String(enabled);
  if (enabled) notificationProbabilityRule.removeAttribute("inert");
  else notificationProbabilityRule.setAttribute("inert", "");
  notificationHorizon.disabled = notificationControlsBusy || !enabled;
  notificationThreshold.disabled = notificationControlsBusy || !enabled;
}

function cancelProbabilityRuleWork() {
  clearTimeout(notificationCalibrationTimer);
  notificationCalibrationTimer = null;
  notificationCalibrationGeneration += 1;
  stopCalibrationThresholdDrag();
  notificationFeedBaselineRequest?.abort();
  notificationFeedBaselineCursor = null;
  personalizedFeedStatus.textContent = "";
  renderNotificationValues();
}

function updateProbabilityRule() {
  notificationProbabilityRule.dataset.pushEnabled = String(
    notificationProbabilityTopic.checked,
  );
  syncProbabilityRuleControls();
  if (!notificationProbabilityTopic.checked) {
    cancelProbabilityRuleWork();
    return;
  }
  if (notificationDialog.open) {
    void refreshPersonalizedFeedBaseline();
    scheduleNotificationCalibration();
  }
}

async function webPushJson(url, { method = "GET", body = null } = {}) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function setNotificationBusy(busy) {
  notificationControlsBusy = busy;
  notificationEnable.disabled = busy;
  notificationDisable.disabled = busy;
  notificationCancel.disabled = busy;
  syncProbabilityRuleControls();
  for (const selector of [
    "#notification-topic-authority",
    "#notification-topic-outcome",
    "#notification-topic-probability",
  ]) {
    const input = document.querySelector(selector);
    if (input) input.disabled = busy;
  }
}

async function refreshNotificationControls(message = null) {
  const subscription = await notificationRegistration.pushManager.getSubscription();
  notificationEnable.textContent = subscription
    ? tr("保存通知设置", "Save notification settings")
    : tr("启用通知", "Enable notifications");
  notificationDisable.hidden = !subscription;
  notificationStatus.textContent = message ?? (subscription
    ? tr("此浏览器已订阅通知。", "This browser is subscribed to notifications.")
    : Notification.permission === "denied"
      ? tr("浏览器已阻止通知，请在站点设置中重新允许。", "The browser blocked notifications. Allow them again in site settings.")
      : tr("通知权限只会在点击保存后询问。", "Notification permission is requested only after you click save."));
}

async function enableWebPush() {
  setNotificationBusy(true);
  try {
    const topics = selectedNotificationTopics();
    if (topics.length === 0) {
      throw new Error(tr("请至少选择一种通知主题。", "Choose at least one notification topic."));
    }
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error(tr("未获得浏览器通知权限。", "Browser notification permission was not granted."));
    }
    let subscription = await notificationRegistration.pushManager.getSubscription();
    let created = false;
    if (!subscription) {
      subscription = await notificationRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(
          notificationPublicConfig.application_server_key,
        ),
      });
      created = true;
    }
    const serialized = subscription.toJSON();
    const preferences = selectedNotificationPreferences();
    // Freeze the user's submitted choice before yielding to the network. A
    // late calibration response must not rewrite either the request or the
    // local mirror while this save is in flight.
    notificationThresholdPristine = false;
    try {
      await webPushJson("/api/web-push/subscriptions", {
        method: "POST",
        body: { ...serialized, topics, preferences },
      });
    } catch (error) {
      if (created) await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    saveLocalNotificationPreferences({ topics, preferences });
    await refreshNotificationControls(
      tr(
        "通知设置已保存；个性化规则会从现在开始应用。",
        "Notification settings were saved; the personalized rule applies from now on.",
      ),
    );
  } catch (error) {
    notificationStatus.textContent = tr(
      `通知未启用：${error.message}`,
      `Notifications were not enabled: ${error.message}`,
    );
  } finally {
    setNotificationBusy(false);
  }
}

async function disableWebPush() {
  setNotificationBusy(true);
  try {
    const subscription = await notificationRegistration.pushManager.getSubscription();
    if (subscription) {
      await webPushJson("/api/web-push/subscriptions", {
        method: "DELETE",
        body: { endpoint: subscription.endpoint },
      });
      await subscription.unsubscribe();
    }
    notificationStatus.textContent = tr("此浏览器的通知已关闭。", "Notifications are off in this browser.");
    await refreshNotificationControls();
  } catch (error) {
    notificationStatus.textContent = tr(
      `关闭通知失败：${error.message}`,
      `Failed to turn off notifications: ${error.message}`,
    );
  } finally {
    setNotificationBusy(false);
  }
}

async function initializeWebPushControls() {
  if (!notificationDialog) return;
  const restoredLocalPreferences = restoreLocalNotificationPreferences();
  renderHorizonTicks();
  renderNotificationValues();
  updateProbabilityRule();
  if (!supportsWebPush()) {
    notificationEnable.disabled = true;
    notificationStatus.textContent = tr(
      "此浏览器不支持 Web Push；仍可使用下方 Atom 订阅。",
      "This browser does not support Web Push; you can still use the Atom feeds below.",
    );
    return;
  }
  try {
    const config = await webPushJson("/api/web-push/config");
    if (!restoredLocalPreferences) applyPublicNotificationDefaults(config);
    renderNotificationValues();
    if (!config?.enabled || !config.application_server_key) {
      notificationEnable.disabled = true;
      notificationStatus.textContent = tr(
        "浏览器通知暂未开放；仍可查看规则或使用 Atom 订阅。",
        "Browser notifications are not available yet; you can still review the rule or use Atom.",
      );
      return;
    }
    notificationPublicConfig = config;
    notificationRegistration = await navigator.serviceWorker.register(
      "/sw.js?v=web-push-1",
      { scope: "/" },
    );
    await refreshNotificationControls();
  } catch (error) {
    notificationEnable.disabled = true;
    notificationStatus.textContent = tr(
      "浏览器通知配置暂时不可用；请稍后重试。",
      "Browser notification configuration is temporarily unavailable. Please try again later.",
    );
    console.warn("Web push is unavailable", error);
  }
}

function openNotificationDialog() {
  notificationDialogTrigger = document.activeElement;
  if (typeof notificationDialog.showModal === "function") {
    notificationDialog.showModal();
  } else {
    notificationDialog.setAttribute("open", "");
  }
  document.body.classList.add("subscription-dialog-open");
  updateProbabilityRule();
}

function closeNotificationDialog() {
  if (typeof notificationDialog.close === "function") notificationDialog.close();
  else notificationDialog.removeAttribute("open");
  document.body.classList.remove("subscription-dialog-open");
  clearTimeout(notificationCalibrationTimer);
  notificationCalibrationTimer = null;
  notificationCalibrationGeneration += 1;
  stopCalibrationThresholdDrag();
  notificationFeedBaselineRequest?.abort();
  notificationDialogTrigger?.focus?.();
  notificationDialogTrigger = null;
}

notificationOpen?.addEventListener("click", openNotificationDialog);
notificationClose?.addEventListener("click", closeNotificationDialog);
notificationCancel?.addEventListener("click", closeNotificationDialog);
notificationDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeNotificationDialog();
});
notificationDialog?.addEventListener("click", (event) => {
  if (event.target === notificationDialog) closeNotificationDialog();
});
notificationDialog?.addEventListener("close", () => {
  document.body.classList.remove("subscription-dialog-open");
});
notificationProbabilityTopic?.addEventListener("change", updateProbabilityRule);
notificationHorizon?.addEventListener("input", () => {
  renderNotificationValues();
  scheduleNotificationCalibration();
});
notificationHorizon?.addEventListener("change", () => {
  renderNotificationValues();
  scheduleNotificationCalibration({ immediate: true });
});
notificationThreshold?.addEventListener("input", () => {
  notificationThresholdPristine = false;
  renderNotificationValues();
  showCalibrationPoint((Number(notificationThreshold.value) || 0) / 100);
});
calibrationHitArea?.addEventListener("pointermove", (event) => {
  if (!calibrationThresholdDragging) return;
  if (
    calibrationThresholdPointerId !== null &&
    event.pointerId !== calibrationThresholdPointerId
  ) return;
  updateThresholdFromCalibrationEvent(event);
});
calibrationHitArea?.addEventListener("pointerdown", (event) => {
  if (!updateThresholdFromCalibrationEvent(event)) return;
  event.preventDefault?.();
  notificationThreshold.focus?.({ preventScroll: true });
  calibrationThresholdDragging = true;
  calibrationThresholdPointerId = Number.isFinite(event.pointerId)
    ? event.pointerId
    : null;
  if (calibrationThresholdPointerId !== null) {
    calibrationHitArea.setPointerCapture?.(calibrationThresholdPointerId);
  }
});
calibrationHitArea?.addEventListener("pointerup", (event) => {
  if (!calibrationThresholdDragging) return;
  if (
    calibrationThresholdPointerId !== null &&
    event.pointerId !== calibrationThresholdPointerId
  ) return;
  updateThresholdFromCalibrationEvent(event);
  stopCalibrationThresholdDrag();
});
calibrationHitArea?.addEventListener("pointercancel", () => {
  stopCalibrationThresholdDrag();
});
personalizedFeedCopy?.addEventListener("click", async () => {
  if (!Number.isSafeInteger(notificationFeedBaselineCursor)) {
    personalizedFeedStatus.textContent = tr(
      "尚未建立安全基线，当前没有可复制的链接。",
      "A safe baseline has not been established, so there is no link to copy yet.",
    );
    return;
  }
  try {
    await navigator.clipboard.writeText(personalizedFeedUrl.value);
    personalizedFeedStatus.textContent = tr("个性化订阅链接已复制。", "Personalized subscription link copied.");
  } catch {
    personalizedFeedUrl.focus();
    personalizedFeedUrl.select();
    personalizedFeedStatus.textContent = tr(
      "无法自动复制，链接已选中，请手动复制。",
      "Automatic copy failed. The link is selected; copy it manually.",
    );
  }
});
notificationEnable?.addEventListener("click", () => void enableWebPush());
notificationDisable?.addEventListener("click", () => void disableWebPush());

void initializeWebPushControls();

void load();
