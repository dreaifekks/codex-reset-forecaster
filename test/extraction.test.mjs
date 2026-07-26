import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { extractSignal, normalizeNewObservations } from "../src/pipeline/extract.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";
import { confirmationIdentityIds, sourceRoleForIdentity } from "../src/core/sources.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import {
  featureVectorAt,
  matchesExpectedExtractor,
} from "../src/model/features.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { AS_OF_MODE, latestSignalsAsOf } from "../src/model/as-of.mjs";
import { createRecord, producer, recordRef } from "../src/core/records.mjs";
import { selectCurrentSignals } from "../src/pipeline/signal-selection.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import {
  adjudicateOutcomes,
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../src/pipeline/outcomes.mjs";

const config = await loadConfig();
const authorityConfig = await loadConfig({ overrides: {
  outcome_definition: {
    version: "authority-announced-platform-reset/2",
    event_semantics: "qualifying_authority_completion_statement",
    authority_identity_ids: ["person_tibo_sottiaux"],
    scope_policy: "explicit-platform-or-authority-general-codex/1",
    negative_label_policy: "authoritative_daily_ledger_absence",
  },
} });

function observationForConfig(text, id, runConfig, {
  identityId = "person_tibo_sottiaux",
  handle = "thsottiaux",
  nativeRelations = [],
  mediaType = "text/plain",
} = {}) {
  return rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/${handle}/status/${id}`,
    published_at: "2026-07-18T03:28:00Z",
    author: {
      provider_author_id: `${handle}-x-id`,
      identity_id: identityId,
      display_handle: `@${handle}`,
    },
    native_relations: nativeRelations,
    content: { media_type: mediaType, text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: runConfig.providers.x,
    firstSeenAt: "2026-07-18T03:29:00Z",
    fetchedAt: "2026-07-18T03:29:00Z",
  });
}

function signalForConfig(text, id, runConfig, options = {}) {
  return extractSignal(
    observationForConfig(text, id, runConfig, options),
    runConfig,
  );
}

function signalFor(text, id) {
  return signalForConfig(text, id, config);
}

test("realistic Tibo wording separates completed, scheduled, and denied resets", () => {
  const completed = [
    "We have reset Codex usage limits across all plans. Have fun!",
    "Codex rate limits had been reset for all paid plans.",
    "Oops... I did it again. Enjoy reset usage limits for all paid users for Codex and ChatGPT Work.",
  ].map((text, index) => signalFor(text, `completed-${index}`));
  for (const signal of completed) {
    assert.equal(signal.data.claim.event_type, "quota_reset");
    assert.equal(signal.data.claim.phase, "completed");
    assert.equal(signal.data.claim.scope.population, "platform");
  }

  const scheduled = signalFor(
    "We will reset Codex usage limits for all paid users later today.",
    "scheduled",
  );
  assert.equal(scheduled.data.claim.phase, "scheduled");

  const denied = signalFor(
    "This should not be treated as a new global Codex reset.",
    "denied",
  );
  assert.equal(denied.data.claim.phase, "denied");
  assert.equal(denied.data.claim.stance, "contradicts");
});

test("extractor keeps Codex, ChatGPT Work, unknown, and multi-product scopes distinct", () => {
  const codex = signalFor(
    "Codex usage limits have been reset for all paid plans.",
    "scope-codex",
  );
  const chatgptWork = signalFor(
    "ChatGPT Work usage limits have been reset for all paid plans.",
    "scope-chatgpt-work",
  );
  const unknown = signalFor(
    "Usage limits have been reset for all paid plans.",
    "scope-unknown",
  );
  const multi = signalFor(
    "Codex and ChatGPT Work usage limits have been reset for all paid plans.",
    "scope-multi",
  );
  const mixedVendor = signalFor(
    "Claude usage limits have been reset globally, unlike Codex.",
    "scope-mixed-vendor",
  );

  assert.equal(codex.data.claim.scope.product, "codex");
  assert.equal(chatgptWork.data.claim.scope.product, "chatgpt_work");
  assert.equal(unknown.data.claim.scope.product, "unknown");
  assert.equal(multi.data.claim.scope.product, "multi_product");
  assert.deepEqual(multi.data.claim.scope.products, ["chatgpt_work", "codex"].sort());
  assert.equal(mixedVendor.data.claim.scope.vendor, "multi_vendor");
  assert.equal(mixedVendor.data.claim.scope.product, "multi_product");
  assert.deepEqual(
    mixedVendor.data.claim.scope.products,
    ["codex", "competing_model"].sort(),
  );
});

test("only explicit Codex or multi-product Codex completions become Codex outcomes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-product-scope-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cases = [
    {
      id: "codex",
      text: "Codex usage limits have been reset for all paid plans.",
      product: "codex",
      outcomes: 1,
    },
    {
      id: "multi",
      text: "Codex and ChatGPT Work usage limits have been reset for all paid plans.",
      product: "multi_product",
      outcomes: 1,
    },
    {
      id: "chatgpt-work",
      text: "ChatGPT Work usage limits have been reset for all paid plans.",
      product: "chatgpt_work",
      outcomes: 0,
    },
    {
      id: "unknown",
      text: "Usage limits have been reset for all paid plans.",
      product: "unknown",
      outcomes: 0,
    },
    {
      id: "mixed-vendor",
      text: "Claude usage limits have been reset globally, unlike Codex.",
      product: "multi_product",
      outcomes: 0,
    },
  ];
  for (const entry of cases) {
    const store = await new JsonlStore(path.join(directory, entry.id)).init();
    const observation = rawObservationFromItem({
      provider_item_id: `product-scope-${entry.id}`,
      canonical_url: `https://x.com/thsottiaux/status/product-scope-${entry.id}`,
      published_at: "2026-07-18T03:28:00Z",
      author: {
        provider_author_id: "tibo-x-id",
        identity_id: "person_tibo_sottiaux",
        display_handle: "@thsottiaux",
      },
      native_relations: [],
      content: { media_type: "text/plain", text: entry.text, language: "en" },
    }, {
      providerName: "x",
      providerVersion: "test",
      config: config.providers.x,
      firstSeenAt: "2026-07-18T03:29:00Z",
      fetchedAt: "2026-07-18T03:29:00Z",
    });
    await store.append(observation);
    await normalizeNewObservations(store, config, {
      now: new Date("2026-07-18T03:30:00Z"),
    });
    await linkEventCandidates(store, config, {
      asOf: new Date("2026-07-18T03:31:00Z"),
    });
    await adjudicateOutcomes(store, config, {
      now: new Date("2026-07-18T03:32:00Z"),
    });

    const [signal] = await store.all("normalized_signal");
    assert.equal(signal.data.claim.scope.product, entry.product);
    const outcomes = await store.all("reset_outcome");
    assert.equal(outcomes.length, entry.outcomes, entry.id);
    if (entry.outcomes === 1) {
      assert.equal(outcomes[0].data.status, "confirmed");
      const eligibility = buildOutcomeEligibilityContext({
        observations: await store.all("raw_observation", { latestOnly: false }),
        signals: await store.all("normalized_signal"),
        config,
      });
      assert.equal(
        isEligibleConfirmedOutcome(outcomes[0], {
          ...eligibility,
          confirmationIdentityIds: confirmationIdentityIds(config),
        }),
        true,
        `${entry.id} should remain label-eligible`,
      );
    }
  }
});

