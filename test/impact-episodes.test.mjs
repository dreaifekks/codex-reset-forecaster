import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRecord,
  producer,
  targetScope,
} from "../src/core/records.mjs";
import { makeRecordId } from "../src/core/hash.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import {
  buildImpactEpisodes,
  IMPACT_EPISODE_POLICY_VERSION,
} from "../src/pipeline/impact-episodes.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

const SEMANTIC_POLICY_HASH =
  `sha256:${"a".repeat(64)}`;
const CONFIG = {
  impact_tracking: {
    version: IMPACT_EPISODE_POLICY_VERSION,
    enabled: true,
    cluster_gap_hours: 72,
    active_evidence_ttl_hours: 24,
    freshness_half_life_hours: 36,
  },
};

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "impact-episodes-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new JsonlStore(directory).init();
}

function impactSignal({
  id,
  availableAt,
  group = `ind_${id}`,
  eventType = "experience_issue",
  category = "tool_execution",
  severity = "medium",
  lifecycle = "active",
  affectedScope = "multiple_users",
  surfaces = ["cli", "mcp", "tool_use"],
  workaround = "unknown",
  evidenceBasis = "first_party_report",
  derivation = "primary_statement",
  sourceRole = "community",
  product = "codex",
}) {
  return createRecord({
    recordType: "normalized_signal",
    naturalKey: id,
    createdAt: new Date(availableAt),
    producer: producer("test-claim-extractor", "1.0.0"),
    data: {
      observation_refs: [
        {
          record_id: makeRecordId("obs", id),
          revision: 1,
        },
      ],
      available_at: new Date(availableAt).toISOString(),
      taxonomy_version: "reset-taxonomy/test",
      claim: {
        event_type: eventType,
        phase: lifecycle === "resolved" ? "completed" : "started",
        stance: "supports",
        scope: targetScope({
          product,
          population: "affected_users",
          plans: ["paid"],
        }),
        asserted_time_range: null,
        author_certainty: "explicit",
        impact: {
          category,
          severity,
          lifecycle,
          affected_scope: affectedScope,
          affected_surfaces: surfaces,
          workaround,
          evidence_basis: evidenceBasis,
        },
        competitive_context: null,
      },
      provenance: {
        source_identity_id: `source_${id}`,
        source_role: sourceRole,
        root_evidence_id: `root_${group}`,
        derivation,
        independence_group_id: group,
        feature_eligible: false,
        selection_bias: null,
        source_published_at: new Date(availableAt).toISOString(),
        first_seen_at: new Date(availableAt).toISOString(),
        recency_basis: "source_publication",
        canonical_source_url: `https://example.test/${id}`,
      },
      extraction: {
        model: "deterministic-rules",
        model_version: "test",
        prompt_version: "test",
        semantic_policy_hash: SEMANTIC_POLICY_HASH,
        confidence: 0.9,
        relevance: {
          policy_version: "test",
          decision: "relevant",
          reason_code: "target_operational_claim",
          basis: "self",
          matched_segments: ["test impact claim"],
          context_refs: [],
        },
      },
    },
  });
}

function rawObservation({ id, availableAt, text = "Codex MCP execution hangs" }) {
  return createRecord({
    recordType: "raw_observation",
    naturalKey: id,
    createdAt: new Date(availableAt),
    producer: producer("test-provider", "1.0.0"),
    data: {
      ingest_provider: "test",
      provider_item_id: id,
      canonical_url: `https://example.test/${id}`,
      published_at: new Date(availableAt).toISOString(),
      first_seen_at: new Date(availableAt).toISOString(),
      fetched_at: new Date(availableAt).toISOString(),
      availability_attestation: null,
      author: {
        provider_author_id: `author_${id}`,
        identity_id: `source_${id}`,
        display_handle: `@${id}`,
      },
      native_relations: [],
      content: {
        media_type: "text/plain",
        text,
        language: "en",
        content_hash: `hash_${id}`,
        raw_payload_ref: null,
      },
    },
  });
}

