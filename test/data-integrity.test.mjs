import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashLabel } from "../src/core/hash.mjs";
import { loadConfig } from "../src/core/config.mjs";
import { createRecord } from "../src/core/records.mjs";
import {
  addCoverageAssertion,
  adequateCoverageIntervals,
  coverageAssertions,
  verifyCoverageAssertionEvidence,
} from "../src/pipeline/coverage.mjs";
import { normalizeNewObservations } from "../src/pipeline/extract.mjs";
import { linkEventCandidates } from "../src/pipeline/link.mjs";
import {
  adjudicateOutcomes,
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../src/pipeline/outcomes.mjs";
import {
  collectConfiguredProviders,
  processRecords,
} from "../src/pipeline/run.mjs";
import { selectCurrentSignals } from "../src/pipeline/signal-selection.mjs";
import { HistoricalMonitorProvider } from "../src/providers/historical-monitor-provider.mjs";
import {
  appendRawObservationRevision,
  rawObservationFromItem,
} from "../src/providers/raw.mjs";
import { XSearchGatewayProvider } from "../src/providers/x-search-gateway-provider.mjs";
import { XProvider } from "../src/providers/x-provider.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

async function temporaryStore(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    store: await new JsonlStore(directory).init(),
  };
}

test("coverage is outcome-only by default and negative labels require append-only completeness evidence", async (t) => {
  const { store } = await temporaryStore(t, "reset-coverage-integrity-");
  await addCoverageAssertion(store, {
    provider: "archive",
    start: "2026-07-01T00:00:00Z",
    end: "2026-07-02T00:00:00Z",
    mode: "archive_date_grid",
    evidenceRefs: [{ kind: "date_grid", ref: "blob://example/not-complete" }],
    assertedAt: "2026-07-03T00:00:00Z",
  });
  assert.deepEqual(await adequateCoverageIntervals(store, ["archive"]), []);
  assert.equal((await coverageAssertions(store, ["archive"]))[0].adequacy, "outcome_only");

  await assert.rejects(
    addCoverageAssertion(store, {
      provider: "archive",
      start: "2026-07-02T00:00:00Z",
      end: "2026-07-03T00:00:00Z",
      mode: "claimed_complete",
      adequacy: "negative_label_eligible",
      evidenceRefs: [],
    }),
    /requires completeness evidence/,
  );

  const manifest = {
    method: "paginated_source_exhaustion",
    exhausted_at: "2026-07-03T00:00:00.000Z",
    cursor: null,
  };
  const manifestHash = hashLabel(manifest);
  const manifestRef = await store.writeBlob("coverage-test", manifestHash, manifest);
  await assert.rejects(
    addCoverageAssertion(store, {
      provider: "archive",
      start: "2026-07-02T00:00:00Z",
      end: "2026-07-03T00:00:00Z",
      mode: "tampered-proof",
      adequacy: "negative_label_eligible",
      evidenceRefs: [{
        ref: manifestRef,
        sha256: hashLabel({ ...manifest, cursor: "tampered" }),
        method: manifest.method,
        exhausted_at: manifest.exhausted_at,
      }],
      assertedAt: manifest.exhausted_at,
    }),
    /hash does not match/,
  );
  await addCoverageAssertion(store, {
    provider: "archive",
    start: "2026-07-02T00:00:00Z",
    end: "2026-07-03T00:00:00Z",
    mode: "verified_complete",
    adequacy: "negative_label_eligible",
    evidenceRefs: [{
      kind: "complete_poll",
      ref: manifestRef,
      sha256: manifestHash,
      method: manifest.method,
      exhausted_at: manifest.exhausted_at,
    }],
    assertedAt: manifest.exhausted_at,
  });
  assert.deepEqual(await adequateCoverageIntervals(store, ["archive"]), [{
    start: "2026-07-02T00:00:00.000Z",
    end: "2026-07-03T00:00:00.000Z",
  }]);
  const replayManifest = {
    method: "signed-archive-manifest",
    exhausted_at: "2026-07-04T01:00:00.000Z",
    replay_available_at: "2026-07-04T01:00:00.000Z",
  };
  const replayManifestHash = hashLabel(replayManifest);
  const replayManifestRef = await store.writeBlob(
    "coverage-test",
    replayManifestHash,
    replayManifest,
  );
  await addCoverageAssertion(store, {
    provider: "archive",
    start: "2026-07-03T00:00:00Z",
    end: "2026-07-04T00:00:00Z",
    mode: "verified_archive_complete",
    adequacy: "negative_label_eligible",
    evidenceRefs: [{
      kind: "independent_completeness_attestation",
      ref: replayManifestRef,
      sha256: replayManifestHash,
      method: replayManifest.method,
      exhausted_at: replayManifest.exhausted_at,
      replay_available_at: replayManifest.replay_available_at,
    }],
    replayAvailableAt: replayManifest.replay_available_at,
    assertedAt: "2026-07-05T00:00:00Z",
  });
  assert.equal(
    (await coverageAssertions(store, ["archive"]))
      .find((assertion) => assertion.mode === "verified_archive_complete")
      .replay_available_at,
    replayManifest.replay_available_at,
  );
  assert.equal((await store.allAudit("coverage_assertion")).length, 3);
  await assert.rejects(
    addCoverageAssertion(store, {
      provider: "future",
      start: "2026-07-03T00:00:00Z",
      end: "2026-07-03T01:00:00Z",
      assertedAt: "2026-07-03T00:30:00Z",
    }),
    /end cannot be later than asserted_at/,
  );
});