test("real archived rollout wording is recognized without promoting banked or future resets", () => {
  const completedAfterUnrelatedNegation = signalFor(
    "We are taking active steps for incidents to not reproduce. I have reset usage limits for Codex across all paid plans.",
    "cross-sentence-negation",
  );
  assert.equal(completedAfterUnrelatedNegation.data.claim.phase, "completed");
  assert.equal(completedAfterUnrelatedNegation.data.claim.scope.population, "platform");

  const started = [
    "Enjoy a full reset of your usage limits for ChatGPT Work and Codex. Propagating in the next hour.",
    "Introducing another usage limit reset for all our ChatGPT Work and Codex users. Should land over next 30 minutes.",
    "We are once again resetting the usage limits for all Codex users.",
    "Another reset for our Codex and ChatGPT Work users. Should have that sweet 100% weekly usage limit back in a few.",
    "New day, new usage reset for paid users of Codex and ChatGPT Work. Lands in the next hour.",
  ].map((text, index) => signalFor(text, `started-${index}`));
  for (const signal of started) {
    assert.equal(signal.data.claim.phase, "started");
    assert.equal(signal.data.claim.scope.population, "platform");
  }
  assert.equal(started[1].data.claim.asserted_time_range.precision, "minute");

  const banked = signalFor(
    "We have added a banked Codex reset to everyone's account. You can apply the reset later on your own schedule.",
    "banked",
  );
  assert.ok(!["started", "completed"].includes(banked.data.claim.phase));

  const future = signalFor(
    "We will reset Codex usage limits for all paid users later today.",
    "future",
  );
  assert.equal(future.data.claim.phase, "scheduled");
});

