import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { recordRef } from "../src/core/records.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { buildResetReviewBundle, reviewResetClaims, pendingResetReviewRanges, resetReviewEvidenceValid } from "../src/semantic-assistance/reset-review.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import { adjudicateOutcomes, buildOutcomeEligibilityContext, isEligibleConfirmedOutcome } from "../src/pipeline/outcomes.mjs";
import { latestSignalsAsOf } from "../src/model/as-of.mjs";
import { causalWindowLabel } from "../src/model/evaluation.mjs";
import { buildTrainingExamples } from "../src/model/training.mjs";

const NOW = "2026-09-14T14:00:00.000Z";
async function setup(t) {
  const directory = await fs.mkdtemp("/tmp/reset-semantic-review-test-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ configPath: "config/tibo-authority-live.json", overrides: {
    runtime: { data_dir: directory }, extractor: { semantic_assistance: { enabled: true, token_file: "/unused-test-token" } },
  } });
  const store = await new JsonlStore(directory).init();
  const obs = (id, content, at, relations = [], overrides = {}) => rawObservationFromItem({
    provider_item_id: id, canonical_url: `https://x.com/thsottiaux/status/${id}`,
    published_at: at, author: { identity_id: "person_tibo_sottiaux", provider_author_id: "thsottiaux", display_handle: "@thsottiaux" },
    content: { text: content, media_type: "text/plain", language: "en" }, native_relations: relations, ...overrides,
  }, { providerName: "rsshub_x_timeline", providerVersion: "test", config: config.providers.rsshub_x_timeline, firstSeenAt: at, fetchedAt: at });
  const product = obs("2095961185262997556", "We are progressing through the rollout of Astra across ChatGPT Work and Codex.", "2026-09-04T19:44:22.299Z");
  const parent = obs("2098612714704891959", "Hi Astra users. A reset is landing by midnight today.", "2026-09-12T03:20:36.181Z");
  const anchor = obs("2098685367058612394", "Reset all propagated. Sweet dreams.", "2026-09-12T08:09:17.852Z", [{ type: "quotes", provider_item_id: parent.data.provider_item_id, url: parent.data.canonical_url }]);
  await store.appendMany([product, parent, anchor]);
  const assessment = () => ({ decision: "confirmed", subject: "Astra", confidence: 0.95, reason: "完成声明引用同次预告，权威背景确认产品范围。", citations: [
    { observation_ref: recordRef(anchor), quote: "Reset all propagated.", purpose: "completion" },
    { observation_ref: recordRef(parent), quote: parent.data.content.text, purpose: "scope" },
    { observation_ref: recordRef(product), quote: product.data.content.text, purpose: "product" },
  ] });
  return { config, store, anchor, parent, product, assessment, obs };
}

test("window review confirms a source-backed completion and preserves live knowledge time", async (t) => {
  const { config, store, anchor, assessment } = await setup(t);
  let calls = 0;
  const assessor = { requestContent: async () => { calls += 1; return JSON.stringify(assessment()); } };
  const result = await reviewResetClaims(store, config, { now: NOW, clock: () => NOW, assessor });
  assert.equal(result.confirmed, 1);
  const [signal] = await store.all("normalized_signal");
  assert.equal(signal.data.available_at, NOW);
  assert.equal(signal.data.extraction.reset_review.citations.length, 3);
  assert.deepEqual(latestSignalsAsOf([signal], "2026-09-13T00:00:00Z"), []);
  await linkEventCandidates(store, config, { asOf: new Date(NOW) });
  await adjudicateOutcomes(store, config, { now: new Date(NOW) });
  const [outcome] = await store.all("reset_outcome");
  assert.equal(outcome.data.status, "confirmed");
  assert.equal(outcome.data.occurred_time_range.start, "2026-09-12T08:00:00.000Z");
  assert.equal(outcome.data.known_at, NOW);
  assert.equal(outcome.data.replay_available_at, null);
  const context = buildOutcomeEligibilityContext({ observations: await store.all("raw_observation"), signals: [signal], config });
  assert.equal(isEligibleConfirmedOutcome(outcome, context), true);
  assert.equal(context.currentSignalsByObservationId.has(signal.data.observation_refs[1].record_id), false,
    "a context citation must not inherit the anchor's completed claim");
  const forged = structuredClone(signal); forged.data.extraction.reset_review.citations[0].quote = "Invented completion statement";
  assert.equal(resetReviewEvidenceValid(forged.data.extraction.reset_review, anchor, await store.all("raw_observation"), config), false);
  await reviewResetClaims(store, config, { now: "2026-09-14T21:00:00Z", clock: () => NOW, assessor });
  assert.equal(calls, 1, "unchanged evidence must not repeatedly call AI");
});

