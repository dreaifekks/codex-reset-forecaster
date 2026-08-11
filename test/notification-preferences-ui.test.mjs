import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_CALIBRATION_CACHE_TTL_MS,
  NOTIFICATION_HORIZON_HOURS,
  calibrationAt,
  createNotificationCalibrationCache,
  formatNotificationHorizon,
  nearestHorizonIndex,
  normalizeCalibrationPayload,
} from "../public/notification-preferences.js";

test("notification horizon slider uses the requested non-linear scale", () => {
  assert.deepEqual(NOTIFICATION_HORIZON_HOURS, [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    16, 20, 24, 28, 32, 36, 40, 44, 48,
    60, 72, 84, 96,
    120, 144, 168,
  ]);
  assert.equal(nearestHorizonIndex(24), 14);
  assert.equal(NOTIFICATION_HORIZON_HOURS[nearestHorizonIndex(13)], 12);
  assert.equal(formatNotificationHorizon(72), "3 天（72 小时）");
});

test("calibration cache reuses a horizon only within its bounded page-session lifetime", () => {
  let now = 1_000;
  const cache = createNotificationCalibrationCache({ now: () => now });
  const calibration = {
    schema_version: "notification-threshold-calibration/1",
    horizon_hours: 24,
    status: "available",
    points: [],
  };

  cache.set(24, calibration);
  assert.deepEqual(cache.get(24), calibration);
  assert.equal(cache.get(4), null, "another horizon must never reuse this payload");

  now += NOTIFICATION_CALIBRATION_CACHE_TTL_MS - 1;
  assert.deepEqual(cache.get(24), calibration);
  now += 1;
  assert.equal(cache.get(24), null, "the exact TTL boundary expires the entry");

  assert.throws(() => cache.set(4, calibration), /时间窗不匹配/);
  assert.throws(
    () => createNotificationCalibrationCache({ ttlMs: 0 }),
    /有效期必须大于零/,
  );
});

test("calibration payload keeps density separate from historical reliability", () => {
  const calibration = normalizeCalibrationPayload({
    schema_version: "notification-threshold-calibration/1",
    horizon_hours: 24,
    status: "available",
    sample_count: 80,
    min_sample_count: 20,
    event_count: 8,
    min_event_count: 5,
    points: [
      {
        probability: 0.2,
        density: 0.5,
        confidence_above: 0.4,
        historical_hit_rate_above: 0.4,
        sample_count_above: 50,
        confidence_interval: { lower: 0.27, upper: 0.54, level: 0.95, method: "wilson_score" },
        point_sample_gate: { minimum_windows: 20, evaluated_windows: 50, passed: true },
      },
      {
        probability: 0.6,
        density: 1,
        confidence_above: 0.8,
        sample_count_above: 20,
        point_sample_gate: { minimum_windows: 20, evaluated_windows: 20, passed: true },
      },
    ],
  }, 24);
  assert.equal(calibration.status, "available");
  assert.equal(calibration.event_count, 8);
  assert.equal(calibration.min_event_count, 5);
  const selected = calibrationAt(calibration.points, 0.4);
  assert.equal(selected.probability, 0.2);
  assert.equal(selected.density, 0.5);
  assert.equal(selected.confidence_above, 0.4);
  assert.equal(selected.sample_count_above, 50);
  assert.deepEqual(selected.confidence_interval, {
    lower: 0.27,
    upper: 0.54,
    level: 0.95,
    method: "wilson_score",
  });
  assert.equal(calibration.distribution_summary, null, "legacy payloads remain valid");
});

test("calibration payload strictly normalizes the optional distribution profile", () => {
  const distributionSummary = {
    mean_probability: 0.4,
    standard_deviation: 0.1,
    observed_range: { lower: 0.01, upper: 0.96 },
    display_range: {
      lower: 0.05,
      upper: 0.8,
      standard_deviations: 4,
      clipped_below: 2,
      clipped_above: 3,
    },
    suggested_threshold: {
      probability: 0.6,
      standard_deviations: 2,
    },
  };
  const calibration = normalizeCalibrationPayload({
    horizon_hours: 24,
    status: "available",
    sample_count: 80,
    min_sample_count: 20,
    event_count: 8,
    min_event_count: 1,
    distribution_summary: distributionSummary,
    points: [
      { probability: 0.05, density: 0.1 },
      { probability: 0.8, density: 0.1 },
    ],
  }, 24);

  assert.deepEqual(calibration.distribution_summary, distributionSummary);
  assert.throws(
    () => normalizeCalibrationPayload({
      ...calibration,
      distribution_summary: {
        ...distributionSummary,
        display_range: {
          ...distributionSummary.display_range,
          standard_deviations: "4",
        },
      },
    }, 24),
    /分布摘要无效/,
  );
  assert.throws(
    () => normalizeCalibrationPayload({
      ...calibration,
      distribution_summary: {
        ...distributionSummary,
        display_range: {
          ...distributionSummary.display_range,
          lower: "0.05",
        },
      },
    }, 24),
    /显示范围无效/,
  );
  assert.throws(
    () => normalizeCalibrationPayload({
      ...calibration,
      distribution_summary: {
        ...distributionSummary,
        suggested_threshold: {
          probability: null,
          standard_deviations: 2,
        },
      },
    }, 24),
    /分布摘要无效/,
  );
});

test("an explicitly empty distribution profile remains compatible with no-data windows", () => {
  const calibration = normalizeCalibrationPayload({
    horizon_hours: 4,
    status: "insufficient_data",
    distribution_summary: {
      mean_probability: null,
      standard_deviation: null,
      observed_range: { lower: null, upper: null },
      display_range: {
        lower: null,
        upper: null,
        standard_deviations: 4,
        clipped_below: 0,
        clipped_above: 0,
      },
      suggested_threshold: {
        probability: null,
        standard_deviations: 2,
      },
    },
    points: [],
  }, 4);

  assert.equal(calibration.status, "insufficient");
  assert.equal(calibration.distribution_summary.mean_probability, null);
  assert.equal(calibration.distribution_summary.display_range.lower, null);
});

test("calibration is explicitly insufficient when the sample gate is not met", () => {
  const calibration = normalizeCalibrationPayload({
    horizon_hours: 4,
    status: "available",
    sample_count: 8,
    min_sample_count: 20,
    points: [
      { probability: 0.2, density: 0.5, confidence_above: 0.3 },
      { probability: 0.8, density: 0.2, confidence_above: 0.7 },
    ],
  }, 4);
  assert.equal(calibration.status, "insufficient");
  assert.throws(
    () => normalizeCalibrationPayload({ ...calibration, horizon_hours: 24 }, 4),
    /时间窗不匹配/,
  );
});

test("preliminary calibration remains explicitly preliminary", () => {
  const calibration = normalizeCalibrationPayload({
    horizon_hours: 24,
    status: "preliminary",
    sample_count: 8,
    min_sample_count: 20,
    points: [
      { probability: 0.2, density: 0.5, confidence_above: 0.3 },
      { probability: 0.8, density: 0.2, confidence_above: 0.7 },
    ],
  }, 24);
  assert.equal(calibration.status, "preliminary");
  assert.equal(calibration.sample_count, 8);
});