test("authority scope policy recognizes general completed Codex resets without widening narrow plans", () => {
  const generalCompleted = [
    [
      "2004100061933064395",
      "For Codex users, to thank you all for the fun we've had over the last months, our first gift is that we have reset rate limits and are lifting the usage limits to 2X the usual limits until the 1st of Jan.",
    ],
    [
      "2002137269134819610",
      "We rewrote the underlying system to track and bill usage in Codex and we have reset usage limits in the process. Backfilling is time consuming and it’s more fun to give free usage. Enjoy!",
    ],
    [
      "2031605592352313567",
      "OK, Codex is back and stable and we should be good for a while. Reset button pressed, should see it in a bit",
    ],
  ].map(([id, text]) => signalForConfig(text, id, authorityConfig));
  for (const signal of generalCompleted) {
    assert.equal(signal.data.claim.event_type, "quota_reset");
    assert.equal(signal.data.claim.phase, "completed");
    assert.equal(signal.data.claim.scope.population, "platform");
  }

  const immediateAndBanked = signalForConfig(
    "Dearest gentle codexer. We did a sneaky double reset. Not only do you get a full reset on us. But you are also getting one into the reset bank to use at your own leisure. Enjoy",
    "2067399435009622521",
    authorityConfig,
  );
  assert.equal(immediateAndBanked.data.claim.event_type, "quota_reset");
  assert.equal(immediateAndBanked.data.claim.phase, "completed");
  assert.equal(immediateAndBanked.data.claim.scope.population, "platform");

  const platformResetWithNarrowBankHistory = signalForConfig(
    "As we are still investigating, I have reset everyone's Codex usage limits. This is a hard reset given some users had stacked up to three banked resets already that they can apply on their own schedule.",
    "2071381664853319742",
    authorityConfig,
  );
  assert.equal(
    platformResetWithNarrowBankHistory.data.claim.phase,
    "completed",
  );
  assert.equal(
    platformResetWithNarrowBankHistory.data.claim.scope.population,
    "platform",
  );

  const narrowPlans = signalForConfig(
    "We don’t have evidence of a widespread issue with Codex usage being drained faster than it should but there are enough reports and we have reset rate limits for plus & pro subscriptions while we investigate.",
    "2030474136024400173",
    authorityConfig,
  );
  assert.equal(narrowPlans.data.claim.event_type, "quota_reset");
  assert.equal(narrowPlans.data.claim.phase, "completed");
  assert.equal(narrowPlans.data.claim.scope.population, "unknown");
});

test("a double reset with one banked voucher creates one immediate authority outcome", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-authority-double-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  await store.append(observationForConfig(
    "Dearest gentle codexer. We did a sneaky double reset. Not only do you get a full reset on us. But you are also getting one into the reset bank to use at your own leisure. Enjoy",
    "2067399435009622521",
    authorityConfig,
  ));
  const normalized = await normalizeNewObservations(store, authorityConfig, {
    now: new Date("2026-07-18T03:30:00Z"),
  });
  assert.equal(normalized.records.length, 1);
  await linkEventCandidates(store, authorityConfig, {
    asOf: new Date("2026-07-18T03:31:00Z"),
  });
  await adjudicateOutcomes(store, authorityConfig, {
    now: new Date("2026-07-18T03:32:00Z"),
  });
  const outcomes = await store.all("reset_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].data.status, "confirmed");
});

test("authority inference requires the configured semantics, identity, and a primary statement", () => {
  const text =
    "We rewrote the underlying system to track and bill usage in Codex and we have reset usage limits in the process.";
  const actualResetSemantics = signalForConfig(text, "authority-disabled", config);
  assert.equal(actualResetSemantics.data.claim.scope.population, "unknown");

  const unconfiguredIdentity = signalForConfig(
    text,
    "authority-unconfigured",
    authorityConfig,
    { identityId: "community_member", handle: "community" },
  );
  assert.equal(unconfiguredIdentity.data.claim.scope.population, "unknown");

  const quoted = signalForConfig(
    text,
    "authority-quoted",
    authorityConfig,
    {
      nativeRelations: [{
        type: "quotes",
        provider_item_id: "authority-original",
        url: "https://x.com/someone/status/authority-original",
      }],
    },
  );
  assert.equal(quoted.data.provenance.derivation, "quotes");
  assert.equal(quoted.data.claim.scope.population, "unknown");

  const summary = signalForConfig(
    text,
    "authority-summary",
    authorityConfig,
    { mediaType: "application/vnd.x-search-summary+text" },
  );
  assert.equal(summary.data.provenance.source_role, "aggregator");
  assert.equal(summary.data.claim.scope.population, "unknown");
});

test("global outage wording does not leak into reset scope", () => {
  const text =
    "Codex outage resolved. We suffered a minor outage for last 45 minutes which turned into a global outage for last 30 minutes, this is now resolved and we have reset the rate limits. Please let me know if you still see issues.";
  const defaultSignal = signalForConfig(text, "1986166501435711936", config);
  assert.equal(defaultSignal.data.claim.phase, "completed");
  assert.equal(defaultSignal.data.claim.scope.population, "unknown");

  const authoritySignal = signalForConfig(
    text,
    "1986166501435711936-authority",
    authorityConfig,
  );
  assert.equal(authoritySignal.data.claim.scope.population, "platform");
});