async function appendImpactSignals(store, specifications) {
  const observations = specifications.map(rawObservation);
  const signals = specifications.map(impactSignal);
  await store.appendMany([...observations, ...signals]);
  return signals;
}

test("impact episodes obey the cutoff and deduplicate derivative evidence roots", async (t) => {
  const store = await temporaryStore(t);
  const signals = await appendImpactSignals(store, [
    {
      id: "primary",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_shared",
      text: "Codex MCP execution hangs on tool return",
    },
    {
      id: "summary",
      availableAt: "2026-07-29T01:00:00Z",
      group: "ind_shared",
      derivation: "summarizes",
      text: "Summary of Codex MCP execution hangs",
    },
    {
      id: "independent",
      availableAt: "2026-07-29T02:00:00Z",
      group: "ind_independent",
      evidenceBasis: "independent_corroboration",
      text: "Codex MCP execution hangs for another account",
    },
    {
      id: "future",
      availableAt: "2026-07-29T08:00:00Z",
      group: "ind_future",
      severity: "critical",
      affectedScope: "platform",
      text: "Codex MCP execution hangs platform-wide",
    },
    {
      id: "wrong-event-type",
      availableAt: "2026-07-29T03:00:00Z",
      group: "ind_reset",
      eventType: "quota_reset",
      text: "Codex MCP execution hangs after reset",
    },
  ]);

  const result = await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T04:00:00Z"),
  });
  assert.equal(result.built, 1);
  const [episode] = await store.all("impact_episode");
  assert.equal(episode.data.evidence.length, 2);
  assert.deepEqual(
    episode.data.evidence.map((entry) => entry.independence_group_id),
    ["ind_shared", "ind_independent"],
  );
  assert.equal(
    episode.data.evidence[0].signal_ref.record_id,
    signals[0].record_id,
  );
  assert.equal(
    episode.data.last_independent_update_at,
    "2026-07-29T02:00:00.000Z",
  );
  assert.equal(episode.data.category, "tool_execution");
  assert.match(episode.data.topic_key, /^topic_[a-f0-9]{24}$/);
  assert.deepEqual(episode.data.episode_interval, {
    start: "2026-07-29T00:00:00.000Z",
    end: "2026-07-29T04:00:00.000Z",
    boundary: "[start,end)",
  });
  assert.equal(episode.data.peak_impact.severity, "medium");
});

test("bounded persistence rises, then stale evidence decays without ten-minute revision noise", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "persistent",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_persistent",
      severity: "high",
    },
  ]);

  const opened = await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T00:00:00Z"),
  });
  assert.equal(opened.built, 1);
  const first = (await store.all("impact_episode"))[0];

  const exactRerun = await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T00:00:00Z"),
  });
  const tenMinutesLater = await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T00:10:00Z"),
  });
  assert.equal(exactRerun.built, 0);
  assert.equal(tenMinutesLater.built, 0);

  const persisted = await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-30T00:00:00Z"),
  });
  assert.equal(persisted.built, 1);
  const second = (await store.all("impact_episode"))[0];
  assert.equal(second.revision, 2);
  assert.deepEqual(second.supersedes, {
    record_id: first.record_id,
    revision: 1,
  });
  assert.ok(second.data.current_pressure > first.data.current_pressure);
  assert.equal(
    second.data.pressure_components.active_duration_hours,
    24,
  );

  const stale = await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-08-02T04:00:00Z"),
  });
  assert.equal(stale.built, 1);
  const third = (await store.all("impact_episode"))[0];
  assert.equal(third.revision, 3);
  assert.equal(third.data.pressure_components.active_duration_hours, 24);
  assert.ok(third.data.pressure_components.freshness < 1);
  assert.ok(third.data.current_pressure < second.data.current_pressure);
  assert.equal(third.data.peak_pressure, second.data.peak_pressure);
});

