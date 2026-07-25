import { createRecord, producer, recordRef } from "../core/records.mjs";
import { makeRecordId } from "../core/hash.mjs";
import { canonicalEventType, eventTypeFamily } from "../core/event-types.mjs";
import { selectCurrentSignals } from "./signal-selection.mjs";

const EVENT_LINK_GAP_MS = 2 * 3_600_000;
const MAX_EVENT_SPAN_MS = 6 * 3_600_000;

function scopeKey(signal) {
  const scope = signal.data.claim.scope;
  return [
    scope.vendor,
    scope.product,
    scope.population,
    [...(scope.plans ?? [])].sort().join(","),
    scope.quota_bucket ?? "all",
    eventTypeFamily(signal.data.claim.event_type),
  ].join(":");
}

function signalRange(signal) {
  const asserted = signal.data.claim.asserted_time_range;
  if (asserted) {
    return {
      start: Date.parse(asserted.start),
      end: Date.parse(asserted.end),
      source: asserted,
    };
  }
  const start = Date.parse(signal.data.available_at);
  return { start, end: start + 3_600_000, source: null };
}

function clusterSignals(signals) {
  const grouped = Map.groupBy(signals, scopeKey);
  const clusters = [];
  for (const [baseKey, group] of grouped) {
    const sorted = [...group].sort((left, right) =>
      signalRange(left).start - signalRange(right).start ||
      left.record_id.localeCompare(right.record_id)
    );
    let current = null;
    for (const signal of sorted) {
      const range = signalRange(signal);
      const belongs = current &&
        range.start <= current.end + EVENT_LINK_GAP_MS &&
        Math.max(current.end, range.end) - Math.min(current.start, range.start) <= MAX_EVENT_SPAN_MS;
      if (!belongs) {
        current = {
          baseKey,
          start: range.start,
          end: range.end,
          signals: [],
        };
        clusters.push(current);
      }
      current.signals.push(signal);
      current.start = Math.min(current.start, range.start);
      current.end = Math.max(current.end, range.end);
    }
  }
  return clusters;
}

function hypothesizedRange(cluster) {
  const ranges = cluster.signals
    .map((signal) => signal.data.claim.asserted_time_range)
    .filter(Boolean);
  if (ranges.length === 0) return null;
  const start = ranges.map((range) => range.start).sort()[0];
  const end = ranges.map((range) => range.end).sort().at(-1);
  const first = ranges.find((range) => range.start === start) ?? ranges[0];
  return {
    ...first,
    start,
    end,
    boundary: "[start,end)",
    precision: ranges.every((range) => range.precision === first.precision)
      ? first.precision
      : "unknown",
    original_text: ranges.length === 1
      ? first.original_text
      : "linked event evidence interval",
  };
}

function defaultClusterIdentity(cluster) {
  const anchor = cluster.signals[0];
  return makeRecordId("event", [
    cluster.baseKey,
    anchor.data.provenance.root_evidence_id,
    new Date(cluster.start).toISOString(),
  ].join(":"));
}

function splitClusterIdentity(cluster) {
  const roots = [...new Set(cluster.signals.map((signal) =>
    signal.data.provenance.root_evidence_id
  ))].sort();
  return makeRecordId("event", [
    "split",
    cluster.baseKey,
    new Date(cluster.start).toISOString(),
    new Date(cluster.end).toISOString(),
    roots.join(","),
  ].join(":"));
}

