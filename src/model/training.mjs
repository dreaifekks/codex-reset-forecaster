import { addHours, floorHour, toUtcIso } from "../core/time.mjs";
import { normalizeCoverageIntervals } from "../pipeline/coverage.mjs";
import { FEATURE_NAMES, featureVectorAt, featuresToArray } from "./features.mjs";
import { assertModelCompatibility, trainLogisticHazard } from "./logistic-hazard.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { extractorContract } from "../core/extractor-contract.mjs";
import {
  calibratorPolicy,
  evaluationContractHash,
  modelContractHash,
  modelVersionFor,
  trainingAlgorithmSignature,
} from "./contract.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import { hashLabel, sha256, stableStringify } from "../core/hash.mjs";
import {
  AS_OF_MODE,
  asOfModeForEvidence,
  assertAsOfMode,
  latestObservationsAsOf,
  latestOutcomesAsOf,
  latestSignalsAsOf,
  outcomeAvailableAt,
} from "./as-of.mjs";
import {
  COVERAGE_AS_OF_MODE,
  adequateCoverageAssertionsAsOf,
  coverageAssertionRevisions,
} from "./coverage-as-of.mjs";

function slotCovered(slotStart, slotEnd, intervals) {
  const start = Date.parse(slotStart);
  const end = Date.parse(slotEnd);
  return intervals.some((interval) => Date.parse(interval.start) <= start && Date.parse(interval.end) >= end);
}

function overlaps(slotStart, slotEnd, range) {
  return Date.parse(slotStart) < Date.parse(range.end) && Date.parse(slotEnd) > Date.parse(range.start);
}

export function intervalExposure(slotStart, slotEnd, range) {
  const start = Math.max(Date.parse(slotStart), Date.parse(range.start));
  const end = Math.min(Date.parse(slotEnd), Date.parse(range.end));
  const slotDuration = Date.parse(slotEnd) - Date.parse(slotStart);
  return slotDuration <= 0 ? 0 : Math.max(0, end - start) / slotDuration;
}

function confirmationSourceExclusions(outcome) {
  return {
    recordIds: new Set([
      outcome.record_id,
      ...(outcome.data.verification ?? []).map((entry) => entry.observation_ref.record_id),
    ]),
    independenceGroupIds: new Set(
      (outcome.data.verification ?? [])
        .map((entry) => entry.independence_group_id)
        .filter(Boolean),
    ),
  };
}