test("coverage evidence is reverified and immutable blob collisions fail closed", async (t) => {
  const { store } = await temporaryStore(t, "reset-coverage-reverify-");
  const manifest = {
    method: "independent-completeness-ledger",
    exhausted_at: "2026-07-03T00:00:00.000Z",
    records: [],
  };
  const manifestHash = hashLabel(manifest);
  const manifestRef = await store.writeBlob("coverage-reverify", "fixed-id", manifest);
  await assert.rejects(
    store.writeBlob("coverage-reverify", "fixed-id", {
      ...manifest,
      records: ["tampered"],
    }),
    /collision or corruption/,
  );
  const assertion = await addCoverageAssertion(store, {
    provider: "verified-source",
    start: "2026-07-02T00:00:00Z",
    end: "2026-07-03T00:00:00Z",
    adequacy: "negative_label_eligible",
    evidenceRefs: [{
      kind: "independent_completeness_attestation",
      ref: manifestRef,
      sha256: manifestHash,
      method: manifest.method,
      exhausted_at: manifest.exhausted_at,
    }],
    assertedAt: manifest.exhausted_at,
  });
  assert.equal((await verifyCoverageAssertionEvidence(store, assertion)).valid, true);

  const [namespace, fileName] = manifestRef.slice("blob://".length).split("/");
  await fs.unlink(path.join(store.root, "blobs", namespace, fileName));

  const verification = await verifyCoverageAssertionEvidence(store, assertion);
  assert.equal(verification.valid, false);
  assert.ok(verification.reasons.includes("coverage_completeness_evidence_unreadable"));
  assert.deepEqual(
    await adequateCoverageIntervals(store, ["verified-source"]),
    [],
  );
});

test("historical date grids persist their full evidence snapshot but remain censored for negative labels", async (t) => {
  const { store } = await temporaryStore(t, "reset-historical-evidence-");
  const id = "2075330198887940337";
  const publishedAt = "2026-07-09T21:24:11.842Z";
  const html = [
    '<button data-date="2026-07-09" data-count="1"></button>',
    '<li class="log-item">',
    `<span data-datetime="${publishedAt}"></span>`,
    '<p class="log-item-text">We have reset Codex usage limits across all paid plans.</p>',
    `<a href="https://x.com/thsottiaux/status/${id}">View</a>`,
    "</li>",
  ].join("");
  const now = new Date("2026-07-10T12:00:00Z");
  const provider = new HistoricalMonitorProvider({
    config: {
      provider_name: "historical_monitor",
      base_url: "https://archive.example/",
      format: "test-html",
      verify_x_oembed: false,
      discover_linked_posts: false,
      coverage_adequacy: "outcome_only",
    },
    fetchFn: async () => new Response(html),
    now: () => now,
  });
  const result = await provider.collect(store, { force: true });
  assert.equal(result.coverage_assertion.adequacy, "outcome_only");
  assert.deepEqual(await adequateCoverageIntervals(store, ["historical_monitor"]), []);
  const state = await store.readState("historical-monitor-provider");
  const snapshot = await store.readBlob(state.archive_snapshot_ref);
  assert.equal(snapshot.html, html);
  assert.equal(snapshot.html_sha256, hashLabel(html));
  assert.deepEqual(snapshot.coverage_grid, [{ date: "2026-07-09", count: 1 }]);
  assert.equal((await store.allAudit("coverage_assertion")).length, 1);
});