test("banked-only and non-completed authority resets stay out of immediate outcomes", () => {
  const bankedOnly = [
    "We have added a banked Codex reset to everyone's account. You can apply the reset later on your own schedule.",
    "Added a banked reset to 500k users of ChatGPT Work and Codex. They can redeem it whenever they choose.",
  ].map((text, index) =>
    signalForConfig(text, `banked-only-${index}`, authorityConfig)
  );
  for (const signal of bankedOnly) {
    assert.notEqual(signal.data.claim.phase, "completed");
    assert.equal(signal.data.claim.scope.population, "unknown");
  }

  const started = signalForConfig(
    "We are once again resetting the usage limits for all Codex users.",
    "authority-started",
    authorityConfig,
  );
  assert.equal(started.data.claim.phase, "started");

  const scheduled = signalForConfig(
    "We will reset Codex usage limits later today.",
    "authority-scheduled",
    authorityConfig,
  );
  assert.equal(scheduled.data.claim.phase, "scheduled");
  assert.equal(scheduled.data.claim.scope.population, "platform");
});

test("relative reset intent keeps a conservative future range and incidents remain context", () => {
  const evening = signalFor(
    "We are monitoring to confirm and I will reset usage limits this evening. Now is the time for /fast.",
    "evening",
  );
  assert.equal(evening.data.claim.phase, "scheduled");
  assert.equal(evening.data.claim.asserted_time_range.original_text, "this evening");
  assert.equal(evening.data.claim.asserted_time_range.start, "2026-07-18T03:28:00.000Z");
  assert.equal(evening.data.claim.asserted_time_range.end, "2026-07-19T03:28:00.000Z");

  const tomorrow = signalFor(
    "Five million users would agree. Resetting the limits tomorrow morning to celebrate.",
    "tomorrow",
  );
  assert.equal(tomorrow.data.claim.phase, "scheduled");
  assert.equal(tomorrow.data.claim.asserted_time_range.original_text, "tomorrow morning");

  const incident = signalFor(
    "The Codex team is in a warroom investigating faster usage draining for some accounts.",
    "incident",
  );
  assert.equal(incident.data.claim.event_type, "incident");
  assert.equal(incident.data.claim.phase, "completed");
});

test("numeric reset intent durations become bounded publication-to-deadline ranges", () => {
  const numericRanges = [
    ["within the next 1-2 hours", "numeric-hours-ascii"],
    ["over the next 1–2 hours", "numeric-hours-unicode"],
    ["in the next 1 to 2 hours", "numeric-hours-to"],
  ].map(([duration, id]) =>
    signalFor(
      `We will reset Codex usage limits for all paid users ${duration}.`,
      id,
    )
  );
  for (const signal of numericRanges) {
    assert.equal(signal.data.claim.phase, "scheduled");
    assert.equal(signal.data.claim.asserted_time_range.start, "2026-07-18T03:28:00.000Z");
    assert.equal(signal.data.claim.asserted_time_range.end, "2026-07-18T05:28:00.000Z");
    assert.equal(signal.data.claim.asserted_time_range.precision, "hour");
  }

  const singleDeadline = signalFor(
    "We will reset Codex usage limits for all paid users in 2 hours.",
    "numeric-hours-single",
  );
  assert.equal(singleDeadline.data.claim.asserted_time_range.start, "2026-07-18T03:28:00.000Z");
  assert.equal(singleDeadline.data.claim.asserted_time_range.end, "2026-07-18T05:28:00.000Z");

  const nextHour = signalFor(
    "Codex usage limits for all paid users will reset in the next hour.",
    "preserve-next-hour",
  );
  assert.equal(nextHour.data.claim.asserted_time_range.end, "2026-07-18T04:28:00.000Z");

  const nextFewHours = signalFor(
    "Codex usage limits for all paid users will reset over the next few hours.",
    "preserve-next-few-hours",
  );
  assert.equal(nextFewHours.data.claim.asserted_time_range.end, "2026-07-18T06:28:00.000Z");

  const nextThirtyMinutes = signalFor(
    "A Codex usage limit reset for all paid users should land over the next 30 minutes.",
    "preserve-next-thirty-minutes",
  );
  assert.equal(nextThirtyMinutes.data.claim.asserted_time_range.start, "2026-07-18T03:28:00.000Z");
  assert.equal(nextThirtyMinutes.data.claim.asserted_time_range.end, "2026-07-18T03:58:00.000Z");
  assert.equal(nextThirtyMinutes.data.claim.asserted_time_range.precision, "minute");

  const unrelatedDuration = signalFor(
    "We will reset Codex usage limits for all paid users during a 2 hour window.",
    "unrelated-duration-window",
  );
  assert.equal(unrelatedDuration.data.claim.phase, "scheduled");
  assert.equal(unrelatedDuration.data.claim.asserted_time_range, null);
});

