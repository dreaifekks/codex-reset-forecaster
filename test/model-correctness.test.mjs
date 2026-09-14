import assert from "node:assert/strict";
import test from "node:test";
import { createRecord, producer } from "../src/core/records.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../src/core/outcome-contract.mjs";
import { hashLabel, sha256, stableStringify } from "../src/core/hash.mjs";
import { addHours } from "../src/core/time.mjs";
import {
  FEATURE_NAMES,
  featureVectorAt,
  featuresToArray,
  matchesExpectedExtractor,
} from "../src/model/features.mjs";
import { deriveProbabilitySlots, issueForecast } from "../src/model/forecast.mjs";
import {
  baselineOutcomesAt,
  buildIssuedEvaluationReportingView,
  evaluateIssuedForecasts,
  selectLatestPredictionPerWindow,
  verifyIssuedEvaluationArtifact,
} from "../src/model/issued-evaluation.mjs";
import {
  COEFFICIENT_PRIOR_POLICY_VERSION,
  FEATURE_TRANSFORM_VERSION,
  assertModelCompatibility,
  predictHazard,
  trainLogisticHazard,
} from "../src/model/logistic-hazard.mjs";
import {
  assessFoldCoverage,
  causalWindowLabel,
  foldSourceExclusionsAtAnchor,
  fourHourAnchorsWithinFold,
  promoteChallenger,
  recomputeFrozenEvaluationArtifact,
  selectFixedBudgetAlerts,
  summarizeFoldDispositions,
} from "../src/model/evaluation.mjs";
import {
  buildTrainingExamples,
  intervalExposure,
  trainChallenger,
} from "../src/model/training.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  MODEL_ARTIFACT_VERSION,
  MODEL_VERSION_PREFIX,
  modelContractHash,
  modelVersionFor,
} from "../src/model/contract.mjs";
import { settleIssuedPredictions } from "../src/model/settlement.mjs";
import { assessPredictionIntegrity } from "../src/model/prediction-integrity.mjs";
import { AS_OF_MODE } from "../src/model/as-of.mjs";
import { COVERAGE_AS_OF_MODE } from "../src/model/coverage-as-of.mjs";
import {
  adequateCoverageAssertionsAsOf,
  latestCoverageAssertionsAsOf,
} from "../src/model/coverage-as-of.mjs";
import { outcomeAdjudicationContract } from "../src/pipeline/outcomes.mjs";

const frozenEvaluationBlobs = new Map();
const testCoverageEvidence = {
  method: "test_complete_poll",
  complete: true,
};
const testCoverageEvidenceRef = "blob://test/coverage-evidence.json";
const testCoverageEvidenceHash = hashLabel(testCoverageEvidence);

function testCompletenessEvidence(exhaustedAt) {
  return [{
    ref: testCoverageEvidenceRef,
    sha256: testCoverageEvidenceHash,
    method: testCoverageEvidence.method,
    exhausted_at: exhaustedAt,
  }];
}

function bindFrozenEvaluation(evaluation, {
  minimumWindows = 2,
  minimumEvents = 1,
  eventCount = 1,
} = {}) {
  const pairedStatus = evaluation.paired_comparison?.status ?? "not_applicable";
  const rows = evaluation.folds.flatMap((fold, foldIndex) => {
    const firstAnchor = new Date(Date.parse(fold.origin) + 3_600_000);
    return [
      {
        fold_origin: fold.origin,
        anchor: firstAnchor.toISOString(),
        window_end: new Date(firstAnchor.getTime() + 4 * 3_600_000).toISOString(),
        probability: 0.1,
        champion_probability: pairedStatus === "available" ? 0.1 : null,
        baseline_probability: 0.5,
        features_hash: hashLabel(["features", foldIndex, 0]),
        label: 0,
      },
      {
        fold_origin: fold.origin,
        anchor: new Date(firstAnchor.getTime() + 3_600_000).toISOString(),
        window_end: new Date(firstAnchor.getTime() + 5 * 3_600_000).toISOString(),
        probability: 0.9,
        champion_probability: pairedStatus === "available" ? 0.9 : null,
        baseline_probability: 0.5,
        features_hash: hashLabel(["features", foldIndex, 1]),
        label: 1,
      },
    ];
  });
  const folds = evaluation.folds.map((fold) => {
    const foldRows = rows.filter((row) => row.fold_origin === fold.origin);
    return {
      ...fold,
      coverage_fraction: 1,
      evaluated_windows: foldRows.length,
      evaluated_window_hash: hashLabel(foldRows),
    };
  });
  const foldDispositions = folds.map((fold) => ({
    origin: fold.origin,
    end: fold.end,
    status: "accepted",
    evaluated_window_hash: fold.evaluated_window_hash,
  }));
  const alerts = folds.flatMap((fold) =>
    selectFixedBudgetAlerts(
      rows.filter((row) => row.fold_origin === fold.origin),
      2,
    )
  );
  const eventStart = new Date(
    Date.parse(rows.at(-1).anchor) + 30 * 60_000,
  );
  const event = {
    fold_origin: rows.at(-1).fold_origin,
    hit: true,
    settlement: "hit",
    useful_lead_hours: 1.5,
    maximum_prior_probability: 0.9,
    highest_prior_rank: 1,
    alert_rank_cutoff: 2,
    forecast_issued_at: rows.at(-1).anchor,
    ranked_window: {
      start: rows.at(-1).anchor,
      end: rows.at(-1).window_end,
      probability: 0.9,
    },
    policy_peak_window: {
      start: rows.at(-1).anchor,
      end: rows.at(-1).window_end,
      probability: 0.9,
    },
    occurred_time_range: {
      start: eventStart.toISOString(),
      end: new Date(eventStart.getTime() + 30 * 60_000).toISOString(),
    },
  };
  const events = Array.from({ length: eventCount }, (_, index) => ({
    ...event,
    outcome_ref: { record_id: `outcome_sample_${index}`, revision: 1 },
  }));
  const artifact = {
    artifact_version: "reset-evaluation-rows/0.1.0",
    candidate_artifact_hash: evaluation.candidate.artifact_hash,
    evaluation_contract_hash: evaluation.provenance.evaluation_contract_hash,
    alert_policy: {
      type: "fixed_top_n_per_fold",
      budget: 2,
      tie_breaker: "earlier_anchor",
    },
    thresholds: {
      minimum_event_window_recall: 0,
      require_brier_skill_above: -1,
      maximum_expected_calibration_error: 1,
      minimum_live_evaluation_windows: minimumWindows,
      minimum_live_evaluation_events: minimumEvents,
    },
    paired_status: pairedStatus,
    rows,
    alerts,
    events,
    folds,
    fold_dispositions: foldDispositions,
  };
  const recomputed = recomputeFrozenEvaluationArtifact(artifact);
  const blobHash = hashLabel(artifact);
  const blobRef = `blob://test-evaluation/${blobHash.slice("sha256:".length)}.json`;
  frozenEvaluationBlobs.set(blobRef, artifact);
  evaluation.folds = folds;
  evaluation.fold_dispositions = foldDispositions;
  evaluation.events = events;
  evaluation.calibration = recomputed.calibration;
  evaluation.metrics = recomputed.metrics;
  evaluation.gate = recomputed.gate;
  evaluation.provenance.fold_signature = recomputed.fold_signature;
  evaluation.provenance.fold_disposition_hash =
    recomputed.fold_disposition_hash;
  evaluation.provenance.fold_disposition_count = foldDispositions.length;
  evaluation.provenance.rejected_fold_count = 0;
  evaluation.provenance.row_sample_schema_version =
    artifact.artifact_version;
  evaluation.provenance.row_sample_ref = blobRef;
  evaluation.provenance.row_sample_hash = blobHash;
  evaluation.candidate.evaluation_sample_hash =
    recomputed.evaluation_sample_hash;
  evaluation.paired_comparison.fold_signature =
    recomputed.fold_signature;
  evaluation.paired_comparison.sample_hash =
    recomputed.evaluation_sample_hash;
  evaluation.paired_comparison.champion_metrics =
    recomputed.paired_champion_metrics;
  evaluation.paired_comparison.metric_deltas =
    recomputed.paired_metric_deltas;
  evaluation.evaluation_artifact_hash = evaluationArtifactHash(evaluation);
  return evaluation;
}

function observation(id, {
  publishedAt = "2026-07-25T10:00:00.000Z",
  firstSeenAt = "2026-07-25T10:00:00.000Z",
  availabilityAttestation = null,
  ingestProvider = "fixture",
} = {}) {
  return createRecord({
    recordType: "raw_observation",
    naturalKey: id,
    createdAt: firstSeenAt,
    producer: producer("test", "1"),
    data: {
      ingest_provider: ingestProvider,
      provider_item_id: id,
      canonical_url: `https://example.test/${id}`,
      published_at: publishedAt,
      first_seen_at: firstSeenAt,
      fetched_at: firstSeenAt,
      author: {},
      native_relations: [],
      content: { media_type: "text/plain", text: id, language: "en" },
      availability_attestation: availabilityAttestation,
    },
  });
}

function signal(id, source, {
  availableAt = source.data.first_seen_at,
  role = "product_lead",
  eventType = "quota_reset",
  phase = "completed",
  assertedRange = null,
  vendor = "openai",
  createdAt = availableAt,
  competitiveContext = null,
  derivation = role === "aggregator" ? "summarizes" : "primary_statement",
  independenceGroupId = `ind_${id}`,
} = {}) {
  return createRecord({
    recordType: "normalized_signal",
    naturalKey: id,
    createdAt,
    producer: producer("rule-claim-extractor", "test"),
    data: {
      available_at: availableAt,
      observation_refs: [{ record_id: source.record_id, revision: source.revision }],
      claim: {
        event_type: eventType,
        phase,
        stance: "supports",
        asserted_time_range: assertedRange,
        competitive_context: competitiveContext,
        scope: {
          vendor,
          product: "codex",
          population: "platform",
          plans: ["paid"],
          regions: ["global"],
          quota_bucket: null,
        },
      },
      provenance: {
        source_identity_id: "person_tibo_sottiaux",
        source_role: role,
        independence_group_id: independenceGroupId,
        derivation,
      },
      extraction: {
        model: "rule_claim_extractor",
        model_version: "test",
        prompt_version: "test",
        semantic_policy_hash: extractorContract(modelConfig()).semantic_policy_hash,
      },
    },
  });
}

function outcome(id, source, range, knownAt = range.end, {
  replayAvailableAt = null,
  config = modelConfig(),
  independenceGroupId = `ind_${id}`,
} = {}) {
  return createRecord({
    recordType: "reset_outcome",
    naturalKey: id,
    createdAt: knownAt,
    producer: producer(
      "outcome-adjudicator",
      OUTCOME_ADJUDICATOR_VERSION,
      outcomeAdjudicationContract(config),
    ),
    data: {
      status: "confirmed",
      label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
      event_identity: `evt_${id}`,
      event_type: "quota_reset",
      scope: {
        vendor: "openai",
        product: "codex",
        population: "platform",
        plans: ["paid"],
        regions: ["global"],
        quota_bucket: null,
      },
      occurred_time_range: range,
      known_at: knownAt,
      replay_available_at: replayAvailableAt,
      verification: [{
        kind: "official_confirmation",
        observation_ref: { record_id: source.record_id, revision: source.revision },
        independence_group_id: independenceGroupId,
      }],
      candidate_refs: [{ record_id: `candidate_${id}`, revision: 1 }],
    },
  });
}