test("providers append a raw revision only when stable item content changes", async (t) => {
  const { store } = await temporaryStore(t, "reset-raw-revisions-");
  const base = {
    provider_item_id: "revision-test",
    canonical_url: "https://example.test/items/revision-test",
    published_at: "2026-07-20T10:00:00Z",
    author: { provider_author_id: "a", identity_id: "source_a", display_handle: "@a" },
    native_relations: [],
    content: { media_type: "text/plain", text: "initial content", language: "en" },
  };
  const options = {
    providerName: "revision_provider",
    providerVersion: "test",
    config: { test: true },
    firstSeenAt: "2026-07-20T10:01:00Z",
    fetchedAt: "2026-07-20T10:01:00Z",
    rawPayload: { text: "initial content" },
  };
  assert.equal((await appendRawObservationRevision(store, base, options)).inserted, true);
  assert.equal((await appendRawObservationRevision(store, base, {
    ...options,
    fetchedAt: "2026-07-20T11:00:00Z",
  })).inserted, false);
  assert.equal((await appendRawObservationRevision(store, {
    ...base,
    content: { ...base.content, text: "corrected content" },
  }, {
    ...options,
    fetchedAt: "2026-07-20T12:00:00Z",
    rawPayload: { text: "corrected content" },
  })).inserted, true);

  const revisions = (await store.all("raw_observation", { latestOnly: false }))
    .filter((record) => record.data.provider_item_id === "revision-test");
  assert.deepEqual(revisions.map((record) => record.revision), [1, 2]);
  assert.deepEqual(revisions[1].supersedes, {
    record_id: revisions[0].record_id,
    revision: 1,
  });
  assert.equal(revisions[1].data.first_seen_at, revisions[0].data.first_seen_at);
  assert.notEqual(
    revisions[1].data.content.raw_payload_ref,
    revisions[0].data.content.raw_payload_ref,
  );
});

test("Hermes summaries share the canonical X root without inheriting source recency or authority", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-gateway-root-");
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: {
      x_search_gateway: {
        enabled: true,
        upstream_provider: "hermes",
        queries: [{ name: "reset", query: "from:thsottiaux reset" }],
      },
    },
  } });
  const statusId = "2075657265508647008";
  const sourcePublishedAt = "2026-07-10T19:03:50.000Z";
  const collectedAt = new Date("2026-07-22T20:00:00Z");
  await appendRawObservationRevision(store, {
    provider_item_id: statusId,
    canonical_url: `https://x.com/thsottiaux/status/${statusId}`,
    published_at: sourcePublishedAt,
    availability_attestation: {
      available_at: sourcePublishedAt,
      basis: "direct_source_publication",
      attestor_url: `https://x.com/thsottiaux/status/${statusId}`,
      verified_at: collectedAt.toISOString(),
      verification: "source archive",
    },
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "We have reset Codex usage limits across all paid plans.",
      language: "en",
    },
  }, {
    providerName: "historical_monitor",
    providerVersion: "test",
    config: {},
    firstSeenAt: collectedAt,
    fetchedAt: collectedAt,
  });
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test",
    now: () => collectedAt,
    fetchFn: async () => new Response(JSON.stringify({
      ok: true,
      provider: "hermes",
      all_events: [{
        event_id: `https://twitter.com/thsottiaux/status/${statusId}`,
        handle: "thsottiaux",
        url: `https://twitter.com/thsottiaux/status/${statusId}`,
        created_at: sourcePublishedAt,
        text: "We have reset Codex usage limits across all paid plans.",
      }],
    }), { headers: { "content-type": "application/json" } }),
  });
  await provider.collect(store);
  await normalizeNewObservations(store, config, { now: collectedAt });
  const signals = await store.all("normalized_signal");
  const direct = signals.find((signal) => signal.data.provenance.source_role !== "aggregator");
  const summary = signals.find((signal) => signal.data.provenance.source_role === "aggregator");
  assert.equal(summary.data.provenance.derivation, "summarizes");
  assert.equal(summary.data.provenance.root_evidence_id, `x_post:${statusId}`);
  assert.equal(summary.data.provenance.root_evidence_id, direct.data.provenance.root_evidence_id);
  assert.equal(
    summary.data.provenance.independence_group_id,
    direct.data.provenance.independence_group_id,
  );
  assert.equal(summary.data.available_at, collectedAt.toISOString());
  assert.equal(summary.data.provenance.source_published_at, sourcePublishedAt);
  const summaryObservation = (await store.all("raw_observation"))
    .find((record) => record.data.content.media_type === "application/vnd.x-search-summary+text");
  assert.deepEqual(summaryObservation.data.native_relations, [{
    type: "links",
    provider_item_id: statusId,
    url: `https://x.com/thsottiaux/status/${statusId}`,
  }]);
});