export async function buildTrainingExamples(store, config, {
  trainingCutoff = floorHour(new Date()),
  coverageIntervals = null,
  coverageAssertionRecords = null,
  asOfMode = null,
  coverageAsOfMode = null,
} = {}) {
  const cutoff = floorHour(trainingCutoff);
  const [signals, outcomes, observations] = await Promise.all([
    store.all("normalized_signal", { latestOnly: false }),
    store.all("reset_outcome", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
  ]);
  const evidenceAsOfMode = asOfModeForEvidence(
    observations,
    config.model.outcome_coverage_providers,
  );
  const resolvedAsOfMode = asOfMode ?? (
    evidenceAsOfMode === AS_OF_MODE.ARCHIVE_REPLAY
      ? evidenceAsOfMode
      : config.model.outcome_coverage_providers.length > 0 &&
          config.model.outcome_coverage_providers.every((provider) =>
            ["demo", "fixture"].includes(provider)
          )
        ? AS_OF_MODE.SYNTHETIC_REPLAY
        : AS_OF_MODE.LIVE
  );
  assertAsOfMode(resolvedAsOfMode);
  let featureCoverageAssertions = coverageAssertionRecords;
  if (featureCoverageAssertions === null && coverageIntervals === null) {
    featureCoverageAssertions = await coverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    );
  }
  const resolvedCoverageAsOfMode = coverageAsOfMode ?? (
    resolvedAsOfMode === AS_OF_MODE.ARCHIVE_REPLAY
      ? COVERAGE_AS_OF_MODE.ARCHIVE_REPLAY
      : config.model.outcome_coverage_providers.length > 0 &&
    config.model.outcome_coverage_providers.every((provider) =>
      ["demo", "fixture"].includes(provider)
    )
      ? COVERAGE_AS_OF_MODE.SYNTHETIC_REPLAY
      : COVERAGE_AS_OF_MODE.LIVE
  );
  const selectedCoverageAssertions = featureCoverageAssertions === null
    ? null
    : adequateCoverageAssertionsAsOf(
      featureCoverageAssertions,
      cutoff,
      config.model.outcome_coverage_providers,
      resolvedCoverageAsOfMode,
    );
  const coverage = selectedCoverageAssertions === null
    ? coverageIntervals
    : normalizeCoverageIntervals(selectedCoverageAssertions);
  if (coverage.length === 0) {
    throw new Error("No adequate outcome coverage intervals are recorded; refusing to invent negative labels");
  }
  const maximumStart = addHours(cutoff, -24 * config.model.maximum_training_days);
  const coveredSlots = [];
  for (const interval of coverage) {
    let cursor = floorHour(new Date(Math.max(Date.parse(interval.start), maximumStart.getTime())));
    const intervalEnd = new Date(Math.min(Date.parse(interval.end), cutoff.getTime()));
    while (addHours(cursor, 1) <= intervalEnd) {
      const end = addHours(cursor, 1);
      if (slotCovered(cursor, end, coverage)) {
        coveredSlots.push({ start: toUtcIso(cursor), end: toUtcIso(end) });
      }
      cursor = end;
    }
  }
  const uniqueSlots = [...new Map(coveredSlots.map((slot) => [slot.start, slot])).values()]
    .sort((left, right) => left.start.localeCompare(right.start));
  const extractor = extractorContract(config);
  const confirmationIds = confirmationIdentityIds(config);
  const currentSignals = selectCurrentSignals(
    latestSignalsAsOf(signals, cutoff, resolvedAsOfMode),
  );
  const currentObservations = latestObservationsAsOf(
    observations,
    cutoff,
    resolvedAsOfMode,
  );
  const outcomeEligibility = buildOutcomeEligibilityContext({
    observations: currentObservations,
    signals: currentSignals,
    config,
  });
  const outcomeCandidates = latestOutcomesAsOf(
    outcomes,
    cutoff,
    resolvedAsOfMode,
  ).filter((outcome) =>
    outcome.data.status === "confirmed" &&
    outcome.data.occurred_time_range &&
    Date.parse(outcomeAvailableAt(outcome, resolvedAsOfMode)) <= cutoff.getTime() &&
    Date.parse(outcome.data.occurred_time_range.end) <= cutoff.getTime(),
  );
  const settledOutcomes = outcomeCandidates.filter((outcome) =>
    isEligibleConfirmedOutcome(outcome, {
      ...outcomeEligibility,
      confirmationIdentityIds: confirmationIds,
    }),
  );
  const ambiguousOutcomes = outcomeCandidates.filter((outcome) =>
    !settledOutcomes.includes(outcome),
  );
  const baseRows = uniqueSlots.map((slot) => {
    const vector = featureVectorAt({
      targetTime: slot.start,
      knowledgeCutoff: slot.start,
      signals,
      outcomes,
      observations,
      coverageIntervals: coverage,
      coverageAssertionRecords: featureCoverageAssertions,
      confirmationIdentityIds: confirmationIds,
      expectedExtractor: extractor,
      targetScope: config.target,
      outcomeCoverageProviders: new Set(config.model.outcome_coverage_providers),
      asOfMode: resolvedAsOfMode,
      coverageAsOfMode: resolvedCoverageAsOfMode,
    });
    return { slot, row: featuresToArray(vector.features) };
  });
  const censoredRows = new Set();
  for (const outcome of ambiguousOutcomes) {
    for (const { slot } of baseRows) {
      if (overlaps(slot.start, slot.end, outcome.data.occurred_time_range)) {
        censoredRows.add(slot.start);
      }
    }
  }
  const eventExamples = [];
  for (const outcome of settledOutcomes) {
    const matching = baseRows.filter(({ slot }) =>
      overlaps(slot.start, slot.end, outcome.data.occurred_time_range),
    );
    if (matching.length === 0) continue;
    matching.forEach(({ slot }) => censoredRows.add(slot.start));
    const exclusions = confirmationSourceExclusions(outcome);
    const eventKnowledgeCutoff = new Date(outcome.data.occurred_time_range.start);
    const eventRows = matching.map(({ slot }) => {
      const slotStart = new Date(slot.start);
      const vector = featureVectorAt({
        targetTime: slot.start,
        knowledgeCutoff: slotStart < eventKnowledgeCutoff ? slotStart : eventKnowledgeCutoff,
        signals,
        outcomes: outcomes.filter((candidate) => candidate.record_id !== outcome.record_id),
        observations,
        coverageIntervals: coverage,
        coverageAssertionRecords: featureCoverageAssertions,
        confirmationIdentityIds: confirmationIds,
        expectedExtractor: extractor,
        targetScope: config.target,
        outcomeCoverageProviders: new Set(config.model.outcome_coverage_providers),
        excludedSourceRecordIds: exclusions.recordIds,
        excludedIndependenceGroupIds: exclusions.independenceGroupIds,
        asOfMode: resolvedAsOfMode,
        coverageAsOfMode: resolvedCoverageAsOfMode,
      });
      return {
        row: featuresToArray(vector.features),
        exposure: intervalExposure(slot.start, slot.end, outcome.data.occurred_time_range),
      };
    }).filter(({ exposure }) => exposure > 0);
    if (eventRows.length === 0) continue;
    eventExamples.push({
      type: "event_interval",
      rows: eventRows.map((entry) => entry.row),
      exposures: eventRows.map((entry) => entry.exposure),
      interval_assignment: "exposure_weighted_interval_censoring",
      outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
      interval: outcome.data.occurred_time_range,
    });
  }
  const negativeExamples = baseRows
    .filter(({ slot }) => !censoredRows.has(slot.start))
    .map(({ row, slot }) => ({ type: "negative", row, slot }));
  return {
    examples: [...negativeExamples, ...eventExamples],
    eventCount: eventExamples.length,
    eventExposureHours: eventExamples.reduce(
      (sum, example) => sum + example.exposures.reduce(
        (eventSum, exposure) => eventSum + exposure,
        0,
      ),
      0,
    ),
    negativeCount: negativeExamples.length,
    censoredSlotCount: censoredRows.size,
    ambiguousOutcomeCount: ambiguousOutcomes.length,
    outcomeSnapshot: outcomeCandidates
      .map((outcome) => ({
        record_id: outcome.record_id,
        revision: outcome.revision,
        data_hash: hashLabel(outcome.data),
      }))
      .sort((left, right) =>
        left.record_id.localeCompare(right.record_id) || left.revision - right.revision,
      ),
    coverage,
    coverageAssertionSnapshot: selectedCoverageAssertions ?? [],
    trainingCutoff: toUtcIso(cutoff),
    asOfMode: resolvedAsOfMode,
    coverageAsOfMode: resolvedCoverageAsOfMode,
  };
}