function modelConfig(overrides = {}) {
  return {
    config_hash: "sha256:test-config",
    taxonomy_version: "reset-taxonomy/test",
    feature_schema_version: "reset-features/test",
    deduplication_version: "reset-dedup/test",
    timezone_database_version: "tzdata-test",
    extractor: {
      model: "rule_claim_extractor",
      model_version: "test",
      prompt_version: "test",
    },
    target: { vendor: "openai", product: "codex", population: "platform" },
    providers: {
      fixture: {
        confirmation_identities: [{ identity_id: "person_tibo_sottiaux" }],
        context_identities: [],
      },
    },
    model: {
      family: "ridge_logistic_discrete_time_hazard",
      outcome_coverage_providers: ["fixture"],
      lambda: 1,
      learning_rate: 0.08,
      gradient_tolerance: 1e-5,
      objective_tolerance: 1e-10,
      hessian_step: 1e-4,
      standardized_feature_clip: 8,
      max_iterations: 250,
      post_outcome_refractory: {
        version:
          "post-outcome-refractory-piecewise-hazard-multiplier/1",
        enabled: false,
        outcome_selection_basis:
          "latest_eligible_confirmed_outcome_available_at_cutoff",
        time_basis: "occurred_time_range_end",
        prior_basis:
          "versioned_non_learned_minimum_inter_event_prior",
        recovery_curve: [
          { elapsed_hours: 0, multiplier: 0.001 },
          { elapsed_hours: 1, multiplier: 0.002 },
          { elapsed_hours: 4, multiplier: 0.01 },
          { elapsed_hours: 8, multiplier: 0.1 },
          { elapsed_hours: 12, multiplier: 1 },
        ],
      },
      coefficient_priors: {},
      minimum_outcomes: 1,
      minimum_live_evaluation_windows: 2,
      minimum_live_evaluation_events: 1,
      maximum_training_days: 30,
      promotion: {
        minimum_event_window_recall: 0,
        top_window_hours_per_week: 2,
        require_brier_skill_above: -1,
        maximum_expected_calibration_error: 1,
      },
      ...overrides,
    },
  };
}

test("partially overlapping event hours use exposure-weighted censoring and purge own confirmation", async () => {
  const confirming = observation("confirm", {
    publishedAt: "2026-07-25T10:30:00.000Z",
    firstSeenAt: "2026-07-25T10:30:00.000Z",
  });
  const range = {
    start: "2026-07-25T10:30:00.000Z",
    end: "2026-07-25T11:30:00.000Z",
  };
  const confirmingSignal = signal("confirmation-signal", confirming, {
    availableAt: range.start,
    assertedRange: range,
  });
  const confirmed = outcome("confirmation-signal", confirming, range, range.end);
  const records = {
    raw_observation: [confirming],
    normalized_signal: [confirmingSignal],
    reset_outcome: [confirmed],
  };
  const store = {
    async all(type) {
      return records[type] ?? [];
    },
  };
  const dataset = await buildTrainingExamples(store, modelConfig(), {
    trainingCutoff: "2026-07-25T13:00:00.000Z",
    coverageIntervals: [{
      start: "2026-07-25T09:00:00.000Z",
      end: "2026-07-25T13:00:00.000Z",
    }],
  });
  const event = dataset.examples.find((example) => example.type === "event_interval");
  assert.deepEqual(event.exposures, [0.5, 0.5]);
  assert.equal(event.interval_assignment, "exposure_weighted_interval_censoring");
  assert.equal(dataset.censoredSlotCount, 2);
  assert.equal(dataset.negativeCount, 2);
  assert.equal(dataset.eventExposureHours, 1);
  assert.ok(event.rows.every((row) => row[FEATURE_NAMES.indexOf("asserted_time_overlap")] === 0));
  assert.equal(
    intervalExposure(
      "2026-07-25T10:00:00.000Z",
      "2026-07-25T11:00:00.000Z",
      range,
    ),
    0.5,
  );
  assert.equal(
    [
      ["2026-07-25T10:00:00.000Z", "2026-07-25T11:00:00.000Z"],
      ["2026-07-25T11:00:00.000Z", "2026-07-25T12:00:00.000Z"],
      ["2026-07-25T12:00:00.000Z", "2026-07-25T13:00:00.000Z"],
    ].reduce((sum, [start, end]) => sum + intervalExposure(start, end, {
      start: "2026-07-25T10:15:00.000Z",
      end: "2026-07-25T12:45:00.000Z",
    }), 0),
    2.5,
  );
});

test("confirmed positives outside covered negative-label hours still enter training", async () => {
  const confirming = observation("recent-confirmation", {
    publishedAt: "2026-07-25T14:30:00.000Z",
    firstSeenAt: "2026-07-25T14:35:00.000Z",
  });
  const range = {
    start: "2026-07-25T14:30:00.000Z",
    end: "2026-07-25T15:30:00.000Z",
  };
  const confirmingSignal = signal("recent-confirmation", confirming, {
    availableAt: "2026-07-25T14:35:00.000Z",
    assertedRange: range,
  });
  const confirmed = outcome(
    "recent-confirmation",
    confirming,
    range,
    "2026-07-25T15:35:00.000Z",
  );
  const records = {
    raw_observation: [confirming],
    normalized_signal: [confirmingSignal],
    reset_outcome: [confirmed],
  };
  const dataset = await buildTrainingExamples({
    async all(type) {
      return records[type] ?? [];
    },
  }, modelConfig(), {
    trainingCutoff: "2026-07-25T16:00:00.000Z",
    coverageIntervals: [{
      start: "2026-07-25T09:00:00.000Z",
      end: "2026-07-25T13:00:00.000Z",
    }],
  });

  const event = dataset.examples.find((example) => example.type === "event_interval");
  assert.equal(dataset.eventCount, 1);
  assert.deepEqual(event.exposures, [0.5, 0.5]);
  assert.equal(event.outcome_ref.record_id, confirmed.record_id);
  assert.equal(dataset.negativeCount, 4);
  assert.equal(dataset.censoredSlotCount, 0);
});

