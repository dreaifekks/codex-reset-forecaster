const percent = (value, digits = 1) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const displayZone = localZone === "Etc/UTC" ? "UTC" : localZone;
const formatTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const precisionLabels = {
  second: "秒级",
  minute: "分钟级",
  hour: "小时区间",
  day: "日期区间",
  unknown: "精度未知",
};

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

function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatTime.format(date);
}

function rangeText(range) {
  if (!range?.start || !range?.end) return "—";
  return `${time(range.start)} → ${time(range.end)}`;
}

function exactRefKey(ref) {
  return `${ref?.record_id}@${ref?.revision}`;
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    let data = null;
    try {
      data = await response.json();
    } catch {
      return { ok: false, data: null, error: "响应不是 JSON" };
    }
    return {
      ok: response.ok,
      data,
      error: response.ok ? null : data.message ?? data.error ?? `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, data: null, error: error.message };
  }
}

function drawCalibration(buckets = [], emptyText = "暂无成熟样本") {
  const svg = document.querySelector("#calibration-chart");
  const namespace = "http://www.w3.org/2000/svg";
  const margin = 52;
  const size = 256;
  const point = (x, y) => `${margin + x * size},${margin + (1 - y) * size}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  svg.innerHTML = `<title id="calibration-title">预测概率校准曲线</title><desc id="calibration-description">横轴是平均预测概率，纵轴是实际发生频率；圆点大小表示样本数。</desc>`;
  for (const tick of ticks) {
    const x = margin + tick * size;
    const y = margin + (1 - tick) * size;
    svg.insertAdjacentHTML("beforeend", `<line x1="${x}" y1="${margin}" x2="${x}" y2="${margin + size}" class="chart-grid"/><line x1="${margin}" y1="${y}" x2="${margin + size}" y2="${y}" class="chart-grid"/><text x="${x}" y="${margin + size + 18}" class="tick-label">${Math.round(tick * 100)}%</text><text x="${margin - 10}" y="${y + 3}" class="tick-label y-tick">${Math.round(tick * 100)}%</text>`);
  }
  svg.insertAdjacentHTML("beforeend", `<line x1="${margin}" y1="${margin + size}" x2="${margin + size}" y2="${margin}" class="ideal"/><line x1="${margin}" y1="${margin + size}" x2="${margin + size}" y2="${margin + size}" class="axis"/><line x1="${margin}" y1="${margin}" x2="${margin}" y2="${margin + size}" class="axis"/><text x="${margin + size / 2}" y="350" class="axis-title">平均预测概率</text><text transform="translate(15 ${margin + size / 2}) rotate(-90)" class="axis-title">实际发生频率</text>`);
  const valid = buckets.filter((bucket) =>
    bucket.count > 0 &&
    Number.isFinite(bucket.mean_prediction) &&
    Number.isFinite(bucket.observed_rate),
  );
  if (valid.length === 0) {
    svg.insertAdjacentHTML(
      "beforeend",
      `<text x="${margin + size / 2}" y="${margin + size / 2}" class="chart-empty">${escapeHtml(emptyText)}</text>`,
    );
    return;
  }
  if (valid.length > 1) {
    const path = document.createElementNS(namespace, "polyline");
    path.setAttribute(
      "points",
      valid.map((bucket) => point(bucket.mean_prediction, bucket.observed_rate)).join(" "),
    );
    path.setAttribute("class", "calibration-line");
    svg.append(path);
  }
  for (const bucket of valid) {
    const circle = document.createElementNS(namespace, "circle");
    circle.setAttribute("cx", margin + bucket.mean_prediction * size);
    circle.setAttribute("cy", margin + (1 - bucket.observed_rate) * size);
    circle.setAttribute("r", Math.min(10, 4 + Math.sqrt(bucket.count) / 3));
    circle.setAttribute("class", "calibration-point");
    circle.setAttribute("tabindex", "0");
    circle.setAttribute("role", "img");
    const label = `预测 ${percent(bucket.mean_prediction)}，实际 ${percent(bucket.observed_rate)}，样本 ${bucket.count}`;
    circle.setAttribute("aria-label", label);
    const title = document.createElementNS(namespace, "title");
    title.textContent = label;
    circle.append(title);
    svg.append(circle);
  }
}

function renderTable(evaluation, eventsPayload) {
  const scores = new Map(
    (evaluation.events ?? []).map((event) => [exactRefKey(event.outcome_ref), event]),
  );
  const body = document.querySelector("#event-table");
  body.replaceChildren();
  const events = eventsPayload?.events ?? [];
  if (events.length === 0) {
    body.innerHTML = "<tr><td colspan=\"8\">暂无可展示的已确认事件。</td></tr>";
    return;
  }
  for (const event of events) {
    const score = scores.get(exactRefKey(event.outcome_ref)) ?? event.evaluation;
    const row = document.createElement("tr");
    const sourceUrl = safeExternalUrl(event.source?.canonical_url);
    const source = sourceUrl
      ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(event.source.display_handle ?? "查看来源")}</a>`
      : "—";
    const resultClass = score ? (score.hit ? "hit" : "miss") : "";
    const resultLabel = score ? (score.hit ? "命中" : "未命中") : "未评分";
    const lead = Number.isFinite(score?.useful_lead_hours)
      ? `${score.useful_lead_hours.toFixed(1)} 小时`
      : "—";
    const precision = precisionLabels[event.occurred_time_range?.precision] ??
      event.occurred_time_range?.precision ??
      "精度未知";
    const rankedWindow = score?.ranked_window
      ? `${rangeText(score.ranked_window)}`
      : "—";
    const probability = Number.isFinite(score?.maximum_prior_probability)
      ? score.maximum_prior_probability
      : score?.ranked_window?.probability;
    row.innerHTML = `<td><span class="table-primary">${escapeHtml(rangeText(event.occurred_time_range))}</span><small>${escapeHtml(precision)} · 结果版本 ${escapeHtml(event.outcome_ref.revision)}</small></td><td>${escapeHtml(time(score?.forecast_issued_at))}</td><td>${escapeHtml(rankedWindow)}</td><td>${percent(probability)}</td><td><span class="result ${resultClass}">${resultLabel}</span></td><td>${lead}</td><td><code>${escapeHtml(score?.model_version ?? "—")}</code></td><td>${source}</td>`;
    body.append(row);
  }
}

function setGate(kind, text) {
  const gate = document.querySelector("#gate-status");
  gate.classList.remove("ok", "warning", "error");
  gate.classList.add(kind);
  gate.innerHTML = `<span aria-hidden="true"></span>${escapeHtml(text)}`;
}

function showEvaluationWaiting(waiting) {
  document.querySelector("#evaluation-waiting-panel").hidden = !waiting;
  document.querySelectorAll(".evaluation-results")
    .forEach((node) => { node.hidden = waiting; });
}

function renderRankingPolicy(evaluation) {
  const policy = evaluation.ranking_policy;
  const budget = policy?.top_window_hours_per_week ??
    Math.max(0, ...(evaluation.folds ?? []).map((fold) => fold.top_window_count ?? 0));
  document.querySelector("#ranking-policy").textContent = Number.isFinite(budget) && budget > 0
    ? `每轮最多评估 ${budget} 个 ${policy?.window_hours ?? 4} 小时高概率窗口，重置发生在窗口内即计为命中。`
    : "本次评估暂无高概率窗口规则。";
}

function renderSummary(evaluation, readiness = {}) {
  showEvaluationWaiting(false);
  const synthetic = Boolean(
    evaluation.evidence_mode === "synthetic_replay" || readiness.synthetic_only,
  );
  const archiveReplay = evaluation.evidence_mode === "archive_replay";
  const metrics = evaluation.metrics;
  document.querySelector("#timezone-display").textContent = `时区 · ${displayZone}`;
  document.querySelector("#evaluation-mode").textContent = synthetic
    ? `合成演示 · ${evaluation.mode === "as_issued" ? "发布时评估" : "滚动回测"}`
    : archiveReplay
      ? "历史回放"
      : evaluation.mode === "as_issued"
        ? "发布时评估"
        : "滚动回测";
  document.querySelector("#evaluation-description").textContent = synthetic
    ? "合成数据仅验证模型流程。"
    : archiveReplay
      ? "按历史发布时间回放真实来源数据。"
      : evaluation.mode === "as_issued"
        ? "使用结果发生前已发布的预测评分。"
        : "每个历史起点只使用当时信息。";
  document.querySelector("#event-origin-heading").textContent =
    evaluation.mode === "as_issued" ? "预测发布" : "回测窗口起点";
  document.querySelector("#event-recall").textContent = percent(metrics.event_window_recall);
  document.querySelector("#brier-score").textContent = Number.isFinite(metrics.brier_score)
    ? metrics.brier_score.toFixed(4)
    : "—";
  document.querySelector("#brier-skill").textContent = percent(metrics.brier_skill);
  document.querySelector("#lead-time").textContent =
    Number.isFinite(metrics.median_useful_lead_hours)
      ? `${metrics.median_useful_lead_hours.toFixed(1)} 小时`
      : "—";
  setGate(
    synthetic || archiveReplay ? "warning" : evaluation.gate.passed ? "ok" : "error",
    synthetic
      ? (evaluation.gate.passed ? "合成演示通过" : "合成演示未通过")
      : archiveReplay
        ? (evaluation.gate.passed ? "历史回放通过" : "历史回放未通过")
        : (evaluation.gate.passed ? "发布评估通过" : "发布评估未通过"),
  );
  if (synthetic) {
    document.querySelector("#accuracy-disclaimer").textContent =
      "合成数据仅验证流程；真实精度仍需真实回测与发布记录。";
  } else if (archiveReplay) {
    document.querySelector("#accuracy-disclaimer").textContent =
      "历史回放用于离线评估；线上精度以实际发布记录为准。";
  }
  const values = [
    evaluation.mode === "as_issued" ? "实时记录" : (evaluation.folds?.length ?? 0),
    metrics.evaluated_events,
    metrics.false_alerts_top_n_policy ?? metrics.false_high_probability_alerts,
    percent(metrics.expected_calibration_error),
  ];
  document.querySelectorAll("#evaluation-metadata dd")
    .forEach((node, index) => { node.textContent = values[index] ?? "—"; });
  renderRankingPolicy(evaluation);
  drawCalibration(evaluation.calibration);
}

let refreshTimer = null;
let loading = false;
let lastLoadedAt = 0;

function scheduleHourlyRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const current = new Date();
  const next = new Date(current);
  next.setMinutes(0, 20, 0);
  next.setHours(next.getHours() + 1);
  refreshTimer = setTimeout(() => void load(), Math.max(1_000, next - current));
}

async function load() {
  if (loading) return;
  loading = true;
  document.querySelector("#timezone-display").textContent = `时区 · ${displayZone}`;
  const [summaryResult, eventsResult, readinessResult] = await Promise.all([
    fetchJson("/api/evaluation/summary"),
    fetchJson("/api/evaluation/events"),
    fetchJson("/api/readiness"),
  ]);
  try {
    if (!summaryResult.ok || !summaryResult.data) {
      const readiness = readinessResult.data ?? {};
      const evaluationPending = Boolean(
        readiness.evaluation_waiting &&
        readiness.model?.challenger?.ready,
      );
      if (evaluationPending) {
        showEvaluationWaiting(true);
        setGate("warning", "模型已训练 · 评估中");
        document.querySelector("#evaluation-mode").textContent = "评估进行中";
        document.querySelector("#evaluation-description").textContent =
          "积累足够样本后显示精度结果。";
        document.querySelectorAll("#evaluation-metadata dd")
          .forEach((node) => { node.textContent = "评估中"; });
        document.querySelector("#event-table").innerHTML =
          "<tr><td colspan=\"8\">评估完成后显示事件结果。</td></tr>";
        document.querySelector("#ranking-policy").textContent =
          "评估完成后显示窗口结果。";
        drawCalibration([], "正在积累样本");
        return;
      }
      showEvaluationWaiting(false);
      const invalidated = summaryResult.data?.error === "evaluation_invalidated";
      setGate(
        "error",
        invalidated
          ? "评估已失效 · 等待重新回测"
          : `评估暂不可用：${summaryResult.error}`,
      );
      document.querySelector("#evaluation-description").textContent = invalidated
        ? "当前评估与最新配置或数据不兼容。"
        : "评估接口暂时不可用。";
      document.querySelector("#evaluation-mode").textContent = invalidated
        ? "评估缓存已失效"
        : "评估尚未就绪";
      document.querySelector("#event-table").innerHTML =
        `<tr><td colspan="8">${invalidated ? "重新回测后显示事件评分。" : "事件评分暂不可用。"}</td></tr>`;
      document.querySelector("#ranking-policy").textContent =
        "暂无可用评估结果。";
      drawCalibration([]);
    } else {
      renderSummary(summaryResult.data, readinessResult.data ?? {});
      if (eventsResult.ok) {
        renderTable(summaryResult.data, eventsResult.data);
      } else {
        document.querySelector("#event-table").innerHTML =
          `<tr><td colspan="8">事件列表加载失败：${escapeHtml(eventsResult.error)}</td></tr>`;
      }
    }
  } catch (error) {
    console.error(error);
    setGate("error", "评估渲染失败");
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