export async function trainChallenger(store, config, options = {}) {
  const dataset = await buildTrainingExamples(store, config, options);
  if (dataset.eventCount < config.model.minimum_outcomes) {
    throw new Error(
      `Need at least ${config.model.minimum_outcomes} confirmed covered outcomes; found ${dataset.eventCount}`,
    );
  }
  const model = trainLogisticHazard(dataset.examples, FEATURE_NAMES, {
    lambda: config.model.lambda,
    initialStep: config.model.learning_rate,
    gradientTolerance: config.model.gradient_tolerance,
    objectiveTolerance: config.model.objective_tolerance,
    hessianStep: config.model.hessian_step,
    maxIterations: config.model.max_iterations,
    coefficientPriors: config.model.coefficient_priors,
  });
  if (!model.converged) {
    throw new Error(
      `Challenger optimization did not converge (${model.stop_reason}; ` +
      `gradient_norm=${model.gradient_norm})`,
    );
  }
  const fitArtifactHash = model.artifact_hash;
  const contractHash = modelContractHash(config);
  const algorithmSignature = trainingAlgorithmSignature(config);
  const versionIdentity = modelVersionFor({
    fitArtifactHash,
    modelContractHash: contractHash,
    algorithmSignature,
  });
  const modelFields = { ...model };
  delete modelFields.artifact_hash;
  const trainingOutcomeSnapshotRefs = dataset.outcomeSnapshot
    .map((entry) => ({ ...entry }))
    .sort((left, right) =>
      left.record_id.localeCompare(right.record_id) || left.revision - right.revision,
    );
  const trainingCoverageAssertionRefs = dataset.coverageAssertionSnapshot
    .map((assertion) => ({
      assertion_id: assertion.assertion_id,
      revision: assertion.revision,
      data_hash: hashLabel(assertion),
    }))
    .sort((left, right) =>
      left.assertion_id.localeCompare(right.assertion_id) || left.revision - right.revision,
    );
  const outcomeKeys = trainingOutcomeSnapshotRefs.map(
    (entry) => `${entry.record_id}@${entry.revision}`,
  );
  const coverageKeys = trainingCoverageAssertionRefs.map(
    (entry) => `${entry.assertion_id}@${entry.revision}`,
  );
  if (
    new Set(outcomeKeys).size !== outcomeKeys.length ||
    trainingOutcomeSnapshotRefs.some((entry) =>
      typeof entry.data_hash !== "string" || entry.data_hash.length === 0
    )
  ) {
    throw new Error("Training outcome lineage must contain unique exact revisions with hashes");
  }
  if (
    new Set(coverageKeys).size !== coverageKeys.length ||
    trainingCoverageAssertionRefs.some((entry) =>
      typeof entry.data_hash !== "string" || entry.data_hash.length === 0
    )
  ) {
    throw new Error("Training coverage lineage must contain unique exact revisions with hashes");
  }
  const artifact = {
    artifact_version: "reset-model-artifact/0.3.0",
    model_version: versionIdentity.modelVersion,
    version_policy_hash: versionIdentity.versionPolicyHash,
    trained_at: new Date().toISOString(),
    training_cutoff: dataset.trainingCutoff,
    training_as_of_mode: dataset.asOfMode,
    training_coverage_as_of_mode: dataset.coverageAsOfMode,
    feature_schema_version: config.feature_schema_version,
    taxonomy_version: config.taxonomy_version,
    deduplication_version: config.deduplication_version,
    extractor_model: extractorContract(config).model,
    extractor_model_version: extractorContract(config).model_version,
    extractor_prompt_version: extractorContract(config).prompt_version,
    extractor_semantic_policy_hash: extractorContract(config).semantic_policy_hash,
    config_hash: config.config_hash,
    model_contract_hash: contractHash,
    evaluation_contract_hash: evaluationContractHash(config),
    training_algorithm_signature: algorithmSignature,
    training_hyperparameters: {
      lambda: config.model.lambda,
      initial_step: config.model.learning_rate,
      gradient_tolerance: config.model.gradient_tolerance,
      objective_tolerance: config.model.objective_tolerance,
      hessian_step: config.model.hessian_step,
      max_iterations: config.model.max_iterations,
      coefficient_priors: structuredClone(config.model.coefficient_priors),
    },
    training_outcome_snapshot_refs: trainingOutcomeSnapshotRefs,
    training_outcome_snapshot_hash: hashLabel(trainingOutcomeSnapshotRefs),
    training_coverage_assertion_refs: trainingCoverageAssertionRefs,
    training_coverage_assertion_snapshot_hash:
      hashLabel(trainingCoverageAssertionRefs),
    fit_artifact_hash: fitArtifactHash,
    ...modelFields,
    calibrator_version: calibratorPolicy(config).version,
    calibrator: {
      ...calibratorPolicy(config),
      fitted: false,
      reason: "identity_policy_until_versioned_oof_calibrator_is_available",
      minimum_out_of_fold_events:
        config.model.minimum_live_evaluation_events,
    },
  };
  artifact.artifact_hash = sha256(stableStringify(artifact));
  assertModelCompatibility(artifact, {
    featureNames: FEATURE_NAMES,
    featureSchemaVersion: config.feature_schema_version,
    modelContractHash: modelContractHash(config),
    requireConverged: true,
  });
  await store.writeModel("challenger", artifact);
  return { model: artifact, dataset };
}
