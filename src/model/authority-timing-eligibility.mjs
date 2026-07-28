import { timestampMillis } from "../core/time.mjs";
import { scopeIncludesProduct } from "../core/product-scope.mjs";
import { isResetTimingSignal } from "./signal-lifecycle.mjs";

function durationHours(range) {
  if (range === null) return null;
  try {
    return (
      timestampMillis(range.end) - timestampMillis(range.start)
    ) / 3_600_000;
  } catch {
    return NaN;
  }
}

export function matchesAuthorityTimingTarget(signal, targetScope) {
  if (!targetScope) return true;
  const scope = signal?.data?.claim?.scope;
  return scope?.vendor === targetScope.vendor &&
    scope?.population === targetScope.population &&
    scopeIncludesProduct(scope, targetScope.product);
}

export function isAuthorityTimingCandidateSignal({
  signal,
  observation,
  policy,
  confirmationIdentityIds,
  targetScope,
  excludedSourceRecordIds = new Set(),
  excludedIndependenceGroupIds = new Set(),
}) {
  const claim = signal?.data?.claim;
  const provenance = signal?.data?.provenance;
  const assertedDurationHours = durationHours(claim?.asserted_time_range);
  return policy?.enabled === true &&
    confirmationIdentityIds?.has(provenance?.source_identity_id) &&
    policy.eligible_source_roles.includes(provenance?.source_role) &&
    provenance?.derivation === "primary_statement" &&
    provenance?.feature_eligible !== false &&
    provenance?.selection_bias === null &&
    observation?.data?.content?.media_type === "text/plain" &&
    !excludedSourceRecordIds.has(observation.record_id) &&
    !excludedIndependenceGroupIds.has(
      provenance?.independence_group_id,
    ) &&
    ["quota_reset", "quota_refill"].includes(claim?.event_type) &&
    matchesAuthorityTimingTarget(signal, targetScope) &&
    (
      claim.asserted_time_range === null ||
      (
        assertedDurationHours > 0 &&
        assertedDurationHours <= policy.maximum_asserted_duration_hours
      )
    );
}

export function isAuthorityTimingSupportSignal(options) {
  const { signal, policy } = options;
  const claim = signal?.data?.claim;
  return isAuthorityTimingCandidateSignal(options) &&
    isResetTimingSignal(signal) &&
    claim.stance === "supports" &&
    claim.asserted_time_range !== null &&
    Object.hasOwn(policy.phase_reliability, claim.phase);
}
