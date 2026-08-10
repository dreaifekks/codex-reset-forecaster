import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizedNotificationPreferences,
  probabilityCrossings,
  renderProbabilityAtom,
} from "../src/notifications/probability-feed.mjs";

function input(sequence, probability, issuedAt, outcomeRevisionGate = null) {
  const emittedAt = new Date(Date.parse(issuedAt) + 60_000).toISOString();
  return {
    schema_version: "notification-forecast-input/2",
    sequence,
    input_id: `forecast_input_${String(sequence).padStart(64, "0")}`,
    prediction_ref: { record_id: `prediction-${sequence}`, revision: 1 },
    prediction_hash: `sha256:${String(sequence).padStart(64, "0")}`,
    issued_at: issuedAt,
    emitted_at: emittedAt,
    knowledge_cutoff: issuedAt,
    expires_at: new Date(Date.parse(emittedAt) + 45 * 60_000).toISOString(),
    serving_stage: "validated",
    probabilities: Array.from({ length: 168 }, () => probability),
    outcome_revision_gate: outcomeRevisionGate ?? {
      revision_token: null,
      latest_known_at: null,
      closes_episode: false,
      current_outcomes: [],
    },
  };
}

test("notification preferences are bounded and preserve an exact horizon", () => {
  assert.deepEqual(normalizedNotificationPreferences({
    schema_version: "notification-preferences/1",
    horizon_hours: 24,
    probability_threshold: 0.6,
  }), {
    schema_version: "notification-preferences/1",
    horizon_hours: 24,
    probability_threshold: 0.6,
  });
  assert.throws(
    () => normalizedNotificationPreferences({
      schema_version: "notification-preferences/1",
      horizon_hours: 0,
      probability_threshold: 0.5,
    }),
    /horizon_hours must be an integer/,
  );
  assert.throws(
    () => normalizedNotificationPreferences({
      schema_version: "notification-preferences/1",
      horizon_hours: 4,
      probability_threshold: 1,
    }),
    /probability_threshold must be from/,
  );
});

test("probability crossings baseline, rearm with hysteresis, and do not chatter", () => {
  const inputs = [
    input(1, 0.55, "2026-08-10T00:00:00.000Z"),
    input(2, 0.61, "2026-08-10T00:10:00.000Z"),
    input(3, 0.59, "2026-08-10T00:20:00.000Z"),
    input(4, 0.54, "2026-08-10T00:30:00.000Z"),
    input(5, 0.62, "2026-08-10T00:40:00.000Z"),
  ];
  assert.deepEqual(
    probabilityCrossings(inputs, {
      schema_version: "notification-preferences/1",
      horizon_hours: 4,
      probability_threshold: 0.6,
    }, { baselineSequence: 0 }).map(({ input: value }) => value.sequence),
    [2, 5],
  );
});

test("Atom replay uses each input outcome gate and only publishes the current cycle", () => {
  const confirmedGate = {
    revision_token: "outcome-gate-confirmed",
    latest_known_at: "2026-08-10T00:20:00.000Z",
    closes_episode: true,
    current_outcomes: [{
      outcome_ref: { record_id: "reset-outcome-1", revision: 1 },
      outcome_token: "reset-outcome-1@1",
      status: "eligible_confirmed",
      known_at: "2026-08-10T00:20:00.000Z",
      occurred_time_range: {
        start: "2026-08-10T00:15:00.000Z",
        end: "2026-08-10T00:16:00.000Z",
      },
    }],
  };
  const inputs = [
    input(1, 0.4, "2026-08-10T00:00:00.000Z"),
    input(2, 0.7, "2026-08-10T00:10:00.000Z"),
    input(3, 0.7, "2026-08-10T00:30:00.000Z", confirmedGate),
    input(4, 0.7, "2026-08-10T00:40:00.000Z", confirmedGate),
  ];
  assert.deepEqual(
    probabilityCrossings(inputs, {
      schema_version: "notification-preferences/1",
      horizon_hours: 4,
      probability_threshold: 0.6,
    }, {
      baselineSequence: 0,
      outcomeRevisionGate: confirmedGate,
    }).map(({ input: value }) => value.sequence),
    [4],
  );
});

