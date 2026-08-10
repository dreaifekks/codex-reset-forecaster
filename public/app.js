import {
  NOTIFICATION_HORIZON_HOURS,
  calibrationAt,
  createNotificationCalibrationCache,
  formatNotificationHorizon,
  nearestHorizonIndex,
  normalizeCalibrationPayload,
} from "./notification-preferences.js";

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
  competitor_model_release: "竞争模型发布",
  experience_issue: "体验问题",
  experience_recovery: "体验恢复",
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
  community: "用户报告",
  aggregator: "聚合摘要",
  media: "媒体",
  unknown: "角色未知",
};

const impactSeverityLabels = {
  critical: "严重级 · S1",
  high: "严重级 · S2",
  medium: "严重级 · S3",
  low: "严重级 · S4",
  unknown: "严重级待确认",
};

const timelineRelevanceLabels = {
  relevant: "相关信号",
  irrelevant: "已筛除",
  pending_context: "等待上下文",
  unclassified: "未形成信号",
};

const episodeStateLabels = {
  active: "持续中",
  investigating: "调查中",
  mitigating: "缓解中",
  resolved: "已缓解",
  reopened: "再次出现",
  unknown: "状态待确认",
};

const episodeTrendLabels = {
  rising: "升温",
  stable: "持平",
  falling: "降温",
  resolved: "已解决",
  unknown: "趋势待确认",
};

const impactCategoryLabels = {
  availability: "可用性",
  performance: "性能",
  correctness: "正确性",
  tool_execution: "工具执行",
  session_state: "会话状态",
  quota_accounting: "额度计量",
  auth: "认证",
  client_ux: "客户端体验",
  security_privacy: "安全与隐私",
  data_integrity: "数据完整性",
  compatibility: "兼容性",
  other: "其他问题",
};

const impactScopeLabels = {
  individual: "单个用户",
  multiple_users: "多个用户",
  platform: "平台范围",
  unknown: "范围待确认",
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
    `该小时发生首次重置的概率：${percent(slot.first_reset_probability, 2)}`,
    `从现在到该小时结束的累计重置概率：${percent(cumulativeProbability, 2)}`,
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
  detail.innerHTML = `<strong>${escapeHtml(percent(slot.first_reset_probability, 2))}</strong><div><time>${escapeHtml(formatSlotRange(slot))}</time><span>该小时发生首次重置的概率：${escapeHtml(percent(slot.first_reset_probability, 2))}</span><span>从现在到该小时结束的累计重置概率：${escapeHtml(percent(cumulativeProbability, 2))}</span></div>`;
}

function showSelectedSlotDetail(slot, cumulativeProbability) {
  const detail = document.querySelector("#heat-detail");
  detail.dataset.mode = "cumulative";
  detail.innerHTML = `<strong>${escapeHtml(percent(cumulativeProbability, 2))}</strong><div><time>${escapeHtml(formatSlotRange(slot))} · 已选累计区间</time><span>所选结束小时的首次重置概率：${escapeHtml(percent(slot.first_reset_probability, 2))}</span><span>从现在到所选小时结束的累计重置概率：${escapeHtml(percent(cumulativeProbability, 2))}</span></div>`;
}