test("outcome-conditioned linked observations are auditable but excluded from feature selection", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-selection-bias-");
  const config = await loadConfig({ overrides: { runtime: { data_dir: directory } } });
  await store.append(rawObservationFromItem({
    provider_item_id: "biased-linked-item",
    canonical_url: "https://x.com/thsottiaux/status/2000000000000000000",
    published_at: "2026-07-01T00:00:00Z",
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "We are investigating a Codex capacity incident.",
      language: "en",
    },
    selection_context: {
      feature_eligible: false,
      outcome_conditioned: true,
      selection_method: "linked_from_known_reset_archive_item",
    },
  }, {
    providerName: "historical_monitor",
    providerVersion: "test",
    config: {},
    firstSeenAt: "2026-07-20T00:00:00Z",
    fetchedAt: "2026-07-20T00:00:00Z",
  }));
  await normalizeNewObservations(store, config);
  const signals = await store.all("normalized_signal");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].data.provenance.feature_eligible, false);
  assert.equal(signals[0].data.provenance.selection_bias, "outcome_conditioned_archive_link");
  assert.deepEqual(selectCurrentSignals(signals), []);
});

test("started claims remain candidates while completed direct observations form distinct stable outcomes", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-event-identity-");
  const config = await loadConfig({ overrides: { runtime: { data_dir: directory } } });
  const observations = [
    {
      id: "2100000000000000001",
      at: "2026-07-20T10:05:00Z",
      text: "We are resetting Codex usage limits now for all paid plans. Propagating in the next hour.",
    },
    {
      id: "2100000000000000002",
      at: "2026-07-20T10:45:00Z",
      text: "We have reset Codex usage limits across all paid plans.",
    },
    {
      id: "2100000000000000003",
      at: "2026-07-20T20:10:00Z",
      text: "We have reset Codex usage limits across all paid plans.",
    },
  ];
  for (const item of observations) {
    await store.append(rawObservationFromItem({
      provider_item_id: item.id,
      canonical_url: `https://x.com/thsottiaux/status/${item.id}`,
      published_at: item.at,
      author: {
        provider_author_id: "thsottiaux",
        identity_id: "person_tibo_sottiaux",
        display_handle: "@thsottiaux",
      },
      native_relations: [],
      content: { media_type: "text/plain", text: item.text, language: "en" },
    }, {
      providerName: "x",
      providerVersion: "test",
      config: {},
      firstSeenAt: item.at,
      fetchedAt: item.at,
    }));
  }
  const result = await processRecords(store, config, {
    now: new Date("2026-07-20T21:00:00Z"),
  });
  assert.equal(result.linked.linked, 2);
  assert.equal(result.outcomes.adjudicated, 2);
  const outcomes = await store.all("reset_outcome");
  assert.equal(new Set(outcomes.map((outcome) => outcome.data.event_identity)).size, 2);
  const startedObservation = (await store.all("raw_observation"))
    .find((record) => record.data.provider_item_id === observations[0].id);
  assert.ok(outcomes.every((outcome) =>
    outcome.data.verification.every((entry) =>
      entry.observation_ref.record_id !== startedObservation.record_id
    )
  ));
  assert.equal((await processRecords(store, config, {
    now: new Date("2026-07-20T21:05:00Z"),
  })).outcomes.adjudicated, 0);
});