test("timeline wording keeps denials and reset timing attached to the reset claim", () => {
  const denial = signalForConfig(
    "Here you are! Thinking I am about to announce a reset. But no. I’m just scrolling twitter and looking for feedback on ChatGPT Work.",
    "2077212009071075330",
    authorityConfig,
  );
  assert.equal(denial.data.claim.phase, "denied");
  assert.equal(denial.data.claim.stance, "contradicts");

  const fewMinutes = signalForConfig(
    "Another reset for our Codex and ChatGPT Work users. Should have that sweet 100% weekly usage limit back in a few minutes.",
    "2077607697487188198",
    authorityConfig,
  );
  assert.equal(fewMinutes.data.claim.phase, "started");
  assert.equal(
    fewMinutes.data.claim.asserted_time_range.end,
    "2026-07-18T03:58:00.000Z",
  );
  assert.equal(fewMinutes.data.claim.asserted_time_range.precision, "minute");

  const unrelatedTomorrow = signalForConfig(
    "We are once again resetting the usage limits for all Codex users. See you tomorrow for more product updates!",
    "2077114635308986427",
    authorityConfig,
  );
  assert.equal(unrelatedTomorrow.data.claim.phase, "started");
  assert.equal(unrelatedTomorrow.data.claim.asserted_time_range, null);

  const deadline = signalForConfig(
    "This was fixed. You know what's coming. Give us 24 hours to reset the Codex rate limits across all plans.",
    "2066956441173323943",
    authorityConfig,
  );
  assert.equal(deadline.data.claim.phase, "scheduled");
  assert.equal(
    deadline.data.claim.asserted_time_range.end,
    "2026-07-19T03:28:00.000Z",
  );
});

test("core source roles and confirmation identities are not tied to the X adapter", async () => {
  const providerNeutral = await loadConfig({ overrides: {
    providers: {
      fixture: {
        confirmation_identities: [{
          identity_id: "fixture_confirming_team",
          source_role: "product_team_member",
        }],
      },
    },
  } });
  assert.equal(confirmationIdentityIds(providerNeutral).has("fixture_confirming_team"), true);
  assert.equal(
    sourceRoleForIdentity(providerNeutral, "fixture_confirming_team"),
    "product_team_member",
  );
  assert.match(providerNeutral.timezone_database_version, /^tzdata-/);
});

test("target and identity-role policy changes replay exact observations and exclude old signals", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-semantic-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const observation = rawObservationFromItem({
    provider_item_id: "semantic-policy-replay",
    canonical_url: "https://x.com/thsottiaux/status/2111111111111111111",
    published_at: "2026-07-18T03:28:00Z",
    author: {
      provider_author_id: "tibo-x-id",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "Codex usage limits have been reset for all paid plans.",
      language: "en",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: config.providers.x,
    firstSeenAt: "2026-07-18T03:29:00Z",
    fetchedAt: "2026-07-18T03:29:00Z",
  });
  await store.append(observation);
  const targetChanged = await loadConfig({ overrides: {
    target: { product: "chatgpt_work" },
  } });
  const roleChanged = await loadConfig({ overrides: {
    target: { product: "chatgpt_work" },
    providers: {
      x: {
        confirmation_identities: [{
          username: "thsottiaux",
          identity_id: "person_tibo_sottiaux",
          source_role: "official",
        }],
      },
      x_search_gateway: {
        confirmation_identities: [{
          username: "thsottiaux",
          identity_id: "person_tibo_sottiaux",
          source_role: "official",
        }],
      },
      historical_monitor: {
        confirmation_identities: [{
          username: "thsottiaux",
          identity_id: "person_tibo_sottiaux",
          source_role: "official",
        }],
      },
    },
  } });
  const contracts = [
    extractorContract(config),
    extractorContract(targetChanged),
    extractorContract(roleChanged),
  ];
  assert.equal(new Set(contracts.map((contract) => contract.semantic_policy_hash)).size, 3);

  const runs = [
    [config, "2026-07-18T03:30:00Z"],
    [targetChanged, "2026-07-18T03:31:00Z"],
    [roleChanged, "2026-07-18T03:32:00Z"],
  ];
  const replayed = [];
  for (const [runConfig, now] of runs) {
    const result = await normalizeNewObservations(store, runConfig, {
      now: new Date(now),
    });
    assert.equal(result.normalized, 1);
    replayed.push(result.records[0]);
  }
  assert.deepEqual(
    replayed.map((signal) => signal.data.extraction.semantic_policy_hash),
    contracts.map((contract) => contract.semantic_policy_hash),
  );
  assert.equal(replayed[0].data.provenance.source_role, "product_lead");
  assert.equal(replayed[2].data.provenance.source_role, "official");
  assert.equal(matchesExpectedExtractor(replayed[0], contracts[2]), false);
  assert.equal(matchesExpectedExtractor(replayed[2], contracts[2]), true);

  const vector = featureVectorAt({
    targetTime: "2026-07-18T04:00:00Z",
    knowledgeCutoff: "2026-07-18T04:00:00Z",
    signals: await store.all("normalized_signal", { latestOnly: false }),
    outcomes: [],
    observations: [observation],
    expectedExtractor: contracts[2],
    targetScope: roleChanged.target,
  });
  assert.deepEqual(
    vector.sourceRecords
      .filter((record) => record.record_type === "normalized_signal")
      .map((record) => record.record_id),
    [replayed[2].record_id],
  );
});

