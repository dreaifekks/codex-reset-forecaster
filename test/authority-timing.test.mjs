import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { confirmationIdentityIds } from "../src/core/sources.mjs";
import {
  extractSignal,
  normalizeNewObservations,
} from "../src/pipeline/extract.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import { adjudicateOutcomes } from "../src/pipeline/outcomes.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";
import {
  AUTHORITY_TIMING_RELIABILITY_BASIS,
  conditionAuthorityTimingHazards,
  latestRecurrenceAnchorAsOf,
} from "../src/model/authority-timing.mjs";
import {
  FEATURE_NAMES,
  featureVectorAt,
  featuresToArray,
} from "../src/model/features.mjs";
import { deriveProbabilitySlots } from "../src/model/forecast.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import {
  isResetTimingSignalActiveAt,
  isResetTimingSignalConsumed,
} from "../src/model/signal-lifecycle.mjs";

function observation(config, {
  id,
  text,
  publishedAt,
  fetchedAt,
  mediaType = "text/plain",
}) {
  return rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/thsottiaux/status/${id}`,
    published_at: publishedAt,
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: mediaType,
      text,
      language: "en",
    },
    selection_context: {
      feature_eligible: true,
      outcome_conditioned: false,
      selection_method: "test",
    },
  }, {
    providerName: "timeline_jsonl",
    providerVersion: "test",
    config: {},
    firstSeenAt: fetchedAt,
    fetchedAt,
  });
}

function hazards(start, count, hazard = 0.01) {
  return Array.from({ length: count }, (_, index) => {
    const slotStart = new Date(Date.parse(start) + index * 3_600_000);
    return {
      start: slotStart.toISOString(),
      end: new Date(slotStart.getTime() + 3_600_000).toISOString(),
      hazard,
      interval80: [hazard / 2, hazard * 2],
    };
  });
}

test("exact Tibo timing contracts first-event mass into the asserted interval", async () => {
  const config = await loadConfig();
  const source = observation(config, {
    id: "2079609157934886975",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:47:15Z",
    fetchedAt: "2026-07-21T16:48:00Z",
  });
  const signal = extractSignal(source, config);
  const baseEntries = hazards("2026-07-21T17:00:00Z", 6);
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: baseEntries,
    signals: [signal],
    observations: [source],
    outcomes: [],
    config,
    knowledgeCutoff: "2026-07-21T16:50:00Z",
  });
  const base = deriveProbabilitySlots(baseEntries);
  const result = deriveProbabilitySlots(conditioned.hazardEntries);

  assert.equal(conditioned.metadata.applied, true);
  assert.equal(conditioned.metadata.phase, "scheduled");
  assert.equal(conditioned.metadata.prior_reliability, 0.8);
  assert.equal(
    conditioned.metadata.reliability_basis,
    AUTHORITY_TIMING_RELIABILITY_BASIS,
  );
  assert.ok(
    conditioned.metadata.conditioned_horizon_probability >
      conditioned.metadata.base_horizon_probability,
  );
  assert.ok(1 - result.noResetProbability > 0.8);
  assert.ok(
    result.slots[0].first_reset_probability >
      base.slots[0].first_reset_probability,
  );
  assert.ok(
    result.slots[2].first_reset_probability <
      base.slots[2].first_reset_probability,
  );
  assert.ok(
    Math.abs(
      result.slots.reduce(
        (sum, slot) => sum + slot.first_reset_probability,
        result.noResetProbability,
      ) - 1
    ) < 1e-10,
  );
  assert.ok(
    conditioned.hazardEntries.every((entry) => entry.interval80 === null),
  );
});

test("a later compatible completion consumes an old plan even outside its asserted window", async () => {
  const config = await loadConfig();
  const source = observation(config, {
    id: "2079609157934886974",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:47:15Z",
    fetchedAt: "2026-07-21T16:48:00Z",
  });
  const signal = extractSignal(source, config);
  const completion = {
    data: {
      status: "confirmed",
      event_type: "quota_reset",
      scope: structuredClone(signal.data.claim.scope),
      occurred_time_range: {
        start: "2026-07-21T20:00:00.000Z",
        end: "2026-07-21T21:00:00.000Z",
        boundary: "[start,end)",
      },
    },
  };

  assert.equal(
    isResetTimingSignalConsumed(
      signal,
      [completion],
      "2026-07-21T22:00:00.000Z",
    ),
    true,
  );
  assert.equal(
    isResetTimingSignalActiveAt(signal, {
      outcomes: [completion],
      targetTime: "2026-07-21T22:00:00.000Z",
    }),
    false,
  );
});

test("an earlier cycle completion does not consume a plan asserted for a later cycle", async () => {
  const config = await loadConfig();
  const source = observation(config, {
    id: "2079609157934886973",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:47:15Z",
    fetchedAt: "2026-07-21T16:48:00Z",
  });
  const futurePlan = structuredClone(extractSignal(source, config));
  futurePlan.data.claim.asserted_time_range = {
    start: "2026-07-22T00:00:00.000Z",
    end: "2026-07-22T02:00:00.000Z",
    boundary: "[start,end)",
  };
  const earlierCompletion = {
    data: {
      status: "confirmed",
      event_type: "quota_reset",
      scope: structuredClone(futurePlan.data.claim.scope),
      occurred_time_range: {
        start: "2026-07-21T20:00:00.000Z",
        end: "2026-07-21T21:00:00.000Z",
        boundary: "[start,end)",
      },
    },
  };

  assert.equal(
    isResetTimingSignalConsumed(
      futurePlan,
      [earlierCompletion],
      "2026-07-21T22:00:00.000Z",
    ),
    false,
  );
});

test("real Tibo mode aliases activate a three-hour scheduled authority window", async () => {
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
  });
  const source = observation(config, {
    id: "2081899343091843463",
    text:
      "We’re celebrating the fast adoption of chatGPT Work and all the incredible effort that went into it today. " +
      "I’m feeling like a limit reset.\n\nHold on tight to your ultra and /fast and see you in a few hours when I’m back at the laptop!",
    publishedAt: "2026-07-28T00:27:37.869Z",
    fetchedAt: "2026-07-28T00:28:00Z",
  });
  const signal = extractSignal(source, config);
  assert.equal(signal.data.claim.phase, "scheduled");
  assert.equal(signal.data.claim.scope.product, "multi_product");
  assert.deepEqual(
    signal.data.claim.scope.products,
    ["chatgpt_work", "codex"],
  );
  assert.equal(signal.data.claim.scope.population, "platform");
  assert.equal(
    signal.data.claim.asserted_time_range.end,
    "2026-07-28T03:27:37.869Z",
  );

  const baseEntries = hazards("2026-07-28T01:00:00Z", 6);
  const vector = featureVectorAt({
    targetTime: "2026-07-28T01:00:00Z",
    knowledgeCutoff: "2026-07-28T00:28:00Z",
    signals: [signal],
    outcomes: [],
    observations: [source],
    confirmationIdentityIds: confirmationIdentityIds(config),
    expectedExtractor: extractorContract(config),
    targetScope: config.target,
    authorityTimingPolicy: config.model.authority_timing,
  });
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: baseEntries,
    signals: [signal],
    observations: [source],
    outcomes: [],
    config,
    knowledgeCutoff: "2026-07-28T00:28:00Z",
  });
  const base = deriveProbabilitySlots(baseEntries);
  const result = deriveProbabilitySlots(conditioned.hazardEntries);

  assert.equal(conditioned.metadata.applied, true);
  assert.equal(conditioned.metadata.phase, "scheduled");
  assert.equal(conditioned.metadata.signal_ref.record_id, signal.record_id);
  assert.ok(vector.features.official_reset_intent_decay > 0);
  assert.equal(vector.features.asserted_time_overlap, 0);
  assert.equal(FEATURE_NAMES.includes("official_reset_intent_decay"), false);
  assert.equal(featuresToArray(vector).length, FEATURE_NAMES.length);
  assert.equal(
    isResetTimingSignalActiveAt(signal, {
      targetTime: new Date("2026-07-28T03:27:37.869Z"),
    }),
    false,
  );
  assert.equal(
    isResetTimingSignalActiveAt(signal, {
      targetTime: new Date("2026-07-28T03:27:37.868Z"),
    }),
    true,
  );
  const millisecondOutcome = {
    data: {
      status: "confirmed",
      event_type: "quota_reset",
      scope: structuredClone(signal.data.claim.scope),
      occurred_time_range: {
        start: "2026-07-28T03:09:23.000Z",
        end: "2026-07-28T03:09:23.666Z",
      },
    },
  };
  assert.equal(
    isResetTimingSignalConsumed(
      signal,
      [millisecondOutcome],
      new Date("2026-07-28T03:09:23.665Z"),
    ),
    false,
  );
  assert.equal(
    isResetTimingSignalConsumed(
      signal,
      [millisecondOutcome],
      new Date("2026-07-28T03:09:23.666Z"),
    ),
    true,
  );
  assert.ok(1 - result.noResetProbability > 0.8);
  assert.ok(
    result.slots[0].first_reset_probability >
      base.slots[0].first_reset_probability,
  );
  assert.ok(
    result.slots[3].first_reset_probability <
      base.slots[3].first_reset_probability,
  );
});

test("summaries never trigger strong authority timing conditioning", async () => {
  const config = await loadConfig();
  const source = observation(config, {
    id: "2079609157934886976",
    text:
      "Tibo says Codex usage limits for all paid users reset in the next hour.",
    publishedAt: "2026-07-21T16:47:15Z",
    fetchedAt: "2026-07-21T16:48:00Z",
    mediaType: "application/vnd.x-search-summary+text",
  });
  const signal = extractSignal(source, config);
  const baseEntries = hazards("2026-07-21T17:00:00Z", 4);
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: baseEntries,
    signals: [signal],
    observations: [source],
    outcomes: [],
    config,
    knowledgeCutoff: "2026-07-21T16:50:00Z",
  });
  assert.equal(conditioned.metadata.applied, false);
  assert.deepEqual(conditioned.hazardEntries, baseEntries);
});

test("a newer exact denial cancels an older active authority window", async () => {
  const config = await loadConfig();
  const scheduledSource = observation(config, {
    id: "2079609157934886977",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:20:00Z",
    fetchedAt: "2026-07-21T16:21:00Z",
  });
  const denialSource = observation(config, {
    id: "2079609157934886978",
    text: "No Codex reset for all paid users. But no.",
    publishedAt: "2026-07-21T16:40:00Z",
    fetchedAt: "2026-07-21T16:41:00Z",
  });
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: hazards("2026-07-21T17:00:00Z", 4),
    signals: [
      extractSignal(scheduledSource, config),
      extractSignal(denialSource, config),
    ],
    observations: [scheduledSource, denialSource],
    outcomes: [],
    config,
    knowledgeCutoff: "2026-07-21T16:50:00Z",
  });
  assert.equal(conditioned.metadata.applied, false);
});

test("asserted reset intent expires when its timing window ends", async () => {
  const config = await loadConfig();
  const source = observation(config, {
    id: "20796091579348869781",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:20:00Z",
    fetchedAt: "2026-07-21T16:21:00Z",
  });
  const signal = extractSignal(source, config);
  const vector = featureVectorAt({
    targetTime: "2026-07-21T19:00:00Z",
    knowledgeCutoff: "2026-07-21T16:30:00Z",
    signals: [signal],
    outcomes: [],
    observations: [source],
    confirmationIdentityIds: confirmationIdentityIds(config),
    expectedExtractor: extractorContract(config),
    targetScope: config.target,
    authorityTimingPolicy: config.model.authority_timing,
  });

  assert.equal(vector.features.official_reset_intent_decay, 0);
  assert.equal(vector.features.asserted_time_overlap, 0);
});

test("a confirmed reset consumes its announcement and anchors the next cycle", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "authority-timing-anchor-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: { runtime: { data_dir: directory } },
  });
  const store = await new JsonlStore(directory).init();
  const scheduled = observation(config, {
    id: "2079609157934886979",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:20:00Z",
    fetchedAt: "2026-07-21T16:21:00Z",
  });
  const completed = observation(config, {
    id: "2079609157934886980",
    text: "We have reset Codex usage limits for all paid users.",
    publishedAt: "2026-07-21T17:05:00Z",
    fetchedAt: "2026-07-21T17:06:00Z",
  });
  await store.append(scheduled);
  await store.append(completed);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-21T17:07:00Z"),
  });
  await linkEventCandidates(store, config, {
    asOf: new Date("2026-07-21T17:08:00Z"),
  });
  await adjudicateOutcomes(store, config, {
    now: new Date("2026-07-21T17:09:00Z"),
  });
  const [signals, observations, outcomes] = await Promise.all([
    store.all("normalized_signal", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    store.all("reset_outcome", { latestOnly: false }),
  ]);
  const cutoff = "2026-07-21T17:10:00Z";
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: hazards("2026-07-21T18:00:00Z", 4),
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff: cutoff,
  });
  const heldOutOutcomeConditioned = conditionAuthorityTimingHazards({
    hazardEntries: hazards("2026-07-21T18:00:00Z", 4),
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff: cutoff,
    excludedSourceRecordIds: new Set([
      outcomes.at(-1).record_id,
    ]),
  });
  const anchor = latestRecurrenceAnchorAsOf({
    signals,
    observations,
    outcomes,
    config,
    knowledgeCutoff: cutoff,
  });
  const vector = featureVectorAt({
    targetTime: "2026-07-21T18:00:00Z",
    knowledgeCutoff: cutoff,
    signals,
    outcomes,
    observations,
    confirmationIdentityIds: confirmationIdentityIds(config),
    expectedExtractor: extractorContract(config),
    targetScope: config.target,
    authorityTimingPolicy: config.model.authority_timing,
    outcomeCoverageProviders: new Set(
      config.model.outcome_coverage_providers,
    ),
  });

  assert.equal(conditioned.metadata.applied, false);
  assert.equal(
    heldOutOutcomeConditioned.metadata.applied,
    true,
    "a held-out completion cannot consume the scheduled signal during walk-forward",
  );
  assert.equal(vector.features.official_reset_intent_decay, 0);
  assert.equal(vector.features.asserted_time_overlap, 0);
  assert.ok(anchor);
  assert.equal(
    anchor.occurred_time_range.start,
    "2026-07-21T17:00:00.000Z",
  );
});

test("disabled authority conditioning leaves exact timing evidence in the baseline feature", async () => {
  const config = await loadConfig({
    overrides: {
      model: {
        authority_timing: {
          enabled: false,
        },
      },
    },
  });
  const source = observation(config, {
    id: "2079609157934886981",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:20:00Z",
    fetchedAt: "2026-07-21T16:21:00Z",
  });
  const signal = extractSignal(source, config);
  const vector = featureVectorAt({
    targetTime: "2026-07-21T17:00:00Z",
    knowledgeCutoff: "2026-07-21T16:30:00Z",
    signals: [signal],
    outcomes: [],
    observations: [source],
    confirmationIdentityIds: confirmationIdentityIds(config),
    expectedExtractor: extractorContract(config),
    targetScope: config.target,
    authorityTimingPolicy: config.model.authority_timing,
  });
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: hazards("2026-07-21T17:00:00Z", 4),
    signals: [signal],
    observations: [source],
    outcomes: [],
    config,
    knowledgeCutoff: "2026-07-21T16:30:00Z",
  });

  assert.equal(conditioned.metadata.applied, false);
  assert.equal(vector.features.asserted_time_overlap, 1);
});

test("account-scoped timing evidence cannot affect a platform target", async () => {
  const config = await loadConfig();
  const source = observation(config, {
    id: "2079609157934886982",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-21T16:20:00Z",
    fetchedAt: "2026-07-21T16:21:00Z",
  });
  const signal = extractSignal(source, config);
  signal.data.claim.scope.population = "account";
  const vector = featureVectorAt({
    targetTime: "2026-07-21T17:00:00Z",
    knowledgeCutoff: "2026-07-21T16:30:00Z",
    signals: [signal],
    outcomes: [],
    observations: [source],
    confirmationIdentityIds: confirmationIdentityIds(config),
    expectedExtractor: extractorContract(config),
    targetScope: config.target,
    authorityTimingPolicy: config.model.authority_timing,
  });
  const conditioned = conditionAuthorityTimingHazards({
    hazardEntries: hazards("2026-07-21T17:00:00Z", 4),
    signals: [signal],
    observations: [source],
    outcomes: [],
    config,
    knowledgeCutoff: "2026-07-21T16:30:00Z",
  });

  assert.equal(conditioned.metadata.applied, false);
  assert.equal(vector.features.official_reset_intent_decay, 0);
  assert.equal(vector.features.asserted_time_overlap, 0);
});

test("overlay-ineligible role and duration preserve ordinary baseline overlap", async () => {
  const cases = [
    {
      config: await loadConfig({
        overrides: {
          model: {
            authority_timing: {
              eligible_source_roles: ["official"],
            },
          },
        },
      }),
      mutate(signal) {
        return signal;
      },
    },
    {
      config: await loadConfig(),
      mutate(signal) {
        signal.data.claim.asserted_time_range.end =
          "2026-07-24T16:20:00.000Z";
        return signal;
      },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const source = observation(entry.config, {
      id: `207960915793488699${index}`,
      text:
        "We will reset Codex usage limits for all paid users in the next 2 hours.",
      publishedAt: "2026-07-21T16:20:00Z",
      fetchedAt: "2026-07-21T16:21:00Z",
    });
    const signal = entry.mutate(extractSignal(source, entry.config));
    const vector = featureVectorAt({
      targetTime: "2026-07-21T17:00:00Z",
      knowledgeCutoff: "2026-07-21T16:30:00Z",
      signals: [signal],
      outcomes: [],
      observations: [source],
      confirmationIdentityIds: confirmationIdentityIds(entry.config),
      expectedExtractor: extractorContract(entry.config),
      targetScope: entry.config.target,
      authorityTimingPolicy: entry.config.model.authority_timing,
    });
    const conditioned = conditionAuthorityTimingHazards({
      hazardEntries: hazards("2026-07-21T17:00:00Z", 4),
      signals: [signal],
      observations: [source],
      outcomes: [],
      config: entry.config,
      knowledgeCutoff: "2026-07-21T16:30:00Z",
    });

    assert.equal(conditioned.metadata.applied, false);
    assert.equal(vector.features.asserted_time_overlap, 1);
  }
});