test("a deduplication contract change starts a new candidate record without duplicating its outcome", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-dedup-version-");
  const config = await loadConfig({ overrides: { runtime: { data_dir: directory } } });
  const at = "2026-07-20T10:00:00Z";
  await store.append(rawObservationFromItem({
    provider_item_id: "dedup-version-completed",
    canonical_url: "https://x.com/thsottiaux/status/dedup-version-completed",
    published_at: at,
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "We have reset Codex usage limits across all paid plans.",
      language: "en",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: {},
    firstSeenAt: at,
    fetchedAt: at,
  }));
  await processRecords(store, config, { now: new Date("2026-07-20T10:05:00Z") });
  const originalOutcome = (await store.all("reset_outcome"))[0];

  const bumpedConfig = {
    ...config,
    deduplication_version: `${config.deduplication_version}-next`,
  };
  const linked = await linkEventCandidates(store, bumpedConfig, {
    asOf: new Date("2026-07-20T10:10:00Z"),
  });
  assert.equal(linked.linked, 1);
  const candidates = await store.all("event_candidate");
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.revision === 1));
  assert.equal(new Set(candidates.map((candidate) => candidate.data.event_cluster_id)).size, 1);

  await adjudicateOutcomes(store, bumpedConfig, {
    now: new Date("2026-07-20T10:11:00Z"),
  });
  const outcomes = await store.all("reset_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].record_id, originalOutcome.record_id);
  assert.equal(outcomes[0].revision, 2);
});

test("outcome revisions preserve a legacy record ID after a natural-key migration", async (t) => {
  const { directory, store: sourceStore } = await temporaryStore(t, "reset-outcome-source-");
  const config = await loadConfig({ overrides: { runtime: { data_dir: directory } } });
  const at = "2026-07-20T10:00:00Z";
  await sourceStore.append(rawObservationFromItem({
    provider_item_id: "legacy-outcome-id",
    canonical_url: "https://x.com/thsottiaux/status/legacy-outcome-id",
    published_at: at,
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "We have reset Codex usage limits across all paid plans.",
      language: "en",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: {},
    firstSeenAt: at,
    fetchedAt: at,
  }));
  await processRecords(sourceStore, config, { now: new Date("2026-07-20T10:05:00Z") });
  const [currentOutcome] = await sourceStore.all("reset_outcome");

  const { store } = await temporaryStore(t, "reset-outcome-migration-");
  for (const type of ["raw_observation", "normalized_signal", "event_candidate"]) {
    await store.appendMany(await sourceStore.all(type, { latestOnly: false }));
  }
  const {
    event_identity: _eventIdentity,
    label_policy_version: _labelPolicyVersion,
    replay_available_at: _replayAvailableAt,
    ...legacyData
  } = currentOutcome.data;
  const legacyOutcome = createRecord({
    recordType: "reset_outcome",
    naturalKey: `legacy-official-completed-event:${currentOutcome.data.event_identity}`,
    createdAt: currentOutcome.created_at,
    producer: { name: "outcome-adjudicator", version: "0.1.0" },
    data: legacyData,
  });
  assert.notEqual(legacyOutcome.record_id, currentOutcome.record_id);
  await fs.appendFile(
    store.recordPath("reset_outcome"),
    `${JSON.stringify(legacyOutcome)}\n`,
    "utf8",
  );

  const migrated = await adjudicateOutcomes(store, config, {
    now: new Date("2026-07-20T10:10:00Z"),
  });
  assert.equal(migrated.adjudicated, 1);
  const outcomes = await store.all("reset_outcome", { latestOnly: false });
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((outcome) => outcome.record_id), [
    legacyOutcome.record_id,
    legacyOutcome.record_id,
  ]);
  assert.equal(outcomes[1].revision, 2);
  assert.deepEqual(outcomes[1].supersedes, {
    record_id: legacyOutcome.record_id,
    revision: 1,
  });
  assert.equal(outcomes[1].data.event_identity, currentOutcome.data.event_identity);
  assert.equal(outcomes[1].data.label_policy_version, currentOutcome.data.label_policy_version);

  const repeated = await adjudicateOutcomes(store, config, {
    now: new Date("2026-07-20T10:15:00Z"),
  });
  assert.equal(repeated.adjudicated, 0);
  assert.equal((await store.all("reset_outcome", { latestOnly: false })).length, 2);
});

