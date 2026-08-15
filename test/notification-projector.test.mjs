import assert from "node:assert/strict";
import test from "node:test";
import { hashLabel } from "../src/core/hash.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../src/core/outcome-contract.mjs";
import { createPublicationLedger } from "../src/notifications/ledger.mjs";
import { createPublicationProjector } from "../src/notifications/projector.mjs";
import {
  completedRunOwnsServingSnapshot,
} from "../src/runtime/startup-projection.mjs";

function config() {
  return {
    runtime: {
      public_base_url: "https://codexreset.example",
      publication: {
        enabled: true,
        policy_version: "publication-policy/2",
        bootstrap_mode: "baseline_only",
        outcome_max_delivery_delay_hours: 24,
        authority_max_delivery_delay_hours: 48,
        probability_alert: {
          enabled: true,
          open_threshold: 0.5,
          close_threshold: 0.3,
          minimum_stage: "provisional",
          max_delivery_delay_minutes: 45,
        },
      },
    },
  };
}

function fakeStore() {
  const states = new Map();
  const audit = [];
  return {
    states,
    audit,
    async readState(name, fallback) {
      return states.has(name) ? structuredClone(states.get(name)) : fallback;
    },
    async writeState(name, value) {
      states.set(name, structuredClone(value));
    },
    async allAudit() {
      return structuredClone(audit);
    },
    async appendAudit(_type, event) {
      audit.push(structuredClone(event));
      return { inserted: true, event: structuredClone(event) };
    },
  };
}

function snapshot({
  id,
  issuedAt,
  probability,
  authoritySignal = null,
  status = "fresh",
} = {}) {
  const start = new Date(Date.parse(issuedAt) + 60_000).toISOString();
  const slots = Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(start) + index * 3_600_000).toISOString(),
    end: new Date(Date.parse(start) + (index + 1) * 3_600_000).toISOString(),
    hazard: 0.1,
    rolling_4h_probability: index === 0 ? probability : null,
  }));
  const prediction = {
    record_id: id,
    revision: 1,
    data: {
      issued_at: issuedAt,
      knowledge_cutoff: issuedAt,
      horizon: { start: slots[0].start, end: slots.at(-1).end },
      slots,
      no_reset_probability: 1 - probability,
      authority_conditioning: authoritySignal ? {
        applied: true,
        signal_ref: { record_id: authoritySignal, revision: 1 },
        asserted_time_range: {
          start: slots[0].start,
          end: slots.at(-1).end,
        },
      } : { applied: false, signal_ref: null, asserted_time_range: null },
      data_quality: { score: 0.8 },
    },
  };
  return {
    prediction_ref: { record_id: id, revision: 1 },
    prediction_hash: hashLabel(prediction),
    prediction,
    readiness: {
      serving_ready: true,
      serving_stage: "provisional",
      synthetic_only: false,
      publication_ready: false,
      current_forecast: { status },
    },
  };
}

function outcomeItem({
  recordId = "outcome-1",
  revision,
  status = "confirmed",
  knownAt,
  occurredStart = "2026-08-10T01:00:00.000Z",
  occurredEnd = "2026-08-10T02:00:00.000Z",
  occurredOriginalText = null,
  sourceRevision = null,
  contractCurrent = true,
}) {
  const verificationRevision = sourceRevision ?? 1;
  const outcome = {
    record_id: recordId,
    revision,
    producer: {
      name: "outcome-adjudicator",
      version: contractCurrent ? OUTCOME_ADJUDICATOR_VERSION : "legacy",
      config_hash: "sha256:test",
    },
    data: {
      status,
      label_policy_version: contractCurrent
        ? OUTCOME_LABEL_POLICY_VERSION
        : "legacy",
      known_at: knownAt,
      label_grade: "confirmed",
      occurred_time_range: {
        start: occurredStart,
        end: occurredEnd,
        precision: "hour",
        original_text: occurredOriginalText,
      },
      verification: [{
        observation_ref: {
          record_id: "observation-1",
          revision: verificationRevision,
        },
      }],
    },
  };
  return {
    outcome,
    verification: status === "confirmed"
      ? outcome.data.verification[0]
      : null,
    source: sourceRevision === null ? null : {
      record_id: "observation-1",
      revision: sourceRevision,
      data: {
        canonical_url: "https://status.example/reset-1",
        author: { display_handle: "status" },
        content: { text: "Codex reset completed" },
        published_at: "2026-08-01T02:01:00.000Z",
      },
    },
  };
}

