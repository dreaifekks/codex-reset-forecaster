import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHorizonCumulativeCurve,
  normalizeNotificationPreferences,
  probabilityAtHorizon,
  probabilityCloseThreshold,
  transitionProbabilitySubscription,
} from "../src/notifications/subscription-policy.mjs";

const PREFERENCES = {
  schema_version: "notification-preferences/1",
  horizon_hours: 4,
  probability_threshold: 0.5,
};

function slots(hazards) {
  const start = Date.parse("2026-08-10T00:00:00.000Z");
  return hazards.map((hazard, index) => ({
    start: new Date(start + index * 3_600_000).toISOString(),
    end: new Date(start + (index + 1) * 3_600_000).toISOString(),
    hazard,
  }));
}

function curveWithProbabilityAtFourHours(value) {
  return [0.1, 0.2, 0.3, value].map((probability, index) => ({
    horizon_hours: index + 1,
    probability: Math.min(probability, value),
  }));
}

function snapshot({
  id,
  issuedAt,
  probability,
  knowledgeCutoff = issuedAt,
  emittedAt = new Date(Date.parse(issuedAt) + 60_000).toISOString(),
  expiresAt = new Date(Date.parse(issuedAt) + 46 * 60_000).toISOString(),
} = {}) {
  return {
    schema_version: "notification-probability-snapshot/1",
    prediction_ref: { record_id: id, revision: 1 },
    issued_at: issuedAt,
    knowledge_cutoff: knowledgeCutoff,
    emitted_at: emittedAt,
    expires_at: expiresAt,
    horizon_probabilities: curveWithProbabilityAtFourHours(probability),
  };
}

function gate(overrides = {}) {
  return {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
    ...overrides,
  };
}

function eligibleOutcome({
  id = "outcome-1",
  revision = 1,
  token = `${id}@${revision}`,
  knownAt = "2026-08-10T00:19:30.000Z",
  start = "2026-08-10T00:15:00.000Z",
  end = "2026-08-10T00:16:00.000Z",
} = {}) {
  return {
    outcome_ref: { record_id: id, revision },
    outcome_token: token,
    status: "eligible_confirmed",
    known_at: knownAt,
    occurred_time_range: { start, end },
  };
}

function transition({ state = null, current, outcomeGate = gate(), preferences = PREFERENCES }) {
  return transitionProbabilitySubscription({
    preferences,
    previousState: state,
    snapshot: current,
    outcomeRevisionGate: outcomeGate,
    evaluatedAt: current.emitted_at,
  });
}

test("notification preferences are strict and retain the legacy 4h/50% default", () => {
  assert.deepEqual(normalizeNotificationPreferences(), PREFERENCES);
  const custom = {
    schema_version: "notification-preferences/1",
    horizon_hours: 168,
    probability_threshold: 0.725,
  };
  assert.deepEqual(normalizeNotificationPreferences(custom), custom);
  for (const invalid of [
    null,
    {},
    { ...PREFERENCES, schema_version: "notification-preferences/2" },
    { ...PREFERENCES, horizon_hours: 0 },
    { ...PREFERENCES, horizon_hours: 169 },
    { ...PREFERENCES, horizon_hours: 1.5 },
    { ...PREFERENCES, probability_threshold: 0 },
    { ...PREFERENCES, probability_threshold: -0.01 },
    { ...PREFERENCES, probability_threshold: 1 },
    { ...PREFERENCES, probability_threshold: 1.01 },
    { ...PREFERENCES, probability_threshold: "0.5" },
    { ...PREFERENCES, extra: true },
  ]) {
    assert.throws(() => normalizeNotificationPreferences(invalid));
  }
  assert.equal(probabilityCloseThreshold(PREFERENCES), 0.45);
  assert.equal(probabilityCloseThreshold({
    ...PREFERENCES,
    probability_threshold: 0.03,
  }), 0);
});

test("hourly hazards become a monotonic cumulative 1..168h curve", () => {
  const curve = buildHorizonCumulativeCurve(slots([0.1, 0.2, 0.3, 1]));
  assert.deepEqual(curve.map((point) => point.horizon_hours), [1, 2, 3, 4]);
  assert.ok(Math.abs(curve[0].probability - 0.1) < 1e-12);
  assert.ok(Math.abs(curve[1].probability - 0.28) < 1e-12);
  assert.ok(Math.abs(curve[2].probability - 0.496) < 1e-12);
  assert.equal(curve[3].probability, 1);
  assert.equal(probabilityAtHorizon(curve, 3), curve[2].probability);

  const long = buildHorizonCumulativeCurve(slots(Array(200).fill(0.001)));
  assert.equal(long.length, 168);
  assert.equal(long.at(-1).horizon_hours, 168);
});

