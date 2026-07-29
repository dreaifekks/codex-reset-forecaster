import { timestampMillis } from "../core/time.mjs";

export const POST_OUTCOME_EVIDENCE_POLICY_VERSION =
  "post-outcome-evidence-carryover/1";

export const DEFAULT_POST_OUTCOME_EVIDENCE_POLICY = Object.freeze({
  version: POST_OUTCOME_EVIDENCE_POLICY_VERSION,
  consume_outcome_lineage: true,
  pre_outcome_multiplier: 0.5,
});

export function assertPostOutcomeEvidencePolicy(policy) {
  if (
    policy?.version !== POST_OUTCOME_EVIDENCE_POLICY_VERSION ||
    typeof policy.consume_outcome_lineage !== "boolean" ||
    !Number.isFinite(policy.pre_outcome_multiplier) ||
    policy.pre_outcome_multiplier < 0 ||
    policy.pre_outcome_multiplier > 1
  ) {
    throw new TypeError(
      "model.evidence_carryover must use the supported post-outcome evidence policy",
    );
  }
}

function outcomeAnchorMillis(outcome) {
  const end = outcome?.data?.occurred_time_range?.end;
  if (!end) return null;
  try {
    return timestampMillis(end);
  } catch {
    return null;
  }
}

function outcomeLineageGroups(outcome) {
  return new Set(
    (outcome?.data?.verification ?? [])
      .map((entry) => entry.independence_group_id)
      .filter((value) => typeof value === "string" && value.length > 0),
  );
}

export function postOutcomeEvidenceWeight({
  signal,
  eventTime,
  latestOutcome = null,
  policy = DEFAULT_POST_OUTCOME_EVIDENCE_POLICY,
}) {
  assertPostOutcomeEvidencePolicy(policy);
  if (!latestOutcome) return 1;
  const anchor = outcomeAnchorMillis(latestOutcome);
  if (!Number.isFinite(anchor)) return 1;
  const group = signal?.data?.provenance?.independence_group_id;
  if (
    policy.consume_outcome_lineage === true &&
    typeof group === "string" &&
    outcomeLineageGroups(latestOutcome).has(group)
  ) {
    return 0;
  }
  let event;
  try {
    event = timestampMillis(eventTime);
  } catch {
    return 1;
  }
  return event < anchor
    ? policy.pre_outcome_multiplier
    : 1;
}
