import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { addHours } from "../src/core/time.mjs";
import { generateDemoHistory } from "../src/demo/history.mjs";
import {
  DEFAULT_LIVE_FORECAST_PROMOTION_GUARD_POLICY,
  LIVE_FORECAST_PROMOTION_GUARD_VERSION,
  assessLiveForecastPromotionGuard,
} from "../src/model/live-forecast-guard.mjs";
import { trainChallenger } from "../src/model/training.mjs";
import {
  processRecords,
  runPipeline,
  trainEvaluatePromote,
} from "../src/pipeline/run.mjs";
import { FixtureProvider } from "../src/providers/fixture-provider.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

function model({
  version,
  intercept = -6,
  weight = 0,
} = {}) {
  return {
    model_version: version,
    artifact_hash: `${version}-artifact`,
    training_cutoff: "2026-07-29T04:00:00.000Z",
    feature_names: ["live_signal"],
    means: [0],
    scales: [1],
    weights: [intercept, weight],
    covariance: null,
    uncertainty: {
      status: "unavailable",
      reason: "fixture",
    },
    feature_transform: {
      version: "standardized-feature-transform/1",
      standardized_feature_clip: 8,
    },
  };
}

function snapshots({
  value = 0,
  outOfDistribution = false,
  count = 72,
} = {}) {
  return Array.from({ length: count }, (_, index) => ({
    record_id: `feature_${String(index).padStart(3, "0")}`,
    revision: 1,
    data: {
      target: {
        start: new Date(
          Date.parse("2026-07-29T05:00:00.000Z") + index * 3_600_000,
        ).toISOString(),
        end: new Date(
          Date.parse("2026-07-29T06:00:00.000Z") + index * 3_600_000,
        ).toISOString(),
      },
      features: { live_signal: value },
      data_quality: {
        out_of_distribution: outOfDistribution,
      },
    },
  }));
}

test("guard rejects an order-of-magnitude near-term surge driven by a positive clip-bound contribution", () => {
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: -6,
      weight: 1.2,
    }),
    previous: model({ version: "previous" }),
    snapshots: snapshots({ value: 100, outOfDistribution: true }),
  });

  assert.equal(
    result.schema_version,
    LIVE_FORECAST_PROMOTION_GUARD_VERSION,
  );
  assert.equal(result.mode, "enforced");
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, [
    "candidate_cumulative_probability_exceeds_safety_limit",
    "combined_positive_clip_bound_contribution_exceeded",
    "probability_anomaly_on_out_of_distribution_snapshots",
  ]);
  assert.equal(
    result.data_quality_audit.out_of_distribution_snapshot_count,
    72,
  );
  assert.equal(result.data_quality_audit.blocking, true);
  assert.equal(
    result.candidate_clip_diagnostics
      .large_positive_clip_bound_features[0].feature_name,
    "live_signal",
  );
  assert.ok(
    result.candidate_clip_diagnostics
      .large_positive_clip_bound_features[0]
      .peak_positive_logit_contribution > 9,
  );
  assert.equal(
    result.probability_comparison.first_rolling_4h.surge,
    true,
  );
  assert.ok(
    result.probability_comparison.first_rolling_4h.ratio > 10,
  );
});

test("out-of-distribution data quality alone remains an audit signal", () => {
  const stable = model({ version: "stable" });
  const result = assessLiveForecastPromotionGuard({
    candidate: model({ version: "candidate" }),
    previous: stable,
    snapshots: snapshots({ outOfDistribution: true }),
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(
    result.data_quality_audit.out_of_distribution_snapshot_count,
    72,
  );
});

test("an unsafe clip-bound candidate is blocked even when the previous model matches it", () => {
  const previous = model({
    version: "previous",
    intercept: -6,
    weight: 1.2,
  });
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: -6,
      weight: 1.2,
    }),
    previous,
    snapshots: snapshots({ value: 100 }),
  });

  assert.equal(
    result.candidate_clip_diagnostics
      .large_positive_clip_bound_features.length,
    1,
  );
  assert.equal(
    result.probability_comparison.first_rolling_4h.surge,
    false,
  );
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes(
      "combined_positive_clip_bound_contribution_exceeded",
    ),
  );
});