function resetSlotDetail() {
  const detail = document.querySelector("#heat-detail");
  detail.dataset.mode = "empty";
  detail.innerHTML =
    "<strong>—</strong><div><time>悬停格子查看该小时，点击可固定累计区间</time><span>该小时发生首次重置的概率：—</span><span>从现在到该小时结束的累计重置概率：—</span></div>";
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
  const dayMessage =
    `未来${dayNames[dayIndex]}天内重置概率：${percent(dayProbability, 1)}`;
  label.setAttribute(
    "aria-label",
    `${dateFormatter.format(new Date(slots[0].start))}，${dayMessage}`,
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
  target.setAttribute("aria-label", "从预测起点开始的 168 个连续小时");
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
    const impact = item.impact?.severity
      ? `<span class="signal-badge severity-${escapeHtml(item.impact.severity)}">${escapeHtml(
          impactSeverityLabels[item.impact.severity] ?? "严重级待确认",
        )}</span>`
      : "";
    const competitionStage = item.competitive_context?.stage
      ? `<span class="signal-badge secondary">${escapeHtml(
          item.competitive_context.stage === "rolled_out"
            ? "已发布"
            : item.competitive_context.stage === "general_availability"
              ? "正式可用"
              : item.competitive_context.stage === "preview"
                ? "预览"
                : item.competitive_context.stage === "rumor"
                  ? "传闻"
                  : "已宣布",
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
      `查看 ${sourceDisplayName} ${formatCompactTime(signalTime)} 的${eventType}完整动态`,
    );
    preview.title = "点击查看完整内容";
    preview.innerHTML = `<span class="signal-head"><span class="signal-badges"><span class="signal-badge">${escapeHtml(eventType)}</span><span class="signal-badge secondary">${escapeHtml(role)}</span>${impact}${competitionStage}${pending}</span><time title="系统首次获取并可用于分析的时间：${escapeHtml(formatCompactTime(item.available_at))}">${escapeHtml(formatCompactTime(signalTime))}</time></span><span class="signal-card-text">${escapeHtml(source?.text ?? "暂无原始文本")}</span>`;
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

function renderTimeline(items) {
  const targetSelector = "#tibo-timeline-list";
  const target = document.querySelector(targetSelector);
  target.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    setListMessage(targetSelector, "暂无可展示的 Tibo 精确动态");
    return;
  }
  for (const item of items.slice(0, 12)) {
    const row = document.createElement("li");
    row.className = "timeline-item";
    const sourceUrl = safeExternalUrl(item.canonical_url);
    const eventType = item.event_type
      ? eventTypeLabels[item.event_type] ?? item.event_type
      : "未匹配信号";
    const relevance = timelineRelevanceLabels[item.relevance] ??
      item.relevance ??
      "状态未知";
    const featureStatus = item.quarantined_relation
      ? "已安全隔离"
      : item.matched_signal
        ? item.forecast_feature_eligible
          ? "可进入预测特征"
          : "仅展示"
        : "未抽取";
    const publishedAt = item.published_at ?? item.first_seen_at;
    const firstSeenTitle = item.first_seen_at
      ? `系统首次获取：${formatCompactTime(item.first_seen_at)}`
      : "首次获取时间不可用";
    row.innerHTML = `
      <div class="signal-head">
        <span class="signal-badges">
          <span class="signal-badge">${escapeHtml(eventType)}</span>
          <span class="signal-badge secondary">${escapeHtml(relevance)}</span>
          <span class="signal-badge ${item.forecast_feature_eligible ? "" : "muted"}">${escapeHtml(featureStatus)}</span>
        </span>
        <time title="${escapeHtml(firstSeenTitle)}">${escapeHtml(formatCompactTime(publishedAt))}</time>
      </div>
      <p class="signal-card-text">${escapeHtml(item.text ?? "暂无原始文本")}</p>
      <div class="signal-footer">
        <small>${escapeHtml(item.display_handle ?? "@thsottiaux")} · ${escapeHtml(item.ingest_provider ?? "exact source")}</small>
        ${sourceUrl
          ? `<a class="signal-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="在新窗口打开 Tibo 原文"><span>原文</span>${externalLinkIcon}</a>`
          : ""}
      </div>
    `;
    if (String(item.text ?? "").length > 180) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "timeline-expand";
      toggle.textContent = "展开完整内容";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const expanded = row.classList.toggle("expanded");
        toggle.textContent = expanded ? "收起内容" : "展开完整内容";
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
  if (!value || typeof value !== "object") return "当前影响尚待补充";
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
  return fields.length > 0 ? fields.join(" · ") : "当前影响尚待补充";
}

function renderImpactEpisodes(items, tracking = {}) {
  const targetSelector = "#impact-episode-list";
  const target = document.querySelector(targetSelector);
  target.replaceChildren();
  if (tracking.enabled === false) {
    setListMessage(targetSelector, "问题发酵追踪当前已关闭");
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    setListMessage(targetSelector, "暂无形成持续发酵的问题");
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
    const state = episodeStateLabels[item.state] ?? item.state ?? "状态未知";
    const trend = episodeTrendLabels[item.trend] ?? item.trend ?? "趋势未知";
    const category = impactCategoryLabels[item.category] ??
      String(item.category ?? "其他问题").replaceAll("_", " ");
    const evidenceCount = Array.isArray(item.evidence)
      ? item.evidence.length
      : item.evidence && typeof item.evidence === "object"
        ? Object.keys(item.evidence).length
        : 0;
    const lastUpdate = item.last_independent_update_at
      ? formatCompactTime(item.last_independent_update_at)
      : "更新时间未知";
    const firstObserved = item.first_observed_at
      ? formatCompactTime(item.first_observed_at)
      : "时间未知";
    const computedAt = item.as_of
      ? formatCompactTime(item.as_of)
      : "计算时间未知";
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
        <span>当前压力 <strong>${escapeHtml(pressureScore(item.current_pressure))}</strong></span>
        <span>峰值 ${escapeHtml(pressureScore(item.peak_pressure))}</span>
      </div>
      <div class="pressure-track" aria-hidden="true"><i style="width:${relativeWidth.toFixed(1)}%"></i></div>
      <small>首次观察 ${escapeHtml(firstObserved)} · ${evidenceCount} 条独立证据 · 压力计算于 ${escapeHtml(computedAt)}</small>
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
  const blocker = primaryPublicationBlocker(
    [
      ...(result.data?.serving?.serving_blockers ?? []),
      ...(readiness.serving_blockers ?? []),
      ...(result.data?.serving?.publication_blockers ?? []),
      ...(readiness.publication_blockers ?? []),
    ],
  );
  if (blocker && publicationBlockerLabels[blocker]) {
    return `${publicationBlockerLabels[blocker]}。`;
  }
  const preparation = modelPreparationState(readiness);
  if (preparation === "fitted") {
    return "模型已完成拟合，正在生成首版 7 天试用预测。";
  }
  if (preparation === "running") {
    return "模型正在更新，首版可用结果生成后立即显示。";
  }
  const labels = {
    forecast_incompatible: "模型版本需要更新。",
    forecast_not_publishable: "当前数据还不支持发布预测。",
    forecast_stale: "预测已过期，等待更新。",
    forecast_not_ready: "预测尚未生成。",
    forecast_warming: "预测数据正在预热。",
  };
  if (result.status === 0) return "暂时无法连接预测服务。";
  return labels[result.data?.error] ?? "预测暂不可用，请稍后再试。";
}

function setStatus(kind, text) {
  const status = document.querySelector("#source-status");
  status.classList.remove("ok", "warning", "error");
  status.classList.add(kind);
  status.querySelector(".status-text").textContent = text;
  status.setAttribute("aria-label", `${text}。查看数据状态`);
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
  if (slots.length === 0) throw new Error("预测没有小时数据");
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
    ? "窗口不足"
    : percent(probability4h, 2);
  document.querySelector("#probability-24h").textContent = percent(probability24h, 1);
  document.querySelector("#probability-72h").textContent = probability72h === null
    ? "窗口不足"
    : percent(probability72h, 1);
  document.querySelector("#probability-7d").textContent = percent(probability168h, 1);
  document.querySelector("#data-quality-label").textContent =
    provisional ? "数据状态 · 试用模型" : "数据状态";
  document.querySelector("#interval-4h").textContent = probability4h === null
    ? "滚动 4 小时窗口超出预测范围"
    : intervalText(cumulativeInterval(forecast, "four_hours"));
  document.querySelector("#interval-24h").textContent =
    intervalText(cumulativeInterval(forecast, "twenty_four_hours"));
  document.querySelector("#interval-72h").textContent =
    "未来 72 小时内发生重置的可能性";
  document.querySelector("#interval-7d").textContent =
    intervalText(cumulativeInterval(forecast, "horizon"));
  document.querySelector("#data-quality").textContent = "实时来源检查中";
  const outcomeSampleCount = forecast.data.data_quality?.outcome_sample_count;
  const sampleSufficiency = forecast.data.data_quality?.sample_sufficiency;
  document.querySelector("#coverage").textContent =
    [
      Number.isInteger(outcomeSampleCount) ? `历史事件：${outcomeSampleCount} 个` : null,
      Number.isFinite(sampleSufficiency)
        ? `样本充分度：${percent(sampleSufficiency, 0)}`
        : null,
      "负标签按审计延迟成熟",
    ].filter(Boolean).join(" · ");
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
    "#probability-72h",
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
  document.querySelector("#interval-72h").textContent =
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
    isProvisionalServing(forecast, readiness) ? "数据状态 · 试用模型" : "数据状态";
  document.querySelector("#data-quality").textContent = sourcesFresh
    ? "实时来源正常"
    : "实时来源待更新";
  document.querySelector("#coverage").textContent = [
    Number.isInteger(outcomeSampleCount) ? `历史事件：${outcomeSampleCount} 个` : null,
    Number.isFinite(sampleSufficiency)
      ? `样本充分度：${percent(sampleSufficiency, 0)}`
      : null,
    "负标签按审计延迟成熟",
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
    setStatus("error", "核心来源异常 · 预测已暂停");
  } else if (provisional) {
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
  renderDataStatus(forecast, health, readiness);
}

function renderEvidenceResponse(result) {
  if (!result.ok || !result.data) {
    setListMessage("#core-signal-list", `核心信号加载失败：${result.error}`, "error");
    setListMessage("#experience-signal-list", `体验问题加载失败：${result.error}`, "error");
    setListMessage("#competition-signal-list", `竞争动态加载失败：${result.error}`, "error");
    setListMessage("#pending-signal-list", `待纳入信号加载失败：${result.error}`, "error");
    setListMessage("#tibo-timeline-list", `Tibo 动态加载失败：${result.error}`, "error");
    setListMessage("#impact-episode-list", `问题追踪加载失败：${result.error}`, "error");
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
    `仅显示信息截止 ${formatCompactTime(evidence.knowledge_cutoff)} 前已知的信号。`;
  renderEvidence("#core-signal-list", core, "截止时间前暂无新的精确官方核心信号", "core");
  renderEvidence("#experience-signal-list", experience, "截止时间前暂无新的 Codex 体验问题", "experience");
  renderEvidence("#competition-signal-list", competition, "截止时间前暂无新的竞争模型发布", "competition");
  renderEvidence("#pending-signal-list", pending, "当前没有晚于截止时间的新信号", "pending");
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
    return { ok: false, status: 0, data: null, error: "当前预测快照地址无效" };
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
        error: "预测快照与当前版本不一致",
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
  document.querySelector("#timezone-display").textContent = `时区 · ${displayZone}`;
  let healthResult = { ok: false, status: 0, data: null, error: "尚未检查状态" };
  try {
    healthResult = await fetchJson("/api/health", { timeoutMs: 15_000 });
    const health = healthResult.data ?? {};
    const reference = health.current_prediction_ref;
    const forecastCutoff = reference?.knowledge_cutoff ?? health.knowledge_cutoff;
    if (Number.isFinite(Date.parse(forecastCutoff))) latestForecastCutoff = forecastCutoff;
    const canServe = healthResult.ok &&
      (health.serving_ready === true || health.synthetic_only === true) &&
      predictionRefKey(reference);
    if (!canServe) {
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
        `当前预测快照加载失败：${snapshotResult.error}`,
        health,
      );
      renderPublicationWarning(snapshotResult, healthResult);
      renderHealth(snapshotResult, healthResult, healthResult);
      setStatus("error", "预测快照加载失败");
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
    setStatus("error", "预测渲染失败");
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
const calibrationHitArea = document.querySelector("#calibration-hit-area");
const calibrationTooltip = document.querySelector("#calibration-tooltip");
const calibrationState = document.querySelector("#calibration-state");
const calibrationSample = document.querySelector("#calibration-sample");
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
let notificationCalibrationRequest = null;
let notificationCalibrationTimer = null;
let notificationCalibrationGeneration = 0;
let notificationDialogTrigger = null;
let notificationFeedBaselineCursor = null;
let notificationFeedBaselineRequest = null;

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

function saveLocalNotificationPreferences() {
  try {
    localStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      topics: selectedNotificationTopics(),
      preferences: selectedNotificationPreferences(),
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
      }
      return true;
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
    `打开 ${formatNotificationHorizon(preference.horizon_hours)}、${threshold}% 门槛的个性化 Atom`,
  );
}

async function refreshPersonalizedFeedBaseline() {
  notificationFeedBaselineRequest?.abort();
  const controller = new AbortController();
  notificationFeedBaselineRequest = controller;
  notificationFeedBaselineCursor = null;
  personalizedFeedStatus.textContent = "正在从当前预测建立订阅基线…";
  renderNotificationValues();
  try {
    const timeout = setTimeout(() => controller.abort(), 8_000);
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
      throw new TypeError("订阅基线响应无效");
    }
    if (controller.signal.aborted) return;
    notificationFeedBaselineCursor = payload.cursor;
    personalizedFeedStatus.textContent =
      "链接只会评估建立基线之后的新预测，不会回放过去的提醒。";
    renderNotificationValues();
  } catch (error) {
    if (controller.signal.aborted) return;
    notificationFeedBaselineCursor = null;
    renderNotificationValues();
    personalizedFeedStatus.textContent =
      `暂时无法建立安全基线，个性化 Atom 链接不可用：${error.message}`;
  } finally {
    if (notificationFeedBaselineRequest === controller) {
      notificationFeedBaselineRequest = null;
    }
  }
}

function clearCalibrationGraphic() {
  calibrationArea.removeAttribute("d");
  calibrationCurve.removeAttribute("d");
  calibrationCrosshair.hidden = true;
  calibrationMarker.hidden = true;
  calibrationTooltip.hidden = true;
}

function setCalibrationState(state, message, sampleText = "等待历史数据") {
  calibrationPlot.dataset.state = state;
  calibrationState.textContent = message;
  calibrationSample.textContent = sampleText;
  if (state !== "ready") clearCalibrationGraphic();
}

function calibrationCoordinates(points) {
  const maximumDensity = Math.max(...points.map((point) => point.density), 0);
  if (!(maximumDensity > 0)) return [];
  return points.map((point) => ({
    ...point,
    x: 20 + point.probability * 560,
    y: 165 - (point.density / maximumDensity) * 132,
  }));
}

function renderCalibrationGraphic(calibration) {
  const coordinates = calibrationCoordinates(calibration.points);
  if (coordinates.length < 2) {
    setCalibrationState(
      "insufficient",
      "当前时间窗的历史样本不足，无法判断门槛可靠度。",
      `${calibration.sample_count} 个窗口 · ${calibration.event_count} 次重置`,
    );
    calibrationSummary.textContent = "样本不足，当前不能判断哪个概率门槛更可靠。";
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
    ? `初步 · ${calibration.sample_count}/${calibration.min_sample_count} 窗口 · ${calibration.event_count}/${calibration.min_event_count} 次重置`
    : `${calibration.sample_count} 窗口 / ${calibration.event_count} 次重置`;
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
      detail: `概率 > ${thresholdText} · 样本 ${evaluated}/${minimum}`,
      summary: "该真实 1% 门槛点尚未通过样本门槛，暂不显示历史命中率。",
    };
  }
  const hitRate = percent(point.confidence_above);
  const samples = Number.isFinite(point.sample_count_above)
    ? `${point.sample_count_above} 个门槛以上样本`
    : "样本量未提供";
  const prefix = notificationCalibration?.status === "preliminary"
    ? "初步历史命中率"
    : "历史命中率";
  const interval = point.confidence_interval;
  const intervalText = interval &&
      Number.isFinite(interval.lower) &&
      Number.isFinite(interval.upper)
    ? ` · 95% Wilson 区间 ${percent(interval.lower)}–${percent(interval.upper)}`
    : "";
  return {
    detail: `概率 > ${thresholdText} · ${prefix} ${hitRate}${intervalText}`,
    summary: `${prefix} ${hitRate}${intervalText}，基于${samples}；仅用于辅助选择门槛。`,
  };
}

function showCalibrationPoint(threshold) {
  if (!notificationCalibration || calibrationPlot.dataset.state !== "ready") return;
  const point = calibrationAt(notificationCalibration.points, threshold);
  if (!point) return;
  const coordinates = calibrationCoordinates(notificationCalibration.points);
  const maximumDensity = Math.max(
    ...notificationCalibration.points.map((item) => item.density),
    0,
  );
  const x = 20 + point.probability * 560;
  const y = maximumDensity > 0
    ? 165 - ((point.density ?? 0) / maximumDensity) * 132
    : coordinates.at(-1)?.y ?? 165;
  calibrationCrosshair.setAttribute("x1", x.toFixed(2));
  calibrationCrosshair.setAttribute("x2", x.toFixed(2));
  calibrationCrosshair.hidden = false;
  calibrationMarker.setAttribute("cx", x.toFixed(2));
  calibrationMarker.setAttribute("cy", y.toFixed(2));
  calibrationMarker.hidden = false;
  const copy = calibrationCopy(point, point.probability);
  calibrationTooltip.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = copy.detail;
  const sample = document.createElement("span");
  sample.textContent = Number.isFinite(point.sample_count_above)
    ? `${point.sample_count_above} 个门槛以上样本`
    : "样本量暂不可用";
  calibrationTooltip.append(title, sample);
  calibrationTooltip.style.left = `${(x / 600) * 100}%`;
  calibrationTooltip.style.top = `${Math.max(34, (y / 190) * 174)}px`;
  calibrationTooltip.hidden = false;
  calibrationSummary.textContent = copy.summary;
}

function calibrationThresholdForEvent(event) {
  const bounds = calibrationHitArea.getBoundingClientRect();
  if (!(bounds.width > 0)) return null;
  return Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
}

function renderNotificationCalibration(calibration) {
  notificationCalibration = calibration;
  if (calibration.status === "insufficient") {
    setCalibrationState(
      "insufficient",
      "当前时间窗的历史样本不足，无法判断哪个概率门槛更可靠。",
      `${calibration.sample_count} 窗口 / ${calibration.event_count} 次重置`,
    );
    calibrationSummary.textContent = "样本不足，当前不可判断历史命中率。";
    return;
  }
  renderCalibrationGraphic(calibration);
}

function notificationCalibrationMatchesSelection(hours, generation) {
  return notificationDialog.open &&
    generation === notificationCalibrationGeneration &&
    horizonHours() === hours;
}

function notificationCalibrationIsCurrent(hours, generation, controller = null) {
  return notificationCalibrationMatchesSelection(hours, generation) &&
    !(controller?.signal.aborted);
}

async function loadNotificationCalibration(
  hours = horizonHours(),
  generation = notificationCalibrationGeneration,
) {
  if (!notificationCalibrationIsCurrent(hours, generation)) return null;
  const cached = notificationCalibrationCache.get(hours);
  if (cached) {
    renderNotificationCalibration(cached);
    return cached;
  }
  notificationCalibrationRequest?.controller.abort();
  const controller = new AbortController();
  const request = { controller, generation, horizon_hours: hours };
  notificationCalibrationRequest = request;
  notificationCalibration = null;
  setCalibrationState("loading", "正在读取该时间窗的历史预测与重置记录…");
  calibrationSummary.textContent = "历史可靠度仅用于辅助选择门槛，不是模型置信度。";
  let timedOut = false;
  try {
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    const response = await fetch(
      `/api/notification-preferences/calibration?horizon_hours=${hours}`,
      {
        cache: "no-store",
        signal: controller.signal,
      },
    ).finally(() => clearTimeout(timeout));
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
    }
    const calibration = normalizeCalibrationPayload(payload, hours);
    if (!notificationCalibrationIsCurrent(hours, generation, controller)) return null;
    notificationCalibrationCache.set(hours, calibration);
    renderNotificationCalibration(calibration);
    return calibration;
  } catch (error) {
    if (
      !notificationCalibrationMatchesSelection(hours, generation) ||
      (controller.signal.aborted && !timedOut)
    ) return null;
    const reason = timedOut ? "请求超时" : error.message;
    setCalibrationState(
      "error",
      `历史可靠度暂时加载失败：${reason}`,
      "加载失败",
    );
    calibrationSummary.textContent = "无法读取历史记录，仍可手动设置通知门槛。";
    return null;
  } finally {
    if (notificationCalibrationRequest === request) {
      notificationCalibrationRequest = null;
    }
  }
}

function scheduleNotificationCalibration() {
  if (!notificationDialog.open) return;
  clearTimeout(notificationCalibrationTimer);
  notificationCalibrationTimer = null;
  notificationCalibrationRequest?.controller.abort();
  notificationCalibrationRequest = null;
  const hours = horizonHours();
  const generation = ++notificationCalibrationGeneration;
  const cached = notificationCalibrationCache.get(hours);
  if (cached) {
    renderNotificationCalibration(cached);
    return;
  }
  notificationCalibration = null;
  setCalibrationState("loading", "选择停稳后加载该时间窗的历史记录…");
  calibrationSummary.textContent = "历史可靠度仅用于辅助选择门槛，不是模型置信度。";
  notificationCalibrationTimer = setTimeout(
    () => {
      notificationCalibrationTimer = null;
      if (!notificationCalibrationIsCurrent(hours, generation)) return;
      void loadNotificationCalibration(hours, generation);
    },
    220,
  );
}

function updateProbabilityRule() {
  notificationProbabilityRule.dataset.pushEnabled = String(
    notificationProbabilityTopic.checked,
  );
  if (notificationDialog.open) scheduleNotificationCalibration();
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
  notificationEnable.disabled = busy;
  notificationDisable.disabled = busy;
  notificationCancel.disabled = busy;
}

async function refreshNotificationControls(message = null) {
  const subscription = await notificationRegistration.pushManager.getSubscription();
  notificationEnable.textContent = subscription ? "保存通知设置" : "启用通知";
  notificationDisable.hidden = !subscription;
  notificationStatus.textContent = message ?? (subscription
    ? "此浏览器已订阅通知。"
    : Notification.permission === "denied"
      ? "浏览器已阻止通知，请在站点设置中重新允许。"
      : "通知权限只会在点击保存后询问。");
}

async function enableWebPush() {
  setNotificationBusy(true);
  try {
    const topics = selectedNotificationTopics();
    if (topics.length === 0) throw new Error("请至少选择一种通知主题。");
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") throw new Error("未获得浏览器通知权限。");
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
    try {
      await webPushJson("/api/web-push/subscriptions", {
        method: "POST",
        body: { ...serialized, topics, preferences },
      });
    } catch (error) {
      if (created) await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    saveLocalNotificationPreferences();
    await refreshNotificationControls(
      "通知设置已保存；个性化规则会从现在开始应用。",
    );
  } catch (error) {
    notificationStatus.textContent = `通知未启用：${error.message}`;
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
    notificationStatus.textContent = "此浏览器的通知已关闭。";
    await refreshNotificationControls();
  } catch (error) {
    notificationStatus.textContent = `关闭通知失败：${error.message}`;
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
    notificationStatus.textContent = "此浏览器不支持 Web Push；仍可使用下方公共 Atom 事件流。";
    return;
  }
  try {
    const config = await webPushJson("/api/web-push/config");
    if (!restoredLocalPreferences) applyPublicNotificationDefaults(config);
    renderNotificationValues();
    if (!config?.enabled || !config.application_server_key) {
      notificationEnable.disabled = true;
      notificationStatus.textContent = "浏览器通知暂未开放；仍可查看规则或使用公共 Atom 事件流。";
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
    notificationStatus.textContent = "浏览器通知配置暂时不可用；请稍后重试。";
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
  void refreshPersonalizedFeedBaseline();
  scheduleNotificationCalibration();
}

function closeNotificationDialog() {
  if (typeof notificationDialog.close === "function") notificationDialog.close();
  else notificationDialog.removeAttribute("open");
  document.body.classList.remove("subscription-dialog-open");
  clearTimeout(notificationCalibrationTimer);
  notificationCalibrationTimer = null;
  notificationCalibrationGeneration += 1;
  notificationCalibrationRequest?.controller.abort();
  notificationCalibrationRequest = null;
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
notificationThreshold?.addEventListener("input", () => {
  renderNotificationValues();
  showCalibrationPoint((Number(notificationThreshold.value) || 0) / 100);
});
calibrationHitArea?.addEventListener("pointermove", (event) => {
  const threshold = calibrationThresholdForEvent(event);
  if (threshold !== null) showCalibrationPoint(threshold);
});
calibrationHitArea?.addEventListener("pointerleave", () => {
  showCalibrationPoint((Number(notificationThreshold.value) || 0) / 100);
});
calibrationHitArea?.addEventListener("pointerdown", (event) => {
  const selected = calibrationThresholdForEvent(event);
  if (selected === null) return;
  const point = calibrationAt(notificationCalibration?.points ?? [], selected);
  const threshold = Math.min(0.99, Math.max(0.01, point?.probability ?? selected));
  notificationThreshold.value = String(Math.round(threshold * 100));
  renderNotificationValues();
  showCalibrationPoint(threshold);
});
personalizedFeedCopy?.addEventListener("click", async () => {
  if (!Number.isSafeInteger(notificationFeedBaselineCursor)) {
    personalizedFeedStatus.textContent = "尚未建立安全基线，当前没有可复制的链接。";
    return;
  }
  try {
    await navigator.clipboard.writeText(personalizedFeedUrl.value);
    personalizedFeedStatus.textContent = "个性化订阅链接已复制。";
  } catch {
    personalizedFeedUrl.focus();
    personalizedFeedUrl.select();
    personalizedFeedStatus.textContent = "无法自动复制，链接已选中，请手动复制。";
  }
});
notificationEnable?.addEventListener("click", () => void enableWebPush());
notificationDisable?.addEventListener("click", () => void disableWebPush());

void initializeWebPushControls();

void load();
