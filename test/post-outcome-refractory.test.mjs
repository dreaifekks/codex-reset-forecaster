import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../src/core/outcome-contract.mjs";
import { createRecord, producer } from "../src/core/records.mjs";
import { halfOpenRange } from "../src/core/time.mjs";
import { modelContractHash } from "../src/model/contract.mjs";
import {
  conditionAuthorityTimingHazards,
} from "../src/model/authority-timing.mjs";
import { deriveProbabilitySlots } from "../src/model/forecast.mjs";
import { AS_OF_MODE } from "../src/model/as-of.mjs";
import {
  conditionPostOutcomeRefractoryHazards,
  postOutcomeRefractoryMultiplier,
} from "../src/model/post-outcome-refractory.mjs";
import { extractSignal } from "../src/pipeline/extract.mjs";
import {
  outcomeAdjudicationContract,
} from "../src/pipeline/outcomes.mjs";
import { rawObservationFromItem } from "../src/providers/raw.mjs";

function observation(config, {
  id,
  text,
  publishedAt,
  fetchedAt,
}) {
  return rawObservationFromItem({
    provider_item_id: id,
    canonical_url: `https://x.com/thsottiaux/status/${id}`,
    published_at: publishedAt,
    author: {
      provider_author_id: "thsottiaux",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text,
      language: "en",
    },
    selection_context: {
      feature_eligible: true,
      outcome_conditioned: false,
      selection_method: "test",
    },
  }, {
    providerName: "timeline_jsonl",
    providerVersion: "test",
    config: {},
    firstSeenAt: fetchedAt,
    fetchedAt,
  });
}

function eligibleCompletion(config, {
  knownAt = "2026-07-29T04:10:00.000Z",
  replayAvailableAt = null,
} = {}) {
  const source = observation(config, {
    id: "completion",
    text: "We have reset Codex usage limits for all paid users.",
    publishedAt: "2026-07-29T04:09:00.000Z",
    fetchedAt: knownAt,
  });
  const signal = extractSignal(source, config);
  assert.equal(signal.data.claim.phase, "completed");
  const occurredTimeRange = halfOpenRange(
    "2026-07-29T04:00:00.000Z",
    "2026-07-29T05:00:00.000Z",
    "hour",
  );
  const outcome = createRecord({
    recordType: "reset_outcome",
    naturalKey: "completion",
    createdAt: knownAt,
    producer: producer(
      "outcome-adjudicator",
      OUTCOME_ADJUDICATOR_VERSION,
      outcomeAdjudicationContract(config),
    ),
    data: {
      status: "confirmed",
      label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
      event_identity: "evt_completion",
      event_type: signal.data.claim.event_type,
      scope: structuredClone(signal.data.claim.scope),
      occurred_time_range: occurredTimeRange,
      known_at: knownAt,
      replay_available_at: replayAvailableAt,
      verification: [{
        kind: "official_confirmation",
        observation_ref: {
          record_id: source.record_id,
          revision: source.revision,
        },
        independence_group_id:
          signal.data.provenance.independence_group_id,
      }],
      candidate_refs: [{ record_id: "evt_candidate", revision: 1 }],
    },
  });
  return { source, signal, outcome };
}

function hazards(start, count, hazard = 0.99) {
  return Array.from({ length: count }, (_, index) => {
    const slotStart = new Date(Date.parse(start) + index * 3_600_000);
    return {
      start: slotStart.toISOString(),
      end: new Date(slotStart.getTime() + 3_600_000).toISOString(),
      hazard,
      interval80: [hazard / 2, hazard],
    };
  });
}