test("independent widespread severe follow-up escalates one stable episode revision", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "initial-medium",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_initial",
      severity: "medium",
      affectedScope: "multiple_users",
      text: "Codex MCP execution hangs after tool return",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T01:00:00Z"),
  });
  const first = (await store.all("impact_episode"))[0];

  await appendImpactSignals(store, [
    {
      id: "widespread-high",
      availableAt: "2026-07-29T02:00:00Z",
      group: "ind_escalation",
      severity: "high",
      affectedScope: "platform",
      evidenceBasis: "independent_corroboration",
      text: "Widespread MCP execution hangs across accounts",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T02:00:00Z"),
  });
  const second = (await store.all("impact_episode"))[0];

  assert.equal(second.record_id, first.record_id);
  assert.equal(second.revision, 2);
  assert.equal(second.data.update_kind, "escalated");
  assert.equal(second.data.trend, "rising");
  assert.equal(second.data.current_impact.severity, "high");
  assert.equal(second.data.current_impact.affected_scope, "platform");
  assert.ok(second.data.current_pressure > first.data.current_pressure);
  assert.equal(second.data.evidence.length, 2);
});

test("mitigation, sparse recovery wording, and reopening remain one episode", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "mcp-hang",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_issue",
      severity: "high",
      surfaces: ["cli", "mcp", "tool_use"],
      text: "Codex CLI hangs whenever an MCP tool returns",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T01:00:00Z"),
  });
  const active = (await store.all("impact_episode"))[0];

  await appendImpactSignals(store, [
    {
      id: "mcp-mitigation",
      availableAt: "2026-07-29T02:00:00Z",
      group: "ind_mitigation",
      severity: "unknown",
      lifecycle: "mitigating",
      surfaces: ["mcp"],
      workaround: "available",
      evidenceBasis: "official_incident",
      sourceRole: "official",
      text: "Investigating the MCP hang and applying mitigation",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T02:00:00Z"),
  });
  const mitigating = (await store.all("impact_episode"))[0];
  assert.equal(mitigating.data.state, "mitigating");
  assert.equal(mitigating.data.update_kind, "mitigated");
  assert.equal(
    mitigating.data.official_acknowledged_at,
    "2026-07-29T02:00:00.000Z",
  );
  assert.ok(
    mitigating.data.current_pressure < active.data.current_pressure,
  );

  await appendImpactSignals(store, [
    {
      id: "fixed-now",
      availableAt: "2026-07-29T04:00:00Z",
      group: "ind_resolution",
      eventType: "experience_recovery",
      category: "other",
      severity: "unknown",
      lifecycle: "resolved",
      affectedScope: "unknown",
      surfaces: ["unknown"],
      workaround: "unknown",
      evidenceBasis: "official_incident",
      sourceRole: "official",
      text: "Codex is fixed now",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T04:00:00Z"),
  });
  const resolved = (await store.all("impact_episode"))[0];
  assert.equal((await store.all("impact_episode")).length, 1);
  assert.equal(resolved.record_id, active.record_id);
  assert.equal(resolved.data.state, "resolved");
  assert.equal(resolved.data.update_kind, "resolved");
  assert.equal(resolved.data.trend, "resolved");
  assert.equal(
    resolved.data.resolved_at,
    "2026-07-29T04:00:00.000Z",
  );
  assert.ok(resolved.data.current_pressure < 0.05);
  assert.equal(resolved.data.evidence.at(-1).relation, "resolves");

  await appendImpactSignals(store, [
    {
      id: "mcp-regression",
      availableAt: "2026-07-29T06:00:00Z",
      group: "ind_reopened",
      severity: "high",
      lifecycle: "active",
      affectedScope: "multiple_users",
      surfaces: ["mcp", "tool_use"],
      text: "The MCP hang has returned again",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T06:00:00Z"),
  });
  const reopened = (await store.all("impact_episode"))[0];
  assert.equal((await store.all("impact_episode")).length, 1);
  assert.equal(reopened.record_id, active.record_id);
  assert.equal(reopened.data.state, "reopened");
  assert.equal(reopened.data.update_kind, "reopened");
  assert.equal(reopened.data.trend, "rising");
  assert.ok(
    reopened.data.current_pressure > resolved.data.current_pressure,
  );
  assert.equal(reopened.data.evidence.at(-1).relation, "reopens");
});

test("the temporal cluster gap starts a distinct episode after 72 hours", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "old-issue",
      availableAt: "2026-07-25T00:00:00Z",
      group: "ind_old",
    },
    {
      id: "new-issue",
      availableAt: "2026-07-28T01:00:00Z",
      group: "ind_new",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-28T01:00:00Z"),
  });
  const episodes = await store.all("impact_episode");
  assert.equal(episodes.length, 2);
  assert.notEqual(episodes[0].data.episode_id, episodes[1].data.episode_id);
});

