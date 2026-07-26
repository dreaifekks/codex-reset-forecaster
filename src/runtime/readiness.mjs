import {
  adequateCoverageIntervals,
  coverageAssertions,
  normalizeCoverageIntervals,
  verifiedCoverageAssertionRevisions,
} from "../pipeline/coverage.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import { hashLabel } from "../core/hash.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { FEATURE_NAMES } from "../model/features.mjs";
import { assertModelCompatibility } from "../model/logistic-hazard.mjs";
import { assessPredictionIntegrity } from "../model/prediction-integrity.mjs";
import {
  assessEvaluationSampleGate,
  normalizeEvaluationWaiting,
  verifyEvaluationArtifact,
} from "../model/evaluation.mjs";
import {
  verifyIssuedEvaluationArtifact,
} from "../model/issued-evaluation.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  modelContractHash,
} from "../model/contract.mjs";
import {
  aggregateCoverageWaiting,
  normalizeCoverageWaitingSummary,
  normalizeProviderCoverageWaiting,
} from "../core/coverage-waiting.mjs";

const HOUR_MS = 3_600_000;
const EXPECTED_FORECAST_HOURS = 168;
const SUPPORTED_EVALUATION_CONTRACTS = new Set([
  "reset-evaluation/0.3.0",
  "reset-issued-evaluation/0.3.0",
]);

function coverageHours(intervals) {
  return intervals.reduce((sum, interval) =>
    sum + (Date.parse(interval.end) - Date.parse(interval.start)) / HOUR_MS, 0);
}

function finiteTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluationVersionSupported(value) {
  return SUPPORTED_EVALUATION_CONTRACTS.has(String(value ?? ""));
}

function normalizedAssertionRefs(assertions) {
  return assertions
    .filter((assertion) =>
      assertion.adequacy === "negative_label_eligible" &&
      assertion.revoked !== true,
    )
    .map((assertion) => ({
      assertion_id: assertion.assertion_id,
      revision: assertion.revision,
    }))
    .sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) || left.revision - right.revision,
    );
}

function normalizedModelVersions(evaluation, predictionRevisions = []) {
  if (evaluation?.mode === "walk_forward") {
    return [...new Set(
      (evaluation.folds ?? []).map((fold) => fold.model_version).filter(Boolean),
    )].sort();
  }
  if (evaluation?.mode === "as_issued") {
    const predictionsByRef = new Map(
      predictionRevisions.map((record) => [exactRevisionKey(record), record]),
    );
    return [...new Set(
      (evaluation.provenance?.prediction_snapshot_refs ?? [])
        .map((ref) => predictionsByRef.get(exactRevisionKey(ref))?.data?.model?.version)
        .filter(Boolean),
    )].sort();
  }
  return [...new Set(
    (evaluation?.events ?? []).map((event) => event.model_version).filter(Boolean),
  )].sort();
}

function exactRevisionKey(record) {
  return `${record.record_id}@${record.revision}`;
}

