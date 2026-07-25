import { toUtcIso } from "../core/time.mjs";
import { hashLabel, sha256, stableStringify } from "../core/hash.mjs";
import {
  historicalDailyLedgerContractHash,
  HISTORICAL_DAILY_LEDGER_ATTESTATION_VERSION,
  HISTORICAL_DAILY_LEDGER_EVIDENCE_VERSION,
  HISTORICAL_DAILY_LEDGER_METHOD,
  HISTORICAL_DAILY_LEDGER_OBSERVATION_VERSION,
} from "../core/coverage-contract.mjs";

const NEGATIVE_LABEL_ELIGIBLE = "negative_label_eligible";
const OUTCOME_ONLY = "outcome_only";
const HISTORICAL_DAILY_LEDGER_MODE = "authoritative_daily_tibo_ledger";

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

async function historicalDailyLedgerEvidenceReasons(
  store,
  assertion,
  entry,
  payload,
  config,
) {
  if (payload?.evidence_version !== HISTORICAL_DAILY_LEDGER_EVIDENCE_VERSION) {
    return assertion.mode === HISTORICAL_DAILY_LEDGER_MODE
      ? ["historical_daily_ledger_evidence_version_unsupported"]
      : [];
  }
  const reasons = [];
  const policy = payload.authority_policy;
  const interval = payload.interval;
  const ledger = payload.day_ledger;
  const items = ledger?.verified_items;
  const stability = payload.stability_observation;
  let expectedCoverageContractHash = null;
  try {
    const provider = config?.providers?.historical_monitor;
    if (
      provider &&
      provider.coverage_adequacy === NEGATIVE_LABEL_ELIGIBLE &&
      (provider.provider_name ?? "historical_monitor") === assertion.provider
    ) {
      expectedCoverageContractHash = historicalDailyLedgerContractHash({
        attestation: provider.coverage_completeness_attestation,
        outcomeDefinition: config.outcome_definition,
        providerName: assertion.provider,
        sourceUrl: provider.base_url,
        target: config.target,
        confirmationIdentityIds: (provider.confirmation_identities ?? [])
          .map((identity) => identity.identity_id)
          .filter(Boolean),
      });
    }
  } catch {
    expectedCoverageContractHash = null;
  }
  if (
    !expectedCoverageContractHash ||
    payload.coverage_contract_hash !== expectedCoverageContractHash ||
    entry.coverage_contract_hash !== expectedCoverageContractHash ||
    hashLabel(payload.outcome_definition) !==
      hashLabel(config?.outcome_definition)
  ) {
    reasons.push("historical_daily_ledger_current_contract_mismatch");
  }
  if (
    payload.provider !== assertion.provider ||
    interval?.start !== assertion.start ||
    interval?.end !== assertion.end ||
    interval?.boundary !== "[start,end)" ||
    payload.asserted_at !== assertion.asserted_at ||
    payload.exhausted_at !== entry.exhausted_at ||
    payload.replay_available_at !== assertion.replay_available_at ||
    entry.replay_available_at !== assertion.replay_available_at
  ) {
    reasons.push("historical_daily_ledger_clocks_or_scope_mismatch");
  }
  if (
    policy?.version !== HISTORICAL_DAILY_LEDGER_ATTESTATION_VERSION ||
    policy?.provider !== assertion.provider ||
    policy?.independent !== true ||
    policy?.attestor !== payload.source_url ||
    policy?.method !== HISTORICAL_DAILY_LEDGER_METHOD ||
    policy?.exhaustive_for !==
      "qualifying_completed_platform_reset_outcomes" ||
    hashLabel(policy?.target_scope) !== hashLabel(payload.target_scope) ||
    hashLabel([...(policy?.confirmation_identity_ids ?? [])].sort()) !==
      hashLabel([...(payload.confirmation_identity_ids ?? [])].sort()) ||
    hashLabel(policy) !== payload.authority_policy_hash ||
    payload.authority_policy_hash !== entry.authority_policy_hash
  ) {
    reasons.push("historical_daily_ledger_authority_policy_invalid");
  }
  if (
    !Number.isInteger(policy?.day_close_lag_hours) ||
    !Number.isInteger(policy?.minimum_stability_hours) ||
    policy.minimum_stability_hours < 1 ||
    policy.minimum_stability_hours > policy.day_close_lag_hours
  ) {
    reasons.push("historical_daily_ledger_stability_policy_invalid");
  }
  const firstObservedMs = Date.parse(stability?.first_observed_at);
  const assertedMs = Date.parse(assertion.asserted_at);
  const intervalEndMs = Date.parse(assertion.end);
  const stableForHours =
    (assertedMs - firstObservedMs) / 3_600_000;
  if (
    !stability ||
    !Number.isFinite(firstObservedMs) ||
    typeof stability.ref !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(stability.sha256 ?? "") ||
    !Number.isFinite(stability.stable_for_hours) ||
    Math.abs(stability.stable_for_hours - stableForHours) > 1e-9 ||
    stableForHours < policy?.minimum_stability_hours ||
    firstObservedMs <
      intervalEndMs +
        (policy?.day_close_lag_hours -
          policy?.minimum_stability_hours) *
          3_600_000 ||
    assertedMs <
      intervalEndMs + policy?.day_close_lag_hours * 3_600_000
  ) {
    reasons.push("historical_daily_ledger_stability_evidence_invalid");
  } else {
    try {
      const firstObservation = await store.readBlob(stability.ref);
      if (
        hashLabel(firstObservation) !== stability.sha256 ||
        firstObservation.observation_version !==
          HISTORICAL_DAILY_LEDGER_OBSERVATION_VERSION ||
        firstObservation.provider !== assertion.provider ||
        firstObservation.source_url !== payload.source_url ||
        firstObservation.observed_at !== stability.first_observed_at ||
        firstObservation.coverage_contract_hash !==
          expectedCoverageContractHash ||
        firstObservation.authority_policy_hash !==
          payload.authority_policy_hash ||
        firstObservation.day_ledger_hash !== payload.day_ledger_hash ||
        hashLabel(firstObservation.day_ledger) !==
          payload.day_ledger_hash
      ) {
        reasons.push("historical_daily_ledger_first_observation_invalid");
      } else {
        try {
          const firstSnapshot = await store.readBlob(
            firstObservation.archive_snapshot_ref,
          );
          const firstGridEntry = firstSnapshot.coverage_grid?.find((row) =>
            row.date === ledger?.date
          );
          if (
            firstSnapshot.source_url !== payload.source_url ||
            firstSnapshot.fetched_at !== firstObservation.observed_at ||
            firstSnapshot.html_sha256 !==
              firstObservation.archive_html_sha256 ||
            firstSnapshot.coverage_grid_sha256 !==
              firstObservation.archive_coverage_grid_sha256 ||
            hashLabel(firstSnapshot.html) !==
              firstObservation.archive_html_sha256 ||
            hashLabel(firstSnapshot.coverage_grid) !==
              firstObservation.archive_coverage_grid_sha256 ||
            firstGridEntry?.count !== ledger?.expected_count
          ) {
            reasons.push(
              "historical_daily_ledger_first_archive_snapshot_mismatch",
            );
          }
        } catch {
          reasons.push(
            "historical_daily_ledger_first_archive_snapshot_unreadable",
          );
        }
      }
    } catch {
      reasons.push("historical_daily_ledger_first_observation_unreadable");
    }
  }
  if (
    !ledger ||
    ledger.date !== assertion.start.slice(0, 10) ||
    !Number.isInteger(ledger.expected_count) ||
    !Array.isArray(items) ||
    ledger.expected_count !== items.length ||
    hashLabel(ledger) !== payload.day_ledger_hash ||
    payload.day_ledger_hash !== entry.day_ledger_hash
  ) {
    reasons.push("historical_daily_ledger_manifest_invalid");
  } else {
    const itemIds = items.map((item) => item.provider_item_id);
    if (
      new Set(itemIds).size !== itemIds.length ||
      items.some((item) =>
        typeof item.provider_item_id !== "string" ||
        typeof item.canonical_url !== "string" ||
        typeof item.published_at !== "string" ||
        Date.parse(item.published_at) < Date.parse(assertion.start) ||
        Date.parse(item.published_at) >= Date.parse(assertion.end) ||
        !/^sha256:[a-f0-9]{64}$/.test(item.content_hash ?? "") ||
        !["x_oembed+snowflake", "archive_text+snowflake"].includes(
          item.verification,
        )
      )
    ) {
      reasons.push("historical_daily_ledger_items_invalid");
    }
  }
  if (
    typeof payload.archive_snapshot_ref !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(payload.archive_html_sha256 ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(
      payload.archive_coverage_grid_sha256 ?? "",
    )
  ) {
    reasons.push("historical_daily_ledger_archive_reference_invalid");
  } else {
    try {
      const snapshot = await store.readBlob(payload.archive_snapshot_ref);
      const gridEntry = snapshot.coverage_grid?.find((row) =>
        row.date === ledger?.date
      );
      if (
        snapshot.source_url !== payload.source_url ||
        snapshot.fetched_at !== payload.asserted_at ||
        snapshot.html_sha256 !== payload.archive_html_sha256 ||
        snapshot.coverage_grid_sha256 !==
          payload.archive_coverage_grid_sha256 ||
        hashLabel(snapshot.html) !== payload.archive_html_sha256 ||
        hashLabel(snapshot.coverage_grid) !==
          payload.archive_coverage_grid_sha256 ||
        gridEntry?.count !== ledger?.expected_count
      ) {
        reasons.push("historical_daily_ledger_archive_snapshot_mismatch");
      }
    } catch {
      reasons.push("historical_daily_ledger_archive_snapshot_unreadable");
    }
  }
  return reasons;
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

export async function verifyCoverageAssertionEvidence(
  store,
  assertion,
  { config = null } = {},
) {
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
      } else {
        reasons.push(
          ...await historicalDailyLedgerEvidenceReasons(
            store,
            assertion,
            entry,
            payload,
            config,
          ),
        );
      }
    } catch {
      reasons.push("coverage_completeness_evidence_unreadable");
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export async function verifiedCoverageAssertionRevisions(
  store,
  providers = null,
  options = {},
) {
  const assertions = await coverageAssertionRevisions(store, providers);
  const verified = [];
  for (const assertion of assertions) {
    const verification = await verifyCoverageAssertionEvidence(
      store,
      assertion,
      options,
    );
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

export async function verifiedCoverageAssertions(
  store,
  providers = null,
  options = {},
) {
  const assertions = await coverageAssertions(store, providers);
  const verified = [];
  for (const assertion of assertions) {
    if ((await verifyCoverageAssertionEvidence(store, assertion, options)).valid) {
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

export async function adequateCoverageIntervals(
  store,
  providers = null,
  options = {},
) {
  const assertions = await verifiedCoverageAssertions(store, providers, options);
  return normalizeCoverageIntervals(assertions.filter((assertion) =>
    assertion.adequacy === NEGATIVE_LABEL_ELIGIBLE &&
    assertion.revoked !== true
  ));
}

export const COVERAGE_ADEQUACY = Object.freeze({
  NEGATIVE_LABEL_ELIGIBLE,
  OUTCOME_ONLY,
});