test("cross-provider copies are deduplicated and future knowledge is excluded", async (t) => {
  const { config, store, anchor, parent, product } = await setup(t);
  const records = await store.all("raw_observation");
  const mirror = structuredClone(anchor); mirror.record_id = "obs_mirror"; mirror.data.ingest_provider = "historical_monitor"; mirror.data.native_relations = [];
  const future = structuredClone(product); future.record_id = "obs_future"; future.revision = 2; future.data.fetched_at = "2026-09-15T00:00:00Z";
  const bundle = buildResetReviewBundle(anchor, [...records, mirror, future], config, NOW);
  assert.equal(bundle.evidence.filter((e) => e.status_id === anchor.data.provider_item_id).length, 1);
  assert.ok(bundle.evidence.some((e) => e.observation_ref.record_id === parent.record_id));
  assert.ok(!bundle.evidence.some((e) => e.observation_ref.record_id === future.record_id));
});

test("missing product evidence stays pending and censors negative labels", async (t) => {
  const { config, store, assessment } = await setup(t);
  const assessor = { requestContent: async () => { const a = assessment(); a.citations.pop(); return JSON.stringify(a); } };
  const result = await reviewResetClaims(store, config, { now: NOW, clock: () => NOW, assessor });
  assert.equal(result.pending, 1);
  const signals = await store.all("normalized_signal");
  const ranges = pendingResetReviewRanges(signals);
  assert.equal(ranges.length, 1);
  assert.equal(causalWindowLabel("2026-09-12T05:00:00Z", "2026-09-12T09:00:00Z", [], [], ranges), null);
  assert.equal(pendingResetReviewRanges(latestSignalsAsOf(signals, "2026-09-13T00:00:00Z")).length, 0);
  await linkEventCandidates(store, config, { asOf: new Date(NOW) });
  await adjudicateOutcomes(store, config, { now: new Date(NOW) });
  assert.deepEqual(await store.all("reset_outcome"), []);
  const training = await buildTrainingExamples(store, config, { trainingCutoff: new Date(NOW),
    coverageIntervals: [{ start: "2026-09-12T05:00:00Z", end: "2026-09-12T10:00:00Z" }],
    coverageAssertionRecords: null });
  assert.equal(training.negativeCount, 1);
  assert.equal(training.censoredSlotCount, 4);
});

test("AI cannot invent completion, cite summaries, or override a future/limited claim", async (t) => {
  const { config, store, anchor, assessment } = await setup(t);
  await reviewResetClaims(store, config, { now: NOW, clock: () => NOW, assessor: { requestContent: async () => JSON.stringify(assessment()) } });
  const [signal] = await store.all("normalized_signal");
  const records = await store.all("raw_observation");
  for (const content of ["If all reset for everyone, enjoy Astra.", "We will have reset Astra tomorrow.", "My usage has reset after using a banked reset.", "We have not reset usage."]) {
    const edited = structuredClone(anchor); edited.data.content.text = content;
    assert.equal(resetReviewEvidenceValid(signal.data.extraction.reset_review, edited, records, config), false, content);
  }
  const summaries = records.map((r) => { const copy = structuredClone(r); copy.data.content.media_type = "application/vnd.x-search-summary+text"; return copy; });
  assert.equal(resetReviewEvidenceValid(signal.data.extraction.reset_review, anchor, summaries, config), false);
});

