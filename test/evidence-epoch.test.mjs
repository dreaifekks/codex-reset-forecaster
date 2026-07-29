import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_POST_OUTCOME_EVIDENCE_POLICY,
  POST_OUTCOME_EVIDENCE_POLICY_VERSION,
  assertPostOutcomeEvidencePolicy,
  postOutcomeEvidenceWeight,
} from "../src/model/evidence-epoch.mjs";

function signal(group) {
  return {
    data: {
      provenance: {
        independence_group_id: group,
      },
    },
  };
}

const outcome = {
  data: {
    occurred_time_range: {
      start: "2026-07-29T04:00:00.000Z",
      end: "2026-07-29T05:00:00.000Z",
    },
    verification: [{
      independence_group_id: "ind_completed_reset",
    }],
  },
};

test("post-outcome evidence policy consumes every derivative in the completed lineage", () => {
  assert.equal(
    POST_OUTCOME_EVIDENCE_POLICY_VERSION,
    "post-outcome-evidence-carryover/1",
  );
  assert.equal(
    postOutcomeEvidenceWeight({
      signal: signal("ind_completed_reset"),
      eventTime: "2026-07-29T05:30:00.000Z",
      latestOutcome: outcome,
    }),
    0,
  );
});

test("independent evidence crosses an outcome boundary with a reduced carry-over weight", () => {
  assert.equal(
    postOutcomeEvidenceWeight({
      signal: signal("ind_independent"),
      eventTime: "2026-07-29T03:00:00.000Z",
      latestOutcome: outcome,
    }),
    DEFAULT_POST_OUTCOME_EVIDENCE_POLICY.pre_outcome_multiplier,
  );
  assert.equal(
    postOutcomeEvidenceWeight({
      signal: signal("ind_independent"),
      eventTime: "2026-07-29T05:00:00.000Z",
      latestOutcome: outcome,
    }),
    1,
  );
});

test("evidence is unchanged before the first confirmed outcome", () => {
  assert.equal(
    postOutcomeEvidenceWeight({
      signal: signal("ind_independent"),
      eventTime: "2026-07-29T03:00:00.000Z",
      latestOutcome: null,
    }),
    1,
  );
});

test("post-outcome evidence policy rejects unversioned or amplifying carry-over", () => {
  assert.doesNotThrow(() =>
    assertPostOutcomeEvidencePolicy(
      DEFAULT_POST_OUTCOME_EVIDENCE_POLICY,
    )
  );
  assert.throws(
    () =>
      assertPostOutcomeEvidencePolicy({
        version: POST_OUTCOME_EVIDENCE_POLICY_VERSION,
        consume_outcome_lineage: true,
        pre_outcome_multiplier: 1.1,
      }),
    /supported post-outcome evidence policy/,
  );
});