test("a newer extractor result replaces the same observation without double counting", () => {
  const current = signalFor(
    "We have reset Codex usage limits across all plans.",
    "versioned-observation",
  );
  const old = {
    ...current,
    record_id: "sig_old_extractor",
    producer: { ...current.producer, version: "0.2.2" },
    data: {
      ...current.data,
      extraction: {
        ...current.data.extraction,
        model_version: "0.2.2",
        prompt_version: "reset-extract/rules-0.2.2",
      },
    },
  };
  assert.deepEqual(selectCurrentSignals([current, old]), [current]);

  const laterConfiguredExtractor = {
    ...current,
    record_id: "sig_later_configured_extractor",
    created_at: "2026-07-19T00:00:00.000Z",
    data: {
      ...current.data,
      extraction: {
        ...current.data.extraction,
        model_version: "0.1.0",
        prompt_version: "reset-extract/rules-0.1.0-next",
      },
    },
  };
  assert.deepEqual(
    selectCurrentSignals([current, old, laterConfiguredExtractor]),
    [laterConfiguredExtractor],
  );

  const legacyHealthSignal = {
    ...current,
    record_id: "sig_legacy_provider_health",
    data: {
      ...current.data,
      observation_refs: [{ record_id: "obs_provider_health", revision: 1 }],
      provenance: {
        ...current.data.provenance,
        source_identity_id: null,
        source_published_at: null,
        canonical_source_url: null,
        root_evidence_id:
          "x_search_gateway_hermes:health-2026-07-26T08:00:00.000Z-error",
      },
    },
  };
  assert.deepEqual(
    selectCurrentSignals([current, legacyHealthSignal]),
    [current],
  );
});

test("extractor upgrades replay every exact raw revision without backdating new signals", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-extractor-replay-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const makeRevision = (text, revision, createdAt, supersedes = null) => {
    const base = rawObservationFromItem({
      provider_item_id: "extractor-replay",
      canonical_url: "https://x.com/thsottiaux/status/1234567890123456789",
      published_at: "2026-07-18T03:28:00Z",
      author: {
        provider_author_id: "tibo-x-id",
        identity_id: "person_tibo_sottiaux",
        display_handle: "@thsottiaux",
      },
      native_relations: [],
      content: { media_type: "text/plain", text, language: "en" },
    }, {
      providerName: "x",
      providerVersion: "test",
      config: config.providers.x,
      firstSeenAt: "2026-07-18T03:29:00Z",
      fetchedAt: createdAt,
    });
    return revision === 1 ? base : createRecord({
      recordType: "raw_observation",
      naturalKey: "x:extractor-replay",
      createdAt,
      revision,
      supersedes,
      producer: producer("x-provider", "test"),
      data: {
        ...base.data,
        first_seen_at: "2026-07-18T03:29:00.000Z",
        fetched_at: new Date(createdAt).toISOString(),
      },
    });
  };

  const first = makeRevision(
    "We have reset Codex usage limits across all plans.",
    1,
    "2026-07-18T03:29:00Z",
  );
  await store.append(first);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-18T03:30:00Z"),
  });
  const second = makeRevision(
    "We are resetting Codex usage limits across all plans now.",
    2,
    "2026-07-18T04:00:00Z",
    recordRef(first),
  );
  await store.append(second);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-18T04:01:00Z"),
  });

  const upgradedConfig = {
    ...config,
    extractor: {
      ...config.extractor,
      model_version: "0.2.7-test",
      prompt_version: "reset-extract/rules-0.2.7-test",
    },
  };
  const replayedAt = "2026-07-19T00:00:00.000Z";
  const replay = await normalizeNewObservations(store, upgradedConfig, {
    now: new Date(replayedAt),
  });
  assert.equal(replay.normalized, 2);
  assert.deepEqual(
    replay.records.map((signal) => signal.data.observation_refs[0].revision),
    [1, 2],
  );
  for (const signal of replay.records) {
    assert.equal(signal.created_at, replayedAt);
    assert.equal(signal.data.available_at, replayedAt);
    assert.equal(signal.data.extraction.model_version, "0.2.7-test");
    assert.equal(signal.data.extraction.prompt_version, "reset-extract/rules-0.2.7-test");
  }

  const allSignals = await store.all("normalized_signal", { latestOnly: false });
  for (const rawRevision of [1, 2]) {
    const exactSignals = allSignals.filter((signal) =>
      signal.data.observation_refs[0].revision === rawRevision
    );
    assert.equal(exactSignals.length, 2);
    assert.equal(selectCurrentSignals(exactSignals)[0].data.extraction.model_version, "0.2.7-test");
  }
  assert.equal(selectCurrentSignals(allSignals)[0].data.observation_refs[0].revision, 2);
  assert.equal(
    (await normalizeNewObservations(store, upgradedConfig, {
      now: new Date("2026-07-19T00:01:00Z"),
    })).normalized,
    0,
  );
});