test("a first bootstrap blocks probability saturation driven by a positive clip-bound contribution", () => {
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: -6,
      weight: 1.2,
    }),
    snapshots: snapshots({ value: 100 }),
  });

  assert.equal(result.mode, "bootstrap_enforced");
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes(
      "candidate_cumulative_probability_exceeds_safety_limit",
    ),
  );
  assert.ok(
    result.blockers.includes(
      "combined_positive_clip_bound_contribution_exceeded",
    ),
  );
  assert.ok(
    result.probability_comparison.first_rolling_4h.candidate >
      DEFAULT_LIVE_FORECAST_PROMOTION_GUARD_POLICY
        .maximum_cumulative_probability_by_horizon["4"],
  );
  assert.equal(
    result.candidate_clip_diagnostics
      .large_positive_clip_bound_features.length,
    1,
  );
});

test("a non-saturated first bootstrap passes without a migration baseline", () => {
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: -6,
      weight: 0,
    }),
    snapshots: snapshots({ value: 100 }),
  });

  assert.equal(result.mode, "bootstrap_enforced");
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
});

test("guard policy rejects a zero probability-ratio denominator floor", () => {
  assert.throws(
    () =>
      assessLiveForecastPromotionGuard({
        candidate: model({ version: "candidate" }),
        snapshots: snapshots(),
        policy: {
          ...DEFAULT_LIVE_FORECAST_PROMOTION_GUARD_POLICY,
          probability_ratio_denominator_floor: 0,
        },
      }),
    /supported versioned thresholds/,
  );
});

test("a saturated candidate is blocked even without a clip-bound contribution", () => {
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: 3,
      weight: 0,
    }),
    previous: model({ version: "previous" }),
    snapshots: snapshots({ value: 0 }),
  });

  assert.equal(
    result.probability_comparison.first_rolling_4h.surge,
    true,
  );
  assert.deepEqual(
    result.candidate_clip_diagnostics.large_positive_clip_bound_features,
    [],
  );
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes(
      "candidate_cumulative_probability_exceeds_safety_limit",
    ),
  );
});

test("same-snapshot clipped contributions are combined before the threshold", () => {
  const candidate = {
    ...model({ version: "candidate" }),
    feature_names: ["first", "second"],
    means: [0, 0],
    scales: [1, 1],
    weights: [-12, 0.35, 0.35],
  };
  const liveSnapshots = snapshots().map((snapshot) => ({
    ...snapshot,
    data: {
      ...snapshot.data,
      features: { first: 100, second: 100 },
    },
  }));
  const result = assessLiveForecastPromotionGuard({
    candidate,
    snapshots: liveSnapshots,
  });

  assert.equal(
    result.candidate_clip_diagnostics
      .large_positive_clip_bound_features.length,
    0,
  );
  assert.equal(
    result.candidate_clip_diagnostics
      .peak_combined_positive_clip_logit_contribution
      .positive_logit_contribution,
    5.6,
  );
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, [
    "combined_positive_clip_bound_contribution_exceeded",
  ]);
});

test("a normal four-hour forecast cannot hide 24-hour saturation", () => {
  const hourlyHazard = 0.18;
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: Math.log(hourlyHazard / (1 - hourlyHazard)),
    }),
    snapshots: snapshots(),
  });

  assert.equal(
    result.probability_comparison.cumulative_by_horizon["4"]
      .safety_limit_exceeded,
    false,
  );
  assert.equal(
    result.probability_comparison.cumulative_by_horizon["24"]
      .safety_limit_exceeded,
    true,
  );
  assert.equal(result.passed, false);
});

