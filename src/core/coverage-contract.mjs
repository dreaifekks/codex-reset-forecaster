import { hashLabel } from "./hash.mjs";
import { AUTHORITY_SCOPE_POLICY } from "./extractor-contract.mjs";

export const AUTHORITY_OUTCOME_DEFINITION_VERSION =
  "authority-announced-platform-reset/2";
export const HISTORICAL_DAILY_LEDGER_ATTESTATION_VERSION =
  "historical-daily-authority-ledger/1";
export const HISTORICAL_DAILY_LEDGER_EVIDENCE_VERSION =
  "historical-daily-authority-ledger-evidence/1";
export const HISTORICAL_DAILY_LEDGER_OBSERVATION_VERSION =
  "historical-daily-authority-ledger-observation/1";
export const HISTORICAL_DAILY_LEDGER_CONTRACT_VERSION =
  "historical-daily-authority-ledger-contract/1";
export const HISTORICAL_DAILY_LEDGER_METHOD =
  "contiguous_daily_grid+x_oembed+snowflake";

function sortedUnique(values) {
  return [...new Set(values ?? [])].sort();
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function historicalDailyLedgerAttestationReasons({
  attestation,
  outcomeDefinition,
  providerName,
  sourceUrl,
  target,
  confirmationIdentityIds,
}) {
  const reasons = [];
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return ["attestation_missing"];
  }
  if (outcomeDefinition?.version !== AUTHORITY_OUTCOME_DEFINITION_VERSION) {
    reasons.push("outcome_definition_not_authority_announced");
  }
  if (
    outcomeDefinition?.event_semantics !==
      "qualifying_authority_completion_statement"
  ) {
    reasons.push("outcome_definition_semantics_invalid");
  }
  if (outcomeDefinition?.scope_policy !== AUTHORITY_SCOPE_POLICY) {
    reasons.push("outcome_definition_scope_policy_invalid");
  }
  if (
    outcomeDefinition?.negative_label_policy !==
      "authoritative_daily_ledger_absence"
  ) {
    reasons.push("outcome_definition_negative_label_policy_invalid");
  }
  if (attestation.version !== HISTORICAL_DAILY_LEDGER_ATTESTATION_VERSION) {
    reasons.push("attestation_version_unsupported");
  }
  if (attestation.provider !== providerName) {
    reasons.push("attestation_provider_mismatch");
  }
  if (
    attestation.independent !== true ||
    typeof attestation.attestor !== "string" ||
    attestation.attestor.length === 0
  ) {
    reasons.push("attestation_independence_invalid");
  }
  const attestorUrl = normalizedUrl(attestation.attestor);
  const configuredSourceUrl = normalizedUrl(sourceUrl);
  if (!attestorUrl || !configuredSourceUrl || attestorUrl !== configuredSourceUrl) {
    reasons.push("attestation_source_mismatch");
  }
  if (attestation.method !== HISTORICAL_DAILY_LEDGER_METHOD) {
    reasons.push("attestation_method_unsupported");
  }
  if (
    attestation.exhaustive_for !==
      "qualifying_completed_platform_reset_outcomes"
  ) {
    reasons.push("attestation_outcome_semantics_invalid");
  }
  if (hashLabel(attestation.target_scope) !== hashLabel(target)) {
    reasons.push("attestation_target_scope_mismatch");
  }
  const expectedIdentities = sortedUnique(confirmationIdentityIds);
  const attestedIdentities = sortedUnique(
    attestation.confirmation_identity_ids,
  );
  const outcomeIdentities = sortedUnique(
    outcomeDefinition?.authority_identity_ids,
  );
  if (
    expectedIdentities.length === 0 ||
    hashLabel(attestedIdentities) !== hashLabel(expectedIdentities) ||
    hashLabel(outcomeIdentities) !== hashLabel(expectedIdentities)
  ) {
    reasons.push("attestation_confirmation_identities_mismatch");
  }
  if (
    !Number.isInteger(attestation.day_close_lag_hours) ||
    attestation.day_close_lag_hours < 1 ||
    attestation.day_close_lag_hours > 168
  ) {
    reasons.push("attestation_day_close_lag_invalid");
  }
  if (
    !Number.isInteger(attestation.minimum_stability_hours) ||
    attestation.minimum_stability_hours < 1 ||
    attestation.minimum_stability_hours >
      attestation.day_close_lag_hours
  ) {
    reasons.push("attestation_stability_window_invalid");
  }
  return [...new Set(reasons)];
}

export function assertHistoricalDailyLedgerAttestation(options) {
  const reasons = historicalDailyLedgerAttestationReasons(options);
  if (reasons.length > 0) {
    throw new TypeError(
      `historical_monitor negative_label_eligible authority ledger is invalid: ${reasons.join(", ")}`,
    );
  }
  return options.attestation;
}

export function historicalDailyLedgerContractHash(options) {
  const attestation = assertHistoricalDailyLedgerAttestation(options);
  return hashLabel({
    version: HISTORICAL_DAILY_LEDGER_CONTRACT_VERSION,
    outcome_definition: options.outcomeDefinition,
    provider: options.providerName,
    source_url: normalizedUrl(options.sourceUrl),
    target_scope: options.target,
    confirmation_identity_ids: sortedUnique(options.confirmationIdentityIds),
    attestation,
  });
}
