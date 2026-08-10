import assert from "node:assert/strict";
import test from "node:test";
import {
  createForecastInputProjector,
  createForecastInputStream,
  forecastHorizonProbabilities,
} from "../src/notifications/forecast-input.mjs";
import { hashLabel } from "../src/core/hash.mjs";

function memoryStore() {
  const states = new Map();
  return {
    states,
    async readState(key, fallback) {
      return structuredClone(states.has(key) ? states.get(key) : fallback);
    },
    async writeState(key, value) {
      states.set(key, structuredClone(value));
    },
  };
}

function prediction(id = "prediction-1") {
  let survival = 1;
  const slots = Array.from({ length: 168 }, (_, index) => {
    const hazard = 0.01;
    survival *= 1 - hazard;
    return {
      start: new Date(Date.parse("2026-08-10T00:00:00.000Z") + index * 3_600_000).toISOString(),
      end: new Date(Date.parse("2026-08-10T01:00:00.000Z") + index * 3_600_000).toISOString(),
      hazard,
      reset_by_end_probability: 1 - survival,
    };
  });
  return {
    record_id: id,
    revision: 1,
    data: {
      issued_at: "2026-08-10T00:00:00.000Z",
      knowledge_cutoff: "2026-08-10T00:00:00.000Z",
      horizon: {
        start: "2026-08-10T00:00:00.000Z",
        end: "2026-08-17T00:00:00.000Z",
      },
      slots,
    },
  };
}

function snapshot(value = prediction()) {
  return {
    prediction_ref: { record_id: value.record_id, revision: value.revision },
    prediction_hash: hashLabel(value),
    prediction: value,
    readiness: {
      serving_ready: true,
      synthetic_only: false,
      serving_stage: "validated",
      current_forecast: { status: "fresh" },
    },
  };
}

function config() {
  return {
    runtime: {
      publication: {
        probability_alert: { max_delivery_delay_minutes: 45 },
      },
    },
  };
}

test("forecast input stores a monotonic 1 through 168 hour cumulative curve", () => {
  const probabilities = forecastHorizonProbabilities(prediction());
  assert.equal(probabilities.length, 168);
  assert.ok(Math.abs(probabilities[0] - 0.01) < 1e-12);
  assert.ok(Math.abs(probabilities[23] - (1 - 0.99 ** 24)) < 1e-12);
  assert.ok(probabilities.every((value, index) =>
    index === 0 || value >= probabilities[index - 1]
  ));
});

test("forecast input projection is eligible, idempotent, and outcome-clock gated", async () => {
  const store = memoryStore();
  let outcomes = [];
  const stream = createForecastInputStream(store, {
    clock: () => new Date("2026-08-10T00:07:00.000Z"),
  });
  const projector = createForecastInputProjector({
    store,
    config: config(),
    stream,
    loadOutcomes: async () => outcomes,
  });
  const first = await projector.project({
    snapshot: snapshot(),
    emittedAt: "2026-08-10T00:05:00.000Z",
  });
  assert.equal(first.inserted, true);
  assert.equal(first.input.sequence, 1);
  assert.equal(first.input.schema_version, "notification-forecast-input/2");
  assert.equal(first.input.emitted_at, "2026-08-10T00:05:00.000Z");
  assert.equal(first.input.expires_at, "2026-08-10T00:45:00.000Z");
  assert.equal((await projector.stream.getCursor()), 1);
  assert.equal((await projector.project({
    snapshot: snapshot(),
    emittedAt: "2026-08-10T00:06:00.000Z",
  })).inserted, false);

  outcomes = [{
    outcome: {
      record_id: "outcome-1",
      revision: 1,
      data: {
        status: "confirmed",
        known_at: "2026-08-10T00:01:00.000Z",
        occurred_time_range: {
          start: "2026-08-09T23:00:00.000Z",
          end: "2026-08-10T00:00:00.000Z",
        },
      },
    },
    verification: {
      observation_ref: { record_id: "observation-1", revision: 1 },
    },
  }];
  const stale = prediction("prediction-2");
  const blocked = await projector.project({
    snapshot: snapshot(stale),
    emittedAt: "2026-08-10T00:07:00.000Z",
  });
  assert.deepEqual(blocked, {
    inserted: false,
    reason: "forecast_precedes_latest_outcome",
  });
  const currentGate = await projector.stream.currentOutcomeRevisionGate();
  assert.equal(currentGate.latest_known_at, "2026-08-10T00:07:00.000Z");
  assert.equal(currentGate.current_outcomes.length, 1);
  assert.equal(currentGate.current_outcomes[0].status, "eligible_confirmed");
  assert.deepEqual(first.input.outcome_revision_gate, {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
  });
});

test("forecast input stream exposes explicit retention and ahead resets", async () => {
  const store = memoryStore();
  const stream = createForecastInputStream(store, { retainedInputs: 32 });
  const base = snapshot().prediction;
  for (let index = 0; index < 34; index += 1) {
    const value = prediction(`prediction-${index}`);
    const candidate = {
      schema_version: "notification-forecast-input/2",
      input_id: `forecast_input_${String(index).padStart(64, "0")}`,
      prediction_ref: { record_id: value.record_id, revision: 1 },
      prediction_hash: hashLabel(value),
      issued_at: base.data.issued_at,
      emitted_at: "2026-08-10T00:05:00.000Z",
      knowledge_cutoff: base.data.knowledge_cutoff,
      expires_at: "2026-08-10T00:45:00.000Z",
      serving_stage: "validated",
      probabilities: forecastHorizonProbabilities(value),
      outcome_revision_gate: {
        revision_token: null,
        latest_known_at: null,
        closes_episode: false,
        current_outcomes: [],
      },
    };
    await stream.append(candidate);
  }
  await assert.rejects(
    stream.listAfter(0),
    (error) => error.code === "forecast_input_cursor_reset_required" &&
      error.reason === "retention_gap" && error.cursor === 2,
  );
  await assert.rejects(
    stream.listAfter(35),
    (error) => error.code === "forecast_input_cursor_reset_required" &&
      error.reason === "ahead_of_tail" && error.cursor === 34,
  );
  const page = await stream.listAfter(2, { limit: 3 });
  assert.deepEqual(page.inputs.map((input) => input.sequence), [3, 4, 5]);
  assert.equal(page.has_more, true);
});

test("legacy forecast input state is reset instead of fabricating emitted_at", async () => {
  const store = memoryStore();
  store.states.set("notification-forecast-inputs", {
    schema_version: "notification-forecast-input-stream/1",
    next_sequence: 2,
    last_input_id: `forecast_input_${"1".padStart(64, "0")}`,
    inputs: [{
      schema_version: "notification-forecast-input/1",
      sequence: 1,
      input_id: `forecast_input_${"1".padStart(64, "0")}`,
      prediction_ref: { record_id: "legacy", revision: 1 },
      prediction_hash: hashLabel(prediction("legacy")),
      issued_at: "2026-08-10T00:00:00.000Z",
      knowledge_cutoff: "2026-08-10T00:00:00.000Z",
      expires_at: "2026-08-10T00:45:00.000Z",
      serving_stage: "validated",
      probabilities: forecastHorizonProbabilities(prediction("legacy")),
    }],
  });
  const stream = createForecastInputStream(store);
  assert.equal(await stream.getCursor(), 0);
  assert.equal(await stream.latest(), null);
});
