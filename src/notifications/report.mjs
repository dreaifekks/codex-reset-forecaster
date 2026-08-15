import { buildHorizonCumulativeCurve } from "./subscription-policy.mjs";

function boundedProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function cumulativeProbability(slots) {
  if (
    !Array.isArray(slots) ||
    slots.length === 0 ||
    slots.some((slot) => boundedProbability(slot?.hazard) === null)
  ) return null;
  return 1 - slots.reduce(
    (survival, slot) => survival * (1 - slot.hazard),
    1,
  );
}

function percent(value) {
  return value === null ? "—" : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function publicUrl(base, path) {
  return new URL(path, new URL(base).origin).href;
}

export function forecastReport(prediction, readiness, publicBaseUrl) {
  const slots = prediction?.data?.slots ?? [];
  const horizonProbabilities = buildHorizonCumulativeCurve(slots);
  const probability4h = boundedProbability(slots[0]?.rolling_4h_probability) ??
    cumulativeProbability(slots.slice(0, 4));
  const probability24h = cumulativeProbability(slots.slice(0, 24));
  const probability72h = cumulativeProbability(slots.slice(0, 72));
  const probability168h = boundedProbability(
    1 - prediction?.data?.no_reset_probability,
  ) ?? cumulativeProbability(slots.slice(0, 168));
  const peak = slots
    .map((slot, index) => ({
      index,
      start: slot.start,
      end: slots[index + 3]?.end ?? null,
      probability: boundedProbability(slot.rolling_4h_probability),
    }))
    .filter((item) => item.probability !== null && item.end)
    .sort((left, right) =>
      right.probability - left.probability || left.start.localeCompare(right.start)
    )[0] ?? null;
  return {
    prediction_ref: {
      record_id: prediction.record_id,
      revision: prediction.revision,
    },
    issued_at: prediction.data.issued_at,
    knowledge_cutoff: prediction.data.knowledge_cutoff,
    serving_stage: readiness?.serving_stage ?? null,
    publication_ready: readiness?.publication_ready === true,
    probabilities: {
      next_4h: probability4h,
      next_24h: probability24h,
      next_72h: probability72h,
      next_168h: probability168h,
    },
    horizon_probabilities: horizonProbabilities,
    peak_4h_window: peak,
    authority_conditioning: prediction.data.authority_conditioning ?? null,
    recurrence_anchor: prediction.data.recurrence_anchor ?? null,
    data_quality: prediction.data.data_quality ?? null,
    url: publicUrl(publicBaseUrl, "/"),
  };
}

export function authorityNotification(report) {
  const range = report.authority_conditioning?.asserted_time_range;
  return {
    title: "出现新的权威重置时间窗",
    body: range
      ? `权威来源提到 ${range.start} 至 ${range.end} 的未来重置时间窗；当前 4 小时概率 ${percent(report.probabilities.next_4h)}。这不是已确认重置。`
      : `权威来源出现新的未来重置信号；当前 4 小时概率 ${percent(report.probabilities.next_4h)}。这不是已确认重置。`,
    url: report.url,
    tag: `authority-${report.authority_conditioning?.signal_ref?.record_id ?? "window"}`,
  };
}

export function probabilityNotification(report, { opened }) {
  return opened ? {
    title: "实验概率告警：未来 4 小时风险上升",
    body: `当前模型给出的未来 4 小时概率为 ${percent(report.probabilities.next_4h)}；模型状态为 ${report.serving_stage ?? "未知"}。这是实验预测，不是重置确认。`,
    url: report.url,
    tag: "experimental-probability-watch",
  } : {
    title: "实验概率告警已解除",
    body: `未来 4 小时概率已回落到 ${percent(report.probabilities.next_4h)}，或新的确认结果已结束本轮观察。`,
    url: report.url,
    tag: "experimental-probability-watch",
  };
}

export function outcomeNotification(row, publicBaseUrl, kind) {
  const historyUrl = publicUrl(publicBaseUrl, "/accuracy");
  const operatorConfirmed = row.label_grade === "silver";
  const verificationBasis = operatorConfirmed ? "人工确认" : "官方来源";
  const range = row.occurred_time_range;
  const rangeText = range
    ? `${range.start} 至 ${range.end}`
    : "时间范围待核对";
  if (kind === "retracted") {
    return {
      title: "已确认重置记录已撤回",
      body: `先前发布的重置记录（${rangeText}）已被新的 canonical revision 撤回。`,
      url: historyUrl,
      tag: `outcome-${row.outcome_ref.record_id}`,
    };
  }
  if (kind === "verification_withdrawn") {
    return {
      title: "重置记录的验证已失效",
      body: `先前记录（${rangeText}）当前不再满足${verificationBasis}验证合同；这不等同于断言重置未发生。`,
      url: historyUrl,
      tag: `outcome-${row.outcome_ref.record_id}`,
    };
  }
  if (kind === "corrected") {
    return {
      title: "已确认重置记录已修正",
      body: `确认记录已更新为 ${rangeText}，请以最新 revision 和${verificationBasis}为准。`,
      url: historyUrl,
      tag: `outcome-${row.outcome_ref.record_id}`,
    };
  }
  return {
    title: operatorConfirmed ? "Codex 重置已人工确认" : "Codex 重置已确认",
    body: operatorConfirmed
      ? `操作员以 silver 级别确认发生时间为 ${rangeText}；这不是官方完成声明。`
      : `当前 outcome 合同确认发生时间为 ${rangeText}。`,
    url: historyUrl,
    tag: `outcome-${row.outcome_ref.record_id}`,
  };
}

export { cumulativeProbability };
