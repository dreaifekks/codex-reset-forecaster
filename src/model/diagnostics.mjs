import { clamp } from "../core/time.mjs";

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function averagePrecision(rows) {
  const positives = rows.filter((row) => row.label === 1).length;
  if (positives === 0) return null;
  let truePositives = 0;
  let precisionSum = 0;
  [...rows]
    .sort((left, right) => right.probability - left.probability)
    .forEach((row, index) => {
      if (row.label !== 1) return;
      truePositives += 1;
      precisionSum += truePositives / (index + 1);
    });
  return precisionSum / positives;
}

export function calibrationFit(rows) {
  const positives = rows.filter((row) => row.label === 1).length;
  if (positives === 0 || positives === rows.length) return { intercept: null, slope: null };
  let intercept = 0;
  let slope = 1;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    let gradientIntercept = 0;
    let gradientSlope = 0;
    let informationIntercept = 1e-6;
    let informationCross = 0;
    let informationSlope = 1e-6;
    for (const row of rows) {
      const probability = clamp(row.probability, 1e-6, 1 - 1e-6);
      const logit = Math.log(probability / (1 - probability));
      const linear = clamp(intercept + slope * logit, -30, 30);
      const fitted = 1 / (1 + Math.exp(-linear));
      const residual = row.label - fitted;
      const variance = fitted * (1 - fitted);
      gradientIntercept += residual;
      gradientSlope += residual * logit;
      informationIntercept += variance;
      informationCross += variance * logit;
      informationSlope += variance * logit * logit;
    }
    const determinant = informationIntercept * informationSlope - informationCross ** 2;
    if (Math.abs(determinant) < 1e-12) break;
    const deltaIntercept = (
      informationSlope * gradientIntercept - informationCross * gradientSlope
    ) / determinant;
    const deltaSlope = (
      -informationCross * gradientIntercept + informationIntercept * gradientSlope
    ) / determinant;
    intercept = clamp(intercept + deltaIntercept, -30, 30);
    slope = clamp(slope + deltaSlope, -30, 30);
    if (Math.max(Math.abs(deltaIntercept), Math.abs(deltaSlope)) < 1e-8) break;
  }
  return { intercept, slope };
}

export function falseAlertsByMonth(rows, threshold = 0.5) {
  const groups = Map.groupBy(rows, (row) =>
    String(row.window_start ?? row.anchor).slice(0, 7),
  );
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, monthRows]) => ({
      month,
      count: monthRows.filter((row) => row.probability >= threshold && row.label === 0).length,
    }));
}

export function medianPolicyPeakAbsoluteError(events) {
  return median(events.flatMap((event) => {
    if (!event.policy_peak_window) return [];
    const predictedCenter = (
      Date.parse(event.policy_peak_window.start) +
      Date.parse(event.policy_peak_window.end)
    ) / 2;
    const occurredStart = Date.parse(event.occurred_time_range.start);
    return [Math.abs(predictedCenter - occurredStart) / 3_600_000];
  }));
}