test("an empty cold start defers its baseline until the first materialized data", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  const empty = await projector.project({
    snapshot: null,
    emittedAt: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(empty.deferred, true);
  assert.equal(store.states.has("publication-projection"), false);

  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:05:00.000Z",
  })];
  const partialFailure = await projector.project({
    snapshot: null,
    emittedAt: "2026-08-10T00:06:00.000Z",
    allowInitialize: false,
  });
  assert.equal(partialFailure.deferred, true);
  assert.equal(store.states.has("publication-projection"), false);

  const restartedProjector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  const restartWarmup = await restartedProjector.project({
    snapshot: null,
    emittedAt: "2026-08-10T00:07:00.000Z",
    allowInitialize: Number.isFinite(Date.parse(
      (await store.readState("runtime", {})).last_success_at,
    )),
  });
  assert.equal(restartWarmup.deferred, true);
  assert.equal(store.states.has("publication-projection"), false);

  const baseline = await restartedProjector.project({
    snapshot: snapshot({
      id: "p-bootstrap",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:11:00.000Z",
  });
  assert.equal(baseline.initialized, true);
  assert.equal(baseline.events.length, 0);
});

test("an old-cycle outcome learned later does not close a current probability watch", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });
  await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.6,
    }),
    emittedAt: "2026-08-10T00:11:00.000Z",
  });
  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:15:00.000Z",
    occurredStart: "2026-08-01T01:00:00.000Z",
    occurredEnd: "2026-08-01T02:00:00.000Z",
  })];
  const learned = await projector.project({
    snapshot: snapshot({
      id: "p2",
      issuedAt: "2026-08-10T00:14:00.000Z",
      probability: 0.6,
    }),
    emittedAt: "2026-08-10T00:16:00.000Z",
  });
  assert.deepEqual(learned.events, []);
  assert.equal(
    store.states.get("publication-projection").outcomes["outcome-1"].revision,
    1,
    "a historical confirmation still advances projection state",
  );
  assert.equal(
    store.states.get("publication-projection").probability_watch.active,
    true,
  );
});

test("lineage-only revisions of baseline outcomes stay silent", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-01T02:05:00.000Z",
    occurredStart: "2026-08-01T01:00:00.000Z",
    occurredEnd: "2026-08-01T02:00:00.000Z",
    occurredOriginalText: "August 1, 01:00-02:00 UTC",
    sourceRevision: 1,
  })];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });

  outcomes = [outcomeItem({
    revision: 2,
    knownAt: "2026-08-10T00:05:00.000Z",
    occurredStart: "2026-08-01T01:00:00.000Z",
    occurredEnd: "2026-08-01T02:00:00.000Z",
    occurredOriginalText: "Aug 1 from 01:00 until 02:00 UTC",
    sourceRevision: 2,
  })];
  const projected = await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:06:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:06:00.000Z",
  });

  assert.deepEqual(projected.events, []);
  assert.equal(
    store.states.get("publication-projection").outcomes["outcome-1"].revision,
    2,
  );
  assert.equal((await ledger.all()).length, 0);
});