test("legacy started confirmations are censored instead of becoming labels or negatives", async () => {
  const source = observation("legacy-started", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const range = {
    start: "2026-07-25T10:00:00.000Z",
    end: "2026-07-25T11:00:00.000Z",
  };
  const started = signal("legacy-started", source, {
    availableAt: range.start,
    phase: "started",
    assertedRange: range,
  });
  started.data.claim.scope.population = "platform";
  const legacy = outcome("legacy-started", source, range, range.end);
  legacy.data.event_type = "quota_reset";
  legacy.data.verification[0].kind = "official_confirmation";
  const records = {
    raw_observation: [source],
    normalized_signal: [started],
    reset_outcome: [legacy],
  };
  const dataset = await buildTrainingExamples({
    async all(type) {
      return records[type] ?? [];
    },
  }, modelConfig(), {
    trainingCutoff: "2026-07-25T12:00:00.000Z",
    coverageIntervals: [{
      start: "2026-07-25T09:00:00.000Z",
      end: "2026-07-25T12:00:00.000Z",
    }],
  });
  assert.equal(dataset.eventCount, 0);
  assert.equal(dataset.ambiguousOutcomeCount, 1);
  assert.equal(dataset.censoredSlotCount, 1);
  assert.equal(dataset.negativeCount, 2);
});

test("archive training uses attested replay clocks while live features keep canonical clocks", async () => {
  const archiveAvailableAt = "2026-06-10T10:00:00.000Z";
  const importedAt = "2026-07-25T10:00:00.000Z";
  const source = observation("archive-completion", {
    publishedAt: archiveAvailableAt,
    firstSeenAt: importedAt,
    availabilityAttestation: {
      available_at: archiveAvailableAt,
      basis: "direct_source_publication",
      attestor_url: "https://example.test/archive-completion",
      verified_at: importedAt,
      method: "test",
    },
  });
  const range = {
    start: archiveAvailableAt,
    end: "2026-06-10T11:00:00.000Z",
  };
  const archivedSignal = signal("archive-completion", source, {
    availableAt: archiveAvailableAt,
    createdAt: importedAt,
    assertedRange: range,
  });
  const archivedOutcome = outcome(
    "archive-completion",
    source,
    range,
    importedAt,
    { replayAvailableAt: range.end },
  );
  const records = {
    raw_observation: [source],
    normalized_signal: [archivedSignal],
    reset_outcome: [archivedOutcome],
  };
  const store = {
    async all(type) {
      return records[type] ?? [];
    },
  };
  const dataset = await buildTrainingExamples(store, modelConfig(), {
    trainingCutoff: "2026-06-10T13:00:00.000Z",
    coverageIntervals: [{
      start: "2026-06-10T09:00:00.000Z",
      end: "2026-06-10T13:00:00.000Z",
    }],
  });
  assert.equal(dataset.asOfMode, AS_OF_MODE.ARCHIVE_REPLAY);
  assert.equal(dataset.eventCount, 1);

  const featureArgs = {
    targetTime: "2026-06-10T12:00:00.000Z",
    knowledgeCutoff: "2026-06-10T12:00:00.000Z",
    signals: [archivedSignal],
    outcomes: [archivedOutcome],
    observations: [source],
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor: extractorContract(modelConfig()),
    targetScope: modelConfig().target,
  };
  const live = featureVectorAt(featureArgs).features;
  const replay = featureVectorAt({
    ...featureArgs,
    asOfMode: AS_OF_MODE.ARCHIVE_REPLAY,
  }).features;
  assert.equal(live.renewal_periodic_kernel, 0);
  assert.ok(replay.renewal_periodic_kernel > 0);
});

test("event-time risk sets censor anchors inside an outcome and fixed alerts spend one budget", () => {
  const event = {
    data: {
      occurred_time_range: {
        start: "2026-07-25T10:30:00.000Z",
        end: "2026-07-25T11:30:00.000Z",
      },
    },
  };
  assert.equal(
    causalWindowLabel(
      "2026-07-25T10:00:00.000Z",
      "2026-07-25T14:00:00.000Z",
      [event],
    ),
    1,
  );
  assert.equal(
    causalWindowLabel(
      "2026-07-25T11:00:00.000Z",
      "2026-07-25T15:00:00.000Z",
      [event],
    ),
    null,
  );
  const rows = [
    { anchor: "2026-07-25T00:00:00.000Z", probability: 0.8 },
    { anchor: "2026-07-25T01:00:00.000Z", probability: 0.9 },
    { anchor: "2026-07-25T02:00:00.000Z", probability: 0.7 },
  ];
  assert.deepEqual(
    selectFixedBudgetAlerts(rows, 2).map((row) => row.anchor),
    ["2026-07-25T01:00:00.000Z", "2026-07-25T00:00:00.000Z"],
  );
});

test("walk-forward exclusions release a fold outcome after its as-of availability boundary", () => {
  const foldOutcome = {
    record_id: "out_fold_event",
    revision: 1,
    supersedes: null,
    data: {
      known_at: "2026-07-10T11:00:00.000Z",
      replay_available_at: "2026-07-10T10:00:00.000Z",
      verification: [{
        observation_ref: {
          record_id: "obs_fold_event",
          revision: 1,
        },
        independence_group_id: "ind_fold_event",
      }],
    },
  };
  const beforeLive = foldSourceExclusionsAtAnchor(
    [foldOutcome],
    "2026-07-10T10:30:00.000Z",
    AS_OF_MODE.LIVE,
  );
  const afterLive = foldSourceExclusionsAtAnchor(
    [foldOutcome],
    "2026-07-10T11:00:00.000Z",
    AS_OF_MODE.LIVE,
  );
  const afterArchiveReplay = foldSourceExclusionsAtAnchor(
    [foldOutcome],
    "2026-07-10T10:00:00.000Z",
    AS_OF_MODE.ARCHIVE_REPLAY,
  );

  assert.equal(beforeLive.recordIds.has(foldOutcome.record_id), true);
  assert.equal(beforeLive.independenceGroupIds.has("ind_fold_event"), true);
  assert.equal(afterLive.recordIds.size, 0);
  assert.equal(afterArchiveReplay.recordIds.size, 0);
});

test("as-issued metrics deduplicate a window to its latest pre-start issuance and bind exact rows", async () => {
  const windowStart = "2026-07-25T12:00:00.000Z";
  const makePrediction = (id, issuedAt, probability) => createRecord({
    recordType: "prediction",
    naturalKey: id,
    createdAt: issuedAt,
    producer: producer("test", "1"),
    data: {
      issued_at: issuedAt,
      knowledge_cutoff: issuedAt,
      slots: Array.from({ length: 4 }, (_, index) => ({
        start: new Date(Date.parse(windowStart) + index * 3_600_000).toISOString(),
        end: new Date(Date.parse(windowStart) + (index + 1) * 3_600_000).toISOString(),
        rolling_4h_probability: index === 0 ? probability : null,
      })),
      model: { version: `model-${id}` },
    },
  });
  const early = makePrediction("early", "2026-07-25T10:00:00.000Z", 0.1);
  const late = makePrediction("late", "2026-07-25T11:00:00.000Z", 0.8);
  assert.deepEqual(
    selectLatestPredictionPerWindow([late, early]).selected.map((item) => item.record_id),
    [late.record_id],
  );
  const makeSettlement = (prediction) => createRecord({
    recordType: "prediction_settlement",
    naturalKey: `settlement-${prediction.record_id}`,
    createdAt: "2026-07-25T17:00:00.000Z",
    producer: producer("test", "1"),
    data: {
      prediction_ref: {
        record_id: prediction.record_id,
        revision: prediction.revision,
      },
      status: "negative",
      settled_at: "2026-07-25T17:00:00.000Z",
    },
  });
  const earlySettlement = makeSettlement(early);
  const lateSettlement = makeSettlement(late);
  const assertion = {
    assertion_id: "issued-coverage",
    revision: 1,
    provider: "fixture",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-25T16:00:00.000Z",
    adequacy: "negative_label_eligible",
    revoked: false,
    asserted_at: "2026-07-25T16:00:00.000Z",
    evidence_refs: testCompletenessEvidence(
      "2026-07-25T16:00:00.000Z",
    ),
  };
  const laterCoverage = {
    ...assertion,
    assertion_id: "issued-coverage-added-later",
    asserted_at: "2026-07-26T00:00:00.000Z",
  };
  const baselineCoverage = {
    assertion_id: "issued-baseline-coverage",
    revision: 1,
    provider: "fixture",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-25T11:00:00.000Z",
    adequacy: "negative_label_eligible",
    revoked: false,
    asserted_at: "2026-07-25T11:00:00.000Z",
    evidence_refs: testCompletenessEvidence(
      "2026-07-25T11:00:00.000Z",
    ),
  };
  const priorSource = observation("issued-prior-outcome", {
    publishedAt: "2026-07-20T10:00:00.000Z",
    firstSeenAt: "2026-07-20T10:00:00.000Z",
  });
  const priorSignal = signal("issued-prior-outcome", priorSource, {
    availableAt: "2026-07-20T10:00:00.000Z",
    assertedRange: {
      start: "2026-07-20T10:00:00.000Z",
      end: "2026-07-20T11:00:00.000Z",
    },
  });
  const priorOutcome = outcome("issued-prior-outcome", priorSource, {
    start: "2026-07-20T10:00:00.000Z",
    end: "2026-07-20T11:00:00.000Z",
  }, "2026-07-20T11:00:00.000Z");
  const lateCorrection = structuredClone(priorOutcome);
  lateCorrection.revision = 2;
  lateCorrection.supersedes = {
    record_id: priorOutcome.record_id,
    revision: priorOutcome.revision,
  };
  lateCorrection.created_at = "2026-07-25T18:00:00.000Z";
  lateCorrection.data.status = "rejected";
  for (const settlement of [earlySettlement, lateSettlement]) {
    settlement.data.outcome_as_of_mode = AS_OF_MODE.LIVE;
    settlement.data.coverage_as_of_mode = COVERAGE_AS_OF_MODE.LIVE;
    settlement.data.coverage_assertion_refs = [{
      assertion_id: assertion.assertion_id,
      revision: assertion.revision,
    }];
    settlement.data.coverage_assertion_snapshot_hash = hashLabel([assertion]);
    settlement.data.coverage = {
      complete: true,
      providers: ["fixture"],
    };
  }
  let written = null;
  const issuedBlobs = new Map();
  const summary = await evaluateIssuedForecasts({
    async all(type) {
      if (type === "prediction") return [early, late];
      if (type === "prediction_settlement") return [earlySettlement, lateSettlement];
      if (type === "raw_observation") return [priorSource];
      if (type === "normalized_signal") return [priorSignal];
      if (type === "reset_outcome") return [priorOutcome, lateCorrection];
      return [];
    },
    async allAudit() {
      return [assertion, baselineCoverage, laterCoverage];
    },
    async writeBlob(_namespace, id, payload) {
      const ref = `blob://issued-test/${id}.json`;
      issuedBlobs.set(ref, structuredClone(payload));
      return ref;
    },
    async readBlob(ref) {
      return ref === testCoverageEvidenceRef
        ? testCoverageEvidence
        : structuredClone(issuedBlobs.get(ref));
    },
    async readState(_name, fallback) {
      return fallback;
    },
    async writeState(_name, value) {
      written = value;
    },
  }, modelConfig(), {
    evaluationCutoff: "2026-07-26T00:00:00.000Z",
  });
  assert.equal(summary, written);
  assert.equal(summary.metrics.evaluated_windows, 1);
  assert.equal(summary.metrics.duplicate_issued_predictions_excluded, 1);
  assert.deepEqual(summary.provenance.prediction_snapshot_refs, [{
    record_id: late.record_id,
    revision: late.revision,
    data_hash: hashLabel(late.data),
  }]);
  assert.deepEqual(summary.provenance.settlement_snapshot_refs, [{
    record_id: lateSettlement.record_id,
    revision: lateSettlement.revision,
    data_hash: hashLabel(lateSettlement.data),
  }]);
  assert.equal(
    summary.provenance.prediction_snapshot_hash,
    hashLabel(summary.provenance.prediction_snapshot_refs),
  );
  assert.equal(
    summary.provenance.settlement_snapshot_hash,
    hashLabel(summary.provenance.settlement_snapshot_refs),
  );
  assert.match(summary.provenance.row_sample_hash, /^sha256:/);
  assert.equal(
    summary.evaluation_artifact_hash,
    evaluationArtifactHash(summary),
  );
  assert.equal((await verifyIssuedEvaluationArtifact({
    async readBlob(ref) {
      return structuredClone(issuedBlobs.get(ref));
    },
  }, summary)).valid, true);
  const tamperedIssued = structuredClone(summary);
  tamperedIssued.metrics.brier_score = 0.99;
  tamperedIssued.evaluation_artifact_hash =
    evaluationArtifactHash(tamperedIssued);
  assert.equal((await verifyIssuedEvaluationArtifact({
    async readBlob(ref) {
      return structuredClone(issuedBlobs.get(ref));
    },
  }, tamperedIssued)).reason, "evaluation_recomputed_summary_mismatch");
  const withoutAdditionalFutureCoverage = await evaluateIssuedForecasts({
    async all(type) {
      if (type === "prediction") return [early, late];
      if (type === "prediction_settlement") return [earlySettlement, lateSettlement];
      if (type === "raw_observation") return [priorSource];
      if (type === "normalized_signal") return [priorSignal];
      if (type === "reset_outcome") return [priorOutcome];
      return [];
    },
    async allAudit() {
      return [assertion, baselineCoverage];
    },
    async writeBlob(_namespace, id, payload) {
      const ref = `blob://issued-test/${id}.json`;
      issuedBlobs.set(ref, structuredClone(payload));
      return ref;
    },
    async readBlob(ref) {
      return ref === testCoverageEvidenceRef
        ? testCoverageEvidence
        : structuredClone(issuedBlobs.get(ref));
    },
    async readState(_name, fallback) {
      return fallback;
    },
    async writeState() {},
  }, modelConfig(), {
    evaluationCutoff: "2026-07-26T00:00:00.000Z",
  });
  assert.equal(
    summary.metrics.baseline_brier_score,
    withoutAdditionalFutureCoverage.metrics.baseline_brier_score,
  );
  assert.equal(
    summary.provenance.row_sample_hash,
    withoutAdditionalFutureCoverage.provenance.row_sample_hash,
  );
});

test("issued reporting view excludes earlier model releases and reranks the fixed policy", () => {
  const row = ({ id, start, probability, label, modelVersion }) => ({
    prediction_ref: { record_id: id, revision: 1 },
    settlement_ref: { record_id: `settlement-${id}`, revision: 1 },
    issued_at: start,
    knowledge_cutoff: start,
    window_start: start,
    window_end: addHours(new Date(start), 4).toISOString(),
    probability,
    baseline_probability: 0.02,
    label,
    model_version: modelVersion,
  });
  const artifact = {
    artifact_version: "reset-issued-evaluation-rows/0.1.0",
    alert_policy: {
      type: "fixed_top_n_per_calendar_week",
      budget: 2,
      tie_breaker: "probability_desc_then_window_start",
    },
    thresholds: {
      minimum_event_window_recall: 0.8,
      require_brier_skill_above: 0,
      maximum_expected_calibration_error: 0.1,
    },
    duplicate_predictions_excluded_count: 0,
    rows: [
      row({
        id: "old-release",
        start: "2026-07-27T05:00:00.000Z",
        probability: 0.99,
        label: 0,
        modelVersion: "reset-model/0.3.1-oldhash",
      }),
      row({
        id: "current-negative",
        start: "2026-07-27T00:00:00.000Z",
        probability: 0.49,
        label: 0,
        modelVersion: "reset-model/0.3.2-fit-a",
      }),
      row({
        id: "current-positive",
        start: "2026-07-27T10:00:00.000Z",
        probability: 0.4,
        label: 1,
        modelVersion: "reset-model/0.3.2-fit-b",
      }),
    ],
    alerts: [],
    events: [{
      outcome_ref: { record_id: "outcome-current", revision: 1 },
      occurred_time_range: {
        start: "2026-07-27T12:00:00.000Z",
        end: "2026-07-27T13:00:00.000Z",
        precision: "hour",
      },
    }],
  };

  const view = buildIssuedEvaluationReportingView(artifact, {
    sourceEvaluationArtifactHash: "sha256:source",
  });
  assert.equal(view.status, "available");
  assert.equal(view.model_release, "reset-model/0.3.2");
  assert.deepEqual(view.model_versions, [
    "reset-model/0.3.2-fit-a",
    "reset-model/0.3.2-fit-b",
  ]);
  assert.equal(view.metrics.evaluated_windows, 2);
  assert.equal(view.metrics.evaluated_events, 1);
  assert.equal(view.metrics.event_window_recall, 1);
  assert.equal(view.metrics.false_probability_ge_0_5_windows, 0);
  assert.equal(view.metrics.false_alerts_top_n_policy, 1);
  assert.equal(view.false_alerts.policy_selected_episodes, 2);
  assert.equal(view.false_alerts.policy_selected_non_event_episodes, 1);
  assert.equal(view.events[0].hit, true);
  assert.equal(view.audit_context.excluded_earlier_release_windows, 1);
  assert.equal(view.source_evaluation_artifact_hash, "sha256:source");

  const waiting = buildIssuedEvaluationReportingView(artifact, {
    modelRelease: "reset-model/0.4.0",
  });
  assert.equal(waiting.status, "waiting_for_mature_rows");
});

test("issued baseline numerator uses the same covered maximum-age risk window as its denominator", () => {
  const makeOutcome = (knownAt, start, end) => ({
    data: {
      known_at: knownAt,
      occurred_time_range: { start, end },
    },
  });
  const cutoff = "2026-07-25T12:00:00.000Z";
  const eligible = makeOutcome(
    "2026-07-20T11:00:00.000Z",
    "2026-07-20T10:00:00.000Z",
    "2026-07-20T11:00:00.000Z",
  );
  const tooOld = makeOutcome(
    "2026-06-01T11:00:00.000Z",
    "2026-06-01T10:00:00.000Z",
    "2026-06-01T11:00:00.000Z",
  );
  const uncovered = makeOutcome(
    "2026-07-22T11:00:00.000Z",
    "2026-07-22T10:00:00.000Z",
    "2026-07-22T11:00:00.000Z",
  );
  const learnedLater = makeOutcome(
    "2026-07-26T00:00:00.000Z",
    "2026-07-21T10:00:00.000Z",
    "2026-07-21T11:00:00.000Z",
  );
  const selected = baselineOutcomesAt(
    [eligible, tooOld, uncovered, learnedLater],
    cutoff,
    [{
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
    }],
    30,
  );
  assert.deepEqual(selected, [eligible]);
});

test("walk-forward four-hour windows stay inside their frozen fold", () => {
  const origin = new Date("2026-07-20T00:00:00.000Z");
  const end = new Date("2026-07-27T00:00:00.000Z");
  const anchors = fourHourAnchorsWithinFold(origin, end);
  assert.equal(anchors.length, 165);
  assert.equal(anchors.at(-1).toISOString(), "2026-07-26T20:00:00.000Z");
  assert.equal(
    new Date(anchors.at(-1).getTime() + 4 * 3_600_000).toISOString(),
    end.toISOString(),
  );
  const lastFoldEvent = {
    data: {
      occurred_time_range: {
        start: "2026-07-26T23:30:00.000Z",
        end: "2026-07-27T00:00:00.000Z",
      },
    },
  };
  assert.equal(
    causalWindowLabel(anchors.at(-1), end, [lastFoldEvent]),
    1,
  );
  const complete = assessFoldCoverage(origin, end, [{
    start: origin.toISOString(),
    end: end.toISOString(),
  }]);
  assert.equal(complete.requiredAnchorCount, 165);
  assert.equal(complete.coveredAnchorCount, 165);
  assert.equal(complete.coverageFraction, 1);
  assert.equal(complete.eligible, true);
  const sparse = assessFoldCoverage(origin, end, [{
    start: origin.toISOString(),
    end: new Date(origin.getTime() + 10 * 3_600_000).toISOString(),
  }]);
  assert.ok(sparse.coverageFraction < 0.1);
  assert.equal(sparse.eligible, false);
  const dispositions = summarizeFoldDispositions([
    {
      origin: origin.toISOString(),
      end: end.toISOString(),
      status: "accepted",
      evaluated_window_hash: "sha256:accepted",
    },
    {
      origin: end.toISOString(),
      end: new Date(end.getTime() + 168 * 3_600_000).toISOString(),
      status: "rejected",
      reason: "challenger_nonconverged",
      diagnostic_hash: "sha256:diagnostic",
    },
  ]);
  assert.equal(dispositions.count, 2);
  assert.equal(dispositions.rejected_count, 1);
  assert.equal(dispositions.passed, false);
  assert.equal(dispositions.disposition_hash, hashLabel([
    {
      origin: origin.toISOString(),
      end: end.toISOString(),
      status: "accepted",
      evaluated_window_hash: "sha256:accepted",
    },
    {
      origin: end.toISOString(),
      end: new Date(end.getTime() + 168 * 3_600_000).toISOString(),
      status: "rejected",
      reason: "challenger_nonconverged",
      diagnostic_hash: "sha256:diagnostic",
    },
  ]));
});

test("aggregator recency comes from source publication time, never current first_seen time", () => {
  const oldSource = observation("old-summary", {
    publishedAt: "2026-06-01T00:00:00.000Z",
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const unknownTimeSource = observation("unknown-summary", {
    publishedAt: null,
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const features = featureVectorAt({
    targetTime: "2026-07-25T12:00:00.000Z",
    knowledgeCutoff: "2026-07-25T12:00:00.000Z",
    signals: [
      signal("old-release", oldSource, {
        role: "aggregator",
        eventType: "release",
        phase: "observed",
        vendor: "other",
      }),
      signal("unknown-release", unknownTimeSource, {
        role: "aggregator",
        eventType: "release",
        phase: "observed",
        vendor: "other",
      }),
    ],
    outcomes: [],
    observations: [oldSource, unknownTimeSource],
  }).features;
  assert.equal(features.competitor_model_release_decay, 0);
});

test("competition context uses actual releases and is not amplified by post volume", () => {
  const firstSource = observation("competition-release-1", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:05:00.000Z",
  });
  const secondSource = observation("competition-release-2", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:06:00.000Z",
  });
  const context = {
    kind: "model_release",
    relevance: "adjacent",
    stage: "rolled_out",
  };
  const first = signal("competition-release-1", firstSource, {
    role: "official",
    eventType: "competitor_model_release",
    vendor: "other",
    competitiveContext: context,
  });
  const second = signal("competition-release-2", secondSource, {
    role: "community",
    eventType: "competitor_model_release",
    vendor: "other",
    competitiveContext: context,
  });
  const args = {
    targetTime: "2026-07-25T12:00:00.000Z",
    knowledgeCutoff: "2026-07-25T12:00:00.000Z",
    outcomes: [],
    observations: [firstSource, secondSource],
  };
  const one = featureVectorAt({ ...args, signals: [first] }).features;
  const repeated = featureVectorAt({
    ...args,
    signals: [first, second],
  }).features;
  assert.ok(one.competitor_model_release_decay > 0);
  assert.equal(
    repeated.competitor_model_release_decay,
    one.competitor_model_release_decay,
  );

  const rumor = structuredClone(first);
  rumor.data.claim.competitive_context.stage = "rumor";
  assert.equal(
    featureVectorAt({ ...args, signals: [rumor] }).features
      .competitor_model_release_decay,
    0,
  );
});

test("reposts never inherit an authority source's reset or incident weight", () => {
  const source = observation("authority-repost", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:05:00.000Z",
  });
  const common = {
    targetTime: "2026-07-25T12:00:00.000Z",
    knowledgeCutoff: "2026-07-25T12:00:00.000Z",
    outcomes: [],
    observations: [source],
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor: extractorContract(modelConfig()),
    targetScope: modelConfig().target,
  };
  const incidentPrimary = signal("incident-primary", source, {
    eventType: "incident",
  });
  const incidentRepost = signal("incident-repost", source, {
    eventType: "incident",
    derivation: "repost",
  });
  const primaryIncidentFeatures = featureVectorAt({
    ...common,
    signals: [incidentPrimary],
  }).features;
  const repostIncidentFeatures = featureVectorAt({
    ...common,
    signals: [incidentRepost],
  }).features;
  assert.ok(primaryIncidentFeatures.official_incident_decay > 0);
  assert.equal(repostIncidentFeatures.official_incident_decay, 0);

  const assertedRange = {
    start: "2026-07-25T12:00:00.000Z",
    end: "2026-07-25T13:00:00.000Z",
  };
  const resetPrimary = signal("reset-primary", source, {
    phase: "scheduled",
    assertedRange,
  });
  const resetRepost = signal("reset-repost", source, {
    phase: "scheduled",
    assertedRange,
    derivation: "repost",
  });
  const primaryResetFeatures = featureVectorAt({
    ...common,
    signals: [resetPrimary],
  }).features;
  const repostResetFeatures = featureVectorAt({
    ...common,
    signals: [resetRepost],
  }).features;
  assert.equal(primaryResetFeatures.asserted_time_overlap, 1);
  assert.equal(repostResetFeatures.asserted_time_overlap, 0.35);
});

test("coverage asserted in the future cannot alter an older feature cutoff", () => {
  const args = {
    targetTime: "2026-07-20T12:00:00.000Z",
    knowledgeCutoff: "2026-07-20T12:00:00.000Z",
    signals: [],
    outcomes: [],
    observations: [],
    coverageIntervals: [{
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
    }],
  };
  const baseline = featureVectorAt({
    ...args,
    coverageAssertionRecords: [],
  }).dataQuality;
  const withFutureAssertion = featureVectorAt({
    ...args,
    coverageAssertionRecords: [{
      assertion_id: "future-coverage",
      revision: 1,
      adequacy: "negative_label_eligible",
      revoked: false,
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
      asserted_at: "2026-07-22T00:00:00.000Z",
    }],
  }).dataQuality;
  assert.equal(
    withFutureAssertion.provider_coverage,
    baseline.provider_coverage,
  );
  assert.equal(
    withFutureAssertion.max_delay_seconds,
    baseline.max_delay_seconds,
  );

  const firstRevision = {
    assertion_id: "revised-coverage",
    revision: 1,
    provider: "fixture",
    adequacy: "negative_label_eligible",
    revoked: false,
    start: "2026-07-20T00:00:00.000Z",
    end: "2026-07-21T00:00:00.000Z",
    asserted_at: "2026-07-20T10:00:00.000Z",
  };
  const futureRevocation = {
    ...firstRevision,
    revision: 2,
    revoked: true,
    asserted_at: "2026-07-22T00:00:00.000Z",
  };
  const beforeRevocation = featureVectorAt({
    ...args,
    coverageAssertionRecords: [firstRevision, futureRevocation],
  }).dataQuality;
  assert.equal(beforeRevocation.provider_coverage, 1);
  const visibleRevocation = featureVectorAt({
    ...args,
    coverageAssertionRecords: [
      firstRevision,
      { ...futureRevocation, asserted_at: "2026-07-20T11:00:00.000Z" },
    ],
  }).dataQuality;
  assert.equal(visibleRevocation.provider_coverage, 0.1);
});

test("feature selection filters extractor rollback revisions before selecting the current signal", () => {
  const source = observation("extractor-rollback", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const expectedExtractor = {
    model: "rules-v2",
    model_version: "2",
    prompt_version: "prompt-v2",
    semantic_policy_hash: "sha256:test-semantic-policy",
  };
  const valid = signal("extractor-v2", source, {
    availableAt: "2026-07-25T10:00:00.000Z",
    phase: "scheduled",
    createdAt: "2026-07-25T10:00:00.000Z",
  });
  valid.producer.version = "2";
  valid.data.extraction = { ...expectedExtractor };
  const rollback = signal("extractor-rollback-v1", source, {
    availableAt: "2026-07-25T11:00:00.000Z",
    eventType: "release",
    vendor: "other",
    createdAt: "2026-07-25T11:00:00.000Z",
  });
  rollback.producer.version = "1";
  rollback.data.extraction = {
    model: expectedExtractor.model,
    model_version: expectedExtractor.model_version,
    prompt_version: expectedExtractor.prompt_version,
  };
  assert.equal(matchesExpectedExtractor(valid, expectedExtractor), true);
  assert.equal(matchesExpectedExtractor(rollback, expectedExtractor), false);
  const vector = featureVectorAt({
    targetTime: "2026-07-25T12:00:00.000Z",
    knowledgeCutoff: "2026-07-25T12:00:00.000Z",
    signals: [valid, rollback],
    outcomes: [],
    observations: [source],
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor,
  });
  assert.deepEqual(vector.sourceRecords, [valid]);
  assert.equal(vector.features.competitor_model_release_decay, 0);
});

test("settlement never backdates future coverage into an older live cutoff", async () => {
  const windowStart = Date.parse("2026-07-25T12:00:00.000Z");
  const prediction = createRecord({
    recordType: "prediction",
    naturalKey: "future-coverage-settlement",
    createdAt: "2026-07-25T11:00:00.000Z",
    producer: producer("test", "1"),
    data: {
      slots: Array.from({ length: 4 }, (_, index) => ({
        start: new Date(windowStart + index * 3_600_000).toISOString(),
        end: new Date(windowStart + (index + 1) * 3_600_000).toISOString(),
      })),
    },
  });
  const futureCoverage = {
    assertion_id: "future-settlement-coverage",
    revision: 1,
    provider: "fixture",
    start: "2026-07-25T12:00:00.000Z",
    end: "2026-07-25T16:00:00.000Z",
    adequacy: "negative_label_eligible",
    revoked: false,
    asserted_at: "2026-07-25T18:00:00.000Z",
    mode: "fixture_declared_complete",
    evidence_refs: [{
      kind: "fixture_manifest",
      method: "synthetic_fixture_manifest",
    }],
  };
  const store = {
    async all(type) {
      return type === "prediction" ? [prediction] : [];
    },
    async allAudit() {
      return [futureCoverage];
    },
    async appendMany(records) {
      return records.map(() => ({ inserted: true }));
    },
  };
  const result = await settleIssuedPredictions(store, modelConfig(), {
    settlementCutoff: "2026-07-25T17:00:00.000Z",
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].data.status, "censored");
  assert.equal(result.records[0].data.coverage.complete, false);
  assert.equal(result.records[0].data.outcome_as_of_mode, AS_OF_MODE.LIVE);
  assert.equal(
    result.records[0].data.coverage_as_of_mode,
    COVERAGE_AS_OF_MODE.LIVE,
  );
});

test("coverage supersession revises settlement and preserves exact assertion lineage", async () => {
  const windowStart = Date.parse("2026-07-25T12:00:00.000Z");
  const prediction = createRecord({
    recordType: "prediction",
    naturalKey: "settlement-coverage-revision",
    createdAt: "2026-07-25T11:00:00.000Z",
    producer: producer("test", "1"),
    data: {
      slots: Array.from({ length: 4 }, (_, index) => ({
        start: new Date(windowStart + index * 3_600_000).toISOString(),
        end: new Date(windowStart + (index + 1) * 3_600_000).toISOString(),
      })),
    },
  });
  const coverageRevisionOne = {
    assertion_id: "settlement-revision-coverage",
    revision: 1,
    provider: "fixture",
    start: "2026-07-25T12:00:00.000Z",
    end: "2026-07-25T16:00:00.000Z",
    adequacy: "negative_label_eligible",
    revoked: false,
    asserted_at: "2026-07-25T16:00:00.000Z",
    evidence_refs: testCompletenessEvidence(
      "2026-07-25T16:00:00.000Z",
    ),
  };
  const revokedRevision = {
    ...coverageRevisionOne,
    revision: 2,
    revoked: true,
    asserted_at: "2026-07-25T18:00:00.000Z",
  };
  let coverageRevisions = [coverageRevisionOne];
  let existingSettlements = [];
  const store = {
    async all(type) {
      if (type === "prediction") return [prediction];
      if (type === "prediction_settlement") return existingSettlements;
      return [];
    },
    async allAudit() {
      return coverageRevisions;
    },
    async readBlob() {
      return testCoverageEvidence;
    },
    async appendMany(records) {
      return records.map(() => ({ inserted: true }));
    },
  };
  const initial = await settleIssuedPredictions(store, modelConfig(), {
    settlementCutoff: "2026-07-25T17:00:00.000Z",
  });
  assert.equal(initial.records[0].data.status, "negative");
  assert.deepEqual(initial.records[0].data.coverage_assertion_refs, [{
    assertion_id: coverageRevisionOne.assertion_id,
    revision: 1,
  }]);
  assert.equal(
    initial.records[0].data.coverage_assertion_snapshot_hash,
    hashLabel([coverageRevisionOne]),
  );

  existingSettlements = initial.records;
  coverageRevisions = [coverageRevisionOne, revokedRevision];
  const revised = await settleIssuedPredictions(store, modelConfig(), {
    settlementCutoff: "2026-07-25T19:00:00.000Z",
  });
  assert.equal(revised.records.length, 1);
  assert.equal(revised.records[0].revision, 2);
  assert.deepEqual(revised.records[0].supersedes, {
    record_id: initial.records[0].record_id,
    revision: initial.records[0].revision,
  });
  assert.equal(revised.records[0].data.status, "censored");
  assert.deepEqual(revised.records[0].data.coverage_assertion_refs, []);
  assert.equal(
    revised.records[0].data.coverage_assertion_snapshot_hash,
    hashLabel([]),
  );
});

test("archive coverage replay requires an independently attested availability clock", () => {
  const assertion = {
    assertion_id: "archive-coverage",
    revision: 1,
    provider: "archive",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-08T00:00:00.000Z",
    adequacy: "negative_label_eligible",
    asserted_at: "2026-07-25T00:00:00.000Z",
    replay_available_at: "2026-07-08T01:00:00.000Z",
    evidence_refs: [{
      kind: "independent_completeness_attestation",
      method: "signed-archive-manifest",
      replay_available_at: "2026-07-08T01:00:00.000Z",
    }],
  };
  assert.equal(
    adequateCoverageAssertionsAsOf(
      [assertion],
      "2026-07-09T00:00:00.000Z",
      ["archive"],
      COVERAGE_AS_OF_MODE.LIVE,
    ).length,
    0,
  );
  assert.equal(
    adequateCoverageAssertionsAsOf(
      [assertion],
      "2026-07-08T00:30:00.000Z",
      ["archive"],
      COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY,
    ).length,
    0,
  );
  assert.equal(
    adequateCoverageAssertionsAsOf(
      [assertion],
      "2026-07-09T00:00:00.000Z",
      ["archive"],
      COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY,
    ).length,
    1,
  );
  const millisecondAssertion = {
    ...assertion,
    assertion_id: "live-coverage-millisecond-cutoff",
    asserted_at: "2026-07-25T00:00:00.293Z",
  };
  assert.equal(
    latestCoverageAssertionsAsOf(
      [millisecondAssertion],
      new Date("2026-07-25T00:00:00.293Z"),
      ["archive"],
      COVERAGE_AS_OF_MODE.LIVE,
    ).length,
    1,
  );
});

test("training negatives use the latest coverage revision available at the training cutoff", async () => {
  const revisionOne = {
    assertion_id: "training-coverage",
    revision: 1,
    provider: "fixture",
    start: "2026-07-25T09:00:00.000Z",
    end: "2026-07-25T13:00:00.000Z",
    adequacy: "negative_label_eligible",
    revoked: false,
    asserted_at: "2026-07-25T13:07:18.000Z",
    evidence_refs: testCompletenessEvidence(
      "2026-07-25T13:00:00.000Z",
    ),
  };
  const futureRevocation = {
    ...revisionOne,
    revision: 2,
    revoked: true,
    asserted_at: "2026-07-26T00:00:00.000Z",
  };
  const records = [revisionOne, futureRevocation];
  const store = {
    async all() {
      return [];
    },
    async allAudit() {
      return records;
    },
    async readBlob() {
      return testCoverageEvidence;
    },
  };
  const dataset = await buildTrainingExamples(store, modelConfig(), {
    trainingCutoff: "2026-07-25T13:07:30.000Z",
  });
  assert.equal(dataset.negativeCount, 4);
  assert.equal(dataset.trainingCutoff, "2026-07-25T13:07:30.000Z");
  assert.deepEqual(
    dataset.coverageAssertionSnapshot.map((assertion) => assertion.revision),
    [1],
  );

  await assert.rejects(
    buildTrainingExamples({
      ...store,
      async allAudit() {
        return [{
          ...revisionOne,
          asserted_at: "2026-07-26T00:00:00.000Z",
        }];
      },
    }, modelConfig(), {
      trainingCutoff: "2026-07-25T13:07:30.000Z",
    }),
    /No adequate outcome coverage/,
  );
});

test("training artifact binds exact outcome and coverage revisions in its artifact hash", async () => {
  const source = observation("training-lineage", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const range = {
    start: "2026-07-25T10:00:00.000Z",
    end: "2026-07-25T11:00:00.000Z",
  };
  const completionSignal = signal("training-lineage", source, {
    availableAt: range.start,
    assertedRange: range,
  });
  const confirmed = outcome("training-lineage", source, range, range.end);
  const assertion = {
    assertion_id: "training-lineage-coverage",
    revision: 1,
    provider: "fixture",
    start: "2026-07-25T09:00:00.000Z",
    end: "2026-07-25T13:00:00.000Z",
    adequacy: "negative_label_eligible",
    revoked: false,
    asserted_at: "2026-07-25T13:00:00.000Z",
    evidence_refs: testCompletenessEvidence(
      "2026-07-25T13:00:00.000Z",
    ),
  };
  let written = null;
  const store = {
    async all(type) {
      if (type === "raw_observation") return [source];
      if (type === "normalized_signal") return [completionSignal];
      if (type === "reset_outcome") return [confirmed];
      return [];
    },
    async allAudit() {
      return [assertion];
    },
    async readBlob() {
      return testCoverageEvidence;
    },
    async writeModel(_name, model) {
      written = model;
    },
  };
  const { model } = await trainChallenger(store, modelConfig(), {
    trainingCutoff: "2026-07-25T13:00:00.000Z",
  });
  assert.equal(model, written);
  assert.deepEqual(model.training_outcome_snapshot_refs, [{
    record_id: confirmed.record_id,
    revision: confirmed.revision,
    data_hash: hashLabel(confirmed.data),
  }]);
  assert.equal(
    model.training_outcome_snapshot_hash,
    hashLabel(model.training_outcome_snapshot_refs),
  );
  assert.deepEqual(model.training_coverage_assertion_refs, [{
    assertion_id: assertion.assertion_id,
    revision: assertion.revision,
    data_hash: hashLabel(assertion),
  }]);
  assert.equal(
    model.training_coverage_assertion_snapshot_hash,
    hashLabel(model.training_coverage_assertion_refs),
  );
  assert.equal(model.calibrator_version, "identity-hourly-hazard/1");
  assert.deepEqual(model.calibrator, {
    version: "identity-hourly-hazard/1",
    method: "identity",
    fit_source: "none",
    fitted: false,
    reason: "identity_policy_until_versioned_oof_calibrator_is_available",
    minimum_out_of_fold_events: 1,
  });
  const artifactPayload = { ...model };
  delete artifactPayload.artifact_hash;
  assert.equal(model.artifact_hash, sha256(stableStringify(artifactPayload)));
});

test("renewal kernel represents outcome intervals by midpoint rather than lower bound", () => {
  const source = observation("renewal-source", {
    publishedAt: "2025-12-01T00:00:00.000Z",
    firstSeenAt: "2025-12-01T00:00:00.000Z",
  });
  const make = (id, start, end) => outcome(id, source, { start, end }, end);
  const narrow = [
    make("n1", "2026-01-01T10:00:00.000Z", "2026-01-01T12:00:00.000Z"),
    make("n2", "2026-01-08T10:00:00.000Z", "2026-01-08T12:00:00.000Z"),
  ];
  const wide = [
    make("w1", "2026-01-01T09:00:00.000Z", "2026-01-01T13:00:00.000Z"),
    make("w2", "2026-01-08T08:00:00.000Z", "2026-01-08T14:00:00.000Z"),
  ];
  const renewalSignal = signal("renewal-source", source, {
    availableAt: source.data.first_seen_at,
  });
  const args = {
    targetTime: "2026-01-10T11:00:00.000Z",
    knowledgeCutoff: "2026-01-10T11:00:00.000Z",
    signals: [renewalSignal],
    observations: [source],
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor: extractorContract(modelConfig()),
    targetScope: modelConfig().target,
  };
  const narrowVector = featureVectorAt({ ...args, outcomes: narrow });
  const wideVector = featureVectorAt({ ...args, outcomes: wide });
  assert.equal(
    narrowVector.features.renewal_periodic_kernel,
    wideVector.features.renewal_periodic_kernel,
  );
  assert.deepEqual(
    narrowVector.sourceRecords
      .filter((record) => record.record_type === "reset_outcome")
      .map((record) => `${record.record_id}@${record.revision}`)
      .sort(),
    narrow.map((record) => `${record.record_id}@${record.revision}`).sort(),
  );
});

test("confirmed outcomes without strict verification never enter reset-history features", () => {
  const source = observation("strict-feature-outcome", {
    publishedAt: "2026-01-01T10:00:00.000Z",
    firstSeenAt: "2026-01-01T10:00:00.000Z",
  });
  const strictSignal = signal("strict-feature-outcome", source, {
    availableAt: "2026-01-01T10:00:00.000Z",
  });
  const eligible = outcome("strict-feature-outcome", source, {
    start: "2026-01-01T10:00:00.000Z",
    end: "2026-01-01T11:00:00.000Z",
  }, "2026-01-01T11:00:00.000Z");
  const malformed = outcome("malformed-feature-outcome", source, {
    start: "2026-01-08T10:00:00.000Z",
    end: "2026-01-08T11:00:00.000Z",
  }, "2026-01-08T11:00:00.000Z");
  delete malformed.data.verification;
  const common = {
    targetTime: "2026-01-10T11:00:00.000Z",
    knowledgeCutoff: "2026-01-10T11:00:00.000Z",
    signals: [strictSignal],
    observations: [source],
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor: extractorContract(modelConfig()),
    targetScope: modelConfig().target,
  };
  const strictOnly = featureVectorAt({
    ...common,
    outcomes: [eligible],
  });
  const withMalformed = featureVectorAt({
    ...common,
    outcomes: [eligible, malformed],
  });
  assert.deepEqual(withMalformed.features, strictOnly.features);
  assert.equal(
    withMalformed.sourceRecords.some((record) =>
      record.record_id === malformed.record_id
    ),
    false,
  );
});

test("outcome eligibility retains a verification signal removed by feature evidence deduplication", () => {
  const independenceGroupId = "ind_same_reset_across_providers";
  const verifiedSource = observation("dedup-outcome-historical", {
    publishedAt: "2026-01-01T10:00:00.000Z",
    firstSeenAt: "2026-01-01T10:00:00.000Z",
    ingestProvider: "historical_monitor",
  });
  const preferredFeatureSource = observation("dedup-outcome-rsshub", {
    publishedAt: "2026-01-01T10:00:00.000Z",
    firstSeenAt: "2026-01-01T10:05:00.000Z",
    ingestProvider: "rsshub_x",
  });
  const verifiedSignal = signal("dedup-outcome-historical", verifiedSource, {
    availableAt: "2026-01-01T10:00:00.000Z",
    independenceGroupId,
  });
  const preferredFeatureSignal = signal(
    "dedup-outcome-rsshub",
    preferredFeatureSource,
    {
      availableAt: "2026-01-01T10:05:00.000Z",
      independenceGroupId,
    },
  );
  const verifiedOutcome = outcome(
    "dedup-outcome",
    verifiedSource,
    {
      start: "2026-01-01T10:00:00.000Z",
      end: "2026-01-01T11:00:00.000Z",
    },
    "2026-01-01T11:00:00.000Z",
    { independenceGroupId },
  );

  const vector = featureVectorAt({
    targetTime: "2026-01-02T11:00:00.000Z",
    knowledgeCutoff: "2026-01-02T11:00:00.000Z",
    signals: [verifiedSignal, preferredFeatureSignal],
    outcomes: [verifiedOutcome],
    observations: [verifiedSource, preferredFeatureSource],
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor: extractorContract(modelConfig()),
    targetScope: modelConfig().target,
  });

  assert.equal(vector.dataQuality.outcome_sample_count, 1);
  assert.equal(
    vector.sourceRecords.some((record) =>
      record.record_id === verifiedOutcome.record_id
    ),
    true,
  );
  assert.deepEqual(
    vector.sourceRecords
      .filter((record) => record.record_type === "normalized_signal")
      .map((record) => record.record_id),
    [preferredFeatureSignal.record_id],
  );
});

test("feature construction consumes completed lineage and discounts only older independent evidence", () => {
  const config = modelConfig();
  const completionSource = observation("epoch-completion", {
    publishedAt: "2026-07-29T04:09:00.000Z",
    firstSeenAt: "2026-07-29T04:10:00.000Z",
  });
  const completionSignal = signal("epoch-completion", completionSource, {
    availableAt: "2026-07-29T04:10:00.000Z",
  });
  const completed = outcome(
    "epoch-completion",
    completionSource,
    {
      start: "2026-07-29T04:00:00.000Z",
      end: "2026-07-29T05:00:00.000Z",
    },
    "2026-07-29T05:00:00.000Z",
    { config },
  );
  const olderSource = observation("epoch-older-independent", {
    publishedAt: "2026-07-29T03:00:00.000Z",
    firstSeenAt: "2026-07-29T03:00:00.000Z",
  });
  const olderSignal = signal("epoch-older-independent", olderSource, {
    eventType: "release",
    phase: "completed",
    role: "employee",
    assertedRange: {
      start: "2026-07-29T06:00:00.000Z",
      end: "2026-07-29T07:00:00.000Z",
    },
  });
  const newerSource = observation("epoch-newer-independent", {
    publishedAt: "2026-07-29T05:30:00.000Z",
    firstSeenAt: "2026-07-29T05:30:00.000Z",
  });
  const newerSignal = signal("epoch-newer-independent", newerSource, {
    eventType: "release",
    phase: "completed",
    role: "employee",
    assertedRange: {
      start: "2026-07-29T06:00:00.000Z",
      end: "2026-07-29T07:00:00.000Z",
    },
  });
  const common = {
    targetTime: "2026-07-29T06:00:00.000Z",
    knowledgeCutoff: "2026-07-29T06:00:00.000Z",
    confirmationIdentityIds: new Set(["person_tibo_sottiaux"]),
    expectedExtractor: extractorContract(config),
    targetScope: config.target,
    evidenceCarryoverPolicy: {
      version: "post-outcome-evidence-carryover/1",
      consume_outcome_lineage: true,
      pre_outcome_multiplier: 0.5,
    },
  };
  const olderBaseline = featureVectorAt({
    ...common,
    signals: [olderSignal],
    outcomes: [],
    observations: [olderSource],
  }).features;
  const olderAfterOutcome = featureVectorAt({
    ...common,
    signals: [completionSignal, olderSignal],
    outcomes: [completed],
    observations: [completionSource, olderSource],
  }).features;
  const newerBaseline = featureVectorAt({
    ...common,
    signals: [newerSignal],
    outcomes: [],
    observations: [newerSource],
  }).features;
  const newerAfterOutcome = featureVectorAt({
    ...common,
    signals: [completionSignal, newerSignal],
    outcomes: [completed],
    observations: [completionSource, newerSource],
  }).features;

  assert.equal(olderBaseline.asserted_time_overlap, 0.35);
  assert.equal(olderAfterOutcome.asserted_time_overlap, 0.175);
  assert.equal(newerBaseline.asserted_time_overlap, 0.35);
  assert.equal(newerAfterOutcome.asserted_time_overlap, 0.35);
});

test("the model design includes smoothed weekly and daily Fourier baselines", () => {
  const common = {
    knowledgeCutoff: "2026-07-20T00:00:00.000Z",
    signals: [],
    outcomes: [],
    observations: [],
  };
  const monday = featuresToArray(featureVectorAt({
    ...common,
    targetTime: "2026-07-20T00:00:00.000Z",
  }).features);
  const tuesdayEvening = featuresToArray(featureVectorAt({
    ...common,
    targetTime: "2026-07-21T18:00:00.000Z",
  }).features);
  for (const name of [
    "weekly_sin_1",
    "weekly_cos_1",
    "weekly_sin_2",
    "weekly_cos_2",
    "weekly_sin_3",
    "weekly_cos_3",
    "daily_sin_1",
    "daily_cos_1",
    "daily_sin_2",
    "daily_cos_2",
  ]) {
    assert.ok(FEATURE_NAMES.includes(name));
  }
  for (const name of [
    "provider_coverage",
    "provider_health",
    "source_delay_hours",
    "community_momentum",
    "community_disagreement",
  ]) {
    assert.equal(
      FEATURE_NAMES.includes(name),
      false,
      `${name} is data quality, not a probability feature`,
    );
  }
  assert.ok(FEATURE_NAMES.includes("competitor_model_release_decay"));
  assert.notDeepEqual(monday, tuesdayEvening);
  const dimension = FEATURE_NAMES.length + 1;
  const model = {
    feature_names: FEATURE_NAMES,
    means: FEATURE_NAMES.map(() => 0),
    scales: FEATURE_NAMES.map(() => 1),
    weights: Array(dimension).fill(0),
    covariance: Array.from({ length: dimension }, () => Array(dimension).fill(0)),
    converged: true,
  };
  model.weights[FEATURE_NAMES.indexOf("weekly_sin_1") + 1] = 1;
  assert.notEqual(
    predictHazard(model, monday).probability,
    predictHazard(model, tuesdayEvening).probability,
  );
});

test("optimizer reports convergence diagnostics and max-iteration failure", () => {
  const examples = Array.from({ length: 80 }, (_, index) => ({
    type: "negative",
    row: [index % 3 === 0 ? 0.1 : 0],
  }));
  examples.push(...Array.from({ length: 10 }, () => ({
    type: "event_interval",
    rows: [[1], [0.9]],
    exposures: [0.5, 0.5],
  })));
  const converged = trainLogisticHazard(examples, ["signal"], {
    lambda: 1,
    learningRate: 0.25,
    gradientTolerance: 1e-5,
    objectiveTolerance: 1e-10,
    hessianStep: 1e-4,
    maxIterations: 200,
  });
  assert.equal(converged.converged, true);
  assert.ok(["gradient_tolerance", "objective_tolerance"].includes(converged.stop_reason));
  assert.ok(Number.isFinite(converged.objective));
  assert.ok(converged.gradient_norm <= 1e-4);
  assert.equal(converged.optimizer.initial_step, 0.25);
  assert.equal(converged.optimizer.gradient_tolerance, 1e-5);
  assert.equal(converged.optimizer.objective_tolerance, 1e-10);
  assert.equal(converged.optimizer.hessian_step, 1e-4);
  assert.equal(converged.uncertainty.status, "available");

  const stopped = trainLogisticHazard(examples, ["signal"], {
    lambda: 1,
    maxIterations: 0,
  });
  assert.equal(stopped.converged, false);
  assert.equal(stopped.stop_reason, "max_iterations");

  const singularExamples = [
    ...Array.from({ length: 20 }, () => ({ type: "negative", row: [0] })),
    {
      type: "event_interval",
      rows: [[0]],
      exposures: [1],
    },
  ];
  const singular = trainLogisticHazard(singularExamples, ["constant"], {
    lambda: 0,
    maxIterations: 200,
  });
  assert.equal(singular.converged, true);
  assert.equal(singular.covariance, null);
  assert.equal(singular.uncertainty.status, "unavailable");
  assert.equal(predictHazard(singular, [0]).interval80, null);
});

test("trainChallenger refuses to write a model that did not converge", async () => {
  const source = observation("train-stop", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const range = {
    start: "2026-07-25T10:00:00.000Z",
    end: "2026-07-25T11:00:00.000Z",
  };
  const records = {
    raw_observation: [source],
    normalized_signal: [signal("train-stop", source, {
      availableAt: range.start,
      assertedRange: range,
    })],
    reset_outcome: [outcome("train-stop", source, range, range.end)],
  };
  let writes = 0;
  const store = {
    async all(type) {
      return records[type] ?? [];
    },
    async writeModel() {
      writes += 1;
    },
  };
  await assert.rejects(
    trainChallenger(store, modelConfig({ max_iterations: 0 }), {
      trainingCutoff: "2026-07-25T12:00:00.000Z",
      coverageIntervals: [{
        start: "2026-07-25T09:00:00.000Z",
        end: "2026-07-25T12:00:00.000Z",
      }],
    }),
    /did not converge/,
  );
  assert.equal(writes, 0);
});

test("published horizon has 168 slots and marks incomplete trailing four-hour windows null", () => {
  const entries = Array.from({ length: 168 }, (_, index) => ({
    start: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    end: new Date(Date.UTC(2026, 0, 1, index + 1)).toISOString(),
    hazard: 0.1,
    interval80: [0.05, 0.15],
  }));
  const result = deriveProbabilitySlots(entries);
  assert.equal(result.slots.length, 168);
  assert.ok(Math.abs(result.slots[164].rolling_4h_probability - 0.3439) < 1e-12);
  assert.deepEqual(
    result.slots.slice(165).map((slot) => slot.rolling_4h_probability),
    [null, null, null],
  );
  assert.ok(Math.abs(result.noResetProbability - 0.9 ** 168) < 1e-15);
});

test("no-reset probability retains tiny survival mass without subtractive cancellation", () => {
  const entries = Array.from({ length: 172 }, (_, index) => ({
    start: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    end: new Date(Date.UTC(2026, 0, 1, index + 1)).toISOString(),
    hazard: 0.5,
    interval80: null,
  }));
  const result = deriveProbabilitySlots(entries, {
    publishedSlotCount: 168,
  });

  assert.equal(result.slots.at(-1).reset_by_end_probability, 1);
  assert.equal(result.noResetProbability, 2 ** -168);
  assert.ok(result.noResetProbability > 0);
  assert.notEqual(result.noResetProbability, 2 ** -172);
});

test("forecast preserves its cutoff and rolls a crossed horizon forward before publication", async () => {
  const config = modelConfig();
  const dimension = FEATURE_NAMES.length + 1;
  const champion = {
    artifact_version: MODEL_ARTIFACT_VERSION,
    family: config.model.family,
    model_version: `${MODEL_VERSION_PREFIX}-test`,
    training_cutoff: "2026-07-01T00:00:00.000Z",
    training_data_hash: "training-test",
    feature_schema_version: config.feature_schema_version,
    model_contract_hash: modelContractHash(config),
    feature_names: FEATURE_NAMES,
    means: FEATURE_NAMES.map(() => 0),
    scales: FEATURE_NAMES.map(() => 1),
    weights: Array(dimension).fill(0),
    feature_transform: {
      version: FEATURE_TRANSFORM_VERSION,
      standardized_feature_clip: config.model.standardized_feature_clip,
    },
    coefficient_prior_policy: COEFFICIENT_PRIOR_POLICY_VERSION,
    raw_coefficient_priors: Array(dimension).fill(0),
    coefficient_priors: Array(dimension).fill(0),
    covariance: Array.from({ length: dimension }, () => Array(dimension).fill(0)),
    converged: true,
  };
  champion.artifact_hash = sha256(stableStringify(champion));
  let appended = null;
  const appendedSnapshots = [];
  const store = {
    async readModel() {
      return champion;
    },
    async all() {
      return [];
    },
    async allAudit() {
      return [];
    },
    async readState(_name, fallback) {
      return fallback;
    },
    async appendOrReuseMany(records) {
      appendedSnapshots.push(...records);
      return records.map((record) => ({ record, inserted: true }));
    },
    async append(record) {
      appended = record;
      return { inserted: true };
    },
  };
  const result = await issueForecast(store, config, {
    knowledgeCutoff: "2026-07-25T12:34:56.000Z",
    horizonStart: "2026-07-25T13:00:00.000Z",
    clock: () => new Date("2026-07-25T13:05:00.000Z"),
  });
  assert.equal(result.prediction, appended);
  assert.equal(appended.data.knowledge_cutoff, "2026-07-25T12:34:56.000Z");
  assert.equal(appended.data.horizon.start, "2026-07-25T14:00:00.000Z");
  assert.equal(appended.data.issued_at, "2026-07-25T13:05:00.000Z");
  assert.ok(Date.parse(appended.data.issued_at) <= Date.parse(appended.data.horizon.start));
  assert.equal(appended.data.slots.length, 168);
  assert.equal(appended.data.post_outcome_refractory.status, "disabled");
  assert.deepEqual(Object.keys(appendedSnapshots[0].data.features).sort(), [...FEATURE_NAMES].sort());
  const firstPrediction = appended;
  const integrity = assessPredictionIntegrity({
    prediction: firstPrediction,
    featureSnapshots: appendedSnapshots.slice(0, 168),
    champion,
    config,
  });
  assert.equal(integrity.valid, true);
  const missingRefractory = structuredClone(firstPrediction);
  delete missingRefractory.data.post_outcome_refractory;
  const missingRefractoryIntegrity = assessPredictionIntegrity({
    prediction: missingRefractory,
    featureSnapshots: appendedSnapshots.slice(0, 168),
    champion,
    config,
  });
  assert.equal(missingRefractoryIntegrity.valid, false);
  assert.ok(
    missingRefractoryIntegrity.reasons.includes(
      "prediction_post_outcome_refractory_missing",
    ),
  );
  const tamperedPrediction = structuredClone(firstPrediction);
  tamperedPrediction.data.slots[0].hazard += 0.01;
  tamperedPrediction.data.slots[0].first_reset_probability =
    tamperedPrediction.data.slots[0].hazard;
  tamperedPrediction.data.slots[0].reset_by_end_probability =
    tamperedPrediction.data.slots[0].hazard;
  assert.equal(assessPredictionIntegrity({
    prediction: tamperedPrediction,
    featureSnapshots: appendedSnapshots.slice(0, 168),
    champion,
    config,
  }).valid, false);
  assert.equal(assessPredictionIntegrity({
    prediction: {
      ...firstPrediction,
      data: {
        ...firstPrediction.data,
        feature_snapshot_refs:
          firstPrediction.data.feature_snapshot_refs.slice(0, 167),
      },
    },
    featureSnapshots: appendedSnapshots.slice(0, 168),
    champion,
    config,
  }).valid, false);
  const refit = {
    ...champion,
    weights: [...champion.weights],
  };
  refit.weights[0] = 0.01;
  delete refit.artifact_hash;
  refit.artifact_hash = sha256(stableStringify(refit));
  const refitResult = await issueForecast(store, config, {
    model: refit,
    knowledgeCutoff: "2026-07-25T12:34:56.000Z",
    horizonStart: "2026-07-25T13:00:00.000Z",
    clock: () => new Date("2026-07-25T13:05:00.000Z"),
  });
  assert.notEqual(refitResult.prediction.record_id, firstPrediction.record_id);
});

test("model compatibility and promotion reject mismatched contracts and artifacts", async () => {
  assert.match(
    modelVersionFor({
      fitArtifactHash: "same-fit",
      modelContractHash: "contract-a",
      algorithmSignature: "algorithm",
    }).modelVersion,
    /^reset-model\/0\.3\.2-/,
  );
  assert.notEqual(
    evaluationContractHash(modelConfig()),
    evaluationContractHash(modelConfig({
      promotion: {
        ...modelConfig().model.promotion,
        maximum_expected_calibration_error: 0.2,
      },
    })),
  );
  assert.notEqual(
    modelVersionFor({
      fitArtifactHash: "same-fit",
      modelContractHash: "contract-a",
      algorithmSignature: "algorithm",
    }).modelVersion,
    modelVersionFor({
      fitArtifactHash: "same-fit",
      modelContractHash: "contract-b",
      algorithmSignature: "algorithm",
    }).modelVersion,
  );
  assert.throws(
    () => assertModelCompatibility({
      feature_names: FEATURE_NAMES,
      weights: Array(FEATURE_NAMES.length + 1).fill(0),
      means: FEATURE_NAMES.map(() => 0),
      scales: FEATURE_NAMES.map(() => 1),
      covariance: Array.from(
        { length: FEATURE_NAMES.length + 1 },
        () => Array(FEATURE_NAMES.length + 1).fill(0),
      ),
      feature_schema_version: "wrong",
    }, {
      featureNames: FEATURE_NAMES,
      featureSchemaVersion: "expected",
    }),
    /schema version/,
  );
  const coefficientCount = FEATURE_NAMES.length + 1;
  const currentContractHash = modelContractHash(modelConfig());
  const contractedModel = {
    artifact_version: MODEL_ARTIFACT_VERSION,
    model_version: `${MODEL_VERSION_PREFIX}-compatibility-test`,
    model_contract_hash: currentContractHash,
    feature_names: FEATURE_NAMES,
    weights: Array(coefficientCount).fill(0),
    means: FEATURE_NAMES.map(() => 0),
    scales: FEATURE_NAMES.map(() => 1),
    covariance: null,
    uncertainty: {
      status: "unavailable",
      reason: "test_fixture",
    },
    feature_transform: {
      version: FEATURE_TRANSFORM_VERSION,
      standardized_feature_clip: 8,
    },
    coefficient_prior_policy: COEFFICIENT_PRIOR_POLICY_VERSION,
    raw_coefficient_priors: Array(coefficientCount).fill(0),
    coefficient_priors: Array(coefficientCount).fill(0),
  };
  assert.equal(
    assertModelCompatibility(contractedModel, {
      featureNames: FEATURE_NAMES,
      modelContractHash: currentContractHash,
    }),
    true,
  );
  assert.throws(
    () => assertModelCompatibility({
      ...contractedModel,
      artifact_version: "reset-model-artifact/0.3.0",
    }, {
      featureNames: FEATURE_NAMES,
      modelContractHash: currentContractHash,
    }),
    /artifact version/,
  );
  assert.throws(
    () => assertModelCompatibility({
      ...contractedModel,
      model_version: "reset-model/0.3.0-compatibility-test",
    }, {
      featureNames: FEATURE_NAMES,
      modelContractHash: currentContractHash,
    }),
    /Model version/,
  );
  const challenger = { artifact_hash: "challenger-a" };
  const mismatchedEvaluation = {
    evaluation_version: "reset-evaluation/0.3.0",
    candidate: { artifact_hash: "challenger-b" },
  };
  mismatchedEvaluation.evaluation_artifact_hash =
    evaluationArtifactHash(mismatchedEvaluation);
  const result = await promoteChallenger({
    async readModel(name) {
      return name === "challenger" ? challenger : null;
    },
  }, mismatchedEvaluation, modelConfig());
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "evaluation_challenger_artifact_mismatch");
});

test("a same-policy second train and promote refreshes the champion without fake strict improvement", async () => {
  const config = modelConfig();
  const source = observation("refit-completion", {
    publishedAt: "2026-07-25T10:00:00.000Z",
    firstSeenAt: "2026-07-25T10:00:00.000Z",
  });
  const range = {
    start: "2026-07-25T10:00:00.000Z",
    end: "2026-07-25T11:00:00.000Z",
  };
  const completionSignal = signal("refit-completion", source, {
    availableAt: range.start,
    assertedRange: range,
  });
  const confirmed = outcome("refit-completion", source, range, range.end);
  const records = {
    raw_observation: [source],
    normalized_signal: [completionSignal],
    reset_outcome: [confirmed],
  };
  const models = {};
  const store = {
    async all(type) {
      return records[type] ?? [];
    },
    async allAudit() {
      return [];
    },
    async readModel(name) {
      return models[name] ?? null;
    },
    async writeModel(name, model) {
      models[name] = model;
    },
    async readBlob(ref) {
      return structuredClone(frozenEvaluationBlobs.get(ref));
    },
    async writeState() {},
  };
  const train = () => trainChallenger(store, config, {
    trainingCutoff: "2026-07-25T13:00:00.000Z",
    coverageIntervals: [{
      start: "2026-07-25T09:00:00.000Z",
      end: "2026-07-25T13:00:00.000Z",
    }],
  });
  const folds = [{
    origin: "2026-07-25T09:00:00.000Z",
    end: "2026-07-25T13:00:00.000Z",
  }];
  const makeEvaluation = (trained, champion, pairedStatus) => {
    const sampleHash = "sha256:refit-sample";
    const evaluation = {
      evaluation_version: "reset-evaluation/0.3.0",
      evidence_mode: "historical_walk_forward",
      evaluation_cutoff: "2026-07-25T13:00:00.000Z",
      outcome_coverage_providers: ["fixture"],
      folds,
      provenance: {
        config_hash: trained.model.config_hash,
        model_contract_hash: trained.model.model_contract_hash,
        evaluation_contract_hash: trained.model.evaluation_contract_hash,
        extractor_model: trained.model.extractor_model,
        extractor_model_version: trained.model.extractor_model_version,
        extractor_prompt_version: trained.model.extractor_prompt_version,
        feature_schema_version: trained.model.feature_schema_version,
        taxonomy_version: trained.model.taxonomy_version,
        deduplication_version: trained.model.deduplication_version,
        coverage_assertion_refs: [],
        coverage_assertion_snapshot_hash: hashLabel([]),
        outcome_snapshot_refs: trained.dataset.outcomeSnapshot,
        outcome_snapshot_hash: hashLabel(trained.dataset.outcomeSnapshot),
        outcome_as_of_mode: AS_OF_MODE.LIVE,
        coverage_as_of_mode: COVERAGE_AS_OF_MODE.LIVE,
        fold_signature: hashLabel(folds),
        model_versions: [trained.model.model_version],
      },
      candidate: {
        artifact_hash: trained.model.artifact_hash,
        training_data_hash: trained.model.training_data_hash,
        model_version: trained.model.model_version,
        model_contract_hash: trained.model.model_contract_hash,
        algorithm_signature: trained.model.training_algorithm_signature,
        evaluation_sample_hash: sampleHash,
      },
      paired_comparison: {
        status: pairedStatus,
        fold_signature: hashLabel(folds),
        sample_hash: sampleHash,
        challenger_artifact_hash: trained.model.artifact_hash,
        champion_artifact_hash: champion?.artifact_hash ?? null,
        champion_metrics: pairedStatus === "available"
          ? { brier_score: 0.1, expected_calibration_error: 0.05, log_loss: 0.2 }
          : null,
        metric_deltas: pairedStatus === "available"
          ? { brier_score: 0, expected_calibration_error: 0, log_loss: 0 }
          : null,
      },
      gate: { passed: true },
      metrics: {
        event_window_recall: 1,
        brier_score: 0.1,
        brier_skill: 0.2,
        expected_calibration_error: 0.05,
      },
    };
    return bindFrozenEvaluation(evaluation);
  };

  const firstTraining = await train();
  const firstPromotion = await promoteChallenger(
    store,
    makeEvaluation(firstTraining, null, "not_applicable"),
    config,
  );
  assert.equal(firstPromotion.promoted, true);
  assert.equal(firstPromotion.reason, "evaluation_gate_passed");

  const firstChampion = models.champion;
  const secondTraining = await train();
  const secondPromotion = await promoteChallenger(
    store,
    makeEvaluation(secondTraining, firstChampion, "available"),
    config,
  );
  assert.equal(secondPromotion.promoted, true);
  assert.equal(secondPromotion.reason, "champion_refit_refreshed");
  assert.equal(models.champion.artifact_hash, secondTraining.model.artifact_hash);

  const incompatibleModel = {
    ...secondTraining.model,
    model_contract_hash: "sha256:migrated-contract",
  };
  delete incompatibleModel.artifact_hash;
  incompatibleModel.artifact_hash = sha256(stableStringify(incompatibleModel));
  models.challenger = incompatibleModel;
  const migrationResult = await promoteChallenger(
    store,
    makeEvaluation(
      { ...secondTraining, model: incompatibleModel },
      models.champion,
      "champion_model_contract_incompatible",
    ),
    config,
  );
  assert.equal(migrationResult.promoted, false);
  assert.equal(migrationResult.reason, "explicit_migration_required");
  assert.equal(migrationResult.migration.model_contract_changed, true);
});

test("promotion verifies exact outcome and coverage snapshots but ignores unrelated new coverage", async () => {
  const dimension = FEATURE_NAMES.length + 1;
  const challenger = {
    artifact_version: MODEL_ARTIFACT_VERSION,
    model_version: "reset-model/0.3.2-test",
    training_data_hash: "training-data",
    model_contract_hash: "sha256:model-contract",
    evaluation_contract_hash: "sha256:evaluation-contract",
    training_algorithm_signature: "sha256:algorithm",
    config_hash: "sha256:config",
    feature_schema_version: "reset-features/test",
    taxonomy_version: "reset-taxonomy/test",
    deduplication_version: "reset-dedup/test",
    extractor_model: "rule_claim_extractor",
    extractor_model_version: "test",
    extractor_prompt_version: "test",
    family: "ridge_logistic_discrete_time_hazard",
    feature_names: FEATURE_NAMES,
    means: FEATURE_NAMES.map(() => 0),
    scales: FEATURE_NAMES.map(() => 1),
    weights: Array(dimension).fill(0),
    converged: true,
  };
  challenger.artifact_hash = sha256(stableStringify(challenger));
  const usedAssertion = {
    assertion_id: "coverage-used",
    revision: 1,
    provider: "fixture",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-20T00:00:00.000Z",
    adequacy: "negative_label_eligible",
  };
  const unrelatedAssertion = {
    assertion_id: "coverage-added-later",
    revision: 1,
    provider: "fixture",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-02T00:00:00.000Z",
    adequacy: "negative_label_eligible",
  };
  const source = observation("promotion-outcome", {
    publishedAt: "2026-07-10T10:00:00.000Z",
    firstSeenAt: "2026-07-10T10:00:00.000Z",
  });
  const exactOutcome = outcome("promotion-outcome", source, {
    start: "2026-07-10T10:00:00.000Z",
    end: "2026-07-10T11:00:00.000Z",
  }, "2026-07-10T11:00:00.000Z");
  const outcomeSnapshot = [{
    record_id: exactOutcome.record_id,
    revision: exactOutcome.revision,
    data_hash: hashLabel(exactOutcome.data),
  }];
  const folds = [{
    origin: "2026-07-06T00:00:00.000Z",
    end: "2026-07-13T00:00:00.000Z",
  }];
  const evaluationTemplate = {
    evaluation_version: "reset-evaluation/0.3.0",
    evaluation_cutoff: "2026-07-20T00:00:00.000Z",
    outcome_coverage_providers: ["fixture"],
    folds,
    provenance: {
      config_hash: challenger.config_hash,
      model_contract_hash: challenger.model_contract_hash,
      evaluation_contract_hash: challenger.evaluation_contract_hash,
      extractor_model: challenger.extractor_model,
      extractor_model_version: challenger.extractor_model_version,
      extractor_prompt_version: challenger.extractor_prompt_version,
      feature_schema_version: challenger.feature_schema_version,
      taxonomy_version: challenger.taxonomy_version,
      deduplication_version: challenger.deduplication_version,
      fold_signature: hashLabel(folds),
      coverage_assertion_refs: [{
        assertion_id: usedAssertion.assertion_id,
        revision: usedAssertion.revision,
      }],
      coverage_assertion_snapshot_hash: hashLabel([usedAssertion]),
      outcome_snapshot_refs: outcomeSnapshot,
      outcome_snapshot_hash: hashLabel(outcomeSnapshot),
      outcome_as_of_mode: AS_OF_MODE.LIVE,
      coverage_as_of_mode: COVERAGE_AS_OF_MODE.LIVE,
    },
    candidate: {
      artifact_hash: challenger.artifact_hash,
      training_data_hash: challenger.training_data_hash,
      model_version: challenger.model_version,
      model_contract_hash: challenger.model_contract_hash,
      algorithm_signature: challenger.training_algorithm_signature,
      evaluation_sample_hash: "sha256:sample",
    },
    paired_comparison: {
      status: "not_applicable",
      fold_signature: hashLabel(folds),
      sample_hash: "sha256:sample",
      challenger_artifact_hash: challenger.artifact_hash,
      metric_deltas: null,
    },
    gate: { passed: true },
    metrics: {
      event_window_recall: 1,
      brier_score: 0.1,
      brier_skill: 0.2,
      expected_calibration_error: 0.05,
    },
  };
  const promotionConfig = modelConfig({
    minimum_live_evaluation_windows: 2,
    minimum_live_evaluation_events: 20,
  });
  const insufficientEvaluation = bindFrozenEvaluation(
    structuredClone(evaluationTemplate),
    { minimumWindows: 2, minimumEvents: 20, eventCount: 19 },
  );
  const evaluation = bindFrozenEvaluation(
    evaluationTemplate,
    { minimumWindows: 2, minimumEvents: 20, eventCount: 20 },
  );
  assert.equal(insufficientEvaluation.metrics.evaluated_events, 19);
  assert.equal(insufficientEvaluation.gate.sample_threshold_passed, false);
  assert.equal(evaluation.metrics.evaluated_events, 20);
  assert.equal(evaluation.gate.sample_threshold_passed, true);
  let writes = 0;
  const store = {
    async readModel(name) {
      return name === "challenger" ? challenger : null;
    },
    async allAudit() {
      return [usedAssertion, unrelatedAssertion];
    },
    async all(type) {
      return type === "reset_outcome" ? [exactOutcome] : [];
    },
    async readBlob(ref) {
      return structuredClone(frozenEvaluationBlobs.get(ref));
    },
    async writeModel() {
      writes += 1;
    },
    async writeState() {},
  };
  const insufficientResult = await promoteChallenger(
    store,
    insufficientEvaluation,
    promotionConfig,
  );
  assert.equal(insufficientResult.promoted, false);
  assert.equal(
    insufficientResult.reason,
    "evaluation_sample_threshold_not_met",
  );
  assert.equal(insufficientResult.sample_gate.evaluated_events_passed, false);
  assert.equal(writes, 0);

  const result = await promoteChallenger(store, evaluation, promotionConfig);
  assert.equal(result.promoted, true);
  assert.equal(writes, 1);
  const archiveEvaluation = structuredClone(evaluation);
  archiveEvaluation.evidence_mode = "archive_replay";
  archiveEvaluation.provenance.outcome_as_of_mode =
    AS_OF_MODE.ARCHIVE_REPLAY;
  archiveEvaluation.provenance.coverage_as_of_mode =
    COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY;
  archiveEvaluation.evaluation_artifact_hash =
    evaluationArtifactHash(archiveEvaluation);
  const archiveResult = await promoteChallenger(
    store,
    archiveEvaluation,
    promotionConfig,
  );
  assert.equal(archiveResult.promoted, true);
  assert.equal(writes, 2);

  const tamperedGate = structuredClone(evaluation);
  tamperedGate.gate.passed = false;
  tamperedGate.evaluation_artifact_hash =
    evaluationArtifactHash(tamperedGate);
  const tamperedGateResult = await promoteChallenger(
    store,
    tamperedGate,
    promotionConfig,
  );
  assert.equal(tamperedGateResult.promoted, false);
  assert.equal(
    tamperedGateResult.reason,
    "evaluation_recomputed_summary_mismatch",
  );
  const tamperedMetric = structuredClone(evaluation);
  tamperedMetric.metrics.brier_score = 0.9;
  tamperedMetric.evaluation_artifact_hash =
    evaluationArtifactHash(tamperedMetric);
  const tamperedMetricResult = await promoteChallenger(
    store,
    tamperedMetric,
    promotionConfig,
  );
  assert.equal(tamperedMetricResult.promoted, false);
  assert.equal(
    tamperedMetricResult.reason,
    "evaluation_recomputed_summary_mismatch",
  );

  const changedOutcome = structuredClone(exactOutcome);
  changedOutcome.data.occurred_time_range.end = "2026-07-10T12:00:00.000Z";
  const changed = await promoteChallenger({
    ...store,
    async all(type) {
      return type === "reset_outcome" ? [changedOutcome] : [];
    },
  }, evaluation, promotionConfig);
  assert.equal(changed.promoted, false);
  assert.equal(changed.reason, "evaluation_outcome_revision_changed");

  const revokedCoverage = {
    ...usedAssertion,
    revision: 2,
    revoked: true,
  };
  const supersededCoverageResult = await promoteChallenger({
    ...store,
    async allAudit() {
      return [usedAssertion, unrelatedAssertion, revokedCoverage];
    },
  }, evaluation, promotionConfig);
  assert.equal(supersededCoverageResult.promoted, false);
  assert.equal(
    supersededCoverageResult.reason,
    "evaluation_coverage_assertion_superseded",
  );

  const newerOutcome = structuredClone(exactOutcome);
  newerOutcome.revision = 2;
  const supersededOutcomeResult = await promoteChallenger({
    ...store,
    async all(type) {
      return type === "reset_outcome" ? [exactOutcome, newerOutcome] : [];
    },
  }, evaluation, promotionConfig);
  assert.equal(supersededOutcomeResult.promoted, false);
  assert.equal(
    supersededOutcomeResult.reason,
    "evaluation_outcome_revision_superseded",
  );
});
