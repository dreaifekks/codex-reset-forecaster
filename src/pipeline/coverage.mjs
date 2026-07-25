import { toUtcIso } from "../core/time.mjs";
import { hashLabel, sha256, stableStringify } from "../core/hash.mjs";

const NEGATIVE_LABEL_ELIGIBLE = "negative_label_eligible";
const OUTCOME_ONLY = "outcome_only";

function latestAssertions(assertions) {
  const latest = new Map();
  for (const assertion of assertions) {
    if (!assertion?.assertion_id) continue;
    const previous = latest.get(assertion.assertion_id);
    if (!previous || assertion.revision > previous.revision) {
      latest.set(assertion.assertion_id, assertion);
    }
  }
  return [...latest.values()];
}

function assertionSignature(assertion) {
  return stableStringify({
    provider: assertion.provider,
    start: assertion.start,
    end: assertion.end,
    mode: assertion.mode,
    adequacy: assertion.adequacy,
    evidence_refs: assertion.evidence_refs,
    rationale: assertion.rationale,
    replay_available_at: assertion.replay_available_at ?? null,
  });
}

export async function coverageAssertionRevisions(store, providers = null) {
  let assertions = typeof store.allAudit === "function"
    ? await store.allAudit("coverage_assertion")
    : [];
  if (assertions.length === 0) {
    const state = await store.readState("coverage", { providers: {} });
    assertions = Object.entries(state.providers ?? {}).flatMap(([provider, entries]) =>
      (entries ?? []).map((entry, index) => ({
        provider,
        assertion_id: entry.assertion_id ?? `legacy:${provider}:${index}`,
        revision: entry.revision ?? 1,
        ...entry,
      }))
    );
  }
  return assertions.filter((assertion) =>
    !providers || providers.includes(assertion.provider)
  );
}

export async function coverageAssertions(store, providers = null) {
  return latestAssertions(await coverageAssertionRevisions(store, providers));
}

export async function verifyCoverageAssertionEvidence(store, assertion) {
  if (assertion?.adequacy !== NEGATIVE_LABEL_ELIGIBLE || assertion.revoked === true) {
    return { valid: true, reasons: [] };
  }
  const reasons = [];
  if (typeof store.readBlob !== "function") {
    return { valid: false, reasons: ["coverage_evidence_store_unreadable"] };
  }
  const evidence = (assertion.evidence_refs ?? []).filter((entry) =>
    entry &&
    typeof entry.ref === "string" &&
    typeof entry.sha256 === "string" &&
    typeof entry.method === "string" &&
    typeof entry.exhausted_at === "string"
  );
  if (evidence.length === 0) {
    return { valid: false, reasons: ["coverage_completeness_evidence_missing"] };
  }
  for (const entry of evidence) {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.method.length === 0 ||
      !entry.exhausted_at.endsWith("Z") ||
      !Number.isFinite(Date.parse(entry.exhausted_at)) ||
      Date.parse(entry.exhausted_at) < Date.parse(assertion.end) ||
      Date.parse(entry.exhausted_at) > Date.parse(assertion.asserted_at)
    ) {
      reasons.push("coverage_completeness_evidence_fields_invalid");
      continue;
    }
    try {
      const payload = await store.readBlob(entry.ref);
      if (hashLabel(payload) !== entry.sha256) {
        reasons.push("coverage_completeness_evidence_hash_mismatch");
      }
    } catch {
      reasons.push("coverage_completeness_evidence_unreadable");
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export async function verifiedCoverageAssertionRevisions(store, providers = null) {
  const assertions = await coverageAssertionRevisions(store, providers);
  const verified = [];
  for (const assertion of assertions) {
    const verification = await verifyCoverageAssertionEvidence(store, assertion);
    verified.push(verification.valid
      ? assertion
      : {
          ...assertion,
          revoked: true,
          evidence_verification: verification,
        });
  }
  return verified;
}

export async function verifiedCoverageAssertions(store, providers = null) {
  const assertions = await coverageAssertions(store, providers);
  const verified = [];
  for (const assertion of assertions) {
    if ((await verifyCoverageAssertionEvidence(store, assertion)).valid) {
      verified.push(assertion);
    }
  }
  return verified;
}

export function normalizeCoverageIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: toUtcIso(interval.start), end: toUtcIso(interval.end) }))
    .filter((interval) => Date.parse(interval.start) < Date.parse(interval.end))
    .sort((left, right) => left.start.localeCompare(right.start));
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || Date.parse(interval.start) > Date.parse(previous.end)) {
      merged.push({ ...interval });
    } else if (Date.parse(interval.end) > Date.parse(previous.end)) {
      previous.end = interval.end;
    }
  }
  return merged;
}

