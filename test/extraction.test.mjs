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
import {
  selectCurrentRelevantSignals,
  selectCurrentSignals,
} from "../src/pipeline/signal-selection.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import {
  adjudicateOutcomes,
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../src/pipeline/outcomes.mjs";
import {
  isAuthorityTimingSupportSignal,
} from "../src/model/authority-timing-eligibility.mjs";

const config = await loadConfig();
const authorityConfig = await loadConfig({ overrides: {
  extractor: {
    authority_reply_identity_ids: ["person_tibo_sottiaux"],
  },
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
  publishedAt = "2026-07-18T03:28:00Z",
  firstSeenAt = "2026-07-18T03:29:00Z",
  fetchedAt = firstSeenAt,
} = {}) {
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
    content: { media_type: mediaType, text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: runConfig.providers.x,
    firstSeenAt,
    fetchedAt,
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

test("topic screening keeps search false positives as ineligible audit signals", () => {
  const cases = [
    [
      "__RATE_LIMIT__: Gemini monthly cap exceeded for gemini-2.5-flash. " +
        "HTTP 429: You exceeded your current quota.",
      "individual_quota_error",
    ],
    [
      "Grok isn’t so sure: abundance does not automatically equal open access. " +
        "The capacity to define objectives remains a locus of control and " +
        "technology will force society to confront it.",
      "generic_discussion",
    ],
    [
      "Trying, but not sure this time (possible reset hint; does not explicitly " +
        "state Codex usage-limit reset).",
      "explicit_non_claim",
    ],
  ];
  const screened = cases.map(([text], index) =>
    signalForConfig(text, `screened-${index}`, config, {
      identityId: "x_search_summary",
      handle: "community",
      mediaType: "application/vnd.x-search-summary+text",
    })
  );

  for (const [index, signal] of screened.entries()) {
    assert.ok(signal, `screened case ${index} should retain an audit extraction`);
    assert.equal(signal.data.extraction.relevance.decision, "irrelevant");
    assert.equal(
      signal.data.extraction.relevance.reason_code,
      cases[index][1],
    );
    assert.equal(signal.data.provenance.feature_eligible, false);
  }
  assert.deepEqual(selectCurrentSignals(screened), []);
  assert.equal(
    signalForConfig(
      "Hey Tibo, can we get a Claude reset as well?",
      "screened-request-without-claim",
      config,
      {
        identityId: "x_search_summary",
        handle: "community",
        mediaType: "application/vnd.x-search-summary+text",
      },
    ),
    null,
  );
});

test("topic screening retains genuine target and ecosystem operations", () => {
  const relevant = [
    "We have reset Codex usage limits for all paid users.",
    "Codex is degraded and the team is investigating a capacity incident.",
    "Anthropic doubled Claude Code usage limits across all paid plans.",
    "Google officially released Gemini 3.6 Flash today.",
  ].map((text, index) =>
    signalForConfig(text, `relevant-${index}`, config, {
      identityId: "x_search_summary",
      handle: "community",
      mediaType: "application/vnd.x-search-summary+text",
    })
  );

  assert.equal(selectCurrentSignals(relevant).length, relevant.length);
  assert.ok(relevant.every((signal) =>
    signal.data.extraction.relevance.decision === "relevant" &&
    signal.data.provenance.feature_eligible
  ));
});

test("experience severity and competitive releases are semantic categories, not source roles", () => {
  const userIssue = signalForConfig(
    "Codex CLI hangs indefinitely whenever an MCP tool returns.",
    "2082000000000000001",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(userIssue.data.claim.event_type, "experience_issue");
  assert.deepEqual(userIssue.data.claim.impact, {
    category: "tool_execution",
    severity: "medium",
    lifecycle: "active",
    affected_scope: "unknown",
    affected_surfaces: ["cli", "tool_use", "mcp"],
    workaround: "unknown",
    evidence_basis: "first_party_report",
  });
  assert.equal(userIssue.data.provenance.source_role, "community");
  assert.equal(userIssue.data.provenance.feature_eligible, false);
  assert.deepEqual(selectCurrentSignals([userIssue]), []);
  assert.deepEqual(selectCurrentRelevantSignals([userIssue]), [userIssue]);

  const launchCrash = signalForConfig(
    "Codex desktop crashes on launch with an auth error for multiple users.",
    "2082000000000000004",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(launchCrash.data.claim.event_type, "experience_issue");
  assert.equal(launchCrash.data.claim.impact.category, "auth");
  assert.equal(launchCrash.data.claim.impact.severity, "high");

  const securityIssue = signalForConfig(
    "Codex has a security vulnerability that exposes authentication tokens for multiple users.",
    "2082000000000000005",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(securityIssue.data.claim.event_type, "experience_issue");
  assert.equal(securityIssue.data.claim.impact.category, "security_privacy");
  assert.equal(securityIssue.data.claim.impact.severity, "high");

  const reverseSecurityIssue = signalForConfig(
    "Codex leaked authentication tokens for multiple users.",
    "2082000000000000008",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(reverseSecurityIssue.data.claim.event_type, "experience_issue");
  assert.equal(reverseSecurityIssue.data.claim.impact.category, "security_privacy");
  assert.equal(reverseSecurityIssue.data.claim.impact.severity, "high");

  const forwardSecurityVariants = [
    "Codex authentication tokens were exposed.",
    "Codex credentials were leaked.",
    "Codex API keys were compromised.",
    "Codex private customer data was exposed.",
  ].map((text, index) =>
    signalForConfig(
      text,
      `20820000000000001${index + 4}`,
      config,
      { identityId: "community_reporter", handle: "reporter" },
    )
  );
  for (const signal of forwardSecurityVariants) {
    assert.equal(signal.data.claim.event_type, "experience_issue");
    assert.equal(signal.data.claim.impact.category, "security_privacy");
    assert.notEqual(signal.data.claim.impact.severity, "unknown");
  }

  const dataIntegrityIssue = signalForConfig(
    "Codex lost local changes because session data was corrupted for multiple users.",
    "2082000000000000006",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(dataIntegrityIssue.data.claim.event_type, "experience_issue");
  assert.equal(dataIntegrityIssue.data.claim.impact.category, "data_integrity");

  const destructivePlatformIssue = signalForConfig(
    "Codex data was truncated across the platform.",
    "2082000000000000009",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(destructivePlatformIssue.data.claim.event_type, "experience_issue");
  assert.equal(destructivePlatformIssue.data.claim.impact.category, "data_integrity");
  assert.equal(destructivePlatformIssue.data.claim.impact.affected_scope, "platform");
  assert.equal(destructivePlatformIssue.data.claim.impact.severity, "critical");

  const compatibilityIssue = signalForConfig(
    "Codex has a compatibility regression after the latest IDE update.",
    "2082000000000000007",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(compatibilityIssue.data.claim.event_type, "experience_issue");
  assert.equal(compatibilityIssue.data.claim.impact.category, "compatibility");

  const continuingWithWorkaround = signalForConfig(
    "Codex is still broken for multiple users, but a workaround is available.",
    "2082000000000000010",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(
    continuingWithWorkaround.data.claim.event_type,
    "experience_issue",
  );
  assert.equal(
    continuingWithWorkaround.data.claim.impact.lifecycle,
    "mitigating",
  );
  assert.equal(
    continuingWithWorkaround.data.claim.impact.workaround,
    "available",
  );
  assert.equal(continuingWithWorkaround.data.claim.impact.severity, "high");

  const failedFix = signalForConfig(
    "Codex is still broken for multiple users after it was fixed.",
    "2082000000000000012",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(failedFix.data.claim.event_type, "experience_issue");
  assert.equal(failedFix.data.claim.impact.lifecycle, "active");
  assert.equal(failedFix.data.claim.impact.severity, "high");

  const failedSecurityPatch = signalForConfig(
    "Codex continues leaking authentication tokens after being patched.",
    "2082000000000000013",
    config,
    { identityId: "community_reporter", handle: "reporter" },
  );
  assert.equal(failedSecurityPatch.data.claim.event_type, "experience_issue");
  assert.equal(
    failedSecurityPatch.data.claim.impact.category,
    "security_privacy",
  );
  assert.equal(failedSecurityPatch.data.claim.impact.lifecycle, "active");
  assert.notEqual(failedSecurityPatch.data.claim.impact.severity, "unknown");

  const resolvedMcpIssue = signalForConfig(
    "The Codex MCP issue is fixed and working again.",
    "2082000000000000011",
    config,
    { identityId: "org_openai", handle: "OpenAI" },
  );
  assert.equal(resolvedMcpIssue.data.claim.event_type, "experience_recovery");
  assert.equal(resolvedMcpIssue.data.claim.impact.category, "tool_execution");
  assert.equal(resolvedMcpIssue.data.claim.impact.lifecycle, "resolved");

  const officialOutage = signalForConfig(
    "Codex is unavailable platform-wide while we investigate an outage.",
    "2082000000000000002",
    config,
    { identityId: "org_openai", handle: "OpenAI" },
  );
  assert.equal(officialOutage.data.claim.event_type, "incident");
  assert.equal(officialOutage.data.claim.impact.severity, "critical");
  assert.equal(officialOutage.data.claim.impact.affected_scope, "platform");
  assert.equal(officialOutage.data.claim.impact.evidence_basis, "official_incident");

  const competitor = signalForConfig(
    "Anthropic released Claude Code 5 for general availability.",
    "2082000000000000003",
    config,
    { identityId: "org_anthropic", handle: "Anthropic" },
  );
  assert.equal(competitor.data.claim.event_type, "competitor_model_release");
  assert.deepEqual(competitor.data.claim.competitive_context, {
    kind: "coding_agent_release",
    relevance: "direct",
    stage: "general_availability",
  });
});

test("resolved reply context is bound by exact reference and cannot be backdated", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-topic-context-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const parentId = "2081000000000000001";
  const childId = "2081000000000000002";
  const makeObservation = ({
    id,
    text,
    firstSeenAt,
    nativeRelations = [],
  }) => rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/example/status/${id}`,
    published_at: "2026-07-18T03:28:00Z",
    author: {
      provider_author_id: "example",
      identity_id: "x_example",
      display_handle: "@example",
    },
    native_relations: nativeRelations,
    content: { media_type: "text/plain", text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: config.providers.x,
    firstSeenAt,
    fetchedAt: firstSeenAt,
  });
  const child = makeObservation({
    id: childId,
    text: "Still seeing this in the CLI.",
    firstSeenAt: "2026-07-18T03:29:00Z",
    nativeRelations: [{
      type: "reply",
      provider_item_id: parentId,
      url: `https://x.com/i/status/${parentId}`,
    }],
  });
  const parent = makeObservation({
    id: parentId,
    text: "Codex is degraded and the team is investigating a capacity incident.",
    firstSeenAt: "2026-07-18T03:31:00Z",
  });
  await store.append(child);
  const unresolved = await normalizeNewObservations(store, config, {
    now: new Date("2026-07-18T03:30:00Z"),
  });
  assert.equal(unresolved.records.length, 0);

  await store.append(parent);
  await normalizeNewObservations(store, config, {
    now: new Date("2026-07-18T03:32:00Z"),
  });
  const childSignal = (await store.all("normalized_signal")).find((signal) =>
    signal.data.observation_refs[0].record_id === child.record_id
  );
  assert.ok(childSignal);
  assert.equal(childSignal.data.extraction.relevance.decision, "relevant");
  assert.equal(childSignal.data.extraction.relevance.basis, "reply_parent");
  assert.equal(childSignal.data.provenance.derivation, "reply");
  assert.equal(
    childSignal.data.provenance.root_evidence_id,
    `x_post:${parentId}`,
  );
  assert.deepEqual(
    childSignal.data.observation_refs,
    [recordRef(child), recordRef(parent)],
  );
  assert.equal(childSignal.data.available_at, "2026-07-18T03:32:00.000Z");
});

test("resolving an unused quote context reuses an unchanged immutable signal", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-unused-quote-context-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const parentId = "2080956723297198218";
  const child = observationForConfig(
    "We have reset usage limits for all Codex and ChatGPT Work users.",
    "2081096447718723984",
    authorityConfig,
    {
      publishedAt: "2026-07-25T19:17:12.695Z",
      firstSeenAt: "2026-08-13T04:41:16.000Z",
      nativeRelations: [{
        type: "quotes",
        provider_item_id: parentId,
        url: `https://x.com/community/status/${parentId}`,
      }],
    },
  );
  await store.append(child);
  const first = await normalizeNewObservations(store, authorityConfig, {
    now: new Date("2026-08-13T04:41:16.055Z"),
  });
  assert.equal(first.normalized, 1);
  assert.equal(first.records[0].data.extraction.relevance.basis, "self");
  assert.deepEqual(first.records[0].data.extraction.relevance.context_refs, []);

  const parent = observationForConfig(
    "Hey, does this mean a reset?",
    parentId,
    authorityConfig,
    {
      identityId: "community_member",
      handle: "community",
      mediaType: "application/vnd.x-search-summary+text",
      publishedAt: "2026-07-25T10:01:59.797Z",
      firstSeenAt: "2026-08-23T16:42:11.645Z",
    },
  );
  await store.append(parent);
  const resolved = await normalizeNewObservations(store, authorityConfig, {
    now: new Date("2026-08-23T16:42:12.000Z"),
  });
  assert.equal(resolved.normalized, 0);
  const childRecords = (await store.all("normalized_signal", { latestOnly: false }))
    .filter((signal) =>
      signal.data.observation_refs[0].record_id === child.record_id
    );
  assert.equal(childRecords.length, 1);
  assert.equal(childRecords[0].revision, 1);
  assert.equal(childRecords[0].created_at, first.records[0].created_at);
  assert.equal(childRecords[0].data.available_at, first.records[0].data.available_at);

  const state = await store.readState("normalization", { versions: {} });
  const version = Object.values(state.versions).find((entry) =>
    entry.processed?.[`${child.record_id}@1`] === true
  );
  assert.equal(
    version.context_signatures[`${child.record_id}@1`],
    `resolved|quotes:${parent.record_id}:1`,
  );
});

test("context-only authority replies cannot inherit a reset outcome", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-inherited-reply-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const parentId = "2081000000000000011";
  const replyId = "2081000000000000012";
  const parent = observationForConfig(
    "Codex usage limits have been reset for all paid users.",
    parentId,
    authorityConfig,
    {
      identityId: "community_member",
      handle: "community",
    },
  );
  const reply = observationForConfig(
    "Same here.",
    replyId,
    authorityConfig,
    {
      nativeRelations: [{
        type: "reply",
        provider_item_id: parentId,
        url: `https://x.com/community/status/${parentId}`,
      }],
    },
  );
  await store.appendMany([parent, reply]);
  await normalizeNewObservations(store, authorityConfig, {
    now: new Date("2026-07-18T03:32:00Z"),
  });
  const replySignal = (await store.all("normalized_signal"))
    .find((signal) =>
      signal.data.observation_refs[0].record_id === reply.record_id
    );
  assert.ok(replySignal);
  assert.equal(replySignal.data.extraction.relevance.basis, "reply_parent");
  assert.equal(replySignal.data.claim.phase, "completed");
  assert.equal(replySignal.data.provenance.derivation, "reply");
  assert.equal(replySignal.data.provenance.feature_eligible, false);
  assert.equal(
    replySignal.data.provenance.root_evidence_id,
    `x_post:${parentId}`,
  );

  await linkEventCandidates(store, authorityConfig, {
    asOf: new Date("2026-07-18T03:33:00Z"),
  });
  await adjudicateOutcomes(store, authorityConfig, {
    now: new Date("2026-07-18T03:34:00Z"),
  });
  assert.deepEqual(await store.all("reset_outcome"), []);
});

test("a self-contained authority reply remains its own primary statement", () => {
  const parentId = "2081000000000000021";
  const reply = observationForConfig(
    "We have reset Codex usage limits for all paid users.",
    "2081000000000000022",
    authorityConfig,
    {
      nativeRelations: [{
        type: "reply",
        provider_item_id: parentId,
        url: `https://x.com/community/status/${parentId}`,
      }],
    },
  );
  const signal = extractSignal(reply, authorityConfig);
  assert.ok(signal);
  assert.equal(signal.data.extraction.relevance.basis, "self");
  assert.equal(signal.data.provenance.derivation, "primary_statement");
  assert.equal(signal.data.provenance.feature_eligible, true);
  assert.equal(
    signal.data.provenance.root_evidence_id,
    "x_post:2081000000000000022",
  );
});

test("Tibo's own future reset reply uses parent scope without inheriting parent phase", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-authority-reply-commitment-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runConfig = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: { runtime: { data_dir: directory } },
  });
  const store = await new JsonlStore(directory).init();
  const childId = "2086189414292865249";
  const parentId = "2086188425691140496";
  const childText = "I'll do another performative reset on Monday";
  const parent = observationForConfig(
    "This is just performative at this point. The weekly reset was yesterday.\n" +
      "Tibo: I have reset usage limits for all paid users of ChatGPT Work and Codex.",
    parentId,
    runConfig,
    {
      identityId: "x_rxmphai",
      handle: "rxmphai",
      mediaType: "application/vnd.reset-reply-context+text",
      publishedAt: "2026-08-08T20:30:54.000Z",
      firstSeenAt: "2026-08-09T10:45:00.000Z",
    },
  );
  const child = observationForConfig(childText, childId, runConfig, {
    nativeRelations: [{
      type: "reply",
      provider_item_id: parentId,
      url: `https://x.com/rxmphai/status/${parentId}`,
    }],
    publishedAt: "2026-08-08T20:34:50.549Z",
    firstSeenAt: "2026-08-08T20:40:08.351Z",
  });
  await store.appendMany([child, parent]);

  const normalized = await normalizeNewObservations(store, runConfig, {
    now: new Date("2026-08-09T10:46:00.000Z"),
  });
  assert.equal(normalized.records.length, 1);
  const [signal] = normalized.records;
  assert.equal(signal.data.claim.event_type, "quota_reset");
  assert.equal(signal.data.claim.phase, "scheduled");
  assert.equal(signal.data.claim.stance, "supports");
  assert.equal(signal.data.claim.scope.product, "codex");
  assert.equal(signal.data.claim.scope.population, "platform");
  assert.deepEqual(signal.data.claim.asserted_time_range, {
    start: "2026-08-10T00:00:00.000Z",
    end: "2026-08-11T00:00:00.000Z",
    boundary: "[start,end)",
    precision: "day",
    timezone_basis: "UTC",
    original_text: "on Monday",
  });
  assert.equal(signal.data.available_at, "2026-08-09T10:45:00.000Z");
  assert.equal(
    signal.data.provenance.root_evidence_id,
    `x_post:${childId}`,
  );
  assert.equal(signal.data.provenance.derivation, "primary_statement");
  assert.equal(signal.data.provenance.feature_eligible, true);
  assert.equal(signal.data.extraction.relevance.basis, "self");
  assert.equal(
    signal.data.extraction.relevance.reason_code,
    "authority_reply_reset_commitment",
  );
  assert.deepEqual(signal.data.extraction.relevance.matched_segments, [childText]);
  assert.deepEqual(signal.data.extraction.relevance.context_refs, [recordRef(parent)]);
  assert.deepEqual(signal.data.observation_refs, [recordRef(child), recordRef(parent)]);

  await linkEventCandidates(store, runConfig, {
    asOf: new Date("2026-08-09T10:47:00.000Z"),
  });
  await adjudicateOutcomes(store, runConfig, {
    now: new Date("2026-08-09T10:48:00.000Z"),
  });
  assert.deepEqual(await store.all("reset_outcome"), []);
});

test("a same-day authority reply weekday range cannot precede publication", () => {
  const parentId = "2086188425691140496";
  const publishedAt = "2026-08-10T12:34:56.000Z";
  const observation = observationForConfig(
    "I'll do another performative reset on Monday",
    "2086189414292865256",
    authorityConfig,
    {
      nativeRelations: [{
        type: "reply",
        provider_item_id: parentId,
        url: `https://x.com/rxmphai/status/${parentId}`,
      }],
      publishedAt,
    },
  );
  const signal = extractSignal(observation, authorityConfig, {
    contexts: [{
      relation_type: "reply",
      text: "Codex usage limits were reset for all paid users.",
      observation_ref: { record_id: "obs_parent", revision: 1 },
      available_at: publishedAt,
    }],
  });

  assert.ok(signal);
  assert.deepEqual(signal.data.claim.asserted_time_range, {
    start: publishedAt,
    end: "2026-08-11T00:00:00.000Z",
    boundary: "[start,end)",
    precision: "day",
    timezone_basis: "UTC",
    original_text: "on Monday",
  });
});

test("authority reply adaptation fails closed outside the exact identity and relation", () => {
  const parentId = "2086188425691140496";
  const text = "I'll do another performative reset on Monday";
  const relation = [{
    type: "reply",
    provider_item_id: parentId,
    url: `https://x.com/rxmphai/status/${parentId}`,
  }];
  const contexts = [{
    relation_type: "reply",
    text: "Tibo: I have reset usage limits for all paid users of Codex.",
    observation_ref: { record_id: "obs_parent", revision: 1 },
    available_at: "2026-08-09T10:45:00.000Z",
  }];

  const nonAuthority = observationForConfig(text, "2086189414292865250", authorityConfig, {
    identityId: "community_member",
    handle: "thsottiaux",
    nativeRelations: relation,
    publishedAt: "2026-08-08T20:34:50.549Z",
  });
  assert.equal(extractSignal(nonAuthority, authorityConfig, { contexts }), null);

  const noReplyAllowlist = structuredClone(authorityConfig);
  noReplyAllowlist.extractor.authority_reply_identity_ids = [];
  const notAllowlisted = observationForConfig(
    text,
    "2086189414292865254",
    noReplyAllowlist,
    {
      nativeRelations: relation,
      publishedAt: "2026-08-08T20:34:50.549Z",
    },
  );
  assert.equal(
    extractSignal(notAllowlisted, noReplyAllowlist, { contexts }),
    null,
  );

  const standalone = observationForConfig(text, "2086189414292865251", authorityConfig, {
    publishedAt: "2026-08-08T20:34:50.549Z",
  });
  assert.equal(extractSignal(standalone, authorityConfig, { contexts }), null);

  const unresolved = observationForConfig(text, "2086189414292865252", authorityConfig, {
    nativeRelations: relation,
    publishedAt: "2026-08-08T20:34:50.549Z",
  });
  assert.equal(
    extractSignal(unresolved, authorityConfig, { hasUnresolvedContext: true }),
    null,
  );

  const unrelatedParent = observationForConfig(text, "2086189414292865253", authorityConfig, {
    nativeRelations: relation,
    publishedAt: "2026-08-08T20:34:50.549Z",
  });
  assert.equal(extractSignal(unrelatedParent, authorityConfig, {
    contexts: [{ ...contexts[0], text: "A conversation about Monday weather." }],
  }), null);

  for (const parentText of [
    "My Codex usage was reset yesterday.",
    "Codex usage limits were reset for Pro users.",
    "ChatGPT Work usage limits were reset for all paid users.",
    "Codex usage limits were reset for all users in the EU.",
    "Codex usage limits were reset for all users in Canada.",
    "Codex usage limits were reset for all users on Pro.",
  ]) {
    assert.equal(extractSignal(unrelatedParent, authorityConfig, {
      contexts: [{ ...contexts[0], text: parentText }],
    }), null, parentText);
  }

  const mismatchedRelation = observationForConfig(
    text,
    "2086189414292865255",
    authorityConfig,
    {
      nativeRelations: [{
        type: "reply",
        provider_item_id: parentId,
        url: "https://x.com/rxmphai/status/2086188425691140497",
      }],
      publishedAt: "2026-08-08T20:34:50.549Z",
    },
  );
  assert.equal(
    extractSignal(mismatchedRelation, authorityConfig, { contexts }),
    null,
  );

  for (const uncertain of [
    "Maybe I'll do another reset on Monday",
    "Will I do another reset on Monday?",
    "I'll cancel another reset on Monday",
    "I'll prevent another reset on Monday",
    "I'll wait for another reset on Monday",
    "I'll ask the team to do another reset on Monday",
    "I'll reset expectations on Monday",
    "I'll reset my quota on Monday",
    "I'll reset your quota on Monday",
    "I'll reset one user's quota on Monday",
    "I'll reset Pro quota on Monday",
    "I'll reset quota for me on Monday",
    "I'll reset quota for Pro on Monday",
    "I'll reset my five-hour limit on Monday",
    "I'll reset Codex usage for EU users on Monday",
    "I think I'll do another performative reset on Monday",
    "I guess I'll do another performative reset on Monday",
    "I suppose I'll do another performative reset on Monday",
    "Looks like I'll do another performative reset on Monday",
    "I'll do another performative reset on Monday. Cancelled.",
    "I'll do another performative reset on Monday. Canceled.",
    "I'll do another performative reset on Monday. Called off.",
    "I'll do another performative reset on Monday. Scratch that.",
    "I'll do another performative reset on Monday. Never mind.",
    "I'll do another performative reset on Monday. I won't.",
    "I'll do another performative reset on Monday. It is not happening.",
    "I'll do another performative reset on Monday. Delayed.",
    "I'll do another performative reset on Monday. We did a hard reset yesterday.",
  ]) {
    const observation = observationForConfig(
      uncertain,
      `uncertain-${uncertain.length}`,
      authorityConfig,
      { nativeRelations: relation },
    );
    const signal = extractSignal(observation, authorityConfig, { contexts });
    if (!signal) continue;
    assert.notEqual(
      signal.data.extraction.relevance.reason_code,
      "authority_reply_reset_commitment",
      uncertain,
    );
    assert.equal(signal.data.claim.asserted_time_range, null, uncertain);
    assert.equal(
      signal.data.claim.scope.population === "platform" &&
        signal.data.provenance.feature_eligible === true,
      false,
      uncertain,
    );
  }
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

test("real /fast quote wrapper is a started primary timing signal, not a completed outcome", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-real-landing-wrapper-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runConfig = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: { runtime: { data_dir: directory } },
  });
  const store = await new JsonlStore(directory).init();
  const quoted = observationForConfig(
    "Codex usage limits were reset for all paid users.",
    "2087423996115681767",
    runConfig,
    {
      identityId: "community_member",
      handle: "community",
      publishedAt: "2026-08-12T06:20:00.000Z",
      firstSeenAt: "2026-08-13T01:09:00.000Z",
    },
  );
  const wrapper = observationForConfig(
    "Old news actually from a bunch of days ago, but crossed that 15M. " +
      "Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.",
    "2087706104814023111",
    runConfig,
    {
      nativeRelations: [{
        type: "quotes",
        provider_item_id: "2087423996115681767",
        url: "https://x.com/community/status/2087423996115681767",
      }],
      publishedAt: "2026-08-13T01:01:37.748Z",
      firstSeenAt: "2026-08-13T01:10:00.000Z",
    },
  );
  await store.appendMany([quoted, wrapper]);

  await normalizeNewObservations(store, runConfig, {
    now: new Date("2026-08-13T01:11:00.000Z"),
  });
  const wrapperSignal = (await store.all("normalized_signal"))
    .find((signal) =>
      signal.data.observation_refs[0].record_id === wrapper.record_id
    );
  assert.ok(wrapperSignal);
  assert.equal(wrapperSignal.data.extraction.relevance.basis, "self");
  assert.equal(wrapperSignal.data.provenance.derivation, "primary_statement");
  assert.equal(wrapperSignal.data.claim.event_type, "quota_reset");
  assert.equal(wrapperSignal.data.claim.phase, "started");
  assert.equal(wrapperSignal.data.claim.scope.product, "codex");
  assert.equal(wrapperSignal.data.claim.scope.population, "platform");
  assert.deepEqual(wrapperSignal.data.claim.asserted_time_range, {
    start: "2026-08-13T01:01:37.748Z",
    end: "2026-08-13T02:01:37.748Z",
    boundary: "[start,end)",
    precision: "hour",
    timezone_basis: "UTC",
    original_text: "next hour",
  });
  assert.equal(isAuthorityTimingSupportSignal({
    signal: wrapperSignal,
    observation: wrapper,
    policy: runConfig.model.authority_timing,
    confirmationIdentityIds: confirmationIdentityIds(runConfig),
    targetScope: runConfig.target,
  }), true);

  await linkEventCandidates(store, runConfig, {
    asOf: new Date("2026-08-13T01:12:00.000Z"),
  });
  await adjudicateOutcomes(store, runConfig, {
    now: new Date("2026-08-13T01:13:00.000Z"),
  });
  assert.equal((await store.all("reset_outcome")).length, 0);
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

test("authority inference treats a quote wrapper's own claim as a primary statement", () => {
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
  assert.equal(quoted.data.extraction.relevance.basis, "self");
  assert.equal(quoted.data.provenance.derivation, "primary_statement");
  assert.equal(quoted.data.claim.scope.population, "platform");

  const summary = signalForConfig(
    text,
    "authority-summary",
    authorityConfig,
    { mediaType: "application/vnd.x-search-summary+text" },
  );
  assert.equal(summary.data.provenance.source_role, "aggregator");
  assert.equal(summary.data.claim.scope.population, "unknown");
});

test("real authority hint and self-authored quoted completion form one outcome", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-real-authority-lifecycle-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runConfig = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: { runtime: { data_dir: directory } },
  });
  const store = await new JsonlStore(directory).init();
  const scheduledId = "2081899343091843463";
  const completedId = "2081940052154933696";
  const scheduledAt = "2026-07-28T00:27:37.869Z";
  const completedAt = "2026-07-28T03:09:23.666Z";
  const makeAuthorityObservation = ({
    id,
    at,
    text,
    nativeRelations = [],
  }) => rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/thsottiaux/status/${id}`,
    published_at: at,
    author: {
      provider_author_id: "1953337039510003712",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: nativeRelations,
    content: { media_type: "text/plain", text, language: "en" },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: runConfig.providers.x,
    firstSeenAt: at,
    fetchedAt: at,
  });
  const scheduledObservation = makeAuthorityObservation({
    id: scheduledId,
    at: scheduledAt,
    text:
      "We’re celebrating the fast adoption of chatGPT Work and all the incredible effort that went into it today. " +
      "I’m feeling like a limit reset.\n\nHold on tight to your ultra and /fast and see you in a few hours when I’m back at the laptop!",
  });
  const completedObservation = makeAuthorityObservation({
    id: completedId,
    at: completedAt,
    text:
      "Back at the laptop. The usage limits have been reset for all paid users of Codex and ChatGPT Work. " +
      "Weeeeeeeee. It’s a good day!",
    nativeRelations: [{
      type: "quotes",
      provider_item_id: scheduledId,
      url: `https://x.com/thsottiaux/status/${scheduledId}`,
    }],
  });
  await store.appendMany([scheduledObservation, completedObservation]);

  const normalized = await normalizeNewObservations(store, runConfig, {
    now: new Date("2026-07-28T03:10:00Z"),
  });
  assert.equal(normalized.records.length, 2);
  const [scheduled, completed] = normalized.records.sort((left, right) =>
    left.data.available_at.localeCompare(right.data.available_at)
  );
  assert.equal(scheduled.data.claim.phase, "scheduled");
  assert.equal(scheduled.data.claim.scope.product, "multi_product");
  assert.deepEqual(
    scheduled.data.claim.scope.products,
    ["chatgpt_work", "codex"],
  );
  assert.equal(scheduled.data.claim.scope.population, "platform");
  assert.equal(
    scheduled.data.claim.asserted_time_range.start,
    scheduledAt,
  );
  assert.equal(
    scheduled.data.claim.asserted_time_range.end,
    "2026-07-28T03:27:37.869Z",
  );
  assert.equal(scheduled.data.provenance.derivation, "primary_statement");

  assert.equal(completed.data.claim.phase, "completed");
  assert.equal(completed.data.claim.scope.population, "platform");
  assert.equal(completed.data.extraction.relevance.basis, "self");
  assert.equal(completed.data.provenance.derivation, "primary_statement");
  assert.equal(
    completed.data.provenance.root_evidence_id,
    `x_post:${completedId}`,
  );

  const linked = await linkEventCandidates(store, runConfig, {
    asOf: new Date("2026-07-28T03:10:30Z"),
  });
  assert.equal(linked.linked, 1);
  const [candidate] = await store.all("event_candidate");
  assert.equal(candidate.data.state, "closed");
  assert.equal(candidate.data.evidence.length, 2);

  const adjudicated = await adjudicateOutcomes(store, runConfig, {
    now: new Date("2026-07-28T03:11:00Z"),
  });
  assert.equal(adjudicated.adjudicated, 1);
  const [outcome] = await store.all("reset_outcome");
  assert.equal(outcome.data.status, "confirmed");
  assert.equal(outcome.data.candidate_refs[0].record_id, candidate.record_id);
  assert.equal(
    outcome.data.verification[0].observation_ref.record_id,
    completedObservation.record_id,
  );
});