test("an undelivered verification gap cannot turn lineage replay into a correction", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });

  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:05:00.000Z",
    sourceRevision: 1,
  })];
  const confirmed = await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:06:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:06:00.000Z",
  });
  assert.deepEqual(confirmed.events.map((event) => event.event_type), [
    "outcome.reset_confirmed.v1",
  ]);

  const temporarilyUnverified = outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:05:00.000Z",
    sourceRevision: 1,
  });
  temporarilyUnverified.verification = null;
  temporarilyUnverified.source = null;
  outcomes = [temporarilyUnverified];
  const expiredGap = await projector.project({
    snapshot: snapshot({
      id: "p2",
      issuedAt: "2026-08-12T00:06:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-12T00:07:00.000Z",
  });
  assert.deepEqual(expiredGap.events, []);
  const gapState = store.states.get("publication-projection")
    .outcomes["outcome-1"];
  assert.equal(gapState.status, "verification_withdrawn");
  assert.equal(gapState.delivery_status, "eligible_confirmed");

  outcomes = [outcomeItem({
    revision: 2,
    knownAt: "2026-08-12T00:08:00.000Z",
    sourceRevision: 1,
  })];
  const restored = await projector.project({
    snapshot: snapshot({
      id: "p3",
      issuedAt: "2026-08-12T00:09:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-12T00:10:00.000Z",
  });
  assert.deepEqual(restored.events, []);
  assert.equal((await ledger.all()).length, 1);
  const restoredState = store.states.get("publication-projection")
    .outcomes["outcome-1"];
  assert.equal(restoredState.revision, 2);
  assert.equal(restoredState.status, "eligible_confirmed");
  assert.equal(
    restoredState.published_event_id,
    confirmed.events[0].event_id,
  );
});

test("an outcome contract migration gap stays silent inside the delivery window", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });

  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:05:00.000Z",
    sourceRevision: 1,
  })];
  const confirmed = await projector.project({
    snapshot: snapshot({
      id: "p-confirmed",
      issuedAt: "2026-08-10T00:06:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:06:00.000Z",
  });
  assert.deepEqual(confirmed.events.map((event) => event.event_type), [
    "outcome.reset_confirmed.v1",
  ]);

  const pending = outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:05:00.000Z",
    sourceRevision: 1,
    contractCurrent: false,
  });
  pending.verification = null;
  pending.source = null;
  outcomes = [pending];
  const gap = await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:07:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:07:00.000Z",
  });
  assert.deepEqual(gap.events, []);
  const gapState = store.states.get("publication-projection")
    .outcomes["outcome-1"];
  assert.equal(gapState.status, "contract_pending");
  assert.equal(gapState.delivery_status, "eligible_confirmed");

  outcomes = [outcomeItem({
    revision: 2,
    knownAt: "2026-08-10T00:08:00.000Z",
    sourceRevision: 1,
  })];
  const restored = await projector.project({
    snapshot: snapshot({
      id: "p2",
      issuedAt: "2026-08-10T00:09:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:09:00.000Z",
  });
  assert.deepEqual(restored.events, []);
  assert.equal((await ledger.all()).length, 1);
});