export async function addCoverageAssertion(store, {
  provider,
  start,
  end,
  mode = "explicit_complete_poll",
  adequacy = OUTCOME_ONLY,
  evidenceRefs = [],
  rationale = null,
  assertedAt = new Date(),
  replayAvailableAt = null,
  assertionId = null,
}) {
  const normalizedStart = toUtcIso(start);
  const normalizedEnd = toUtcIso(end);
  const normalizedAssertedAt = toUtcIso(assertedAt);
  const normalizedReplayAvailableAt = replayAvailableAt === null
    ? null
    : toUtcIso(replayAvailableAt);
  if (Date.parse(normalizedStart) >= Date.parse(normalizedEnd)) {
    throw new Error("Coverage assertion interval must be non-empty");
  }
  if (Date.parse(normalizedEnd) > Date.parse(normalizedAssertedAt)) {
    throw new Error("Coverage assertion end cannot be later than asserted_at");
  }
  if (![NEGATIVE_LABEL_ELIGIBLE, OUTCOME_ONLY].includes(adequacy)) {
    throw new Error(`Unsupported coverage adequacy: ${adequacy}`);
  }
  if (
    normalizedReplayAvailableAt !== null &&
    (
      adequacy !== NEGATIVE_LABEL_ELIGIBLE ||
      Date.parse(normalizedReplayAvailableAt) < Date.parse(normalizedEnd) ||
      Date.parse(normalizedReplayAvailableAt) > Date.parse(normalizedAssertedAt)
    )
  ) {
    throw new Error(
      "coverage replay_available_at requires eligible coverage and must be between interval end and asserted_at",
    );
  }
  if (adequacy === NEGATIVE_LABEL_ELIGIBLE) {
    const completenessEvidence = evidenceRefs.find((evidence) =>
      evidence &&
      typeof evidence.ref === "string" &&
      evidence.ref.length > 0 &&
      typeof evidence.sha256 === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(evidence.sha256) &&
      typeof evidence.method === "string" &&
      evidence.method.length > 0 &&
      typeof evidence.exhausted_at === "string" &&
      evidence.exhausted_at.endsWith("Z") &&
      !Number.isNaN(Date.parse(evidence.exhausted_at)) &&
      Date.parse(evidence.exhausted_at) >= Date.parse(normalizedEnd) &&
      Date.parse(evidence.exhausted_at) <= Date.parse(normalizedAssertedAt)
    );
    if (!completenessEvidence) {
      throw new Error(
        "negative_label_eligible coverage requires completeness evidence with ref, sha256, method, and exhausted_at",
      );
    }
    if (typeof store.readBlob !== "function") {
      throw new Error("negative_label_eligible coverage requires a readable immutable evidence blob");
    }
    let evidencePayload;
    try {
      evidencePayload = await store.readBlob(completenessEvidence.ref);
    } catch (error) {
      throw new Error(`negative-label completeness evidence is unreadable: ${error.message}`);
    }
    if (hashLabel(evidencePayload) !== completenessEvidence.sha256) {
      throw new Error("negative-label completeness evidence hash does not match its immutable blob");
    }
    if (normalizedReplayAvailableAt !== null) {
      const replayEvidence = evidenceRefs.find((evidence) =>
        evidence.kind === "independent_completeness_attestation" &&
        evidence.replay_available_at === normalizedReplayAvailableAt &&
        typeof evidence.method === "string" &&
        evidence.method.length > 0 &&
        typeof evidence.ref === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(evidence.sha256 ?? "")
      );
      if (!replayEvidence) {
        throw new Error(
          "coverage replay_available_at requires matching independent completeness attestation evidence",
        );
      }
      let replayPayload;
      try {
        replayPayload = await store.readBlob(replayEvidence.ref);
      } catch (error) {
        throw new Error(`coverage replay evidence is unreadable: ${error.message}`);
      }
      const attestedReplayAvailableAt =
        replayPayload.replay_available_at ??
        replayPayload.attestation?.replay_available_at ??
        null;
      if (
        hashLabel(replayPayload) !== replayEvidence.sha256 ||
        (
          attestedReplayAvailableAt !== null &&
          toUtcIso(attestedReplayAvailableAt) !== normalizedReplayAvailableAt
        ) ||
        attestedReplayAvailableAt === null
      ) {
        throw new Error(
          "coverage replay_available_at does not match its immutable attestation payload",
        );
      }
    }
  }
  const identity = assertionId ?? `cov_${sha256(stableStringify({
    provider,
    start: normalizedStart,
    end: normalizedEnd,
    mode,
  })).slice(0, 24)}`;
  const all = typeof store.allAudit === "function"
    ? await store.allAudit("coverage_assertion")
    : [];
  const previous = all
    .filter((assertion) => assertion.assertion_id === identity)
    .sort((left, right) => left.revision - right.revision)
    .at(-1) ?? null;
  if (
    previous &&
    Date.parse(normalizedAssertedAt) < Date.parse(previous.asserted_at)
  ) {
    throw new Error("Coverage assertion revisions cannot move asserted_at backwards");
  }
  const proposed = {
    assertion_id: identity,
    revision: previous ? previous.revision + 1 : 1,
    supersedes: previous
      ? { assertion_id: previous.assertion_id, revision: previous.revision }
      : null,
    provider,
    start: normalizedStart,
    end: normalizedEnd,
    mode,
    adequacy,
    evidence_refs: structuredClone(evidenceRefs),
    rationale,
    asserted_at: normalizedAssertedAt,
    replay_available_at: normalizedReplayAvailableAt,
  };
  if (previous && assertionSignature(previous) === assertionSignature(proposed)) {
    return previous;
  }
  if (typeof store.appendAudit === "function") {
    await store.appendAudit("coverage_assertion", proposed);
  }

  const state = await store.readState("coverage", { providers: {} });
  state.schema_version = "coverage-state/0.2";
  state.providers ??= {};
  const current = (state.providers[provider] ?? [])
    .filter((assertion) => assertion.assertion_id !== identity);
  state.providers[provider] = [...current, proposed]
    .sort((left, right) => left.start.localeCompare(right.start));
  await store.writeState("coverage", state);
  return proposed;
}