test("live policy is a versioned monotonic recovery curve bound to the model contract", async () => {
  const disabled = await loadConfig();
  const enabled = await loadConfig({
    overrides: {
      model: {
        post_outcome_refractory: { enabled: true },
      },
    },
  });
  const policy = enabled.model.post_outcome_refractory;
  const samples = [0, 0.5, 1, 2, 4, 6, 8, 10, 12, 24]
    .map((elapsed) =>
      postOutcomeRefractoryMultiplier(policy, elapsed)
    );

  assert.equal(disabled.model.post_outcome_refractory.enabled, false);
  assert.equal(policy.enabled, true);
  assert.deepEqual(samples, [...samples].sort((left, right) => left - right));
  assert.equal(samples[0], 0.001);
  assert.equal(samples.at(-1), 1);
  assert.notEqual(modelContractHash(disabled), modelContractHash(enabled));
  await assert.rejects(
    loadConfig({
      overrides: {
        model: {
          post_outcome_refractory: {
            recovery_curve: [
              { elapsed_hours: 0, multiplier: 0.1 },
              { elapsed_hours: 2, multiplier: 0.05 },
              { elapsed_hours: 12, multiplier: 1 },
            ],
          },
        },
      },
    }),
    /recover monotonically/,
  );
});

test("latest eligible completion suppresses next-event hazard without creating a negative label", async () => {
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
  });
  const evidence = eligibleCompletion(config);
  const baseEntries = hazards("2026-07-29T05:00:00.000Z", 4);
  const conditioned = conditionPostOutcomeRefractoryHazards({
    hazardEntries: baseEntries,
    signals: [evidence.signal],
    observations: [evidence.source],
    outcomes: [evidence.outcome],
    config,
    knowledgeCutoff: "2026-07-29T04:15:00.000Z",
  });
  const probabilities = deriveProbabilitySlots(conditioned.hazardEntries);

  assert.equal(conditioned.metadata.applied, true);
  assert.equal(conditioned.metadata.status, "active");
  assert.equal(
    conditioned.metadata.outcome_ref.record_id,
    evidence.outcome.record_id,
  );
  assert.equal(conditioned.metadata.first_slot_multiplier, 0.001);
  assert.equal(conditioned.hazardEntries[0].hazard, 0.00099);
  assert.ok(probabilities.slots[0].rolling_4h_probability < 0.02);
  assert.ok(
    Math.abs(
      probabilities.slots.reduce(
        (sum, slot) => sum + slot.first_reset_probability,
        probabilities.noResetProbability,
      ) - 1
    ) < 1e-12,
  );
  assert.equal(evidence.outcome.data.status, "confirmed");
  assert.equal(evidence.outcome.data.label_policy_version, OUTCOME_LABEL_POLICY_VERSION);
  assert.deepEqual(baseEntries.map((entry) => entry.hazard), Array(4).fill(0.99));
});

test("Date forecast cutoffs preserve millisecond availability boundaries", async () => {
  const config = await loadConfig({ configPath: "config/tibo-authority-live.json" });
  const evidence = eligibleCompletion(config, { knownAt: "2026-07-29T04:10:00.500Z" });
  const input = { hazardEntries: hazards("2026-07-29T05:00:00.000Z", 4),
    signals: [evidence.signal], observations: [evidence.source], outcomes: [evidence.outcome], config };
  assert.equal(conditionPostOutcomeRefractoryHazards({ ...input,
    knowledgeCutoff: new Date("2026-07-29T04:10:00.750Z") }).metadata.applied, true);
  assert.equal(conditionPostOutcomeRefractoryHazards({ ...input,
    knowledgeCutoff: new Date("2026-07-29T04:10:00.499Z") }).metadata.status, "no_eligible_outcome");
});

