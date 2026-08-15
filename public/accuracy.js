import { tr, uiLocale } from "./i18n.js?v=seo-i18n-1";

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const displayZone = localZone === "Etc/UTC" ? "UTC" : localZone;
const formatTime = new Intl.DateTimeFormat(uiLocale, {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const precisionLabels = {
  exact: tr("精确时间", "Exact time"),
  minute: tr("分钟级确认", "Minute-level confirmation"),
  hour: tr("小时区间", "Hourly interval"),
  part_of_day: tr("时段范围", "Part-of-day range"),
  day: tr("日期范围", "Daily range"),
  week: tr("周范围", "Weekly range"),
  interval_observed: tr("观察区间", "Observed interval"),
  unknown: tr("时间精度未知", "Unknown time precision"),
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
  const start = time(range.start);
  const end = time(range.end);
  return start === end ? start : `${start} → ${end}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      return { ok: false, data: null, error: tr("响应不是 JSON", "Response was not JSON") };
    }
    return {
      ok: response.ok,
      data,
      error: response.ok ? null : data.message ?? data.error ?? `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: error.name === "AbortError" ? tr("请求超时", "Request timed out") : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sourceCell(source) {
  if (!source) return "—";
  const url = safeExternalUrl(source.canonical_url);
  const handle = escapeHtml(source.display_handle ?? tr("查看来源", "View source"));
  const link = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${handle}</a>`
    : handle;
  const normalizedText = source.text?.replace(/\s+/g, " ").trim();
  const excerpt = normalizedText?.length > 180
    ? `${normalizedText.slice(0, 179)}…`
    : normalizedText;
  const text = excerpt
    ? `<small>${escapeHtml(excerpt)}</small>`
    : "";
  return `<span class="table-primary">${link}</span>${text}`;
}

function renderResults(results = []) {
  const body = document.querySelector("#result-table");
  const count = document.querySelector("#result-count");
  body.replaceChildren();
  count.textContent = results.length > 0
    ? tr(
      `共 ${results.length} 条，按发生时间从新到旧排列。`,
      `${results.length} confirmed ${results.length === 1 ? "record" : "records"}, newest first.`,
    )
    : tr("暂时没有已确认的重置结果。", "No confirmed reset outcomes yet.");
  if (results.length === 0) {
    body.innerHTML = `<tr><td colspan="4">${tr("暂无已确认记录。", "No confirmed records.")}</td></tr>`;
    return;
  }
  for (const result of results) {
    const row = document.createElement("tr");
    const status = result.label_grade === "silver"
      ? tr("人工确认（silver）", "Operator confirmed (silver)")
      : tr("官方确认（gold）", "Officially confirmed (gold)");
    const precision = precisionLabels[result.occurred_time_range?.precision] ??
      result.occurred_time_range?.precision ??
      precisionLabels.unknown;
    row.innerHTML = `<td><span class="table-primary">${escapeHtml(rangeText(result.occurred_time_range))}</span><small>${escapeHtml(precision)}</small></td><td><span class="result confirmed">${escapeHtml(status)}</span></td><td>${escapeHtml(time(result.source?.published_at ?? result.known_at))}</td><td>${sourceCell(result.source)}</td>`;
    body.append(row);
  }
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
  document.querySelector("#timezone-display").textContent = tr(
    `时区 · ${displayZone}`,
    `Time zone · ${displayZone}`,
  );
  const result = await fetchJson("/api/history/results");
  try {
    if (!result.ok || !Array.isArray(result.data?.results)) {
      document.querySelector("#result-count").textContent = tr(
        "历史结果暂时无法加载。",
        "Reset history is temporarily unavailable.",
      );
      document.querySelector("#result-table").innerHTML =
        `<tr><td colspan="4">${tr("加载失败", "Load failed")}: ${escapeHtml(result.error ?? tr("未知错误", "Unknown error"))}</td></tr>`;
      return;
    }
    renderResults(result.data.results);
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