function latestRevisions(records, identity = (record) => record.record_id) {
  const latest = new Map();
  for (const record of records) {
    const key = identity(record);
    const previous = latest.get(key);
    if (!previous || Number(record.revision) > Number(previous.revision)) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
}

function normalizedSnapshotEntries(entries) {
  return [...(entries ?? [])]
    .map((entry) => ({
      record_id: entry.record_id,
      revision: entry.revision,
      data_hash: entry.data_hash,
    }))
    .sort((left, right) =>
      String(left.record_id).localeCompare(String(right.record_id)) ||
      Number(left.revision) - Number(right.revision),
    );
}

function assessRecordSnapshot({
  entries,
  expectedHash,
  records,
  name,
  requireSnapshot = true,
}) {
  const reasons = [];
  if (!Array.isArray(entries)) {
    if (requireSnapshot) reasons.push(`${name}_snapshot_missing`);
    return reasons;
  }
  const normalized = normalizedSnapshotEntries(entries);
  if (expectedHash !== hashLabel(normalized)) {
    reasons.push(`${name}_snapshot_hash_mismatch`);
  }
  const latestById = new Map(
    latestRevisions(records).map((record) => [record.record_id, record]),
  );
  const exactByRef = new Map(records.map((record) => [exactRevisionKey(record), record]));
  for (const entry of normalized) {
    const exact = exactByRef.get(exactRevisionKey(entry));
    if (!exact || hashLabel(exact.data) !== entry.data_hash) {
      reasons.push(`${name}_revision_mismatch`);
      continue;
    }
    if (Number(latestById.get(entry.record_id)?.revision) > Number(entry.revision)) {
      reasons.push(`${name}_revision_superseded`);
    }
  }
  return [...new Set(reasons)];
}

export function assessEvaluationCompatibility(
  evaluation,
  config,
  assertions = [],
  {
    champion = null,
    outcomeRevisions = [],
    predictionRevisions = [],
    settlementRevisions = [],
    evaluationArtifactVerification = null,
  } = {},
) {
  if (!evaluation) {
    return { compatible: false, invalidated: true, reasons: ["evaluation_missing"] };
  }
  const provenance = evaluation.provenance ?? {};
  const reasons = [];
  if (!evaluationVersionSupported(evaluation.evaluation_version)) {
    reasons.push("evaluation_version_unsupported");
  }
  if (
    typeof evaluation.evaluation_artifact_hash !== "string" ||
    evaluationArtifactHash(evaluation) !== evaluation.evaluation_artifact_hash
  ) {
    reasons.push("evaluation_artifact_hash_mismatch");
  }
  if (evaluationArtifactVerification?.valid !== true) {
    reasons.push(
      evaluationArtifactVerification?.reason ??
        "evaluation_row_sample_unverified",
    );
  }
  for (const [field, expected] of [
    ["feature_schema_version", config.feature_schema_version],
    ["deduplication_version", config.deduplication_version],
    ["taxonomy_version", config.taxonomy_version],
    ["model_contract_hash", modelContractHash(config)],
    ["evaluation_contract_hash", evaluationContractHash(config)],
    ["extractor_model", config.extractor.model],
    ["extractor_model_version", config.extractor.model_version],
    ["extractor_prompt_version", config.extractor.prompt_version],
  ]) {
    if (!provenance[field] || provenance[field] !== expected) {
      reasons.push(`${field}_mismatch`);
    }
  }
  if (typeof provenance.config_hash !== "string" || provenance.config_hash.length === 0) {
    reasons.push("config_hash_missing");
  }
  const actualCoverageRefs = [...(provenance.coverage_assertion_refs ?? [])]
    .map((ref) => ({ assertion_id: ref.assertion_id, revision: ref.revision }))
    .sort((left, right) =>
      String(left.assertion_id).localeCompare(String(right.assertion_id)) ||
      Number(left.revision) - Number(right.revision),
    );
  const latestAssertionById = new Map(
    latestRevisions(assertions, (assertion) => assertion.assertion_id)
      .map((assertion) => [assertion.assertion_id, assertion]),
  );
  const assertionByRef = new Map(assertions.map((assertion) => [
    `${assertion.assertion_id}@${assertion.revision}`,
    assertion,
  ]));
  const referencedAssertions = [];
  if (actualCoverageRefs.length === 0) {
    reasons.push("coverage_assertions_missing");
  }
  for (const ref of actualCoverageRefs) {
    const exact = assertionByRef.get(`${ref.assertion_id}@${ref.revision}`);
    if (!exact) {
      reasons.push("coverage_assertion_revision_missing");
      continue;
    }
    referencedAssertions.push(exact);
    if (
      exact.adequacy !== "negative_label_eligible" ||
      exact.revoked === true
    ) {
      reasons.push("coverage_assertion_not_eligible");
    }
    if (Number(latestAssertionById.get(ref.assertion_id)?.revision) > Number(ref.revision)) {
      reasons.push("coverage_assertion_revision_superseded");
    }
  }
  referencedAssertions.sort((left, right) =>
    left.assertion_id.localeCompare(right.assertion_id) || left.revision - right.revision,
  );
  if (
    provenance.coverage_assertion_snapshot_hash !== hashLabel(referencedAssertions)
  ) {
    reasons.push("coverage_assertion_snapshot_hash_mismatch");
  }
  if (provenance.fold_signature !== hashLabel(evaluation.folds ?? [])) {
    reasons.push("fold_signature_mismatch");
  }
  if (
    JSON.stringify([...(provenance.model_versions ?? [])].sort()) !==
    JSON.stringify(normalizedModelVersions(evaluation, predictionRevisions))
  ) {
    reasons.push("model_versions_mismatch");
  }
  if (evaluation.mode === "walk_forward") {
    if (!evaluation.candidate?.model_version) {
      reasons.push("candidate_model_version_missing");
    } else if (
      champion?.model_version &&
      evaluation.candidate.model_version !== champion.model_version
    ) {
      reasons.push("champion_model_version_mismatch");
    }
  }
  reasons.push(...assessRecordSnapshot({
    entries: provenance.outcome_snapshot_refs,
    expectedHash: provenance.outcome_snapshot_hash,
    records: outcomeRevisions,
    name: "outcome",
  }));
  if (evaluation.mode === "as_issued") {
    reasons.push(...assessRecordSnapshot({
      entries: provenance.prediction_snapshot_refs,
      expectedHash: provenance.prediction_snapshot_hash,
      records: predictionRevisions,
      name: "prediction",
    }));
    reasons.push(...assessRecordSnapshot({
      entries: provenance.settlement_snapshot_refs,
      expectedHash: provenance.settlement_snapshot_hash,
      records: settlementRevisions,
      name: "settlement",
    }));
    if (
      typeof provenance.row_sample_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(provenance.row_sample_hash)
    ) {
      reasons.push("row_sample_hash_missing");
    }
  }
  return {
    compatible: reasons.length === 0,
    invalidated: reasons.length > 0,
    reasons: [...new Set(reasons)],
    evaluation_version: evaluation.evaluation_version ?? null,
    referenced_coverage_assertion_refs: actualCoverageRefs,
  };
}

function stateKey(name) {
  return `${name.replaceAll("_", "-")}-provider`;
}

function canonicalProviderId(name, provider, state) {
  if (typeof state.provider === "string" && state.provider) return state.provider;
  if (typeof provider.provider_name === "string" && provider.provider_name) {
    return provider.provider_name;
  }
  if (name === "x_search_gateway") {
    const upstream = state.upstream_provider ?? provider.upstream_provider ?? "unknown";
    return `x_search_gateway_${upstream}`;
  }
  return name;
}

function providerRoles(name, provider, state, outcomeProviders) {
  const roles = new Set();
  const upstream = state.upstream_provider ?? provider.upstream_provider ?? null;
  const providerId = canonicalProviderId(name, provider, state);
  const isSummaryGateway = name === "x_search_gateway" && upstream === "hermes";
  if (outcomeProviders.has(providerId)) roles.add("required_outcome");
  if (
    outcomeProviders.has(providerId) ||
    name === "x" ||
    name.includes("historical") ||
    (name === "x_search_gateway" && upstream && !isSummaryGateway)
  ) roles.add("exact");
  if (
    name === "x_search_gateway" ||
    (provider.context_identities?.length ?? 0) > 0 ||
    (provider.context_queries?.length ?? 0) > 0 ||
    (provider.queries?.length ?? 0) > 0
  ) roles.add("context");
  return [...roles];
}

function providerMaximumAgeHours(name, provider) {
  if (Number.isFinite(provider.freshness_max_age_hours)) {
    return Number(provider.freshness_max_age_hours);
  }
  if (name.includes("historical")) {
    return Math.max(2, Number(provider.refresh_interval_hours ?? 24) * 1.25);
  }
  return 2.5;
}

function providerFreshness(name, provider, state, now, outcomeProviders) {
  const enabled = Boolean(provider.enabled);
  const roles = providerRoles(name, provider, state, outcomeProviders);
  const lastSuccess = state.last_success_at ?? null;
  const lastFailure = state.last_failure_at ?? state.last_partial_at ?? null;
  const successMs = finiteTimestamp(lastSuccess);
  const failureMs = finiteTimestamp(lastFailure);
  const nowMs = now.getTime();
  const ageHours = successMs === null ? null : Math.max(0, (nowMs - successMs) / HOUR_MS);
  const maximumAgeHours = providerMaximumAgeHours(name, provider);
  const failureIsCurrent = Boolean(
    state.last_error &&
    (failureMs === null || successMs === null || failureMs >= successMs),
  );
  let status = "disabled";
  if (enabled) {
    if (failureIsCurrent) status = "error";
    else if (successMs === null) status = "unknown";
    else if (ageHours > maximumAgeHours) status = "stale";
    else status = "fresh";
  }
  const result = {
    provider_id: canonicalProviderId(name, provider, state),
    enabled,
    roles,
    upstream_provider: state.upstream_provider ?? provider.upstream_provider ?? null,
    status,
    effective_stale: enabled && status !== "fresh",
    age_hours: ageHours,
    maximum_age_hours: maximumAgeHours,
    last_success_at: lastSuccess,
    last_failure_at: lastFailure,
    last_error: state.last_error ?? null,
    coverage_waiting: enabled
      ? normalizeProviderCoverageWaiting(state.coverage_waiting)
      : null,
  };
  if (
    roles.includes("context") &&
    (
      state.context_status ||
      state.last_context_success_at ||
      state.last_context_failure_at ||
      state.last_context_error
    )
  ) {
    const contextLastSuccess = state.last_context_success_at ?? null;
    const contextSuccessMs = finiteTimestamp(contextLastSuccess);
    const contextAgeHours = contextSuccessMs === null
      ? null
      : Math.max(0, (nowMs - contextSuccessMs) / HOUR_MS);
    let contextStatus = enabled ? state.context_status ?? "unknown" : "disabled";
    if (
      enabled &&
      contextStatus === "fresh" &&
      (contextSuccessMs === null || contextAgeHours > maximumAgeHours)
    ) {
      contextStatus = contextSuccessMs === null ? "unknown" : "stale";
    }
    result.role_freshness = {
      context: {
        status: contextStatus,
        effective_stale: enabled && contextStatus !== "fresh",
        age_hours: contextAgeHours,
        last_success_at: contextLastSuccess,
        last_failure_at: state.last_context_failure_at ?? null,
        last_error: state.last_context_error ?? null,
      },
    };
  }
  return result;
}

function freshnessGroup(role, providerStates, requiredNames = []) {
  const matching = Object.entries(providerStates)
    .filter(([, provider]) => provider.roles.includes(role))
    .map(([name, provider]) => ({
      name,
      ...provider,
      ...(provider.role_freshness?.[role] ?? {}),
    }));
  const required = new Set(requiredNames);
  for (const name of required) {
    if (!matching.some((provider) => provider.provider_id === name)) {
      matching.push({
        name,
        provider_id: name,
        enabled: false,
        roles: [role],
        status: "unavailable",
        effective_stale: true,
        age_hours: null,
        maximum_age_hours: null,
        last_success_at: null,
        last_failure_at: null,
        last_error: "provider_not_configured",
      });
    }
  }
  const enabled = matching.filter((provider) => provider.enabled);
  const statuses = enabled.map((provider) => provider.status);
  let status = "disabled";
  if (
    required.size > 0 &&
    matching.some((provider) => required.has(provider.provider_id) && !provider.enabled)
  ) {
    status = "unavailable";
  } else if (enabled.length > 0 && statuses.every((value) => value === "fresh")) {
    status = "fresh";
  } else if (statuses.includes("fresh") || statuses.includes("degraded")) {
    status = "degraded";
  } else if (statuses.includes("error")) {
    status = "error";
  } else if (statuses.includes("stale")) {
    status = "stale";
  } else if (statuses.includes("unknown")) {
    status = "unknown";
  }
  return {
    status,
    effective_stale: status !== "fresh",
    providers: matching.map((provider) => provider.name),
    last_success_at: matching
      .map((provider) => provider.last_success_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null,
    last_error: matching
      .filter((provider) => provider.last_error)
      .sort((left, right) =>
        String(left.last_failure_at ?? "").localeCompare(String(right.last_failure_at ?? "")),
      )
      .at(-1)?.last_error ?? null,
  };
}

export function assessPredictionFreshness(prediction, config, now = new Date()) {
  const freshAgeHours = Number(config.runtime?.forecast_fresh_age_hours ?? 1.5);
  const staleAgeHours = Math.max(
    freshAgeHours,
    Number(config.runtime?.forecast_stale_age_hours ?? 3),
  );
  if (!prediction?.data) {
    return {
      status: "missing",
      effective_stale: true,
      reason_codes: ["forecast_missing"],
      age_hours: null,
      knowledge_lag_hours: null,
      remaining_horizon_hours: null,
      slot_count: 0,
      expected_slot_count: EXPECTED_FORECAST_HOURS,
      full_rolling_horizon: false,
      fresh_age_hours: freshAgeHours,
      stale_age_hours: staleAgeHours,
    };
  }
  const issuedMs = finiteTimestamp(prediction.data.issued_at);
  const cutoffMs = finiteTimestamp(prediction.data.knowledge_cutoff);
  const horizonStartMs = finiteTimestamp(prediction.data.horizon?.start);
  const horizonEndMs = finiteTimestamp(prediction.data.horizon?.end);
  const slots = Array.isArray(prediction.data.slots) ? prediction.data.slots : [];
  const nowMs = now.getTime();
  const ageHours = issuedMs === null ? null : (nowMs - issuedMs) / HOUR_MS;
  const knowledgeLagHours = cutoffMs === null ? null : (nowMs - cutoffMs) / HOUR_MS;
  const remainingHorizonHours = horizonEndMs === null ? null : (horizonEndMs - nowMs) / HOUR_MS;
  const contiguousSlots = slots.every((slot, index) => {
    const start = finiteTimestamp(slot.start);
    const end = finiteTimestamp(slot.end);
    if (start === null || end === null || end - start !== HOUR_MS) return false;
    if (index === 0) return horizonStartMs === null || start === horizonStartMs;
    return start === finiteTimestamp(slots[index - 1].end);
  });
  const declaredHours = horizonStartMs === null || horizonEndMs === null
    ? null
    : (horizonEndMs - horizonStartMs) / HOUR_MS;
  const fullRollingHorizon = slots.length === EXPECTED_FORECAST_HOURS &&
    declaredHours === EXPECTED_FORECAST_HOURS &&
    contiguousSlots &&
    finiteTimestamp(slots.at(-1)?.end) === horizonEndMs;
  const reasons = [];
  if (
    issuedMs === null ||
    cutoffMs === null ||
    horizonStartMs === null ||
    horizonEndMs === null ||
    !fullRollingHorizon
  ) reasons.push("invalid_horizon");
  if (issuedMs !== null && issuedMs - nowMs > 5 * 60_000) reasons.push("issued_in_future");
  if (cutoffMs !== null && cutoffMs - nowMs > 5 * 60_000) reasons.push("cutoff_in_future");
  if (remainingHorizonHours !== null && remainingHorizonHours <= 0) reasons.push("horizon_expired");
  if (ageHours !== null && ageHours > staleAgeHours) reasons.push("forecast_too_old");
  let status = "fresh";
  if (reasons.length > 0) status = reasons.includes("invalid_horizon") ? "invalid" : "stale";
  else if (
    ageHours === null ||
    ageHours > freshAgeHours ||
    knowledgeLagHours === null ||
    knowledgeLagHours > freshAgeHours + 0.5 ||
    remainingHorizonHours < EXPECTED_FORECAST_HOURS - staleAgeHours
  ) {
    status = "degraded";
    if (ageHours > freshAgeHours) reasons.push("forecast_aging");
    if (knowledgeLagHours > freshAgeHours + 0.5) reasons.push("knowledge_cutoff_lagging");
    if (remainingHorizonHours < EXPECTED_FORECAST_HOURS - staleAgeHours) {
      reasons.push("rolling_horizon_shortened");
    }
  }
  return {
    status,
    effective_stale: status !== "fresh",
    reason_codes: reasons,
    age_hours: ageHours,
    knowledge_lag_hours: knowledgeLagHours,
    remaining_horizon_hours: remainingHorizonHours,
    slot_count: slots.length,
    expected_slot_count: EXPECTED_FORECAST_HOURS,
    full_rolling_horizon: fullRollingHorizon,
    horizon_start: prediction.data.horizon?.start ?? null,
    horizon_end: prediction.data.horizon?.end ?? null,
    fresh_age_hours: freshAgeHours,
    stale_age_hours: staleAgeHours,
  };
}

export async function getProviderFreshness(store, config, now = new Date()) {
  const outcomeProviders = new Set(config.model?.outcome_coverage_providers ?? []);
  const providerEntries = Object.entries(config.providers ?? {})
    .filter(([, provider]) => provider && typeof provider === "object" && !Array.isArray(provider));
  const states = await Promise.all(providerEntries.map(async ([name, provider]) => [
    name,
    providerFreshness(
      name,
      provider,
      await store.readState(stateKey(name), {}),
      now,
      outcomeProviders,
    ),
  ]));
  const providers = Object.fromEntries(states);
  return {
    providers,
    groups: {
      required_outcome: freshnessGroup(
        "required_outcome",
        providers,
        [...outcomeProviders],
      ),
      exact: freshnessGroup("exact", providers),
      context: freshnessGroup("context", providers),
    },
  };
}

function predictionMatchesModel(prediction, model) {
  const predictionModel = prediction?.data?.model;
  return Boolean(
    predictionModel &&
    model &&
    predictionModel.version === model.model_version &&
    predictionModel.artifact_hash === model.artifact_hash &&
    predictionModel.model_contract_hash === model.model_contract_hash &&
    predictionModel.training_cutoff === model.training_cutoff
  );
}

function provisionalIneligibilityReason({
  enabled,
  championCompatible,
  prediction,
  validationStatus,
  challenger,
  challengerCompatible,
  predictionMatchesChallenger,
  minimumOutcomesMet,
}) {
  if (!enabled) return "provisional_bootstrap_disabled";
  if (championCompatible) return "compatible_champion_available";
  if (!prediction) return "forecast_missing";
  if (validationStatus === null) return "prediction_validation_status_missing";
  if (validationStatus !== "provisional") {
    return "prediction_not_marked_provisional";
  }
  if (!challenger) return "challenger_missing";
  if (!challengerCompatible) return "challenger_incompatible";
  if (!minimumOutcomesMet) return "challenger_outcome_sample_insufficient";
  if (!predictionMatchesChallenger) return "forecast_challenger_mismatch";
  return null;
}

export async function getReadiness(store, config, { now = new Date() } = {}) {
  const championRead = store.readModel("champion")
    .then((model) => ({ model, error: null }))
    .catch((error) => ({ model: null, error }));
  const challengerRead = store.readModel("challenger")
    .then((model) => ({ model, error: null }))
    .catch((error) => ({ model: null, error }));
  const [
    observationRevisions,
    signals,
    outcomes,
    predictions,
    featureSnapshots,
    settlements,
    coverage,
    championResult,
    challengerResult,
    latestWalkForward,
    championEvaluation,
    issued,
    runtime,
    providerFreshnessSummary,
    assertions,
    assertionRevisions,
  ] = await Promise.all([
    store.all("raw_observation", { latestOnly: false }),
    store.all("normalized_signal"),
    store.all("reset_outcome", { latestOnly: false }),
    store.all("prediction", { latestOnly: false }),
    store.all("feature_snapshot", { latestOnly: false }),
    store.all("prediction_settlement", { latestOnly: false }),
    adequateCoverageIntervals(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
    championRead,
    challengerRead,
    store.readState("walk-forward-summary", null),
    store.readState("champion-evaluation", null),
    store.readState("issued-evaluation-summary", null),
    store.readState("runtime", {}),
    getProviderFreshness(store, config, now),
    coverageAssertions(store, config.model.outcome_coverage_providers),
    verifiedCoverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
  ]);
  const champion = championResult.model;
  const challenger = challengerResult.model;
  const currentOutcomes = latestRevisions(outcomes);
  const currentPredictions = latestRevisions(predictions);
  const currentSettlements = latestRevisions(settlements);
  const verifiedAssertions = latestRevisions(
    assertionRevisions,
    (assertion) => assertion.assertion_id,
  );
  const observations = [...Map.groupBy(
    observationRevisions,
    (record) => record.record_id,
  ).values()].map((revisions) =>
    [...revisions].sort((left, right) => left.revision - right.revision).at(-1)
  );
  const outcomeEligibility = buildOutcomeEligibilityContext({
    observations: observationRevisions,
    signals,
    config,
  });
  const eligibleOutcomes = currentOutcomes.filter((outcome) =>
    isEligibleConfirmedOutcome(outcome, {
      ...outcomeEligibility,
      confirmationIdentityIds: confirmationIdentityIds(config),
    })
  );
  let championCompatibility = championResult.error
    ? {
        compatible: false,
        reason: `champion_artifact_invalid: ${championResult.error.message}`,
      }
    : { compatible: false, reason: "champion_missing" };
  if (champion) {
    try {
      assertModelCompatibility(champion, {
        featureNames: FEATURE_NAMES,
        featureSchemaVersion: config.feature_schema_version,
        modelContractHash: modelContractHash(config),
        requireConverged: true,
      });
      championCompatibility = { compatible: true, reason: null };
    } catch (error) {
      championCompatibility = { compatible: false, reason: error.message };
    }
  }
  let challengerCompatibility = challengerResult.error
    ? {
        compatible: false,
        reason:
          `challenger_artifact_invalid: ${challengerResult.error.message}`,
      }
    : { compatible: false, reason: "challenger_missing" };
  if (challenger) {
    try {
      assertModelCompatibility(challenger, {
        featureNames: FEATURE_NAMES,
        featureSchemaVersion: config.feature_schema_version,
        modelContractHash: modelContractHash(config),
        requireConverged: true,
      });
      challengerCompatibility = { compatible: true, reason: null };
    } catch (error) {
      challengerCompatibility = {
        compatible: false,
        reason: error.message,
      };
    }
  }
  let championArtifact = null;
  if (
    champion?.artifact_hash &&
    typeof store.readModelArtifact === "function"
  ) {
    try {
      championArtifact = await store.readModelArtifact(champion.artifact_hash);
      if (!championArtifact) {
        championCompatibility = {
          compatible: false,
          reason: "immutable_champion_artifact_missing",
        };
      } else {
        assertModelCompatibility(championArtifact, {
          featureNames: FEATURE_NAMES,
          featureSchemaVersion: config.feature_schema_version,
          modelContractHash: modelContractHash(config),
          requireConverged: true,
        });
      }
    } catch (error) {
      championCompatibility = {
        compatible: false,
        reason: `immutable_champion_artifact_invalid: ${error.message}`,
      };
    }
  }
  const providerCounts = Object.fromEntries([...Map.groupBy(
    observations,
    (record) => record.data.ingest_provider,
  ).entries()].map(([provider, records]) => [provider, records.length]));
  const evaluationOptions = {
    champion,
    outcomeRevisions: outcomes,
    predictionRevisions: predictions,
    settlementRevisions: settlements,
  };
  const [
    championEvaluationArtifactVerification,
    latestWalkForwardArtifactVerification,
    issuedEvaluationArtifactVerification,
  ] = await Promise.all([
    championEvaluation
      ? verifyEvaluationArtifact(store, championEvaluation)
      : Promise.resolve({ valid: false, reason: "evaluation_missing" }),
    latestWalkForward
      ? verifyEvaluationArtifact(store, latestWalkForward)
      : Promise.resolve({ valid: false, reason: "evaluation_missing" }),
    issued
      ? verifyIssuedEvaluationArtifact(store, issued)
      : Promise.resolve({ valid: false, reason: "evaluation_missing" }),
  ]);
  const championEvaluationCompatibility = assessEvaluationCompatibility(
    championEvaluation,
    config,
    assertionRevisions,
    {
      ...evaluationOptions,
      evaluationArtifactVerification:
        championEvaluationArtifactVerification,
    },
  );
  const latestWalkForwardCompatibility = assessEvaluationCompatibility(
    latestWalkForward,
    config,
    assertionRevisions,
    {
      ...evaluationOptions,
      evaluationArtifactVerification:
        latestWalkForwardArtifactVerification,
    },
  );
  const walkForward = championEvaluationCompatibility.compatible
    ? championEvaluation
    : latestWalkForward;
  const walkForwardCompatibility = championEvaluationCompatibility.compatible
    ? championEvaluationCompatibility
    : latestWalkForwardCompatibility;
  const issuedCompatibility = assessEvaluationCompatibility(
    issued,
    config,
    assertionRevisions,
    {
      ...evaluationOptions,
      evaluationArtifactVerification:
        issuedEvaluationArtifactVerification,
    },
  );
  const liveSampleGate = assessEvaluationSampleGate(
    issued?.metrics,
    config.model,
  );
  const liveSampleThresholdReached = liveSampleGate.sample_threshold_passed;
  const liveThresholdReached = liveSampleThresholdReached && issuedCompatibility.compatible;
  const syntheticProviders = new Set(["demo", "fixture"]);
  const evaluatedCoverageProviders = walkForward?.outcome_coverage_providers ?? [];
  const configuredCoverageProviders = config.model.outcome_coverage_providers ?? [];
  const walkForwardUsesRealCoverage = Boolean(
    walkForwardCompatibility.compatible &&
    evaluatedCoverageProviders.length > 0 &&
    evaluatedCoverageProviders.length === configuredCoverageProviders.length &&
    evaluatedCoverageProviders.every((provider) => configuredCoverageProviders.includes(provider)) &&
    evaluatedCoverageProviders.every((provider) => !syntheticProviders.has(provider)) &&
    evaluatedCoverageProviders.every((provider) => (providerCounts[provider] ?? 0) > 0) &&
    coverage.length > 0,
  );
  const walkForwardSampleGate = assessEvaluationSampleGate(
    walkForward?.metrics,
    config.model,
  );
  const realWalkForwardAcceptanceProven = Boolean(
    walkForwardUsesRealCoverage &&
    walkForwardSampleGate.sample_threshold_passed &&
    (walkForward?.gate?.passed ?? false),
  );
  const providersEnabled = Object.fromEntries(
    Object.entries(config.providers ?? {})
      .filter(([, provider]) => provider && typeof provider === "object")
      .map(([name, provider]) => [name, Boolean(provider.enabled)]),
  );
  const latestPrediction = [...currentPredictions]
    .sort((left, right) => left.data.issued_at.localeCompare(right.data.issued_at))
    .at(-1) ?? null;
  const currentForecast = assessPredictionFreshness(latestPrediction, config, now);
  const predictionValidationStatus =
    latestPrediction?.data?.model?.validation_status ?? null;
  const effectiveChampion = championArtifact ?? champion;
  const predictionMatchesChampion = Boolean(
    championCompatibility.compatible &&
    predictionMatchesModel(latestPrediction, effectiveChampion),
  );
  const predictionMatchesChallenger = Boolean(
    challengerCompatibility.compatible &&
    predictionMatchesModel(latestPrediction, challenger),
  );
  const provisionalBootstrapEnabled =
    config.runtime?.provisional_bootstrap?.enabled === true;
  const provisionalMinimumOutcomes = Number(
    config.runtime?.provisional_bootstrap?.minimum_outcomes ?? 0,
  );
  const challengerEventCount = Number.isInteger(challenger?.event_count)
    ? challenger.event_count
    : null;
  const provisionalMinimumOutcomesMet = Boolean(
    Number.isFinite(provisionalMinimumOutcomes) &&
    provisionalMinimumOutcomes >= 0 &&
    challengerEventCount !== null &&
    challengerEventCount >= provisionalMinimumOutcomes,
  );
  const provisionalReason = provisionalIneligibilityReason({
    enabled: provisionalBootstrapEnabled,
    championCompatible: championCompatibility.compatible,
    prediction: latestPrediction,
    validationStatus: predictionValidationStatus,
    challenger,
    challengerCompatible: challengerCompatibility.compatible,
    predictionMatchesChallenger,
    minimumOutcomesMet: provisionalMinimumOutcomesMet,
  });
  const provisionalEligible = provisionalReason === null;
  const legacyValidatedPrediction = Boolean(
    predictionValidationStatus === null &&
    predictionMatchesChampion,
  );
  const validatedEligible = Boolean(
    predictionMatchesChampion &&
    (
      predictionValidationStatus === "validated" ||
      legacyValidatedPrediction
    ),
  );
  const activeModel = validatedEligible
    ? effectiveChampion
    : provisionalEligible
      ? challenger
      : null;
  const predictionIntegrity = assessPredictionIntegrity({
    prediction: latestPrediction,
    featureSnapshots,
    model: activeModel,
    config,
  });
  const outcomeOnlyCoverage = normalizeCoverageIntervals(
    assertions
      .filter((assertion) => assertion.adequacy === "outcome_only" && assertion.revoked !== true)
      .map((assertion) => ({ start: assertion.start, end: assertion.end })),
  );
  const syntheticOnly = observations.length > 0 &&
    Object.keys(providerCounts).every((provider) => syntheticProviders.has(provider));
  const runtimeSuccessMs = finiteTimestamp(runtime.last_success_at);
  const runtimeFailureMs = finiteTimestamp(runtime.last_failure_at);
  const runtimeFailureIsCurrent = Boolean(
    runtime.last_error &&
    (
      runtimeFailureMs === null ||
      runtimeSuccessMs === null ||
      runtimeFailureMs >= runtimeSuccessMs
    ),
  );
  const providerCoverageWaiting = aggregateCoverageWaiting(
    Object.values(providerFreshnessSummary.providers)
      .filter((provider) => provider.roles.includes("required_outcome"))
      .map((provider) => provider.coverage_waiting),
    { now },
  );
  const runtimeCoverageWaiting = normalizeCoverageWaitingSummary(
    runtime.last_waiting,
    { now },
  );
  const coverageWaiting = coverage.length === 0
    ? providerCoverageWaiting ?? runtimeCoverageWaiting
    : null;
  const evaluationWaiting =
    coverage.length > 0 &&
    runtime.last_status === "waiting_for_evaluation"
    ? normalizeEvaluationWaiting(runtime.last_evaluation_waiting)
    : null;
  const pipelineStatus = runtime.current_run_started_at
    ? "running"
    : runtimeFailureIsCurrent
      ? "error"
      : coverageWaiting
        ? "waiting_for_coverage"
        : evaluationWaiting
          ? "waiting_for_evaluation"
          : runtime.last_success_at
            ? "completed"
            : "idle";
  const forecastAvailable = Boolean(
    latestPrediction &&
    activeModel &&
    predictionIntegrity.valid &&
    !["stale", "invalid", "missing"].includes(currentForecast.status),
  );
  const servingBlockers = [];
  if (!latestPrediction) {
    servingBlockers.push("forecast_missing");
  } else if (["stale", "invalid", "missing"].includes(currentForecast.status)) {
    servingBlockers.push(`forecast_${currentForecast.status}`);
  }
  if (latestPrediction && !activeModel) {
    if (predictionValidationStatus === null && !predictionMatchesChampion) {
      servingBlockers.push("forecast_validation_status_missing");
    } else if (
      predictionValidationStatus !== null &&
      !["provisional", "validated"].includes(predictionValidationStatus)
    ) {
      servingBlockers.push("forecast_validation_status_invalid");
    } else if (
      predictionValidationStatus === "provisional" &&
      !provisionalEligible
    ) {
      servingBlockers.push("provisional_model_ineligible");
    } else {
      servingBlockers.push("active_model_unavailable");
    }
  }
  if (latestPrediction && activeModel && !predictionIntegrity.valid) {
    servingBlockers.push("forecast_integrity_failed");
  }
  if (providerFreshnessSummary.groups.required_outcome.status !== "fresh") {
    servingBlockers.push("required_outcome_source_not_fresh");
  }
  if (providerFreshnessSummary.groups.exact.status !== "fresh") {
    servingBlockers.push("exact_source_not_fresh");
  }
  const servingReady = forecastAvailable && servingBlockers.length === 0;
  const servingStage = !servingReady
    ? "blocked"
    : provisionalEligible
      ? "provisional"
      : "validated";
  const publicationBlockers = [];
  if (championResult.error) publicationBlockers.push("champion_incompatible");
  else if (!champion) publicationBlockers.push("champion_missing");
  else if (!championCompatibility.compatible) {
    publicationBlockers.push("champion_incompatible");
  }
  if (!latestPrediction) publicationBlockers.push("forecast_missing");
  else if (currentForecast.status !== "fresh") {
    publicationBlockers.push(`forecast_${currentForecast.status}`);
  }
  if (
    latestPrediction &&
    predictionValidationStatus !== "validated" &&
    !legacyValidatedPrediction
  ) {
    publicationBlockers.push("forecast_not_validated");
  }
  if (latestPrediction && !predictionIntegrity.valid) {
    publicationBlockers.push("forecast_integrity_failed");
  }
  if (
    latestPrediction &&
    champion &&
    latestPrediction.data.model.version !== champion.model_version
  ) {
    publicationBlockers.push("forecast_model_mismatch");
  }
  if (
    latestPrediction &&
    champion &&
    latestPrediction.data.model.artifact_hash !== champion.artifact_hash
  ) {
    publicationBlockers.push("forecast_model_artifact_mismatch");
  }
  if (
    latestPrediction &&
    champion &&
    latestPrediction.data.model.model_contract_hash !== champion.model_contract_hash
  ) {
    publicationBlockers.push("forecast_model_contract_mismatch");
  }
  if (
    champion?.artifact_hash &&
    typeof store.readModelArtifact === "function" &&
    !championArtifact
  ) {
    publicationBlockers.push("champion_artifact_missing");
  }
  if (syntheticOnly) publicationBlockers.push("synthetic_only");
  if (
    !liveSampleThresholdReached &&
    !realWalkForwardAcceptanceProven
  ) {
    publicationBlockers.push("real_walk_forward_not_proven");
  }
  if (liveSampleThresholdReached && !issuedCompatibility.compatible) {
    publicationBlockers.push("live_evaluation_incompatible");
  } else if (liveSampleThresholdReached && !(issued?.gate?.passed ?? false)) {
    publicationBlockers.push("live_evaluation_gate_failed");
  }
  if (coverage.length === 0) {
    publicationBlockers.push(
      coverageWaiting
        ? "negative_label_coverage_pending"
        : "negative_label_coverage_missing",
    );
  }
  if (evaluationWaiting && !champion) {
    publicationBlockers.push("model_evaluation_pending");
  }
  if (providerFreshnessSummary.groups.required_outcome.status !== "fresh") {
    publicationBlockers.push("required_outcome_source_not_fresh");
  }
  if (providerFreshnessSummary.groups.exact.status !== "fresh") {
    publicationBlockers.push("exact_source_not_fresh");
  }
  if (runtimeFailureIsCurrent) publicationBlockers.push("pipeline_error");
  return {
    generated_at: now.toISOString(),
    provider_enabled: Object.values(providersEnabled).some(Boolean),
    providers_enabled: providersEnabled,
    provider_record_counts: providerCounts,
    canonical_records: {
      raw_observations: observations.length,
      normalized_signals: selectCurrentSignals(signals).length,
      confirmed_outcomes: eligibleOutcomes.length,
      ineligible_legacy_outcomes:
        currentOutcomes.filter((outcome) => outcome.data.status === "confirmed").length -
        eligibleOutcomes.length,
      predictions: currentPredictions.length,
      prediction_settlements: currentSettlements.length,
    },
    outcome_coverage: {
      status: coverage.length > 0
        ? "available"
        : coverageWaiting
          ? "waiting_for_stability"
          : "missing",
      waiting: coverageWaiting,
      providers: config.model.outcome_coverage_providers,
      negative_label_eligible: {
        purpose: "negative_labels_and_model_evaluation",
        intervals: coverage.length,
        hours: coverageHours(coverage),
        assertion_refs: normalizedAssertionRefs(verifiedAssertions),
      },
      outcome_only: {
        purpose: "event_discovery_only_not_negative_labels",
        intervals: outcomeOnlyCoverage.length,
        hours: coverageHours(outcomeOnlyCoverage),
        assertion_refs: assertions
          .filter((assertion) =>
            assertion.adequacy === "outcome_only" && assertion.revoked !== true,
          )
          .map((assertion) => ({
            assertion_id: assertion.assertion_id,
            revision: assertion.revision,
          })),
      },
      intervals: coverage.length,
      hours: coverageHours(coverage),
    },
    model: {
      champion_available: Boolean(champion),
      version: champion?.model_version ?? null,
      compatibility: championCompatibility,
      challenger: {
        available: Boolean(challenger),
        ready: Boolean(challenger && challengerCompatibility.compatible),
        version: challenger?.model_version ?? null,
        trained_at: challenger?.trained_at ?? null,
        training_cutoff: challenger?.training_cutoff ?? null,
        converged: challenger?.converged === true,
        example_count: Number.isInteger(challenger?.example_count)
          ? challenger.example_count
          : null,
        event_count: Number.isInteger(challenger?.event_count)
          ? challenger.event_count
          : null,
        compatibility: challengerCompatibility,
      },
      walk_forward_gate_passed: walkForward?.gate?.passed ?? false,
      walk_forward_event_recall: walkForward?.metrics?.event_window_recall ?? null,
      walk_forward_evidence_mode: walkForward?.evidence_mode ?? null,
      walk_forward_compatibility: walkForwardCompatibility,
      champion_evaluation_compatibility: championEvaluationCompatibility,
      latest_challenger_evaluation_compatibility: latestWalkForwardCompatibility,
      walk_forward_sample_gate: walkForwardSampleGate,
      real_walk_forward_acceptance_proven: realWalkForwardAcceptanceProven,
    },
    live_evaluation: {
      sample_gate: liveSampleGate,
      sample_threshold_reached: liveSampleThresholdReached,
      threshold_reached: liveThresholdReached,
      gate_passed: liveThresholdReached && issued.gate.passed,
      evaluated_windows: issued?.metrics?.evaluated_windows ?? 0,
      evaluated_events: issued?.metrics?.evaluated_events ?? 0,
      event_window_recall: issued?.metrics?.event_window_recall ?? null,
      compatibility: issuedCompatibility,
    },
    current_forecast: currentForecast,
    prediction_integrity: predictionIntegrity,
    forecast_available: forecastAvailable,
    serving_ready: servingReady,
    serving_stage: servingStage,
    serving_blockers: [...new Set(servingBlockers)],
    provisional_model: {
      available: Boolean(challenger),
      version: challenger?.model_version ?? null,
      artifact_hash: challenger?.artifact_hash ?? null,
      training_cutoff: challenger?.training_cutoff ?? null,
      compatibility: challengerCompatibility,
      eligibility: {
        enabled: provisionalBootstrapEnabled,
        eligible: provisionalEligible,
        reason: provisionalReason,
        prediction_validation_status: predictionValidationStatus,
        requirements: {
          no_compatible_champion: !championCompatibility.compatible,
          challenger_compatible: challengerCompatibility.compatible,
          prediction_marked_provisional:
            predictionValidationStatus === "provisional",
          prediction_matches_challenger: predictionMatchesChallenger,
          minimum_outcomes: provisionalMinimumOutcomes,
          challenger_event_count: challengerEventCount,
          minimum_outcomes_met: provisionalMinimumOutcomesMet,
        },
      },
    },
    provider_freshness: providerFreshnessSummary,
    publication_ready: publicationBlockers.length === 0,
    publication_blockers: publicationBlockers,
    pipeline_status: pipelineStatus,
    coverage_waiting: coverageWaiting,
    evaluation_waiting: evaluationWaiting,
    synthetic_only: syntheticOnly,
    last_pipeline_success_at: runtime.last_success_at ?? null,
    last_pipeline_failure_at: runtime.last_failure_at ?? null,
    last_pipeline_error: runtime.last_error ?? null,
  };
}