test("curve construction rejects gaps, non-hour slots, and malformed probabilities", () => {
  const gap = slots([0.1, 0.2]);
  gap[1].start = "2026-08-10T02:00:00.000Z";
  gap[1].end = "2026-08-10T03:00:00.000Z";
  assert.throws(() => buildHorizonCumulativeCurve(gap), /contiguous/);

  const longSlot = slots([0.1]);
  longSlot[0].end = "2026-08-10T02:00:00.000Z";
  assert.throws(() => buildHorizonCumulativeCurve(longSlot), /exactly one hour/);
  assert.throws(
    () => buildHorizonCumulativeCurve(slots([Number.NaN])),
    /finite probability/,
  );
  assert.throws(
    () => probabilityAtHorizon([
      { horizon_hours: 1, probability: 0.4 },
      { horizon_hours: 2, probability: 0.3 },
    ], 2),
    /must not decrease/,
  );
});

test("the first snapshot is a silent baseline and duplicate predictions are idempotent", () => {
  const current = snapshot({
    id: "prediction-1",
    issuedAt: "2026-08-10T00:00:00.000Z",
    probability: 0.7,
  });
  const baseline = transition({ current });
  assert.equal(baseline.accepted, true);
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.transition, null);
  assert.equal(baseline.state.active, true);
  assert.equal(baseline.state.open_notification_emitted, false);

  const duplicate = transition({ state: baseline.state, current });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "duplicate_prediction");
  assert.deepEqual(duplicate.state, baseline.state);
});

test("a sparse result-UI projection preserves the same silent crossing semantics", () => {
  const preferences = {
    schema_version: "notification-preferences/1",
    horizon_hours: 24,
    probability_threshold: 0.5,
  };
  const sparseSnapshot = (id, issuedAt, probability) => ({
    ...snapshot({ id, issuedAt, probability }),
    schema_version: "notification-probability-snapshot/2",
    horizon_probabilities: [
      { horizon_hours: 4, probability: Math.min(0.3, probability) },
      { horizon_hours: 24, probability },
    ],
  });
  const baseline = transition({
    current: sparseSnapshot(
      "prediction-sparse-1",
      "2026-08-10T00:00:00.000Z",
      0.4,
    ),
    preferences,
  });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.transition, null);
  const opened = transition({
    state: baseline.state,
    current: sparseSnapshot(
      "prediction-sparse-2",
      "2026-08-10T00:10:00.000Z",
      0.7,
    ),
    preferences,
  });
  assert.equal(opened.transition.kind, "opened");
  assert.equal(opened.transition.probability, 0.7);
  assert.throws(
    () => transition({
      current: {
        ...sparseSnapshot(
          "prediction-sparse-missing",
          "2026-08-10T00:20:00.000Z",
          0.8,
        ),
        horizon_probabilities: [{ horizon_hours: 4, probability: 0.3 }],
      },
      preferences,
    }),
    /outside the available probability projection/,
  );
});

test("a watch opens once, holds through hysteresis, closes once, and can reopen", () => {
  let result = transition({
    current: snapshot({
      id: "prediction-0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.4,
    }),
  });
  assert.equal(result.state.active, false);

  result = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.5,
    }),
  });
  assert.equal(result.transition, null, "opening is strictly above the threshold");

  result = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-2",
      issuedAt: "2026-08-10T00:20:00.000Z",
      probability: 0.6,
    }),
  });
  assert.equal(result.transition.kind, "opened");
  const firstEpisode = result.transition.episode_id;

  result = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-3",
      issuedAt: "2026-08-10T00:30:00.000Z",
      probability: 0.47,
    }),
  });
  assert.equal(result.transition, null);
  assert.equal(result.state.active, true);

  result = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-4",
      issuedAt: "2026-08-10T00:40:00.000Z",
      probability: 0.45,
    }),
  });
  assert.equal(result.transition.kind, "closed");
  assert.equal(result.transition.episode_id, firstEpisode);
  assert.equal(result.state.active, false);

  result = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-5",
      issuedAt: "2026-08-10T00:50:00.000Z",
      probability: 0.7,
    }),
  });
  assert.equal(result.transition.kind, "opened");
  assert.notEqual(result.transition.episode_id, firstEpisode);
});

test("changing preferences creates a new silent baseline instead of a synthetic crossing", () => {
  const baseline = transition({
    current: snapshot({
      id: "prediction-0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.4,
    }),
  });
  const changed = transition({
    state: baseline.state,
    preferences: {
      schema_version: "notification-preferences/1",
      horizon_hours: 4,
      probability_threshold: 0.3,
    },
    current: snapshot({
      id: "prediction-1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.4,
    }),
  });
  assert.equal(changed.baseline, true);
  assert.equal(changed.reason, "preferences_rebaselined");
  assert.equal(changed.transition, null);
  assert.equal(changed.state.active, true);
});