test("unknown, excluded, and fully recovered outcomes do not alter hazards", async () => {
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
  });
  const evidence = eligibleCompletion(config);
  const nearEntries = hazards("2026-07-29T05:00:00.000Z", 4, 0.4);
  const unknown = conditionPostOutcomeRefractoryHazards({
    hazardEntries: nearEntries,
    signals: [evidence.signal],
    observations: [evidence.source],
    outcomes: [evidence.outcome],
    config,
    knowledgeCutoff: "2026-07-29T04:09:59.000Z",
  });
  const excluded = conditionPostOutcomeRefractoryHazards({
    hazardEntries: nearEntries,
    signals: [evidence.signal],
    observations: [evidence.source],
    outcomes: [evidence.outcome],
    config,
    knowledgeCutoff: "2026-07-29T04:15:00.000Z",
    excludedSourceRecordIds: new Set([evidence.outcome.record_id]),
  });
  const recoveredEntries = hazards(
    "2026-07-29T17:00:00.000Z",
    4,
    0.4,
  );
  const recovered = conditionPostOutcomeRefractoryHazards({
    hazardEntries: recoveredEntries,
    signals: [evidence.signal],
    observations: [evidence.source],
    outcomes: [evidence.outcome],
    config,
    knowledgeCutoff: "2026-07-29T16:30:00.000Z",
  });

  assert.equal(unknown.metadata.status, "no_eligible_outcome");
  assert.deepEqual(unknown.hazardEntries, nearEntries);
  assert.equal(excluded.metadata.status, "no_eligible_outcome");
  assert.deepEqual(excluded.hazardEntries, nearEntries);
  assert.equal(recovered.metadata.status, "recovered");
  assert.equal(recovered.metadata.first_slot_multiplier, 1);
  assert.deepEqual(recovered.hazardEntries, recoveredEntries);
});

test("archive replay records the selected availability clock separately from canonical known_at", async () => {
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
  });
  const evidence = eligibleCompletion(config, {
    knownAt: "2026-07-30T04:10:00.000Z",
    replayAvailableAt: "2026-07-29T04:10:00.000Z",
  });
  evidence.source.data.availability_attestation = {
    available_at: "2026-07-29T04:09:00.000Z",
    basis: "direct_source_publication",
    attestor_url: evidence.source.data.canonical_url,
    verified_at: "2026-07-30T04:10:00.000Z",
    verification: "test archive replay clock",
  };
  evidence.signal.data.available_at = "2026-07-29T04:09:00.000Z";
  const conditioned = conditionPostOutcomeRefractoryHazards({
    hazardEntries: hazards("2026-07-29T05:00:00.000Z", 4),
    signals: [evidence.signal],
    observations: [evidence.source],
    outcomes: [evidence.outcome],
    config,
    knowledgeCutoff: "2026-07-29T04:15:00.000Z",
    asOfMode: AS_OF_MODE.ARCHIVE_REPLAY,
  });

  assert.equal(conditioned.metadata.applied, true);
  assert.equal(conditioned.metadata.as_of_mode, "archive_replay");
  assert.equal(
    conditioned.metadata.outcome_known_at,
    "2026-07-30T04:10:00.000Z",
  );
  assert.equal(
    conditioned.metadata.outcome_available_at,
    "2026-07-29T04:10:00.000Z",
  );
});

test("new authority timing is applied after refractory suppression and can raise the forecast", async () => {
  const config = await loadConfig({
    configPath: "config/tibo-authority-live.json",
  });
  const evidence = eligibleCompletion(config);
  const scheduledSource = observation(config, {
    id: "new-schedule",
    text:
      "We will reset Codex usage limits for all paid users in the next 2 hours.",
    publishedAt: "2026-07-29T05:05:00.000Z",
    fetchedAt: "2026-07-29T05:06:00.000Z",
  });
  const scheduledSignal = extractSignal(scheduledSource, config);
  const baseEntries = hazards("2026-07-29T06:00:00.000Z", 4, 0.4);
  const inputs = {
    signals: [evidence.signal, scheduledSignal],
    observations: [evidence.source, scheduledSource],
    outcomes: [evidence.outcome],
    config,
    knowledgeCutoff: "2026-07-29T05:10:00.000Z",
  };
  const refractory = conditionPostOutcomeRefractoryHazards({
    hazardEntries: baseEntries,
    ...inputs,
  });
  const authority = conditionAuthorityTimingHazards({
    hazardEntries: refractory.hazardEntries,
    ...inputs,
  });

  assert.equal(refractory.metadata.applied, true);
  assert.equal(authority.metadata.applied, true);
  assert.equal(authority.metadata.signal_ref.record_id, scheduledSignal.record_id);
  assert.ok(
    authority.metadata.conditioned_horizon_probability >
      refractory.metadata.conditioned_horizon_probability,
  );
  assert.ok(
    Math.abs(
      authority.metadata.base_horizon_probability -
      refractory.metadata.conditioned_horizon_probability
    ) < 1e-12,
  );
});