test("unrelated issues with the same category and surfaces do not amplify each other", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "mcp-hang-topic",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_mcp_hang",
      text: "MCP execution hangs after a tool result",
    },
    {
      id: "destructive-tool-topic",
      availableAt: "2026-07-29T01:00:00Z",
      group: "ind_destructive_tool",
      text: "CLI deletes workspace files during cleanup",
    },
  ]);
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T02:00:00Z"),
  });
  const episodes = await store.all("impact_episode");
  assert.equal(episodes.length, 2);
  assert.notEqual(
    episodes[0].data.topic_key,
    episodes[1].data.topic_key,
  );
  assert.ok(
    episodes.every(
      (episode) =>
        episode.data.pressure_components.independent_evidence_count === 1,
    ),
  );
});

test("a same-root reply can resolve lifecycle without adding corroboration", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "same-root-issue",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_same_root",
      severity: "high",
      text: "Codex MCP execution hangs after tool return",
    },
    {
      id: "same-root-resolution",
      availableAt: "2026-07-29T02:00:00Z",
      group: "ind_same_root",
      eventType: "experience_recovery",
      category: "other",
      severity: "unknown",
      lifecycle: "resolved",
      affectedScope: "unknown",
      surfaces: ["unknown"],
      evidenceBasis: "official_incident",
      derivation: "reply",
      sourceRole: "official",
      text: "Fixed now",
    },
  ]);

  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T00:00:00Z"),
  });
  const active = (await store.all("impact_episode"))[0];
  assert.equal(active.data.state, "active");
  assert.equal(active.data.evidence.length, 1);

  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T02:00:00Z"),
  });
  const resolved = (await store.all("impact_episode"))[0];
  assert.equal(resolved.record_id, active.record_id);
  assert.equal(resolved.revision, 2);
  assert.equal(resolved.data.state, "resolved");
  assert.equal(resolved.data.update_kind, "resolved");
  assert.equal(resolved.data.evidence.length, 1);
  assert.equal(
    resolved.data.pressure_components.independent_evidence_count,
    1,
  );
  assert.equal(resolved.data.peak_impact.severity, "high");
  assert.equal(
    resolved.data.evidence[0].signal_ref.record_id,
    impactSignal({
      id: "same-root-resolution",
      availableAt: "2026-07-29T02:00:00Z",
      group: "ind_same_root",
      eventType: "experience_recovery",
      category: "other",
      severity: "unknown",
      lifecycle: "resolved",
      affectedScope: "unknown",
      surfaces: ["unknown"],
      evidenceBasis: "official_incident",
      derivation: "reply",
      sourceRole: "official",
    }).record_id,
  );
});

test("a same-root still-broken reply refreshes persistence without adding corroboration", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "same-root-active",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_same_active_root",
      severity: "high",
      text: "Codex MCP execution hangs after tool return",
    },
    {
      id: "same-root-still-broken",
      availableAt: "2026-07-29T06:00:00Z",
      group: "ind_same_active_root",
      severity: "high",
      derivation: "reply",
      text: "Still broken: the MCP execution hangs",
    },
  ]);

  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T00:00:00Z"),
  });
  const opened = (await store.all("impact_episode"))[0];
  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T06:00:00Z"),
  });
  const followedUp = (await store.all("impact_episode"))[0];

  assert.equal(followedUp.record_id, opened.record_id);
  assert.equal(followedUp.revision, 2);
  assert.equal(followedUp.data.state, "active");
  assert.equal(
    followedUp.data.last_independent_update_at,
    "2026-07-29T06:00:00.000Z",
  );
  assert.equal(followedUp.data.evidence.length, 1);
  assert.equal(
    followedUp.data.pressure_components.independent_evidence_count,
    1,
  );
  assert.equal(
    followedUp.data.pressure_components.hours_since_last_independent_update,
    0,
  );
});