test("an outcome revision gates stale knowledge and can close only one notified episode", () => {
  let result = transition({
    current: snapshot({
      id: "prediction-0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.4,
    }),
  });
  result = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.7,
    }),
  });
  assert.equal(result.transition.kind, "opened");

  const stale = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-2",
      issuedAt: "2026-08-10T00:20:00.000Z",
      probability: 0.8,
      knowledgeCutoff: "2026-08-10T00:19:00.000Z",
    }),
    outcomeGate: gate({
      revision_token: "outcome-1@1",
      latest_known_at: "2026-08-10T00:19:30.000Z",
      closes_episode: true,
      current_outcomes: [eligibleOutcome()],
    }),
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "outcome_revision_not_in_knowledge_cutoff");
  assert.deepEqual(stale.state, result.state);

  const covered = transition({
    state: result.state,
    current: snapshot({
      id: "prediction-3",
      issuedAt: "2026-08-10T00:30:00.000Z",
      probability: 0.8,
      knowledgeCutoff: "2026-08-10T00:29:00.000Z",
    }),
    outcomeGate: gate({
      revision_token: "outcome-1@1",
      latest_known_at: "2026-08-10T00:19:30.000Z",
      closes_episode: true,
      current_outcomes: [eligibleOutcome()],
    }),
  });
  assert.equal(covered.transition.kind, "closed");
  assert.equal(covered.transition.reason, "outcome_revision_closed_episode");
  assert.equal(covered.state.active, false);

  const sameRevision = transition({
    state: covered.state,
    current: snapshot({
      id: "prediction-4",
      issuedAt: "2026-08-10T00:40:00.000Z",
      probability: 0.8,
      knowledgeCutoff: "2026-08-10T00:39:00.000Z",
    }),
    outcomeGate: gate({
      revision_token: "outcome-1@1",
      latest_known_at: "2026-08-10T00:19:30.000Z",
      closes_episode: true,
      current_outcomes: [eligibleOutcome()],
    }),
  });
  assert.equal(sameRevision.transition.kind, "opened");
});

test("a historical outcome correction stale-gates but never closes the current episode", () => {
  let result = transition({
    current: snapshot({
      id: "historical-baseline",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.4,
    }),
  });
  result = transition({
    state: result.state,
    current: snapshot({
      id: "current-episode",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.7,
    }),
  });
  assert.equal(result.transition.kind, "opened");
  const episodeId = result.transition.episode_id;

  const historicalGate = gate({
    revision_token: "historical-correction@2",
    latest_known_at: "2026-08-10T00:19:30.000Z",
    closes_episode: true,
    current_outcomes: [eligibleOutcome({
      id: "historical-outcome",
      revision: 2,
      token: "historical-outcome@2",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-01T01:00:00.000Z",
    })],
  });
  result = transition({
    state: result.state,
    current: snapshot({
      id: "post-correction",
      issuedAt: "2026-08-10T00:30:00.000Z",
      probability: 0.8,
      knowledgeCutoff: "2026-08-10T00:29:00.000Z",
    }),
    outcomeGate: historicalGate,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.transition, null);
  assert.equal(result.state.active, true);
  assert.equal(result.state.episode_id, episodeId);

  result = transition({
    state: result.state,
    current: snapshot({
      id: "post-correction-2",
      issuedAt: "2026-08-10T00:40:00.000Z",
      probability: 0.85,
      knowledgeCutoff: "2026-08-10T00:39:00.000Z",
    }),
    outcomeGate: historicalGate,
  });
  assert.equal(result.transition, null);
  assert.equal(result.state.episode_id, episodeId);
});

test("expired, future, and historical snapshots never mutate subscription state", () => {
  const baseline = transition({
    current: snapshot({
      id: "prediction-1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.4,
    }),
  });
  const historical = transition({
    state: baseline.state,
    current: snapshot({
      id: "prediction-old",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.8,
    }),
  });
  assert.equal(historical.reason, "historical_prediction");
  assert.deepEqual(historical.state, baseline.state);

  const expiredSnapshot = snapshot({
    id: "prediction-expired",
    issuedAt: "2026-08-10T00:20:00.000Z",
    probability: 0.8,
    expiresAt: "2026-08-10T00:21:30.000Z",
  });
  const expired = transitionProbabilitySubscription({
    preferences: PREFERENCES,
    previousState: baseline.state,
    snapshot: expiredSnapshot,
    outcomeRevisionGate: gate(),
    evaluatedAt: "2026-08-10T00:22:00.000Z",
  });
  assert.equal(expired.reason, "snapshot_expired");
  assert.deepEqual(expired.state, baseline.state);

  const futureSnapshot = snapshot({
    id: "prediction-future",
    issuedAt: "2026-08-10T00:30:00.000Z",
    probability: 0.8,
  });
  const future = transitionProbabilitySubscription({
    preferences: PREFERENCES,
    previousState: baseline.state,
    snapshot: futureSnapshot,
    outcomeRevisionGate: gate(),
    evaluatedAt: "2026-08-10T00:30:30.000Z",
  });
  assert.equal(future.reason, "snapshot_from_future");
  assert.deepEqual(future.state, baseline.state);
});
