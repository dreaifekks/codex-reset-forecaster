import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_SUPPORT_POLICY_VERSION,
} from "../src/model/feature-support.mjs";
import {
  predictHazard,
  trainLogisticHazard,
} from "../src/model/logistic-hazard.mjs";

const policy = Object.freeze({
  version: FEATURE_SUPPORT_POLICY_VERSION,
  enabled: true,
  minimum_nonzero_positive_events: 3,
  minimum_nonzero_negative_hours: 24,
  maximum_absolute_pairwise_correlation: 0.995,
  nonzero_epsilon: 1e-12,
});

test("sparse event-only features are frozen at zero before fitting", () => {
  const examples = Array.from({ length: 48 }, () => ({
    type: "negative",
    row: [0, 0],
  }));
  examples.push({
    type: "event_interval",
    rows: [[1, 0.2], [1.1, 0.22]],
    exposures: [0.5, 0.5],
  });
  examples.push(...Array.from({ length: 3 }, () => ({
    type: "event_interval",
    rows: [[0, 0]],
    exposures: [1],
  })));

  const model = trainLogisticHazard(
    examples,
    ["renewal", "competitor"],
    {
      lambda: 2,
      maxIterations: 400,
      coefficientPriors: { renewal: 0.8 },
      featureSupportPolicy: policy,
    },
  );

  assert.deepEqual(model.feature_support.active_features, []);
  assert.deepEqual(
    model.feature_support.features.map((feature) => ({
      status: feature.status,
      positive: feature.positive_nonzero_event_count,
      negative: feature.negative_nonzero_hour_count,
      appliedPrior: feature.applied_raw_prior,
    })),
    [
      {
        status: "insufficient_positive_support",
        positive: 1,
        negative: 0,
        appliedPrior: 0,
      },
      {
        status: "insufficient_positive_support",
        positive: 1,
        negative: 0,
        appliedPrior: 0,
      },
    ],
  );
  assert.deepEqual(model.weights.slice(1), [0, 0]);
  assert.equal(
    predictHazard(model, [1e9, 1e9]).probability,
    predictHazard(model, [0, 0]).probability,
  );
});

test("positive support counts independent event intervals, not their rows", () => {
  const negatives = Array.from({ length: 24 }, (_, index) => ({
    type: "negative",
    row: [0.1 + index / 100],
  }));
  const events = [
    {
      type: "event_interval",
      rows: [[1], [0.9], [0.8]],
      exposures: [0.25, 0.5, 0.25],
    },
    {
      type: "event_interval",
      rows: [[1.1]],
      exposures: [1],
    },
    {
      type: "event_interval",
      rows: [[1.2]],
      exposures: [1],
    },
  ];
  const model = trainLogisticHazard(
    [...negatives, ...events],
    ["supported"],
    {
      lambda: 2,
      maxIterations: 500,
      featureSupportPolicy: policy,
    },
  );
  const support = model.feature_support.features[0];

  assert.equal(support.status, "active");
  assert.equal(support.positive_nonzero_event_count, 3);
  assert.equal(support.positive_nonzero_row_count, 5);
  assert.equal(support.negative_nonzero_hour_count, 24);
  assert.notEqual(model.weights[1], 0);
});

test("perfectly collinear supported features keep one deterministic representative", () => {
  const negatives = Array.from({ length: 24 }, (_, index) => {
    const value = 0.1 + index / 100;
    return { type: "negative", row: [value, value * 2] };
  });
  const events = [1, 1.1, 1.2].map((value) => ({
    type: "event_interval",
    rows: [[value, value * 2]],
    exposures: [1],
  }));
  const model = trainLogisticHazard(
    [...negatives, ...events],
    ["first", "duplicate"],
    {
      lambda: 2,
      maxIterations: 500,
      featureSupportPolicy: policy,
    },
  );

  assert.deepEqual(model.feature_support.active_features, ["first"]);
  assert.equal(
    model.feature_support.features[1].status,
    "collinear_duplicate",
  );
  assert.equal(model.feature_support.features[1].collinear_with, "first");
  assert.equal(model.weights[2], 0);
  assert.equal(
    predictHazard(model, [0.5, 0]).probability,
    predictHazard(model, [0.5, 1e9]).probability,
  );
});