test("a normal 24-hour forecast cannot hide 72-hour saturation", () => {
  const hourlyHazard = 0.08;
  const result = assessLiveForecastPromotionGuard({
    candidate: model({
      version: "candidate",
      intercept: Math.log(hourlyHazard / (1 - hourlyHazard)),
    }),
    snapshots: snapshots(),
  });

  assert.equal(
    result.probability_comparison.cumulative_by_horizon["24"]
      .safety_limit_exceeded,
    false,
  );
  assert.equal(
    result.probability_comparison.cumulative_by_horizon["72"]
      .safety_limit_exceeded,
    true,
  );
  assert.equal(result.passed, false);
});

test("pipeline restores and serves the previous provisional challenger when the live guard rejects a refit", async (t) => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "reset-forecaster-live-guard-",
  ));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: {
      data_dir: directory,
      provisional_bootstrap: {
        enabled: true,
        minimum_outcomes: 3,
      },
    },
    model: {
      max_iterations: 450,
      minimum_outcomes: 3,
      outcome_coverage_providers: ["demo"],
      live_forecast_promotion_guard: {
        enabled: true,
      },
    },
  } });
  const store = await new JsonlStore(directory).init();
  const now = new Date("2026-07-29T04:00:00.000Z");
  await new FixtureProvider({
    items: generateDemoHistory({ now, days: 84 }),
    name: "demo",
    now: () => now,
  }).collect(store);
  await processRecords(store, config, { now });
  const previous = (await trainChallenger(store, config, {
    trainingCutoff: now,
  })).model;
  assert.equal(await store.readModel("champion"), null);

  let inspectionCount = 0;
  const pipeline = await runPipeline(store, config, {
    now: addHours(now, 1),
    collect: false,
    retrain: true,
    assessPromotionGuard({ candidate, previous: compared, snapshots: live }) {
      inspectionCount += 1;
      assert.equal(live.length, 168);
      if (inspectionCount === 2) {
        assert.equal(compared, null);
        assert.equal(candidate.artifact_hash, previous.artifact_hash);
        return {
          schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
          mode: "bootstrap_enforced",
          passed: true,
          blockers: [],
        };
      }
      assert.equal(compared.artifact_hash, previous.artifact_hash);
      assert.notEqual(candidate.artifact_hash, previous.artifact_hash);
      return {
        schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
        mode: "enforced",
        passed: false,
        blockers: ["candidate_cumulative_probability_exceeds_safety_limit"],
      };
    },
  });

  assert.equal(inspectionCount, 2);
  assert.equal(pipeline.status, "promotion_blocked");
  assert.equal(pipeline.training.status, "promotion_blocked");
  assert.equal(pipeline.training.succeeded, true);
  assert.equal(
    pipeline.training.promotion.reason,
    "live_forecast_promotion_guard_rejected",
  );
  assert.equal(pipeline.promotion_guard.passed, false);
  assert.equal(
    pipeline.promotion_guard.challenger_restoration.restored,
    true,
  );
  assert.equal(
    pipeline.promotion_guard.challenger_restoration
      .restored_model_version,
    previous.model_version,
  );
  assert.equal(
    pipeline.promotion_guard.challenger_restoration.guard.passed,
    true,
  );
  assert.equal(
    (await store.readModel("challenger")).artifact_hash,
    previous.artifact_hash,
  );
  assert.equal(await store.readModel("champion"), null);
  assert.equal(
    pipeline.forecast.prediction.data.model.artifact_hash,
    previous.artifact_hash,
  );
  assert.equal(
    pipeline.forecast.prediction.data.model.validation_status,
    "provisional",
  );
  assert.deepEqual(
    (await store.all("prediction")).map(
      (prediction) => prediction.data.model.artifact_hash,
    ),
    [previous.artifact_hash],
  );

  let reuseInspected = false;
  const reused = await runPipeline(store, config, {
    now: addHours(now, 2),
    collect: false,
    retrain: false,
    assessPromotionGuard({ candidate, previous: compared, snapshots: live }) {
      reuseInspected = true;
      assert.equal(candidate.artifact_hash, previous.artifact_hash);
      assert.equal(compared, null);
      assert.equal(live.length, 168);
      return {
        schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
        mode: "bootstrap_enforced",
        passed: true,
        blockers: [],
      };
    },
  });
  assert.equal(reuseInspected, true);
  assert.equal(reused.training.reused_challenger, true);
  assert.equal(reused.promotion_guard.passed, true);
  assert.equal(
    reused.forecast.prediction.data.model.artifact_hash,
    previous.artifact_hash,
  );
});

