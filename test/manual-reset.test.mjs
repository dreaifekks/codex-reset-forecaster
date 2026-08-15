import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import {
  isOperatorConfirmationObservation,
} from "../src/core/operator-confirmation.mjs";
import { assertCanonicalRecord } from "../src/core/validate-record.mjs";
import {
  latestRecurrenceAnchorAsOf,
} from "../src/model/authority-timing.mjs";
import {
  conditionPostOutcomeRefractoryHazards,
} from "../src/model/post-outcome-refractory.mjs";
import { confirmManualPlatformReset } from "../src/operators/manual-reset.mjs";
import { normalizeNewObservations } from "../src/pipeline/extract.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import {
  adjudicateOutcomes,
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../src/pipeline/outcomes.mjs";
import { confirmationIdentityIds } from "../src/core/sources.mjs";
import { loadConfirmedHistoryResults } from "../src/query/history-results.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

const QUOTED_STATUS = "2087423996115681767";
const AUTHORITY_STATUS = "2087706104814023111";

function observation(config, {
  id,
  text,
  identityId = "person_tibo_sottiaux",
  handle = "thsottiaux",
  nativeRelations = [],
  publishedAt,
  firstSeenAt,
}) {
  return rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/${handle}/status/${id}`,
    published_at: publishedAt,
    author: {
      provider_author_id: `${handle}-x-id`,
      identity_id: identityId,
      display_handle: `@${handle}`,
    },
    native_relations: nativeRelations,
    content: { media_type: "text/plain", text, language: "en" },
    selection_context: {
      feature_eligible: true,
      outcome_conditioned: false,
      selection_method: "manual-confirmation-test",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: config.providers.x,
    firstSeenAt,
    fetchedAt: firstSeenAt,
  });
}

function hazards(start, count, hazard = 0.2) {
  return Array.from({ length: count }, (_, index) => {
    const slotStart = new Date(Date.parse(start) + index * 3_600_000);
    return {
      start: slotStart.toISOString(),
      end: new Date(slotStart.getTime() + 3_600_000).toISOString(),
      hazard,
      interval80: [hazard / 2, hazard * 1.5],
    };
  });
}

async function authorityPlan(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "manual-reset-confirmation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: {
      extractor: {
        semantic_assistance: { enabled: false, token_file: null },
      },
      runtime: { data_dir: directory },
    },
  });
  const store = await new JsonlStore(directory).init();
  const quoted = observation(config, {
    id: QUOTED_STATUS,
    text: "Codex usage limits were reset for all paid users.",
    identityId: "community_member",
    handle: "community",
    publishedAt: "2026-08-12T06:20:00.000Z",
    firstSeenAt: "2026-08-13T01:09:00.000Z",
  });
  const wrapper = observation(config, {
    id: AUTHORITY_STATUS,
    text:
      "Old news actually from a bunch of days ago, but crossed that 15M. " +
      "Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.",
    nativeRelations: [{
      type: "quotes",
      provider_item_id: QUOTED_STATUS,
      url: `https://x.com/community/status/${QUOTED_STATUS}`,
    }],
    publishedAt: "2026-08-13T01:01:37.748Z",
    firstSeenAt: "2026-08-13T01:10:00.000Z",
  });
  await store.appendMany([quoted, wrapper]);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-08-13T01:11:00.000Z"),
    semanticAssessor: null,
  });
  await linkEventCandidates(store, config, {
    asOf: new Date("2026-08-13T01:12:00.000Z"),
  });
  await adjudicateOutcomes(store, config, {
    now: new Date("2026-08-13T01:13:00.000Z"),
  });
  assert.equal((await store.all("reset_outcome")).length, 0);
  return { config, store };
}