test("API failure remains pending, does not create negatives, and waits six hours", async (t) => {
  const { config, store } = await setup(t);
  let calls = 0;
  const assessor = { requestContent: async () => { calls += 1; throw new Error("upstream unavailable"); } };
  await reviewResetClaims(store, config, { now: NOW, clock: () => NOW, assessor });
  await reviewResetClaims(store, config, { now: "2026-09-14T19:59:59Z", clock: () => NOW, assessor });
  assert.equal(calls, 1);
  await reviewResetClaims(store, config, { now: "2026-09-14T20:00:00Z", clock: () => NOW, assessor });
  assert.equal(calls, 2);
  assert.equal(pendingResetReviewRanges(await store.all("normalized_signal")).length, 1);
});

test("a short native completion reply can use its parent's reset scope", async (t) => {
  const { config, store, anchor, assessment } = await setup(t);
  const edited = structuredClone(anchor);
  edited.revision = 2; edited.supersedes = recordRef(anchor);
  edited.data.content.text = "Done.";
  await store.append(edited);
  const response = assessment(); response.citations[0] = {
    observation_ref: recordRef(edited), quote: "Done.", purpose: "completion",
  };
  const result = await reviewResetClaims(store, config, { now: NOW, clock: () => NOW,
    assessor: { requestContent: async () => JSON.stringify(response) } });
  assert.equal(result.confirmed, 1);
});

test("a benchmark mentioning a product is not evidence of model availability", async (t) => {
  const { config, store, product, assessment } = await setup(t);
  const edited = structuredClone(product);
  edited.revision = 2; edited.supersedes = recordRef(product);
  edited.data.content.text = "Astra won a benchmark using the Codex harness.";
  await store.append(edited);
  const response = assessment(); response.citations[2] = {
    observation_ref: recordRef(edited), quote: edited.data.content.text, purpose: "product",
  };
  const result = await reviewResetClaims(store, config, { now: NOW, clock: () => NOW,
    assessor: { requestContent: async () => JSON.stringify(response) } });
  assert.equal(result.confirmed, 0);
  assert.equal(result.pending, 1);
});

test("statements beyond the API budget are pending immediately", async (t) => {
  const { config, store, obs, parent } = await setup(t);
  config.extractor.reset_review.maximum_reviews_per_run = 1;
  await store.append(obs("2098685367058612395", "All reset for everyone. Enjoy Astra.", "2026-09-12T09:00:00.000Z",
    [{ type: "quotes", provider_item_id: parent.data.provider_item_id, url: parent.data.canonical_url }]));
  let calls = 0;
  const assessor = { requestContent: async () => { calls += 1; throw new Error("unavailable"); } };
  await reviewResetClaims(store, config, { now: NOW, clock: () => NOW, assessor });
  assert.equal(calls, 1);
  assert.equal(pendingResetReviewRanges(await store.all("normalized_signal")).length, 2);
  await reviewResetClaims(store, config, { now: "2026-09-14T14:10:00Z", clock: () => NOW, assessor });
  assert.equal(calls, 2, "the queued statement need not wait for a failed-attempt cooldown");
});

test("malformed model citations fail closed without crashing the pipeline", async (t) => {
  const { config, store, assessment } = await setup(t);
  const response = assessment(); response.citations = [null];
  const result = await reviewResetClaims(store, config, { now: NOW, clock: () => NOW,
    assessor: { requestContent: async () => JSON.stringify(response) } });
  assert.equal(result.pending, 1);
  const [signal] = await store.all("normalized_signal");
  assert.deepEqual(signal.data.extraction.reset_review.citations, []);
  assert.equal(signal.data.provenance.feature_eligible, false);
});