function clusterIdentity(
  cluster,
  existing,
  claimedExistingIds,
  reservedIdentityOwners,
) {
  const independenceGroups = new Set(
    cluster.signals.map((signal) => signal.data.provenance.independence_group_id),
  );
  const prior = existing
    .filter((candidate) => candidate.data.evidence.some((entry) =>
      independenceGroups.has(entry.independence_group_id)
    ) &&
      !claimedExistingIds.has(candidate.data.event_cluster_id) &&
      (
        !reservedIdentityOwners.has(candidate.data.event_cluster_id) ||
        reservedIdentityOwners.get(candidate.data.event_cluster_id) === cluster
      ))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
  if (prior) {
    claimedExistingIds.add(prior.data.event_cluster_id);
    return prior.data.event_cluster_id;
  }
  const defaultIdentity = defaultClusterIdentity(cluster);
  if (!claimedExistingIds.has(defaultIdentity)) {
    claimedExistingIds.add(defaultIdentity);
    return defaultIdentity;
  }
  const splitIdentity = splitClusterIdentity(cluster);
  claimedExistingIds.add(splitIdentity);
  return splitIdentity;
}

function candidateState(signals) {
  if (signals.some((signal) => signal.data.claim.phase === "completed")) return "closed";
  const supports = signals.filter((signal) => signal.data.claim.stance === "supports").length;
  const contradicts = signals.filter((signal) => signal.data.claim.stance === "contradicts").length;
  if (contradicts > supports) return "contradicted";
  if (supports > 0) return "supported";
  return "open";
}

export async function linkEventCandidates(store, config, { asOf = new Date() } = {}) {
  const signals = selectCurrentSignals(await store.all("normalized_signal")).filter((signal) =>
    ["quota_reset", "quota_refill", "capacity_restore"].includes(signal.data.claim.event_type),
  );
  const existing = await store.all("event_candidate");
  const records = [];
  const claimedExistingIds = new Set();
  const clusters = clusterSignals(signals);
  const reservedIdentityOwners = new Map();
  const existingIdentityIds = new Set(
    existing.map((candidate) => candidate.data.event_cluster_id),
  );
  for (const cluster of clusters) {
    const defaultIdentity = defaultClusterIdentity(cluster);
    if (
      existingIdentityIds.has(defaultIdentity) &&
      !reservedIdentityOwners.has(defaultIdentity)
    ) {
      reservedIdentityOwners.set(defaultIdentity, cluster);
    }
  }

  for (const cluster of clusters) {
    const key = clusterIdentity(
      cluster,
      existing,
      claimedExistingIds,
      reservedIdentityOwners,
    );
    const naturalKey = `${config.deduplication_version}:${key}`;
    const nextRecordId = makeRecordId("evt", naturalKey);
    const prior = existing.find((candidate) => candidate.record_id === nextRecordId);
    const group = cluster.signals;
    const evidence = group
      .sort((a, b) => a.data.available_at.localeCompare(b.data.available_at))
      .map((signal) => ({
        signal_ref: recordRef(signal),
        relation: signal.data.claim.stance === "contradicts" ? "contradicts" : "supports",
        provenance_relation: signal.data.provenance.derivation === "primary_statement"
          ? "independent"
          : signal.data.provenance.derivation,
        independence_group_id: signal.data.provenance.independence_group_id,
        link_confidence: 0.95,
      }));
    const evidenceSignature = JSON.stringify(evidence);
    const range = hypothesizedRange(cluster);
    const state = candidateState(group);
    if (
      prior &&
      JSON.stringify(prior.data.evidence) === evidenceSignature &&
      JSON.stringify(prior.data.hypothesized_time_range) === JSON.stringify(range) &&
      prior.data.state === state
    ) continue;
    records.push(createRecord({
      recordType: "event_candidate",
      naturalKey,
      createdAt: asOf,
      revision: prior ? prior.revision + 1 : 1,
      supersedes: prior ? recordRef(prior) : null,
      producer: producer("event-linker", "0.3.0", {
        deduplication_version: config.deduplication_version,
      }),
      data: {
        as_of: new Date(asOf).toISOString(),
        state,
        event_type: canonicalEventType(group[0].data.claim.event_type),
        scope: group[0].data.claim.scope,
        hypothesized_time_range: range,
        event_cluster_id: key,
        identity_basis: "scope+canonical_event_family+temporal_cluster+stable_evidence_root",
        evidence,
      },
    }));
  }
  const results = await store.appendMany(records);
  return { linked: results.filter((result) => result.inserted).length, records };
}