test("fresh revisions of an old outcome update audit state without notifying", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });

  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:05:00.000Z",
    occurredStart: "2026-08-10T00:01:00.000Z",
    occurredEnd: "2026-08-10T00:02:00.000Z",
    sourceRevision: 1,
  })];
  const confirmed = await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:06:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:06:00.000Z",
  });
  assert.deepEqual(confirmed.events.map((event) => event.event_type), [
    "outcome.reset_confirmed.v1",
  ]);

  const withdrawn = outcomeItem({
    revision: 2,
    knownAt: "2026-08-12T00:05:00.000Z",
    occurredStart: "2026-08-10T00:01:00.000Z",
    occurredEnd: "2026-08-10T00:02:00.000Z",
    sourceRevision: 1,
  });
  withdrawn.verification = null;
  withdrawn.source = null;
  outcomes = [withdrawn];
  const staleWithdrawal = await projector.project({
    snapshot: snapshot({
      id: "p2",
      issuedAt: "2026-08-12T00:06:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-12T00:06:00.000Z",
  });
  assert.deepEqual(staleWithdrawal.events, []);

  outcomes = [outcomeItem({
    revision: 3,
    knownAt: "2026-08-12T00:07:00.000Z",
    occurredStart: "2026-08-10T00:11:00.000Z",
    occurredEnd: "2026-08-10T00:12:00.000Z",
    sourceRevision: 2,
  })];
  const staleCorrection = await projector.project({
    snapshot: snapshot({
      id: "p3",
      issuedAt: "2026-08-12T00:08:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-12T00:08:00.000Z",
  });
  assert.deepEqual(staleCorrection.events, []);
  assert.equal((await ledger.all()).length, 1);
  const state = store.states.get("publication-projection").outcomes["outcome-1"];
  assert.equal(state.revision, 3);
  assert.equal(state.status, "eligible_confirmed");
  assert.equal(state.published_event_id, confirmed.events[0].event_id);
});

test("startup projection accepts only the forecast owned by the last completed run", () => {
  const current = snapshot({
    id: "prediction-current",
    issuedAt: "2026-08-10T00:10:00.000Z",
    probability: 0.2,
  });
  const runtimeState = {
    last_success_at: "2026-08-10T00:11:00.000Z",
    last_prediction_id: "prediction-current",
  };
  assert.equal(
    completedRunOwnsServingSnapshot(runtimeState, current),
    true,
  );
  assert.equal(
    completedRunOwnsServingSnapshot({
      ...runtimeState,
      last_prediction_id: "prediction-older",
    }, current),
    false,
  );
  assert.equal(
    completedRunOwnsServingSnapshot({
      ...runtimeState,
      last_success_at: "2026-08-10T00:09:00.000Z",
    }, current),
    false,
  );
  assert.equal(
    completedRunOwnsServingSnapshot(runtimeState, {
      ...current,
      readiness: {
        ...current.readiness,
        serving_ready: false,
      },
    }),
    false,
  );
  assert.equal(completedRunOwnsServingSnapshot(runtimeState, null), false);
});

test("an already handled confirmation cannot reopen a stale high-probability cycle", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });
  const staleHighSnapshot = snapshot({
    id: "p1",
    issuedAt: "2026-08-10T00:10:00.000Z",
    probability: 0.6,
  });
  await projector.project({
    snapshot: staleHighSnapshot,
    emittedAt: "2026-08-10T00:11:00.000Z",
  });
  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:15:00.000Z",
    occurredStart: "2026-08-10T00:12:00.000Z",
    occurredEnd: "2026-08-10T00:13:00.000Z",
  })];
  const closed = await projector.project({
    snapshot: staleHighSnapshot,
    emittedAt: "2026-08-10T00:16:00.000Z",
  });
  assert.deepEqual(closed.events.map((event) => event.event_type), [
    "outcome.reset_confirmed.v1",
    "forecast.reset_watch.closed.v1",
  ]);

  const repeated = await projector.project({
    snapshot: staleHighSnapshot,
    emittedAt: "2026-08-10T00:17:00.000Z",
  });
  assert.equal(repeated.events.length, 0);
  assert.equal(
    store.states.get("publication-projection").probability_watch.active,
    false,
  );

  outcomes = [outcomeItem({
    revision: 2,
    status: "rejected",
    knownAt: "2026-08-10T00:16:30.000Z",
    occurredStart: "2026-08-10T00:12:00.000Z",
    occurredEnd: "2026-08-10T00:13:00.000Z",
  })];
  const retracted = await projector.project({
    snapshot: staleHighSnapshot,
    emittedAt: "2026-08-10T00:17:00.000Z",
  });
  assert.deepEqual(retracted.events.map((event) => event.event_type), [
    "outcome.reset_retracted.v1",
  ]);
  assert.equal(
    store.states.get("publication-projection").probability_watch.active,
    false,
  );
});