test("an attested archive correction uses its real fetch time and stays out of older cutoffs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-archive-correction-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const item = (text) => ({
    provider_item_id: "archive-correction",
    canonical_url: "https://x.com/thsottiaux/status/1234567890123456789",
    published_at: "2026-07-01T03:28:00Z",
    availability_attestation: {
      available_at: "2026-07-01T03:28:00Z",
      basis: "direct_source_publication",
      attestor_url: "https://x.com/thsottiaux/status/1234567890123456789",
      verified_at: "2026-07-20T03:29:00Z",
      verification: "x_oembed+snowflake",
    },
    author: {
      provider_author_id: "tibo-x-id",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: { media_type: "text/plain", text, language: "en" },
  });
  const first = rawObservationFromItem(
    item("We have reset Codex usage limits across all paid plans."),
    {
      providerName: "historical_monitor",
      providerVersion: "test",
      config: config.providers.historical_monitor,
      firstSeenAt: "2026-07-20T03:29:00Z",
      fetchedAt: "2026-07-20T03:29:00Z",
    },
  );
  await store.append(first);
  const initial = await normalizeNewObservations(store, config, {
    now: new Date("2026-07-20T03:30:00Z"),
  });
  assert.equal(initial.records[0].data.available_at, "2026-07-01T03:28:00.000Z");

  const correctionFetchedAt = "2026-07-25T12:00:00.000Z";
  const correctedBase = rawObservationFromItem(
    item("This was not a global Codex reset."),
    {
      providerName: "historical_monitor",
      providerVersion: "test",
      config: config.providers.historical_monitor,
      firstSeenAt: first.data.first_seen_at,
      fetchedAt: correctionFetchedAt,
    },
  );
  const correction = createRecord({
    recordType: "raw_observation",
    naturalKey: "historical_monitor:archive-correction",
    createdAt: correctionFetchedAt,
    revision: 2,
    supersedes: recordRef(first),
    producer: producer("historical-monitor-provider", "test"),
    data: correctedBase.data,
  });
  await store.append(correction);
  const normalizedCorrection = await normalizeNewObservations(store, config, {
    now: new Date("2026-07-25T12:01:00Z"),
  });
  assert.equal(normalizedCorrection.normalized, 1);
  assert.equal(normalizedCorrection.records[0].data.available_at, correctionFetchedAt);

  const signals = await store.all("normalized_signal", { latestOnly: false });
  const visibleAtOldCutoff = selectCurrentSignals(latestSignalsAsOf(
    signals,
    "2026-07-10T00:00:00Z",
    AS_OF_MODE.ARCHIVE_REPLAY,
  ));
  assert.equal(visibleAtOldCutoff.length, 1);
  assert.equal(visibleAtOldCutoff[0].data.observation_refs[0].revision, 1);
});

