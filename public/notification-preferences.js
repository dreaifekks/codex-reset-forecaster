export const NOTIFICATION_HORIZON_HOURS = Object.freeze([
  ...Array.from({ length: 12 }, (_, index) => index + 1),
  ...Array.from({ length: 9 }, (_, index) => 16 + index * 4),
  ...Array.from({ length: 4 }, (_, index) => 60 + index * 12),
  ...Array.from({ length: 3 }, (_, index) => 120 + index * 24),
]);

export const NOTIFICATION_CALIBRATION_CACHE_TTL_MS = 10 * 60_000;

function calibrationHorizon(hours) {
  const value = Number(hours);
  if (!Number.isSafeInteger(value) || value < 1 || value > 168) {
    throw new TypeError("历史可靠度缓存的时间窗无效");
  }
  return value;
}

export function createNotificationCalibrationCache({
  ttlMs = NOTIFICATION_CALIBRATION_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("历史可靠度缓存有效期必须大于零");
  }
  if (typeof now !== "function") {
    throw new TypeError("历史可靠度缓存时钟必须是函数");
  }
  const entries = new Map();

  return Object.freeze({
    get(hours) {
      const horizonHours = calibrationHorizon(hours);
      const entry = entries.get(horizonHours);
      if (!entry) return null;
      const currentTime = Number(now());
      if (
        !Number.isFinite(currentTime) ||
        currentTime < entry.stored_at ||
        currentTime - entry.stored_at >= ttlMs
      ) {
        entries.delete(horizonHours);
        return null;
      }
      return structuredClone(entry.calibration);
    },

    set(hours, calibration) {
      const horizonHours = calibrationHorizon(hours);
      if (
        !calibration ||
        typeof calibration !== "object" ||
        calibration.horizon_hours !== horizonHours
      ) {
        throw new TypeError("历史可靠度缓存内容与时间窗不匹配");
      }
      const storedAt = Number(now());
      if (!Number.isFinite(storedAt)) {
        throw new TypeError("历史可靠度缓存时钟无效");
      }
      entries.set(horizonHours, {
        stored_at: storedAt,
        calibration: structuredClone(calibration),
      });
      return structuredClone(calibration);
    },

    clear() {
      entries.clear();
    },
  });
}

export function nearestHorizonIndex(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return NOTIFICATION_HORIZON_HOURS.indexOf(24);
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, option] of NOTIFICATION_HORIZON_HOURS.entries()) {
    const distance = Math.abs(option - hours);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

export function formatNotificationHorizon(hours) {
  const value = Number(hours);
  if (!Number.isFinite(value)) return "—";
  if (value >= 24 && value % 24 === 0) {
    return `${value / 24} 天（${value} 小时）`;
  }
  return `${value} 小时`;
}

function unitInterval(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1
    ? number
    : null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function confidenceInterval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lower = unitInterval(value.lower);
  const upper = unitInterval(value.upper);
  const level = unitInterval(value.level);
  if (
    lower === null ||
    upper === null ||
    lower > upper ||
    level === null ||
    typeof value.method !== "string" ||
    value.method.length === 0
  ) return null;
  return { lower, upper, level, method: value.method };
}

export function normalizeCalibrationPayload(payload, expectedHorizonHours) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("历史可靠度响应必须是对象");
  }
  const horizonHours = Number(payload.horizon_hours);
  if (
    !Number.isSafeInteger(horizonHours) ||
    horizonHours < 1 ||
    horizonHours > 168 ||
    (expectedHorizonHours !== undefined && horizonHours !== expectedHorizonHours)
  ) {
    throw new TypeError("历史可靠度响应的时间窗不匹配");
  }
  const sampleCount = nonNegativeInteger(payload.sample_count) ?? 0;
  const minimumSampleCount = nonNegativeInteger(payload.min_sample_count) ?? 20;
  const eventCount = nonNegativeInteger(payload.event_count) ?? 0;
  const minimumEventCount = nonNegativeInteger(payload.min_event_count) ?? 1;
  const byProbability = new Map();
  for (const source of Array.isArray(payload.points) ? payload.points : []) {
    const probability = unitInterval(source?.probability ?? source?.threshold);
    const density = nonNegative(source?.density);
    const rawConfidenceAbove = unitInterval(
      source?.confidence_above ?? source?.confidence,
    );
    const historicalHitRateAbove = unitInterval(
      source?.historical_hit_rate_above ?? rawConfidenceAbove,
    );
    const sampleCountAbove = nonNegativeInteger(
      source?.sample_count_above ?? source?.sample_count,
    );
    const pointMinimum = nonNegativeInteger(
      source?.point_sample_gate?.minimum_windows,
    ) ?? 20;
    const pointEvaluated = nonNegativeInteger(
      source?.point_sample_gate?.evaluated_windows,
    ) ?? sampleCountAbove ?? 0;
    const pointSampleGatePassed = source?.point_sample_gate?.passed === true &&
      pointEvaluated >= pointMinimum;
    if (probability === null || density === null) continue;
    byProbability.set(probability, {
      probability,
      density,
      confidence_above: pointSampleGatePassed ? rawConfidenceAbove : null,
      historical_hit_rate_above: historicalHitRateAbove,
      sample_count_above: sampleCountAbove,
      confidence_interval: confidenceInterval(source?.confidence_interval),
      point_sample_gate: {
        minimum_windows: pointMinimum,
        evaluated_windows: pointEvaluated,
        passed: pointSampleGatePassed,
      },
    });
  }
  const points = [...byProbability.values()]
    .sort((left, right) => left.probability - right.probability);
  const explicitlyInsufficient = [
    "insufficient",
    "insufficient_data",
  ].includes(payload.status);
  const status = explicitlyInsufficient || points.length < 2
    ? "insufficient"
    : payload.status === "preliminary"
      ? "preliminary"
      : sampleCount < minimumSampleCount || eventCount < minimumEventCount
        ? "insufficient"
        : "available";
  return {
    schema_version:
      payload.schema_version ?? "notification-threshold-calibration/1",
    horizon_hours: horizonHours,
    status,
    sample_count: sampleCount,
    min_sample_count: minimumSampleCount,
    event_count: eventCount,
    min_event_count: minimumEventCount,
    points,
  };
}

export function calibrationAt(points, threshold) {
  const target = Math.min(1, Math.max(0, Number(threshold) || 0));
  if (!Array.isArray(points) || points.length === 0) return null;
  const nearest = points.reduce((selected, point) =>
    Math.abs(point.probability - target) <
      Math.abs(selected.probability - target) - 1e-12
      ? point
      : selected,
  points[0]);
  return structuredClone(nearest);
}