test("cold bootstrap rejection never persists or serves the rejected candidate", async (t) => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "reset-forecaster-cold-guard-",
  ));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: {
      data_dir: directory,
      provisional_bootstrap: {
        enabled: true,
        minimum_outcomes: 3,
      },
    },
    model: {
      max_iterations: 450,
      minimum_outcomes: 3,
      outcome_coverage_providers: ["demo"],
    },
  } });
  const store = await new JsonlStore(directory).init();
  const now = new Date("2026-07-29T04:00:00.000Z");
  await new FixtureProvider({
    items: generateDemoHistory({ now, days: 84 }),
    name: "demo",
    now: () => now,
  }).collect(store);
  await processRecords(store, config, { now });

  const pipeline = await runPipeline(store, config, {
    now,
    collect: false,
    retrain: true,
    assessPromotionGuard() {
      return {
        schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
        mode: "bootstrap_enforced",
        passed: false,
        blockers: [
          "bootstrap_probability_saturation_with_positive_clip_bound_contribution",
        ],
      };
    },
  });

  assert.equal(pipeline.status, "promotion_blocked");
  assert.equal(pipeline.forecast, null);
  assert.equal(await store.readModel("champion"), null);
  assert.equal(await store.readModel("challenger"), null);
  assert.deepEqual(await store.all("prediction"), []);
});

test("an enabled guard cannot be bypassed by calling trainEvaluatePromote directly", async (t) => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "reset-forecaster-required-guard-",
  ));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: { runtime: { data_dir: directory } },
  });
  const store = await new JsonlStore(directory).init();

  await assert.rejects(
    trainEvaluatePromote(store, config, {
      now: new Date("2026-07-29T04:00:00.000Z"),
    }),
    /requires an evaluated live snapshot set/,
  );
  assert.equal(await store.readModel("challenger"), null);
});

test("pipeline compares against the serving champion and restores a pre-existing pending challenger", async (t) => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "reset-forecaster-serving-guard-",
  ));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: {
      data_dir: directory,
      provisional_bootstrap: {
        enabled: true,
        minimum_outcomes: 3,
      },
    },
    model: {
      max_iterations: 450,
      minimum_outcomes: 3,
      outcome_coverage_providers: ["demo"],
    },
  } });
  const store = await new JsonlStore(directory).init();
  const now = new Date("2026-07-29T04:00:00.000Z");
  await new FixtureProvider({
    items: generateDemoHistory({ now, days: 84 }),
    name: "demo",
    now: () => now,
  }).collect(store);
  await processRecords(store, config, { now });
  const champion = (await trainChallenger(store, config, {
    trainingCutoff: now,
  })).model;
  await store.writeModel("champion", champion);
  const pending = (await trainChallenger(store, config, {
    trainingCutoff: addHours(now, 1),
  })).model;
  assert.notEqual(pending.artifact_hash, champion.artifact_hash);

  let inspected = false;
  const pipeline = await runPipeline(store, config, {
    now: addHours(now, 2),
    collect: false,
    retrain: true,
    assessPromotionGuard({ previous }) {
      inspected = true;
      assert.equal(previous.artifact_hash, champion.artifact_hash);
      return {
        schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
        mode: "enforced",
        passed: false,
        blockers: [
          "live_probability_surge_with_positive_clip_bound_contribution",
        ],
      };
    },
  });

  assert.equal(inspected, true);
  assert.equal(pipeline.status, "promotion_blocked");
  assert.equal(
    pipeline.forecast.prediction.data.model.artifact_hash,
    champion.artifact_hash,
  );
  assert.equal(
    (await store.readModel("challenger")).artifact_hash,
    pending.artifact_hash,
  );
  assert.equal(
    pipeline.promotion_guard.challenger_restoration.source,
    "previous_challenger",
  );
});