export async function addCoverageInterval(store, provider, start, end, options = {}) {
  await addCoverageAssertion(store, {
    provider,
    start,
    end,
    mode: options.mode ?? "explicit_complete_poll",
    adequacy: options.adequacy ?? OUTCOME_ONLY,
    evidenceRefs: options.evidence_refs ?? options.evidenceRefs ?? [],
    rationale: options.rationale ?? null,
    assertedAt: options.asserted_at ?? options.assertedAt ?? new Date(),
    replayAvailableAt:
      options.replay_available_at ?? options.replayAvailableAt ?? null,
    assertionId: options.assertion_id ?? options.assertionId ?? null,
  });
  const assertions = await coverageAssertions(store, [provider]);
  return normalizeCoverageIntervals(assertions);
}

export async function markCurrentPollCoverage(store, provider, at = new Date(), options = {}) {
  if (!options.previous_success_at) return [];
  return addCoverageInterval(store, provider, options.previous_success_at, at, options);
}

export async function adequateCoverageIntervals(store, providers = null) {
  const assertions = await verifiedCoverageAssertions(store, providers);
  return normalizeCoverageIntervals(assertions.filter((assertion) =>
    assertion.adequacy === NEGATIVE_LABEL_ELIGIBLE &&
    assertion.revoked !== true
  ));
}

export const COVERAGE_ADEQUACY = Object.freeze({
  NEGATIVE_LABEL_ELIGIBLE,
  OUTCOME_ONLY,
});