test("reset and refill wording in one event family produces one confirmed outcome", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-refill-family-");
  const config = await loadConfig({ overrides: { runtime: { data_dir: directory } } });
  const baseItem = {
    published_at: "2026-07-21T10:10:00Z",
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      language: "en",
    },
  };
  await appendRawObservationRevision(store, {
    ...baseItem,
    provider_item_id: "2120000000000000101",
    canonical_url: "https://x.com/thsottiaux/status/2120000000000000101",
    content: {
      ...baseItem.content,
      text: "Codex usage limits refill is complete across all paid plans.",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: {},
    firstSeenAt: "2026-07-21T10:11:00Z",
    fetchedAt: "2026-07-21T10:11:00Z",
  });
  await appendRawObservationRevision(store, {
    ...baseItem,
    provider_item_id: "2120000000000000102",
    canonical_url: "https://x.com/thsottiaux/status/2120000000000000102",
    published_at: "2026-07-21T10:20:00Z",
    content: {
      ...baseItem.content,
      text: "We have now fully reset Codex usage limits across all paid plans.",
    },
  }, {
    providerName: "x",
    providerVersion: "test",
    config: {},
    firstSeenAt: "2026-07-21T10:21:00Z",
    fetchedAt: "2026-07-21T10:21:00Z",
  });
  await processRecords(store, config, { now: new Date("2026-07-21T10:22:00Z") });
  const candidates = await store.all("event_candidate");
  const outcomes = await store.all("reset_outcome");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].data.event_type, "quota_reset");
  assert.equal(candidates[0].data.evidence.length, 2);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].data.verification.length, 2);
});

test("loss of a repeated confirmation never rejects an outcome without an explicit same-root correction", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-outcome-correction-policy-");
  const config = await loadConfig({ overrides: { runtime: { data_dir: directory } } });
  const item = {
    provider_item_id: "2120000000000000001",
    canonical_url: "https://x.com/thsottiaux/status/2120000000000000001",
    published_at: "2026-07-21T10:00:00Z",
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: "We have reset Codex usage limits across all paid plans.",
      language: "en",
    },
  };
  const options = {
    providerName: "x",
    providerVersion: "test",
    config: {},
    firstSeenAt: "2026-07-21T10:01:00Z",
    fetchedAt: "2026-07-21T10:01:00Z",
  };
  await appendRawObservationRevision(store, item, options);
  await processRecords(store, config, { now: new Date("2026-07-21T10:02:00Z") });
  let outcome = (await store.all("reset_outcome"))[0];
  assert.equal(outcome.data.status, "confirmed");
  assert.equal(outcome.revision, 1);
  let eligibility = buildOutcomeEligibilityContext({
    observations: await store.all("raw_observation", { latestOnly: false }),
    signals: await store.all("normalized_signal", { latestOnly: false }),
    config,
  });
  assert.equal(isEligibleConfirmedOutcome(outcome, {
    ...eligibility,
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
  }), true);

  await appendRawObservationRevision(store, {
    ...item,
    content: {
      ...item.content,
      text: "We are resetting Codex usage limits now for all paid plans.",
    },
  }, {
    ...options,
    fetchedAt: "2026-07-21T10:05:00Z",
  });
  await processRecords(store, config, { now: new Date("2026-07-21T10:06:00Z") });
  outcome = (await store.all("reset_outcome"))[0];
  assert.equal(outcome.data.status, "confirmed");
  assert.equal(outcome.revision, 1, "absence of a repeated completion is not a correction");
  eligibility = buildOutcomeEligibilityContext({
    observations: await store.all("raw_observation", { latestOnly: false }),
    signals: await store.all("normalized_signal", { latestOnly: false }),
    config,
  });
  assert.equal(isEligibleConfirmedOutcome(outcome, {
    ...eligibility,
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
  }), false, "a superseded completed observation must not remain label-eligible");

  await appendRawObservationRevision(store, {
    ...item,
    content: {
      ...item.content,
      text: "This was not a global Codex reset of usage limits.",
    },
  }, {
    ...options,
    fetchedAt: "2026-07-21T10:10:00Z",
  });
  await processRecords(store, config, { now: new Date("2026-07-21T10:11:00Z") });
  outcome = (await store.all("reset_outcome"))[0];
  assert.equal(outcome.data.status, "rejected");
  assert.equal(outcome.revision, 2);
  assert.equal(outcome.data.verification[0].observation_ref.revision, 3);
});

