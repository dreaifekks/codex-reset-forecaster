import {
  normalizeCoverageIntervals,
  verifiedCoverageAssertionRevisions,
} from "../pipeline/coverage.mjs";

export const COVERAGE_AS_OF_MODE = Object.freeze({
  LIVE: "live",
  ARCHIVE_REPLAY: "archive_replay",
  SYNTHETIC_REPLAY: "synthetic_replay",
});

function assertionAvailableAt(assertion, mode) {
  if (
    mode === COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY &&
    typeof assertion.replay_available_at === "string" &&
    assertion.evidence_refs?.some((evidence) =>
      evidence.kind === "independent_completeness_attestation" &&
      evidence.replay_available_at === assertion.replay_available_at &&
      typeof evidence.method === "string" &&
      evidence.method.length > 0
    )
  ) {
    return assertion.replay_available_at;
  }
  if (
    mode === COVERAGE_AS_OF_MODE.SYNTHETIC_REPLAY &&
    assertion.revision === 1 &&
    ["demo", "fixture"].includes(assertion.provider) &&
    assertion.mode === "fixture_declared_complete" &&
    assertion.evidence_refs?.some((evidence) =>
      evidence.kind === "fixture_manifest" &&
      evidence.method === "synthetic_fixture_manifest"
    )
  ) {
    return assertion.start;
  }
  return assertion.asserted_at;
}

function providerSelected(assertion, providers) {
  return !providers || providers.includes(assertion.provider);
}

export async function coverageAssertionRevisions(
  store,
  providers = null,
  options = {},
) {
  return (await verifiedCoverageAssertionRevisions(store, providers, options))
    .filter((assertion) => providerSelected(assertion, providers));
}

export function latestCoverageAssertionsAsOf(
  assertions,
  cutoff,
  providers = null,
  mode = COVERAGE_AS_OF_MODE.LIVE,
) {
  if (!Object.values(COVERAGE_AS_OF_MODE).includes(mode)) {
    throw new TypeError(`Unsupported coverage as-of mode: ${mode}`);
  }
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) throw new TypeError("Invalid coverage as-of cutoff");
  const latest = new Map();
  for (const assertion of assertions) {
    if (
      !assertion?.assertion_id ||
      !providerSelected(assertion, providers) ||
      typeof assertionAvailableAt(assertion, mode) !== "string" ||
      Date.parse(assertionAvailableAt(assertion, mode)) > cutoffMs
    ) {
      continue;
    }
    const previous = latest.get(assertion.assertion_id);
    if (!previous || assertion.revision > previous.revision) {
      latest.set(assertion.assertion_id, assertion);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.assertion_id.localeCompare(right.assertion_id) ||
    left.revision - right.revision,
  );
}

export function adequateCoverageAssertionsAsOf(
  assertions,
  cutoff,
  providers = null,
  mode = COVERAGE_AS_OF_MODE.LIVE,
) {
  return latestCoverageAssertionsAsOf(assertions, cutoff, providers, mode)
    .filter((assertion) =>
      assertion.adequacy === "negative_label_eligible" &&
      assertion.revoked !== true,
    );
}

export function adequateCoverageIntervalsAsOf(
  assertions,
  cutoff,
  providers = null,
  mode = COVERAGE_AS_OF_MODE.LIVE,
) {
  return normalizeCoverageIntervals(
    adequateCoverageAssertionsAsOf(assertions, cutoff, providers, mode),
  );
}