test("latest outcome gating compares RFC 3339 instants rather than timestamp strings", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:14:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:14:00.000Z",
  });
  outcomes = [
    outcomeItem({
      recordId: "outcome-early",
      revision: 1,
      knownAt: "2026-08-10T00:15:00Z",
    }),
    outcomeItem({
      recordId: "outcome-late",
      revision: 1,
      knownAt: "2026-08-10T00:15:00.500Z",
    }),
  ];
  const highSnapshot = snapshot({
    id: "p1",
    issuedAt: "2026-08-10T00:15:00.250Z",
    probability: 0.6,
  });
  await projector.project({
    snapshot: highSnapshot,
    emittedAt: "2026-08-10T00:15:00.600Z",
  });
  const repeated = await projector.project({
    snapshot: highSnapshot,
    emittedAt: "2026-08-10T00:15:00.700Z",
  });
  assert.equal(repeated.events.length, 0);
  assert.notEqual(
    store.states.get("publication-projection").probability_watch?.active,
    true,
  );
});

test("probability alert uses baseline, hysteresis, and exact event deduplication", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  const baselineAt = "2026-08-10T00:00:00.000Z";
  assert.equal((await projector.project({
    snapshot: snapshot({ id: "p0", issuedAt: baselineAt, probability: 0.2 }),
    emittedAt: baselineAt,
  })).events.length, 0);

  const opened = await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.6,
    }),
    emittedAt: "2026-08-10T00:11:00.000Z",
  });
  assert.deepEqual(opened.events.map((event) => event.event_type), [
    "forecast.reset_watch.opened.v1",
  ]);
  assert.equal(opened.events[0].report.default_delivery, false);

  assert.equal((await projector.project({
    snapshot: snapshot({
      id: "p2",
      issuedAt: "2026-08-10T00:20:00.000Z",
      probability: 0.7,
    }),
    emittedAt: "2026-08-10T00:21:00.000Z",
  })).events.length, 0);
  assert.equal((await projector.project({
    snapshot: snapshot({
      id: "p-stale",
      issuedAt: "2026-08-10T00:30:00.000Z",
      probability: 0.1,
      status: "stale",
    }),
    emittedAt: "2026-08-10T00:31:00.000Z",
  })).events.length, 0, "unknown/stale must not close the latch");

  const closed = await projector.project({
    snapshot: snapshot({
      id: "p3",
      issuedAt: "2026-08-10T00:40:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:41:00.000Z",
  });
  assert.deepEqual(closed.events.map((event) => event.event_type), [
    "forecast.reset_watch.closed.v1",
  ]);

  const reopened = await projector.project({
    snapshot: snapshot({
      id: "p4",
      issuedAt: "2026-08-10T00:50:00.000Z",
      probability: 0.55,
    }),
    emittedAt: "2026-08-10T00:51:00.000Z",
  });
  assert.equal(reopened.events[0].event_type, "forecast.reset_watch.opened.v1");
  assert.notEqual(reopened.events[0].event_id, opened.events[0].event_id);
  assert.deepEqual((await ledger.all()).map((event) => event.sequence), [1, 2, 3]);
});