test("X poll coverage is outcome-only without an independent exhaustiveness attestation", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-x-poll-interval-");
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: {
      x: {
        enabled: true,
        backfill_start: null,
        max_retries: 0,
        context_identities: [],
        context_queries: ["Codex community"],
      },
    },
  } });
  let now = new Date("2026-07-22T12:05:00Z");
  let timelinePoll = 0;
  const provider = new XProvider({
    config: config.providers.x,
    bearerToken: "test",
    now: () => now,
    fetchFn: async (url) => {
      if (url.pathname.endsWith("/users/by/username/thsottiaux")) {
        return new Response(JSON.stringify({
          data: { id: "10", username: "thsottiaux", name: "Tibo" },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/tweets/search/recent")) {
        return new Response("optional search unavailable", { status: 503 });
      }
      if (url.pathname === "/2/tweets") {
        return new Response(JSON.stringify({
          data: [{
            id: "2121000000000000001",
            author_id: "10",
            created_at: "2026-07-22T12:00:00Z",
            text: "Corrected Codex capacity update.",
            lang: "en",
          }],
          includes: { users: [{ id: "10", username: "thsottiaux" }] },
        }), { headers: { "content-type": "application/json" } });
      }
      timelinePoll += 1;
      return new Response(JSON.stringify({
        data: timelinePoll === 1 ? [{
          id: "2121000000000000001",
          author_id: "10",
          created_at: "2026-07-22T12:00:00Z",
          text: "Codex capacity update.",
          lang: "en",
        }] : [],
        includes: { users: [{ id: "10", username: "thsottiaux" }] },
        meta: {},
      }), { headers: { "content-type": "application/json" } });
    },
  });
  const first = await provider.collect(store);
  assert.equal(first.health.ok, true);
  assert.equal(first.context_errors.length, 1);
  assert.deepEqual(await adequateCoverageIntervals(store, ["x"]), []);

  now = new Date("2026-07-22T12:30:00Z");
  await provider.collect(store);
  assert.deepEqual(await adequateCoverageIntervals(store, ["x"]), []);
  const [assertion] = await coverageAssertions(store, ["x"]);
  assert.equal(assertion.adequacy, "outcome_only");
  assert.equal(assertion.end, "2026-07-22T12:30:00.000Z");
  const revised = (await store.all("raw_observation"))
    .find((record) => record.data.provider_item_id === "2121000000000000001");
  assert.equal(revised.revision, 2);
  assert.equal(revised.data.content.text, "Corrected Codex capacity update.");
});

test("optional provider failures are isolated and each provider result is retained", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-provider-isolation-");
  const collectionOrder = [];
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: {
      x: { enabled: false },
      x_search_gateway: { enabled: true },
      historical_monitor: { enabled: true },
    },
    model: { outcome_coverage_providers: ["historical_monitor"] },
  } });
  const results = await collectConfiguredProviders(store, config, {
    instances: {
      x_search_gateway: {
        providerName: "x_search_gateway_hermes",
        collect: async () => {
          collectionOrder.push("context");
          throw new Error("optional context unavailable");
        },
      },
      historical_monitor: {
        providerName: "historical_monitor",
        collect: async () => {
          collectionOrder.push("required");
          return { collected: 2, health: { ok: true } };
        },
      },
    },
  });
  assert.deepEqual(results.x_search_gateway, {
    ok: false,
    fetched: false,
    required: false,
    provider: "x_search_gateway_hermes",
    error: "optional context unavailable",
  });
  assert.equal(results.historical_monitor.ok, true);
  assert.equal(results.historical_monitor.required, true);
  assert.equal(results.historical_monitor.collected, 2);
  assert.deepEqual(collectionOrder, ["required", "context"]);
});