test("personalized Atom self link carries parameters and omits expired crossings", () => {
  const inputs = [
    input(1, 0.4, "2026-08-10T00:00:00.000Z"),
    input(2, 0.7, "2026-08-10T00:20:00.000Z"),
    input(3, 0.4, "2026-08-10T00:40:00.000Z"),
    input(4, 0.8, "2026-08-10T00:50:00.000Z"),
  ];
  const rendered = renderProbabilityAtom(inputs, {
    schema_version: "notification-preferences/1",
    horizon_hours: 24,
    probability_threshold: 0.6,
  }, {
    publicBaseUrl: "https://reset.example",
    now: "2026-08-10T01:10:00.000Z",
    baselineSequence: 0,
    entryRetentionHours: 0.5,
  });
  assert.equal(rendered.event_count, 1);
  assert.match(
    rendered.body,
    /horizon_hours=24&amp;probability_threshold=0.6&amp;after=0/,
  );
  assert.match(rendered.body, /80.0%/);
  assert.doesNotMatch(rendered.body, /70.0%/);
  assert.match(rendered.body, /不是已确认重置/);
  assert.match(rendered.body, /2026-08-10T00:51:00.000Z/);
});

test("Atom baseline is explicit and Web Push expiry does not shorten 24h feed retention", () => {
  const inputs = [
    input(1, 0.4, "2026-08-10T00:00:00.000Z"),
    input(2, 0.7, "2026-08-10T00:10:00.000Z"),
    input(3, 0.4, "2026-08-10T00:20:00.000Z"),
    input(4, 0.8, "2026-08-10T00:30:00.000Z"),
  ];
  const preferences = {
    schema_version: "notification-preferences/1",
    horizon_hours: 4,
    probability_threshold: 0.6,
  };
  assert.deepEqual(
    probabilityCrossings(inputs, preferences, { baselineSequence: 2 })
      .map(({ input: value }) => value.sequence),
    [4],
  );
  const rendered = renderProbabilityAtom(inputs.slice(0, 2), preferences, {
    publicBaseUrl: "https://reset.example",
    now: "2026-08-10T01:30:00.000Z",
    baselineSequence: 1,
  });
  assert.equal(rendered.event_count, 1);
  assert.match(rendered.body, /70.0%/);
  assert.match(rendered.body, /预测签发时间/);
  assert.match(rendered.body, /提醒生成时间/);
  const otherBaseline = renderProbabilityAtom(inputs.slice(0, 2), preferences, {
    publicBaseUrl: "https://reset.example",
    now: "2026-08-10T01:30:00.000Z",
    baselineSequence: 0,
  });
  assert.notEqual(
    rendered.body.match(/<id>([^<]+)<\/id>/)?.[1],
    otherBaseline.body.match(/<id>([^<]+)<\/id>/)?.[1],
  );
});

test("pruned and reset baselines fail closed but can rearm in retained history", () => {
  const preferences = {
    schema_version: "notification-preferences/1",
    horizon_hours: 4,
    probability_threshold: 0.6,
  };
  const retained = [
    input(513, 0.58, "2026-08-10T00:00:00.000Z"),
    input(514, 0.61, "2026-08-10T00:10:00.000Z"),
  ];
  assert.deepEqual(
    probabilityCrossings(retained, preferences, { baselineSequence: 512 })
      .map(({ input: value }) => value.sequence),
    [],
  );
  retained.push(
    input(515, 0.54, "2026-08-10T00:20:00.000Z"),
    input(516, 0.62, "2026-08-10T00:30:00.000Z"),
  );
  assert.deepEqual(
    probabilityCrossings(retained, preferences, { baselineSequence: 512 })
      .map(({ input: value }) => value.sequence),
    [516],
  );

  const resetInputs = retained.map((value, index) => ({
    ...value,
    sequence: index + 1,
    input_id: `forecast_input_${String(index + 1).padStart(64, "0")}`,
    prediction_ref: { record_id: `reset-${index + 1}`, revision: 1 },
  }));
  const resetCrossings = probabilityCrossings(resetInputs, preferences, {
    baselineSequence: 999,
  });
  assert.deepEqual(
    resetCrossings.map(({ input: value }) => value.sequence),
    [4],
  );
  assert.equal(resetCrossings.retention_reset, true);
  assert.equal(resetCrossings.reset_reason, "cursor_ahead_after_stream_reset");
});
