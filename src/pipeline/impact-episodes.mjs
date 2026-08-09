import { createRecord, producer, recordRef } from "../core/records.mjs";
import { makeRecordId } from "../core/hash.mjs";
import {
  extractorContract,
  matchesExtractorContract,
} from "../core/extractor-contract.mjs";

export const IMPACT_EPISODE_POLICY_VERSION = "impact-episode-policy/1";
export const IMPACT_EPISODE_PRODUCER_VERSION = "0.1.0";

const HOUR_MS = 3_600_000;
const ELIGIBLE_EVENT_TYPES = new Set([
  "incident",
  "capacity_restore",
  "experience_issue",
  "experience_recovery",
]);
const DEFAULT_POLICY = Object.freeze({
  version: IMPACT_EPISODE_POLICY_VERSION,
  enabled: true,
  cluster_gap_hours: 72,
  active_evidence_ttl_hours: 24,
  freshness_half_life_hours: 36,
});
const SEVERITY_WEIGHT = Object.freeze({
  critical: 1,
  high: 0.8,
  medium: 0.55,
  low: 0.3,
  unknown: 0.2,
});
const SCOPE_WEIGHT = Object.freeze({
  platform: 1,
  multiple_users: 0.72,
  individual: 0.35,
  unknown: 0.45,
});
const WORKAROUND_WEIGHT = Object.freeze({
  none: 1,
  partial: 0.72,
  available: 0.42,
  unknown: 0.8,
});
const STATE_WEIGHT = Object.freeze({
  active: 1,
  investigating: 0.9,
  mitigating: 0.45,
  resolved: 0.02,
  reopened: 1,
  unknown: 0.65,
});
const MATERIAL_PRESSURE_DELTA = 0.005;
const TOPIC_STOPWORDS = new Set([
  "about",
  "across",
  "after",
  "again",
  "agent",
  "another",
  "api",
  "auth",
  "before",
  "codex",
  "currently",
  "during",
  "fixed",
  "from",
  "have",
  "ide",
  "incident",
  "issue",
  "latest",
  "mcp",
  "mode",
  "now",
  "openai",
  "problem",
  "resolved",
  "result",
  "return",
  "service",
  "still",
  "that",
  "their",
  "this",
  "tool",
  "tools",
  "update",
  "user",
  "users",
  "using",
  "web",
  "when",
  "while",
  "with",
].flatMap((token) => [token, topicStem(token)]));
const DISTINCTIVE_TOPIC_TOKENS = new Set([
  "allowance",
  "corrupt",
  "crash",
  "delete",
  "drain",
  "freeze",
  "hang",
  "leak",
  "login",
  "regress",
  "stuck",
  "timeout",
  "upload",
  "workspace",
]);

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function impactTrackingPolicy(config = {}) {
  const configured = config.impact_tracking ?? {};
  const policy = {
    version:
      typeof configured.version === "string" && configured.version.length > 0
        ? configured.version
        : DEFAULT_POLICY.version,
    enabled:
      typeof configured.enabled === "boolean"
        ? configured.enabled
        : DEFAULT_POLICY.enabled,
    cluster_gap_hours: positiveNumber(
      configured.cluster_gap_hours,
      DEFAULT_POLICY.cluster_gap_hours,
    ),
    active_evidence_ttl_hours: positiveNumber(
      configured.active_evidence_ttl_hours,
      DEFAULT_POLICY.active_evidence_ttl_hours,
    ),
    freshness_half_life_hours: positiveNumber(
      configured.freshness_half_life_hours,
      DEFAULT_POLICY.freshness_half_life_hours,
    ),
  };
  if (policy.version !== IMPACT_EPISODE_POLICY_VERSION) {
    throw new TypeError(
      `Unsupported impact episode policy version: ${policy.version}`,
    );
  }
  return policy;
}

export function impactEpisodeContract(config = {}) {
  return {
    impact_tracking: impactTrackingPolicy(config),
    taxonomy_version: config.taxonomy_version ?? null,
    deduplication_version: config.deduplication_version ?? null,
    extractor: config.extractor ? extractorContract(config) : null,
  };
}