test("a quote that only inherits reset text remains derivative and cannot confirm", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-inherited-quote-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runConfig = await loadConfig({
    configPath: "config/tibo-authority-live.json",
    overrides: { runtime: { data_dir: directory } },
  });
  const store = await new JsonlStore(directory).init();
  const sourceId = "2081800000000000001";
  const wrapperId = "2081800000000000002";
  const source = rawObservationFromItem({
    provider_item_id: sourceId,
    canonical_url: `https://x.com/community/status/${sourceId}`,
    published_at: "2026-07-28T00:00:00Z",
    author: {
      provider_author_id: "community",
      identity_id: "community_member",
      display_handle: "@community",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "Codex usage limits have been reset for all paid users.",
      language: "en",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: runConfig.providers.x,
    firstSeenAt: "2026-07-28T00:00:00Z",
    fetchedAt: "2026-07-28T00:00:00Z",
  });
  const wrapper = rawObservationFromItem({
    provider_item_id: wrapperId,
    canonical_url: `https://x.com/thsottiaux/status/${wrapperId}`,
    published_at: "2026-07-28T00:05:00Z",
    author: {
      provider_author_id: "1953337039510003712",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [{
      type: "quotes",
      provider_item_id: sourceId,
      url: `https://x.com/community/status/${sourceId}`,
    }],
    content: {
      media_type: "text/plain",
      text: "Yep.",
      language: "en",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: runConfig.providers.x,
    firstSeenAt: "2026-07-28T00:05:00Z",
    fetchedAt: "2026-07-28T00:05:00Z",
  });
  await store.appendMany([source, wrapper]);
  await normalizeNewObservations(store, runConfig, {
    now: new Date("2026-07-28T00:06:00Z"),
  });
  const wrapperSignal = (await store.all("normalized_signal"))
    .find((signal) =>
      signal.data.observation_refs[0].record_id === wrapper.record_id
    );
  assert.ok(wrapperSignal);
  assert.equal(wrapperSignal.data.extraction.relevance.basis, "quote");
  assert.equal(wrapperSignal.data.provenance.derivation, "quotes");

  await linkEventCandidates(store, runConfig, {
    asOf: new Date("2026-07-28T00:07:00Z"),
  });
  await adjudicateOutcomes(store, runConfig, {
    now: new Date("2026-07-28T00:08:00Z"),
  });
  assert.equal((await store.all("reset_outcome")).length, 0);
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

  const standaloneWeekday = signalForConfig(
    "We will reset Codex usage limits for all paid users on Monday.",
    "authority-standalone-weekday",
    authorityConfig,
  );
  assert.equal(standaloneWeekday.data.claim.phase, "scheduled");
  assert.equal(standaloneWeekday.data.claim.asserted_time_range, null);
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
      rsshub_x_timeline: {
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

test("copied posts collapse within one wave without granting authority or erasing later events", async (t) => {
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
  assert.equal(
    vector.features.official_reset_activity_decay,
    0,
    "a derivative copy must not inherit the configured authority's weight",
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