test("a correction from completed to merely started does not rewrite a confirmed outcome", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-outcome-correction-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const makeRaw = (text) => rawObservationFromItem({
    provider_item_id: "corrected-outcome",
    canonical_url: "https://x.com/thsottiaux/status/corrected-outcome",
    published_at: "2026-07-18T03:28:00Z",
    author: {
      provider_author_id: "tibo-x-id",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: { media_type: "text/plain", text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: config.providers.x,
    firstSeenAt: "2026-07-18T03:29:00Z",
    fetchedAt: "2026-07-18T03:29:00Z",
  });
  const first = makeRaw("We have reset Codex usage limits across all plans.");
  await store.append(first);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-18T03:30:00Z"),
  });
  await linkEventCandidates(store, config, { asOf: new Date("2026-07-18T03:30:00Z") });
  await adjudicateOutcomes(store, config, {
    now: new Date("2026-07-18T03:30:00Z"),
  });

  const replacement = makeRaw(
    "We are resetting Codex usage limits across all plans. Propagating in the next hour.",
  );
  await store.append(createRecord({
    recordType: "raw_observation",
    naturalKey: "x:corrected-outcome",
    createdAt: "2026-07-18T04:00:00Z",
    revision: 2,
    supersedes: recordRef(first),
    producer: producer("x-provider", "test"),
    data: { ...replacement.data, first_seen_at: "2026-07-18T04:00:00Z", fetched_at: "2026-07-18T04:00:00Z" },
  }));
  await normalizeNewObservations(store, config, { now: new Date("2026-07-18T04:01:00Z") });
  await linkEventCandidates(store, config, { asOf: new Date("2026-07-18T04:01:00Z") });
  await adjudicateOutcomes(store, config, { now: new Date("2026-07-18T04:02:00Z") });
  const outcomes = await store.all("reset_outcome", { latestOnly: false });
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0];
  assert.equal(outcome.revision, 1);
  assert.equal(outcome.supersedes, null);
  assert.equal(outcome.data.known_at, "2026-07-18T03:30:00.000Z");
  assert.equal(outcome.data.verification[0].observation_ref.revision, 1);
});

test("copied posts collapse within one wave without erasing the authoritative root or later events", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-extraction-dedup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const text = "We have reset Codex usage limits across all paid plans.";
  const makeObservation = ({ id, at, identityId, handle, body = text }) => rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/${handle}/status/${id}`,
    published_at: at,
    author: {
      provider_author_id: `${handle}-id`,
      identity_id: identityId,
      display_handle: `@${handle}`,
    },
    native_relations: [],
    content: { media_type: "text/plain", text: body, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: config.providers.x,
    firstSeenAt: new Date(Date.parse(at) + 60_000),
    fetchedAt: new Date(Date.parse(at) + 60_000),
  });
  const first = makeObservation({
    id: "root",
    at: "2026-07-01T00:00:00Z",
    identityId: "community-copy",
    handle: "community",
  });
  const copied = makeObservation({
    id: "copy",
    at: "2026-07-01T01:00:00Z",
    identityId: "person_tibo_sottiaux",
    handle: "thsottiaux",
  });
  const laterEvent = makeObservation({
    id: "later",
    at: "2026-07-09T00:00:00Z",
    identityId: "person_tibo_sottiaux",
    handle: "thsottiaux",
  });
  await store.appendMany([first, copied]);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-01T01:02:00Z"),
  });
  await store.append(laterEvent);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-09T00:02:00Z"),
  });
  const signals = (await store.all("normalized_signal"))
    .sort((left, right) => left.data.available_at.localeCompare(right.data.available_at));
  assert.equal(signals[0].data.provenance.independence_group_id, signals[1].data.provenance.independence_group_id);
  assert.equal(signals[1].data.provenance.derivation, "summarizes");
  assert.notEqual(signals[0].data.provenance.independence_group_id, signals[2].data.provenance.independence_group_id);

  const vector = featureVectorAt({
    targetTime: "2026-07-01T02:00:00Z",
    knowledgeCutoff: "2026-07-01T02:00:00Z",
    signals,
    outcomes: [],
    observations: [first, copied],
    coverageIntervals: [{ start: "2026-07-01T00:00:00Z", end: "2026-07-01T03:00:00Z" }],
    confirmationIdentityIds: confirmationIdentityIds(config),
    outcomeCoverageProviders: new Set(["x"]),
  });
  assert.ok(
    vector.features.official_reset_activity_decay > 0,
    "a later copy must not replace the authoritative evidence root",
  );

  assert.equal((await normalizeNewObservations(store, config)).normalized, 0);
  const replacement = makeObservation({
    id: "root",
    at: "2026-07-01T03:00:00Z",
    identityId: "community-copy",
    handle: "community",
    body: "This should not be treated as a new global Codex reset.",
  });
  const correction = createRecord({
    recordType: "raw_observation",
    naturalKey: "x:root",
    createdAt: "2026-07-01T03:01:00Z",
    revision: 2,
    supersedes: recordRef(first),
    producer: producer("x-provider", "test"),
    data: replacement.data,
  });
  await store.append(correction);
  const corrected = await normalizeNewObservations(store, config, {
    now: new Date("2026-07-01T03:02:00Z"),
  });
  assert.equal(corrected.normalized, 1);
  assert.equal(corrected.records[0].data.observation_refs[0].revision, 2);
});