function round(value, digits = 6) {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function clampProbability(value) {
  return round(Math.max(0, Math.min(1, value)));
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid ${label}: ${value}`);
  return parsed;
}

function signalAvailableAt(signal) {
  return timestamp(signal.data.available_at, "signal available_at");
}

function compareSignalRank(left, right) {
  const derivationRank = (signal) =>
    ["primary_statement", "independent_observation"].includes(
      signal.data.provenance?.derivation,
    )
      ? 0
      : 1;
  const roleRank = (signal) =>
    ["official", "product_lead", "product_team_member"].includes(
      signal.data.provenance?.source_role,
    )
      ? 0
      : 1;
  return (
    derivationRank(left) - derivationRank(right) ||
    roleRank(left) - roleRank(right) ||
    signalAvailableAt(right) - signalAvailableAt(left) ||
    String(right.created_at).localeCompare(String(left.created_at)) ||
    right.revision - left.revision ||
    String(left.record_id).localeCompare(String(right.record_id))
  );
}

function selectSignalsAsOf(signals, asOfMs, expectedExtractor) {
  const byObservation = new Map();
  for (const signal of signals) {
    if (
      signal?.record_type !== "normalized_signal" ||
      !signal.data?.claim?.impact ||
      !ELIGIBLE_EVENT_TYPES.has(signal.data.claim.event_type) ||
      !matchesExtractorContract(signal, expectedExtractor) ||
      signal.data.extraction?.relevance?.decision !== "relevant" ||
      (
        expectedExtractor !== null &&
        signal.data.extraction.relevance.policy_version !==
          expectedExtractor.topic_relevance_policy_version
      ) ||
      signalAvailableAt(signal) > asOfMs ||
      timestamp(signal.created_at, "signal created_at") > asOfMs
    ) {
      continue;
    }
    const observationId = signal.data.observation_refs?.[0]?.record_id;
    if (!observationId) continue;
    const prior = byObservation.get(observationId);
    const priorObservationRevision =
      prior?.data.observation_refs?.[0]?.revision ?? 0;
    const observationRevision =
      signal.data.observation_refs?.[0]?.revision ?? 0;
    if (
      !prior ||
      observationRevision > priorObservationRevision ||
      (
        observationRevision === priorObservationRevision &&
        compareSignalRank(signal, prior) < 0
      )
    ) {
      byObservation.set(observationId, signal);
    }
  }
  return [...byObservation.values()];
}

function productKey(scope) {
  if (scope.product !== "multi_product") return scope.product;
  return `multi_product:${[...(scope.products ?? [])].sort().join(",")}`;
}

function impactKey(signal) {
  const impact = signal.data.claim.impact;
  return [
    productKey(signal.data.claim.scope),
    impact.category,
    [...impact.affected_surfaces].sort().join(","),
  ].join(":");
}

function exactRefKey(reference) {
  return `${reference.record_id}@${reference.revision}`;
}

function topicStem(token) {
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function topicTokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.map(topicStem)
      .filter(
        (token) =>
          token.length >= 4 &&
          !TOPIC_STOPWORDS.has(token),
      ) ?? [],
  );
}

function observationTextByRef(observations, asOfMs) {
  const selected = new Map();
  for (const observation of observations) {
    if (
      observation?.record_type !== "raw_observation" ||
      timestamp(observation.created_at, "observation created_at") >
        asOfMs
    ) {
      continue;
    }
    selected.set(
      exactRefKey({
        record_id: observation.record_id,
        revision: observation.revision,
      }),
      observation.data.content?.text ?? "",
    );
  }
  return selected;
}

function signalTopicTokens(signal, observationsByRef) {
  const tokens = new Set();
  for (const reference of signal.data.observation_refs ?? []) {
    for (const token of topicTokens(observationsByRef.get(exactRefKey(reference)))) {
      tokens.add(token);
    }
  }
  return tokens;
}

function isRecoveryEntry(entry) {
  return ["capacity_restore", "experience_recovery"].includes(
    entry.signal.data.claim.event_type,
  );
}

function isLifecycleFollowup(entry) {
  return (
    isRecoveryEntry(entry) ||
    ["investigating", "mitigating", "resolved"].includes(
      entry.signal.data.claim.impact.lifecycle,
    )
  );
}

function surfacesOverlap(left, right) {
  const leftSurfaces =
    left.anchorSignal.data.claim.impact.affected_surfaces;
  const rightSurfaces =
    right.anchorSignal.data.claim.impact.affected_surfaces;
  if (
    leftSurfaces.includes("unknown") ||
    rightSurfaces.includes("unknown")
  ) {
    return true;
  }
  const rightSet = new Set(rightSurfaces);
  return leftSurfaces.some((surface) => rightSet.has(surface));
}

function sharesTopic(cluster, entry) {
  const shared = [];
  for (const token of entry.topicTokens) {
    if (cluster.topicTokens.has(token)) shared.push(token);
  }
  return (
    shared.length >= 2 ||
    shared.some((token) => DISTINCTIVE_TOPIC_TOKENS.has(token))
  );
}

function clusterCompatibility(cluster, entry, gapMs) {
  if (entry.firstObservedAtMs - cluster.lastObservedAtMs > gapMs) return -1;
  const anchor = cluster.entries[0];
  if (
    productKey(entry.anchorSignal.data.claim.scope) !==
      productKey(anchor.anchorSignal.data.claim.scope)
  ) {
    return -1;
  }
  const anchorImpact = anchor.anchorSignal.data.claim.impact;
  const impact = entry.anchorSignal.data.claim.impact;
  const categoryMatches = anchorImpact.category === impact.category;
  const surfaceMatches = cluster.entries.some((item) =>
    surfacesOverlap(item, entry)
  );
  if (categoryMatches && surfaceMatches && sharesTopic(cluster, entry)) {
    return 4;
  }
  if (
    isLifecycleFollowup(entry) &&
    surfaceMatches &&
    (
      categoryMatches ||
      impact.category === "other" ||
      impact.affected_surfaces.includes("unknown")
    )
  ) {
    return 1;
  }
  return -1;
}

function impactUpdateSignature(signal) {
  return JSON.stringify({
    event_type: signal.data.claim.event_type,
    impact: signal.data.claim.impact,
  });
}

function independentEvidence(signals, observationsByRef) {
  const grouped = new Map();
  for (const signal of signals) {
    const groupId = signal.data.provenance.independence_group_id;
    const group = grouped.get(groupId) ?? [];
    group.push(signal);
    grouped.set(groupId, group);
  }
  return [...grouped.entries()].map(([independenceGroupId, group]) => {
    const byUpdate = new Map();
    for (const signal of group) {
      const signature = impactUpdateSignature(signal);
      const updateIdentity =
        signal.data.provenance.derivation === "reply"
          ? `${signature}:reply:${
              signal.data.provenance.canonical_source_url ??
              signal.data.observation_refs?.[0]?.record_id ??
              signal.record_id
            }`
          : signature;
      const prior = byUpdate.get(updateIdentity);
      if (!prior) {
        byUpdate.set(updateIdentity, {
          signal,
          observedAtMs: signalAvailableAt(signal),
        });
      } else {
        prior.observedAtMs = Math.min(
          prior.observedAtMs,
          signalAvailableAt(signal),
        );
        if (compareSignalRank(signal, prior.signal) < 0) {
          prior.signal = signal;
        }
      }
    }
    const updates = [...byUpdate.values()]
      .map((update) => ({
        ...update,
        independenceGroupId,
      }))
      .sort(
        (left, right) =>
          left.observedAtMs - right.observedAtMs ||
          left.signal.record_id.localeCompare(right.signal.record_id),
      );
    const anchorSignal = updates[0].signal;
    const signal = updates.at(-1).signal;
    const tokens = new Set();
    for (const item of group) {
      for (const token of signalTopicTokens(item, observationsByRef)) {
        tokens.add(token);
      }
    }
    return {
      independenceGroupId,
      signal,
      anchorSignal,
      updates,
      topicTokens: tokens,
      firstObservedAtMs: updates[0].observedAtMs,
      observedAtMs: updates.at(-1).observedAtMs,
      key: impactKey(anchorSignal),
    };
  });
}

function clusterEvidence(entries, clusterGapHours) {
  const gapMs = clusterGapHours * HOUR_MS;
  const clusters = [];
  const sorted = [...entries].sort(
    (left, right) =>
      left.firstObservedAtMs - right.firstObservedAtMs ||
      left.independenceGroupId.localeCompare(right.independenceGroupId),
  );
  for (const entry of sorted) {
    const candidates = clusters
      .map((cluster) => ({
        cluster,
        score: clusterCompatibility(cluster, entry, gapMs),
      }))
      .filter(({ score }) => score >= 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.cluster.lastObservedAtMs -
            left.cluster.lastObservedAtMs,
      );
    let current = candidates[0]?.cluster ?? null;
    if (
      current &&
      candidates[0].score === 1 &&
      candidates.filter(({ score }) => score === 1).length > 1
    ) {
      current = null;
    }
    if (!current) {
      current = {
        key: entry.key,
        entries: [],
        topicTokens: new Set(),
        firstObservedAtMs: entry.firstObservedAtMs,
        lastObservedAtMs: entry.observedAtMs,
      };
      clusters.push(current);
    }
    current.entries.push(entry);
    for (const token of entry.topicTokens) current.topicTokens.add(token);
    current.lastObservedAtMs = Math.max(
      current.lastObservedAtMs,
      entry.observedAtMs,
    );
  }
  return clusters.sort(
    (left, right) =>
      left.firstObservedAtMs - right.firstObservedAtMs ||
      left.key.localeCompare(right.key),
  );
}

function lifecycle(entry) {
  return entry.signal.data.claim.impact.lifecycle;
}

function timelineEntries(entries, atMs = Number.POSITIVE_INFINITY) {
  return entries
    .flatMap((entry) => entry.updates)
    .filter((entry) => entry.observedAtMs <= atMs)
    .sort(
      (left, right) =>
        left.observedAtMs - right.observedAtMs ||
        left.independenceGroupId.localeCompare(
          right.independenceGroupId,
        ),
    );
}

function timelineState(entries) {
  let state = "unknown";
  let hasResolved = false;
  for (const entry of entries) {
    const next = lifecycle(entry);
    if (next === "resolved") {
      state = "resolved";
      hasResolved = true;
    } else if (hasResolved) {
      state = "reopened";
    } else {
      state = next;
    }
  }
  return state;
}

function evidenceRelation(entry, context) {
  const next = lifecycle(entry);
  if (next === "resolved") return "resolves";
  if (context.hasResolved) return "reopens";
  if (next === "investigating") return "investigates";
  if (next === "mitigating") return "mitigates";
  return context.seen ? "corroborates" : "reports";
}

function severityRank(impact) {
  return SEVERITY_WEIGHT[impact.severity] ?? 0;
}

function affectedScopeRank(impact) {
  return SCOPE_WEIGHT[impact.affected_scope] ?? 0;
}

function peakImpact(entries, category = null) {
  const impacts = entries.map((entry) => entry.signal.data.claim.impact);
  const categoryImpacts = category === null
    ? impacts
    : impacts.filter((impact) => impact.category === category);
  return structuredClone(
    [...(categoryImpacts.length > 0 ? categoryImpacts : impacts)]
      .sort(
        (left, right) =>
          severityRank(right) - severityRank(left) ||
          affectedScopeRank(right) - affectedScopeRank(left),
      )[0],
  );
}

function currentActiveSpell(entries, atMs) {
  let spellStartMs = entries[0].observedAtMs;
  let resolvedAtMs = null;
  let resolved = false;
  for (const entry of entries) {
    if (lifecycle(entry) === "resolved") {
      resolvedAtMs = entry.observedAtMs;
      resolved = true;
    } else if (resolved) {
      spellStartMs = entry.observedAtMs;
      resolvedAtMs = null;
      resolved = false;
    }
  }
  return {
    startMs: spellStartMs,
    endMs: resolved && resolvedAtMs !== null ? resolvedAtMs : atMs,
  };
}

function pressureAt(entries, atMs, policy) {
  const visible = timelineEntries(entries, atMs);
  if (visible.length === 0) return null;
  const independentEvidenceCount = new Set(
    visible.map((entry) => entry.independenceGroupId),
  ).size;
  const state = timelineState(visible);
  const current = visible.at(-1).signal.data.claim.impact;
  const peak = peakImpact(
    visible,
    visible[0].signal.data.claim.impact.category,
  );
  const lastUpdateMs = visible.at(-1).observedAtMs;
  const activeSpell = currentActiveSpell(visible, atMs);
  const activeDurationHours = Math.max(
    0,
    Math.min(
      policy.active_evidence_ttl_hours,
      (activeSpell.endMs - activeSpell.startMs) / HOUR_MS,
    ),
  );
  const pressureDurationHours = Math.floor(activeDurationHours);
  const persistenceProgress =
    pressureDurationHours / policy.active_evidence_ttl_hours;
  const persistence =
    (1 - Math.exp(-3 * persistenceProgress)) / (1 - Math.exp(-3));
  const hoursSinceLastIndependentUpdate = Math.max(
    0,
    (atMs - lastUpdateMs) / HOUR_MS,
  );
  const decayAgeHours = Math.max(
    0,
    hoursSinceLastIndependentUpdate -
      policy.active_evidence_ttl_hours,
  );
  const pressureDecayAgeHours = Math.floor(decayAgeHours);
  const freshness = 0.5 ** (
    pressureDecayAgeHours / policy.freshness_half_life_hours
  );
  const corroboration = Math.min(
    1,
    0.4 + Math.max(0, independentEvidenceCount - 1) * 0.2,
  );
  const components = {
    severity: SEVERITY_WEIGHT[peak.severity],
    affected_scope: SCOPE_WEIGHT[peak.affected_scope],
    lifecycle: STATE_WEIGHT[state],
    persistence: clampProbability(persistence),
    corroboration: clampProbability(corroboration),
    freshness: clampProbability(freshness),
    workaround: WORKAROUND_WEIGHT[current.workaround],
    independent_evidence_count: independentEvidenceCount,
    active_duration_hours: round(activeDurationHours),
    hours_since_last_independent_update: round(
      hoursSinceLastIndependentUpdate,
    ),
  };
  const base =
    components.severity * 0.4 +
    components.affected_scope * 0.25 +
    components.persistence * 0.1 +
    components.corroboration * 0.15 +
    components.workaround * 0.1;
  return {
    pressure: clampProbability(
      base * components.lifecycle * components.freshness,
    ),
    components,
  };
}

function historicalPeakPressure(entries, asOfMs, policy) {
  const sampleTimes = new Set([asOfMs]);
  const updates = timelineEntries(entries, asOfMs);
  for (const entry of updates) {
    if (entry.observedAtMs > asOfMs) continue;
    sampleTimes.add(entry.observedAtMs);
    if (entry.observedAtMs > updates[0].observedAtMs) {
      sampleTimes.add(entry.observedAtMs - 1);
    }
    sampleTimes.add(
      Math.min(
        asOfMs,
        entry.observedAtMs +
          policy.active_evidence_ttl_hours * HOUR_MS,
      ),
    );
  }
  let maximum = 0;
  for (const atMs of sampleTimes) {
    maximum = Math.max(
      maximum,
      pressureAt(entries, atMs, policy)?.pressure ?? 0,
    );
  }
  return maximum;
}

function episodeTimestamps(entries) {
  const official = entries
    .filter((entry) =>
      entry.signal.data.claim.impact.evidence_basis ===
        "official_incident" ||
      ["official", "product_lead", "product_team_member"].includes(
        entry.signal.data.provenance.source_role,
      )
    )
    .map((entry) => entry.observedAtMs);
  const mitigated = entries
    .filter((entry) => lifecycle(entry) === "mitigating")
    .map((entry) => entry.observedAtMs);
  const resolved = entries
    .filter((entry) => lifecycle(entry) === "resolved")
    .map((entry) => entry.observedAtMs);
  const toIso = (value) =>
    value === undefined ? null : new Date(value).toISOString();
  return {
    official_acknowledged_at: toIso(official.sort((a, b) => a - b)[0]),
    mitigated_at: toIso(mitigated.sort((a, b) => a - b).at(-1)),
    resolved_at: toIso(resolved.sort((a, b) => a - b).at(-1)),
  };
}

function episodeEvidence(entries) {
  let seen = false;
  let hasResolved = false;
  return entries.map((entry) => {
    const relation = evidenceRelation(entry, { seen, hasResolved });
    seen = true;
    if (lifecycle(entry) === "resolved") hasResolved = true;
    return {
      signal_ref: recordRef(entry.signal),
      independence_group_id: entry.independenceGroupId,
      relation,
    };
  });
}

function updateKind(prior, next) {
  if (!prior) return "opened";
  if (
    prior.data.state === "resolved" &&
    next.state === "reopened"
  ) {
    return "reopened";
  }
  if (
    next.state === "resolved" &&
    prior.data.state !== "resolved"
  ) {
    return "resolved";
  }
  if (
    next.state === "mitigating" &&
    prior.data.state !== "mitigating"
  ) {
    return "mitigated";
  }
  if (
    severityRank(next.peak_impact) >
      severityRank(prior.data.peak_impact) ||
    affectedScopeRank(next.peak_impact) >
      affectedScopeRank(prior.data.peak_impact)
  ) {
    return "escalated";
  }
  const priorGroups = new Set(
    prior.data.evidence.map((entry) => entry.independence_group_id),
  );
  if (
    next.evidence.some(
      (entry) => !priorGroups.has(entry.independence_group_id),
    )
  ) {
    return "evidence_added";
  }
  if (JSON.stringify(next.evidence) !== JSON.stringify(prior.data.evidence)) {
    return "evidence_updated";
  }
  return "recomputed";
}

function trend(prior, next) {
  if (next.state === "resolved") return "resolved";
  if (next.state === "unknown") return "unknown";
  if (next.state === "reopened") return "rising";
  if (next.state === "mitigating") return "falling";
  if (!prior) return "rising";
  const change = next.current_pressure - prior.data.current_pressure;
  if (change >= MATERIAL_PRESSURE_DELTA) return "rising";
  if (change <= -MATERIAL_PRESSURE_DELTA) return "falling";
  return "stable";
}

function materialRevision(prior, next) {
  if (!prior) return true;
  const structuralFields = [
    "state",
    "scope",
    "first_observed_at",
    "last_independent_update_at",
    "current_impact",
    "peak_impact",
    "official_acknowledged_at",
    "mitigated_at",
    "resolved_at",
    "evidence",
    "policy_config_hash",
    "policy_parameters",
    "taxonomy_version",
    "deduplication_version",
    "extractor_contract",
  ];
  if (
    structuralFields.some(
      (field) =>
        JSON.stringify(prior.data[field]) !== JSON.stringify(next[field]),
    )
  ) {
    return true;
  }
  return (
    Math.abs(next.current_pressure - prior.data.current_pressure) >=
      MATERIAL_PRESSURE_DELTA ||
    next.peak_pressure > prior.data.peak_pressure
  );
}

function clusterTopicKey(cluster) {
  const anchor = cluster.entries[0];
  const informativeTokens = [...anchor.topicTokens].sort();
  const fingerprint =
    informativeTokens.length > 0
      ? informativeTokens.join(",")
      : anchor.independenceGroupId;
  return makeRecordId(
    "topic",
    [
      cluster.key,
      fingerprint,
      anchor.independenceGroupId,
    ].join(":"),
  );
}

function defaultEpisodeIdentity(cluster) {
  return makeRecordId("episode", [
    clusterTopicKey(cluster),
    new Date(cluster.firstObservedAtMs).toISOString(),
  ].join(":"));
}

function splitEpisodeIdentity(cluster) {
  const groups = [...new Set(
    cluster.entries.map((entry) => entry.independenceGroupId),
  )].sort();
  return makeRecordId("episode", [
    "split",
    clusterTopicKey(cluster),
    new Date(cluster.firstObservedAtMs).toISOString(),
    groups.join(","),
  ].join(":"));
}

function episodeIdentity(
  cluster,
  existing,
  claimedEpisodeIds,
  reservedIdentityOwners,
) {
  const groups = new Set(
    cluster.entries.map((entry) => entry.independenceGroupId),
  );
  const prior = existing
    .filter(
      (episode) =>
        !claimedEpisodeIds.has(episode.data.episode_id) &&
        (
          !reservedIdentityOwners.has(episode.data.episode_id) ||
          reservedIdentityOwners.get(episode.data.episode_id) === cluster
        ) &&
        episode.data.evidence.some((entry) =>
          groups.has(entry.independence_group_id)
        ),
    )
    .sort(
      (left, right) =>
        left.data.first_observed_at.localeCompare(
          right.data.first_observed_at,
        ) ||
        left.data.episode_id.localeCompare(right.data.episode_id),
    )[0];
  if (prior) {
    claimedEpisodeIds.add(prior.data.episode_id);
    return prior.data.episode_id;
  }
  const defaultIdentity = defaultEpisodeIdentity(cluster);
  if (!claimedEpisodeIds.has(defaultIdentity)) {
    claimedEpisodeIds.add(defaultIdentity);
    return defaultIdentity;
  }
  const splitIdentity = splitEpisodeIdentity(cluster);
  if (claimedEpisodeIds.has(splitIdentity)) {
    throw new Error(
      `Deterministic impact episode identity collision: ${splitIdentity}`,
    );
  }
  claimedEpisodeIds.add(splitIdentity);
  return splitIdentity;
}

function buildEpisodeData({
  cluster,
  episodeId,
  prior,
  asOfMs,
  policy,
  semanticContract,
  policyConfigHash,
}) {
  const entries = cluster.entries;
  const timeline = timelineEntries(entries, asOfMs);
  const category = entries[0].anchorSignal.data.claim.impact.category;
  const current = structuredClone(
    timeline.at(-1).signal.data.claim.impact,
  );
  const peak = peakImpact(timeline, category);
  const pressure = pressureAt(entries, asOfMs, policy);
  const timestamps = episodeTimestamps(timeline);
  const evidence = episodeEvidence(entries);
  const peakPressureValue = Math.max(
    prior?.data.peak_pressure ?? 0,
    historicalPeakPressure(entries, asOfMs, policy),
    pressure.pressure,
  );
  const currentSignal = timeline.at(-1).signal;
  const state = timelineState(timeline);
  const intervalEndMs =
    state === "resolved" && timestamps.resolved_at !== null
      ? Date.parse(timestamps.resolved_at) + 1
      : Math.max(asOfMs, cluster.lastObservedAtMs + 1);
  const next = {
    as_of: new Date(asOfMs).toISOString(),
    episode_id: episodeId,
    topic_key: prior?.data.topic_key ?? clusterTopicKey(cluster),
    category,
    episode_interval: {
      start: new Date(cluster.firstObservedAtMs).toISOString(),
      end: new Date(intervalEndMs).toISOString(),
      boundary: "[start,end)",
    },
    policy_version: policy.version,
    policy_config_hash: policyConfigHash,
    taxonomy_version: semanticContract.taxonomy_version,
    deduplication_version: semanticContract.deduplication_version,
    extractor_contract: structuredClone(semanticContract.extractor),
    policy_parameters: {
      cluster_gap_hours: policy.cluster_gap_hours,
      active_evidence_ttl_hours: policy.active_evidence_ttl_hours,
      freshness_half_life_hours: policy.freshness_half_life_hours,
    },
    scope: structuredClone(currentSignal.data.claim.scope),
    state,
    trend: "unknown",
    first_observed_at: new Date(
      cluster.firstObservedAtMs,
    ).toISOString(),
    last_independent_update_at: new Date(
      cluster.lastObservedAtMs,
    ).toISOString(),
    current_impact: current,
    peak_impact: peak,
    current_pressure: pressure.pressure,
    peak_pressure: clampProbability(peakPressureValue),
    pressure_components: pressure.components,
    update_kind: "opened",
    ...timestamps,
    evidence,
  };
  next.update_kind = updateKind(prior, next);
  next.trend = trend(prior, next);
  return next;
}

export async function buildImpactEpisodes(
  store,
  config,
  { asOf = new Date() } = {},
) {
  const asOfDate = new Date(asOf);
  if (Number.isNaN(asOfDate.getTime())) {
    throw new TypeError("Invalid impact episode as-of cutoff");
  }
  const semanticContract = impactEpisodeContract(config);
  const policy = semanticContract.impact_tracking;
  if (!policy.enabled) {
    return { enabled: false, built: 0, records: [] };
  }
  const episodeProducer = producer(
    "impact-episode-builder",
    IMPACT_EPISODE_PRODUCER_VERSION,
    semanticContract,
  );
  const asOfMs = asOfDate.getTime();
  const [allSignals, allObservations] = await Promise.all([
    store.all("normalized_signal", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
  ]);
  const signals = selectSignalsAsOf(
    allSignals,
    asOfMs,
    semanticContract.extractor,
  );
  const observationsByRef = observationTextByRef(
    allObservations,
    asOfMs,
  );
  const clusters = clusterEvidence(
    independentEvidence(signals, observationsByRef),
    policy.cluster_gap_hours,
  );
  const existing = await store.all("impact_episode");
  const claimedEpisodeIds = new Set();
  const reservedIdentityOwners = new Map();
  const existingEpisodeIds = new Set(
    existing.map((episode) => episode.data.episode_id),
  );
  for (const cluster of clusters) {
    const defaultIdentity = defaultEpisodeIdentity(cluster);
    if (
      existingEpisodeIds.has(defaultIdentity) &&
      !reservedIdentityOwners.has(defaultIdentity)
    ) {
      reservedIdentityOwners.set(defaultIdentity, cluster);
    }
  }
  const records = [];
  for (const cluster of clusters) {
    const episodeId = episodeIdentity(
      cluster,
      existing,
      claimedEpisodeIds,
      reservedIdentityOwners,
    );
    const naturalKey = `${policy.version}:${episodeId}`;
    const recordId = makeRecordId("imp", naturalKey);
    const prior = existing.find(
      (episode) => episode.record_id === recordId,
    );
    const data = buildEpisodeData({
      cluster,
      episodeId,
      prior,
      asOfMs,
      policy,
      semanticContract,
      policyConfigHash: episodeProducer.config_hash,
    });
    if (!materialRevision(prior, data)) continue;
    records.push(
      createRecord({
        recordType: "impact_episode",
        naturalKey,
        createdAt: asOfDate,
        revision: prior ? prior.revision + 1 : 1,
        supersedes: prior ? recordRef(prior) : null,
        producer: episodeProducer,
        data,
      }),
    );
  }
  const plannedRecordIds = records.map((record) => record.record_id);
  if (new Set(plannedRecordIds).size !== plannedRecordIds.length) {
    throw new Error("Impact episode batch contains duplicate record identities");
  }
  const results = await store.appendMany(records);
  return {
    enabled: true,
    built: results.filter((result) => result.inserted).length,
    records,
  };
}