test("manual platform confirmation creates an eligible silver outcome and refractory anchor", async (t) => {
  const { config, store } = await authorityPlan(t);
  const result = await confirmManualPlatformReset(store, config, {
    sourceStatus: `https://x.com/thsottiaux/status/${AUTHORITY_STATUS}`,
    effectiveAt: "2026-08-13T04:35:42.000Z",
    knownAt: "2026-08-13T05:35:00.000Z",
    actor: "dreaife",
    note: "Observed platform reset behavior.",
  });

  assert.equal(result.inserted, true);
  assert.equal(result.outcome.data.status, "confirmed");
  assert.equal(result.outcome.data.label_grade, "silver");
  assert.deepEqual(result.outcome.data.occurred_time_range, {
    start: "2026-08-13T04:35:00.000Z",
    end: "2026-08-13T04:36:00.000Z",
    boundary: "[start,end)",
    precision: "minute",
    timezone_basis: "UTC",
    original_text: "authenticated operator-reported effective minute",
  });
  assert.equal(
    result.outcome.data.verification[0].kind,
    "operator_confirmation",
  );
  assert.equal(isOperatorConfirmationObservation(result.observation), true);
  assertCanonicalRecord(result.observation);
  assertCanonicalRecord(result.outcome);

  const [observations, signals, outcomes] = await Promise.all([
    store.all("raw_observation", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
    store.all("reset_outcome", { latestOnly: false }),
  ]);
  const context = buildOutcomeEligibilityContext({
    observations,
    signals,
    config,
  });
  assert.equal(isEligibleConfirmedOutcome(result.outcome, {
    ...context,
    confirmationIdentityIds: confirmationIdentityIds(config),
  }), true);
  const anchor = latestRecurrenceAnchorAsOf({
    observations,
    signals,
    outcomes,
    config,
    knowledgeCutoff: "2026-08-13T05:36:00.000Z",
  });
  assert.deepEqual(anchor?.occurred_time_range, result.outcome.data.occurred_time_range);
  const refractory = conditionPostOutcomeRefractoryHazards({
    hazardEntries: hazards("2026-08-13T06:00:00.000Z", 4),
    observations,
    signals,
    outcomes,
    config,
    knowledgeCutoff: "2026-08-13T05:36:00.000Z",
  });
  assert.equal(refractory.metadata.applied, true);
  assert.equal(refractory.metadata.status, "active");
  assert.ok(refractory.metadata.first_slot_multiplier < 1);

  const history = await loadConfirmedHistoryResults(store, config);
  assert.equal(history.length, 1);
  assert.equal(history[0].label_grade, "silver");
  assert.equal(history[0].source.canonical_url, null);
  assert.match(history[0].source.text, /人工确认（silver）/);

  const beforeCounts = {
    observations: observations.length,
    outcomes: outcomes.length,
  };
  const repeated = await confirmManualPlatformReset(store, config, {
    sourceStatus: AUTHORITY_STATUS,
    effectiveAt: "2026-08-13T04:35:42.000Z",
    knownAt: "2026-08-13T05:35:00.000Z",
    actor: "dreaife",
    note: "Observed platform reset behavior.",
  });
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.reason, "identical_operator_confirmation");
  assert.equal(
    (await store.all("raw_observation", { latestOnly: false })).length,
    beforeCounts.observations,
  );
  assert.equal(
    (await store.all("reset_outcome", { latestOnly: false })).length,
    beforeCounts.outcomes,
  );
});

test("manual confirmation is source-bound and survives outcome contract hash changes", async (t) => {
  const { config, store } = await authorityPlan(t);
  await assert.rejects(
    confirmManualPlatformReset(store, config, {
      sourceStatus: "2087000000000000000",
      effectiveAt: "2026-08-13T04:35:00.000Z",
      knownAt: "2026-08-13T05:35:00.000Z",
      actor: "dreaife",
    }),
    /No current configured-authority platform reset candidate/,
  );
  await assert.rejects(
    confirmManualPlatformReset(store, config, {
      sourceStatus: AUTHORITY_STATUS,
      effectiveAt: "2026-08-13T00:35:00.000Z",
      knownAt: "2026-08-13T05:35:00.000Z",
      actor: "dreaife",
    }),
    /cannot precede its authority plan/,
  );

  const initial = await confirmManualPlatformReset(store, config, {
    sourceStatus: AUTHORITY_STATUS,
    effectiveAt: "2026-08-13T04:35:00.000Z",
    knownAt: "2026-08-13T05:35:00.000Z",
    actor: "dreaife",
  });
  const changedConfig = structuredClone(config);
  changedConfig.deduplication_version = "reset-dedup/operator-carry-test";
  const carried = await adjudicateOutcomes(store, changedConfig, {
    now: new Date("2026-08-13T05:40:00.000Z"),
  });
  assert.equal(carried.adjudicated, 1);
  const current = (await store.all("reset_outcome"))[0];
  assert.equal(current.record_id, initial.outcome.record_id);
  assert.equal(current.revision, initial.outcome.revision + 1);
  assert.equal(current.data.label_grade, "silver");
  assert.deepEqual(
    current.data.occurred_time_range,
    initial.outcome.data.occurred_time_range,
  );
  const [observations, signals] = await Promise.all([
    store.all("raw_observation", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
  ]);
  const context = buildOutcomeEligibilityContext({
    observations,
    signals,
    config: changedConfig,
  });
  assert.equal(isEligibleConfirmedOutcome(current, {
    ...context,
    confirmationIdentityIds: confirmationIdentityIds(changedConfig),
  }), true);
  assert.equal((await adjudicateOutcomes(store, changedConfig, {
    now: new Date("2026-08-13T05:41:00.000Z"),
  })).adjudicated, 0);
});
