const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const COVERAGE_WAITING_SCHEMA_VERSION = "coverage-waiting/1";
export const COVERAGE_WAITING_REASON =
  "coverage_stability_observation_pending";

function finiteTimestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Coverage waiting ${field} must be an RFC 3339 timestamp`);
  }
  return parsed;
}

function earliest(values) {
  return [...values].sort().at(0) ?? null;
}

export function coverageWaitingFromDailyCandidates({
  providerId,
  days,
  dayCloseLagHours,
  minimumStabilityHours,
  observedAt,
}) {
  const entries = Object.entries(days ?? {});
  if (entries.length === 0) return null;
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new TypeError("Coverage waiting provider_id is required");
  }
  if (
    !Number.isFinite(dayCloseLagHours) ||
    dayCloseLagHours < 0 ||
    !Number.isFinite(minimumStabilityHours) ||
    minimumStabilityHours <= 0
  ) {
    throw new TypeError("Coverage waiting stability policy is invalid");
  }
  const observedAtMs = finiteTimestamp(observedAt, "observed_at");
  const candidates = entries.map(([date, candidate]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError(`Coverage waiting candidate date is invalid: ${date}`);
    }
    const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
    const firstObservedMs = finiteTimestamp(
      candidate?.first_observed_at,
      "first_observed_at",
    );
    const earliestRecheckMs = Math.max(
      firstObservedMs + minimumStabilityHours * HOUR_MS,
      dayStartMs + DAY_MS + dayCloseLagHours * HOUR_MS,
    );
    return {
      first_observed_at: new Date(firstObservedMs).toISOString(),
      earliest_recheck_at: new Date(earliestRecheckMs).toISOString(),
    };
  });
  return {
    schema_version: COVERAGE_WAITING_SCHEMA_VERSION,
    status: "observing",
    reason_code: COVERAGE_WAITING_REASON,
    provider_id: providerId,
    candidate_count: candidates.length,
    earliest_first_observed_at: earliest(
      candidates.map((candidate) => candidate.first_observed_at),
    ),
    earliest_recheck_at: earliest(
      candidates.map((candidate) => candidate.earliest_recheck_at),
    ),
    observed_at: new Date(observedAtMs).toISOString(),
  };
}

export function normalizeProviderCoverageWaiting(value) {
  if (value === null || value === undefined) return null;
  if (
    value.schema_version !== COVERAGE_WAITING_SCHEMA_VERSION ||
    value.status !== "observing" ||
    value.reason_code !== COVERAGE_WAITING_REASON ||
    typeof value.provider_id !== "string" ||
    value.provider_id.length === 0 ||
    !Number.isInteger(value.candidate_count) ||
    value.candidate_count < 1
  ) {
    return null;
  }
  const firstObservedMs = Date.parse(value.earliest_first_observed_at);
  const earliestRecheckMs = Date.parse(value.earliest_recheck_at);
  const observedAtMs = Date.parse(value.observed_at);
  if (
    !Number.isFinite(firstObservedMs) ||
    !Number.isFinite(earliestRecheckMs) ||
    !Number.isFinite(observedAtMs) ||
    earliestRecheckMs < firstObservedMs
  ) {
    return null;
  }
  return {
    schema_version: COVERAGE_WAITING_SCHEMA_VERSION,
    status: "observing",
    reason_code: COVERAGE_WAITING_REASON,
    provider_id: value.provider_id,
    candidate_count: value.candidate_count,
    earliest_first_observed_at: new Date(firstObservedMs).toISOString(),
    earliest_recheck_at: new Date(earliestRecheckMs).toISOString(),
    observed_at: new Date(observedAtMs).toISOString(),
  };
}

export function aggregateCoverageWaiting(values, { now = new Date() } = {}) {
  const byProvider = new Map();
  for (const value of values ?? []) {
    const normalized = normalizeProviderCoverageWaiting(value);
    if (!normalized) continue;
    const previous = byProvider.get(normalized.provider_id);
    if (
      !previous ||
      normalized.observed_at.localeCompare(previous.observed_at) > 0
    ) {
      byProvider.set(normalized.provider_id, normalized);
    }
  }
  const providers = [...byProvider.values()]
    .sort((left, right) => left.provider_id.localeCompare(right.provider_id));
  if (providers.length === 0) return null;
  const earliestRecheckAt = earliest(
    providers.map((provider) => provider.earliest_recheck_at),
  );
  return {
    schema_version: COVERAGE_WAITING_SCHEMA_VERSION,
    status: "waiting_for_coverage",
    reason_code: COVERAGE_WAITING_REASON,
    providers: providers.map((provider) => provider.provider_id),
    candidate_count: providers.reduce(
      (sum, provider) => sum + provider.candidate_count,
      0,
    ),
    earliest_first_observed_at: earliest(
      providers.map((provider) => provider.earliest_first_observed_at),
    ),
    earliest_recheck_at: earliestRecheckAt,
    recheck_due: Date.parse(earliestRecheckAt) <= new Date(now).getTime(),
    observed_at: providers
      .map((provider) => provider.observed_at)
      .sort()
      .at(-1),
  };
}

export function normalizeCoverageWaitingSummary(value, { now = new Date() } = {}) {
  if (
    value?.schema_version !== COVERAGE_WAITING_SCHEMA_VERSION ||
    value?.status !== "waiting_for_coverage" ||
    value?.reason_code !== COVERAGE_WAITING_REASON ||
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    value.providers.some((provider) =>
      typeof provider !== "string" || provider.length === 0
    ) ||
    !Number.isInteger(value.candidate_count) ||
    value.candidate_count < 1
  ) {
    return null;
  }
  const firstObservedMs = Date.parse(value.earliest_first_observed_at);
  const earliestRecheckMs = Date.parse(value.earliest_recheck_at);
  const observedAtMs = Date.parse(value.observed_at);
  if (
    !Number.isFinite(firstObservedMs) ||
    !Number.isFinite(earliestRecheckMs) ||
    !Number.isFinite(observedAtMs) ||
    earliestRecheckMs < firstObservedMs
  ) {
    return null;
  }
  return {
    schema_version: COVERAGE_WAITING_SCHEMA_VERSION,
    status: "waiting_for_coverage",
    reason_code: COVERAGE_WAITING_REASON,
    providers: [...new Set(value.providers)].sort(),
    candidate_count: value.candidate_count,
    earliest_first_observed_at: new Date(firstObservedMs).toISOString(),
    earliest_recheck_at: new Date(earliestRecheckMs).toISOString(),
    recheck_due: earliestRecheckMs <= new Date(now).getTime(),
    observed_at: new Date(observedAtMs).toISOString(),
  };
}