test("authority signals and outcome revisions publish stable default events", async () => {
  const store = fakeStore();
  const ledger = createPublicationLedger(store);
  let outcomes = [];
  const projector = createPublicationProjector({
    store,
    config: config(),
    ledger,
    loadOutcomes: async () => outcomes,
  });
  await projector.project({
    snapshot: snapshot({
      id: "p0",
      issuedAt: "2026-08-10T00:00:00.000Z",
      probability: 0.2,
    }),
    emittedAt: "2026-08-10T00:00:00.000Z",
  });

  const authority = await projector.project({
    snapshot: snapshot({
      id: "p1",
      issuedAt: "2026-08-10T00:10:00.000Z",
      probability: 0.4,
      authoritySignal: "signal-1",
    }),
    emittedAt: "2026-08-10T00:11:00.000Z",
  });
  assert.equal(authority.events[0].event_type, "forecast.authority_window.opened.v1");
  assert.equal(authority.events[0].topic, "authority");
  assert.equal(authority.events[0].report.default_delivery, true);
  assert.equal(
    authority.events[0].expires_at,
    "2026-08-10T04:11:00.000Z",
    "authority delivery cannot outlive its asserted future window",
  );
  assert.equal((await projector.project({
    snapshot: snapshot({
      id: "p2",
      issuedAt: "2026-08-10T00:20:00.000Z",
      probability: 0.45,
      authoritySignal: "signal-1",
    }),
    emittedAt: "2026-08-10T00:21:00.000Z",
  })).events.length, 0);

  outcomes = [outcomeItem({
    revision: 1,
    knownAt: "2026-08-10T00:25:00.000Z",
  })];
  const confirmed = await projector.project({
    snapshot: snapshot({
      id: "p3",
      issuedAt: "2026-08-10T00:30:00.000Z",
      probability: 0.1,
    }),
    emittedAt: "2026-08-10T00:31:00.000Z",
  });
  assert.equal(confirmed.events[0].event_type, "outcome.reset_confirmed.v1");
  assert.equal(confirmed.events[0].expires_at, "2026-08-11T00:25:00.000Z");

  outcomes = [outcomeItem({
    revision: 2,
    knownAt: "2026-08-10T00:35:00.000Z",
  })];
  const lineageOnly = await projector.project({
    snapshot: snapshot({
      id: "p4",
      issuedAt: "2026-08-10T00:40:00.000Z",
      probability: 0.1,
    }),
    emittedAt: "2026-08-10T00:41:00.000Z",
  });
  assert.deepEqual(lineageOnly.events, []);
  assert.equal(
    store.states.get("publication-projection").outcomes["outcome-1"]
      .published_event_id,
    confirmed.events[0].event_id,
  );

  outcomes = [outcomeItem({
    revision: 3,
    knownAt: "2026-08-10T00:45:00.000Z",
    occurredStart: "2026-08-10T01:10:00.000Z",
    occurredEnd: "2026-08-10T02:10:00.000Z",
  })];
  const corrected = await projector.project({
    snapshot: snapshot({
      id: "p5",
      issuedAt: "2026-08-10T00:50:00.000Z",
      probability: 0.1,
    }),
    emittedAt: "2026-08-10T00:51:00.000Z",
  });
  assert.equal(corrected.events[0].event_type, "outcome.reset_corrected.v1");
  assert.equal(corrected.events[0].supersedes_event_id, confirmed.events[0].event_id);

  outcomes = [outcomeItem({
    revision: 4,
    status: "rejected",
    knownAt: "2026-08-10T00:55:00.000Z",
    occurredStart: "2026-08-10T01:10:00.000Z",
    occurredEnd: "2026-08-10T02:10:00.000Z",
  })];
  const retracted = await projector.project({
    snapshot: snapshot({
      id: "p6",
      issuedAt: "2026-08-10T01:00:00.000Z",
      probability: 0.1,
    }),
    emittedAt: "2026-08-10T01:01:00.000Z",
  });
  assert.equal(retracted.events[0].event_type, "outcome.reset_retracted.v1");
  assert.equal(retracted.events[0].supersedes_event_id, corrected.events[0].event_id);

  outcomes = [outcomeItem({
    revision: 5,
    knownAt: "2026-08-10T00:25:00.000Z",
  })];
  const lateCorrection = await projector.project({
    snapshot: snapshot({
      id: "p7",
      issuedAt: "2026-08-11T01:00:00.000Z",
      probability: 0.1,
    }),
    emittedAt: "2026-08-11T01:01:00.000Z",
  });
  assert.equal(
    lateCorrection.events.length,
    0,
    "a stale correction updates projection state without becoming a notification",
  );
});