test("one common timing token cannot merge unrelated same-surface issues", async (t) => {
  const store = await temporaryStore(t);
  await appendImpactSignals(store, [
    {
      id: "auth-hang-after-update",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_auth_hang",
      text: "Latest update: MCP tool hangs after authentication",
    },
    {
      id: "upload-crash-after-update",
      availableAt: "2026-07-29T01:00:00Z",
      group: "ind_upload_crash",
      text: "Latest update: tool execution crashes after file upload",
    },
  ]);

  await buildImpactEpisodes(store, CONFIG, {
    asOf: new Date("2026-07-29T02:00:00Z"),
  });
  const episodes = await store.all("impact_episode");
  assert.equal(episodes.length, 2);
  assert.ok(
    episodes.every(
      (episode) =>
        episode.data.pressure_components.independent_evidence_count === 1,
    ),
  );
});

test("impact episodes ignore incompatible extractor history and irrelevant current signals", async (t) => {
  const store = await temporaryStore(t);
  const config = {
    ...CONFIG,
    taxonomy_version: "reset-taxonomy/test-current",
    deduplication_version: "reset-dedup/test-current",
    target: targetScope(),
    providers: {},
    outcome_definition: {
      version: "test",
      event_semantics: "actual_platform_reset",
      authority_identity_ids: [],
      scope_policy: "test",
    },
    extractor: {
      model: "deterministic-rules",
      model_version: "current",
      prompt_version: "current-prompt",
      topic_relevance_policy_version: "current-relevance",
    },
  };
  const expected = extractorContract(config);
  const specifications = [
    {
      id: "current-extractor",
      availableAt: "2026-07-29T00:00:00Z",
      group: "ind_current",
      text: "Codex MCP execution hangs after tool return",
    },
    {
      id: "old-extractor",
      availableAt: "2026-07-29T01:00:00Z",
      group: "ind_old_extractor",
      text: "Codex MCP execution hangs for another account",
    },
    {
      id: "current-but-irrelevant",
      availableAt: "2026-07-29T02:00:00Z",
      group: "ind_irrelevant",
      text: "Codex MCP execution hangs in unrelated context",
    },
  ];
  const observations = specifications.map(rawObservation);
  const [current, old, irrelevant] = specifications.map(impactSignal);
  for (const signal of [current, irrelevant]) {
    signal.producer.name = "rule-claim-extractor";
    signal.producer.version = expected.model_version;
    signal.data.taxonomy_version = config.taxonomy_version;
    Object.assign(signal.data.extraction, {
      model: expected.model,
      model_version: expected.model_version,
      prompt_version: expected.prompt_version,
      semantic_policy_hash: expected.semantic_policy_hash,
    });
    signal.data.extraction.relevance.policy_version =
      expected.topic_relevance_policy_version;
  }
  irrelevant.data.extraction.relevance.decision = "irrelevant";
  irrelevant.data.extraction.relevance.reason_code = "not_target";
  await store.appendMany([
    ...observations,
    current,
    old,
    irrelevant,
  ]);

  await buildImpactEpisodes(store, config, {
    asOf: new Date("2026-07-29T03:00:00Z"),
  });
  const [episode] = await store.all("impact_episode");
  assert.ok(episode);
  assert.equal((await store.all("impact_episode")).length, 1);
  assert.equal(episode.data.evidence.length, 1);
  assert.equal(
    episode.data.evidence[0].signal_ref.record_id,
    current.record_id,
  );
  assert.equal(episode.data.taxonomy_version, config.taxonomy_version);
  assert.equal(
    episode.data.extractor_contract.semantic_policy_hash,
    expected.semantic_policy_hash,
  );
});
