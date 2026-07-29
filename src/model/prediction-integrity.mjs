import { extractorContract } from "../core/extractor-contract.mjs";
import { hashLabel } from "../core/hash.mjs";
import {
  predictionRequiresPostOutcomeRefractory,
} from "../core/prediction-contract.mjs";
import { modelContractHash } from "./contract.mjs";
import { deriveProbabilitySlots } from "./forecast.mjs";
import {
  dataQualityScore,
  FEATURE_NAMES,
  featuresToArray,
} from "./features.mjs";
import {
  assertModelCompatibility,
  predictHazard,
} from "./logistic-hazard.mjs";
import {
  conditionAuthorityTimingHazards,
  latestRecurrenceAnchorAsOf,
} from "./authority-timing.mjs";
import {
  conditionPostOutcomeRefractoryHazards,
} from "./post-outcome-refractory.mjs";

function exactRefKey(record) {
  return `${record.record_id}@${record.revision}`;
}

function nearlyEqual(left, right, tolerance) {
  return Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance;
}

function nullableNumberEqual(left, right, tolerance) {
  return left === null && right === null ||
    nearlyEqual(left, right, tolerance);
}

function intervalEqual(left, right, tolerance) {
  if (left === null || right === null) return left === right;
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => nearlyEqual(value, right[index], tolerance));
}

export function assessPredictionIntegrity({
  prediction,
  featureSnapshots,
  model: suppliedModel = null,
  champion = null,
  config,
  signals = [],
  observations = [],
  outcomes = [],
  tolerance = 1e-10,
}) {
  const reasons = [];
  if (!prediction?.data) {
    return { valid: false, reasons: ["prediction_missing"] };
  }
  if (
    predictionRequiresPostOutcomeRefractory(prediction) &&
    prediction.data.post_outcome_refractory === undefined
  ) {
    reasons.push("prediction_post_outcome_refractory_missing");
  }
  const modelArtifact = suppliedModel ?? champion;
  if (!modelArtifact) {
    return { valid: false, reasons: ["prediction_model_missing"] };
  }
  try {
    assertModelCompatibility(modelArtifact, {
      featureNames: FEATURE_NAMES,
      featureSchemaVersion: config.feature_schema_version,
      modelContractHash: modelContractHash(config),
      requireConverged: true,
    });
  } catch {
    reasons.push("prediction_model_incompatible");
  }
  const predictionModel = prediction.data.model ?? {};
  if (
    prediction.data.event_process !== "first_reset" ||
    prediction.data.base_slot !== "PT1H" ||
    prediction.data.display_horizon !== "PT4H" ||
    hashLabel(prediction.data.scope ?? null) !== hashLabel(config.target ?? null)
  ) {
    reasons.push("prediction_contract_mismatch");
  }
  if (predictionModel.version !== modelArtifact.model_version) {
    reasons.push("prediction_model_version_mismatch");
  }
  if (predictionModel.artifact_hash !== modelArtifact.artifact_hash) {
    reasons.push("prediction_model_artifact_mismatch");
  }
  if (predictionModel.model_contract_hash !== modelArtifact.model_contract_hash) {
    reasons.push("prediction_model_contract_mismatch");
  }
  if (predictionModel.training_cutoff !== modelArtifact.training_cutoff) {
    reasons.push("prediction_training_cutoff_mismatch");
  }
  const refs = prediction.data.feature_snapshot_refs;
  const slots = prediction.data.slots;
  if (
    !Array.isArray(refs) ||
    !Array.isArray(slots) ||
    refs.length !== slots.length ||
    refs.length !== 168
  ) {
    reasons.push("prediction_feature_ref_count_mismatch");
    return { valid: false, reasons: [...new Set(reasons)] };
  }
  if (new Set(refs.map(exactRefKey)).size !== refs.length) {
    reasons.push("prediction_feature_refs_not_unique");
  }
  const snapshotsByRef = new Map(
    (featureSnapshots ?? []).map((snapshot) => [
      exactRefKey(snapshot),
      snapshot,
    ]),
  );
  const exactSnapshots = refs.map((ref) => snapshotsByRef.get(exactRefKey(ref)));
  if (exactSnapshots.some((snapshot) => !snapshot)) {
    reasons.push("prediction_feature_snapshot_missing");
    return { valid: false, reasons: [...new Set(reasons)] };
  }
  const extractor = extractorContract(config);
  if (
    prediction.data.horizon?.start !== slots[0]?.start ||
    prediction.data.horizon?.end !== slots.at(-1)?.end ||
    prediction.data.horizon?.boundary !== "[start,end)"
  ) {
    reasons.push("prediction_horizon_mismatch");
  }
  for (let index = 0; index < exactSnapshots.length; index += 1) {
    const snapshot = exactSnapshots[index];
    const slot = slots[index];
    const data = snapshot.data ?? {};
    if (
      snapshot.record_type !== "feature_snapshot" ||
      data.knowledge_cutoff !== prediction.data.knowledge_cutoff ||
      data.target?.start !== slot.start ||
      data.target?.end !== slot.end ||
      data.target?.base_slot !== "PT1H" ||
      data.target?.display_horizon !== "PT4H"
    ) {
      reasons.push("prediction_feature_snapshot_alignment_mismatch");
    }
    for (const [actual, expected] of [
      [data.config_hash, config.config_hash],
      [data.feature_schema_version, config.feature_schema_version],
      [data.taxonomy_version, config.taxonomy_version],
      [data.deduplication_version, config.deduplication_version],
      [data.timezone_database_version, config.timezone_database_version],
      [data.extractor_model, extractor.model],
      [data.extractor_model_version, extractor.model_version],
      [data.extractor_prompt_version, extractor.prompt_version],
      [data.extractor_semantic_policy_hash, extractor.semantic_policy_hash],
    ]) {
      if (actual !== expected) {
        reasons.push("prediction_feature_snapshot_contract_mismatch");
        break;
      }
    }
  }
  if (reasons.length > 0) {
    return { valid: false, reasons: [...new Set(reasons)] };
  }
  const expectedQualityScore = exactSnapshots.reduce(
    (sum, snapshot) => sum + dataQualityScore(snapshot),
    0,
  ) / exactSnapshots.length;
  const firstQuality = exactSnapshots[0].data.data_quality;
  if (
    !nearlyEqual(
      prediction.data.data_quality?.score,
      expectedQualityScore,
      tolerance,
    ) ||
    !nearlyEqual(
      prediction.data.data_quality?.provider_coverage,
      firstQuality.provider_coverage,
      tolerance,
    ) ||
    prediction.data.data_quality?.outcome_sample_count !==
      firstQuality.outcome_sample_count ||
    !nearlyEqual(
      prediction.data.data_quality?.sample_sufficiency,
      firstQuality.sample_sufficiency,
      tolerance,
    ) ||
    exactSnapshots.some((snapshot) =>
      snapshot.data.data_quality.outcome_sample_count !==
        firstQuality.outcome_sample_count ||
      !nearlyEqual(
        snapshot.data.data_quality.sample_sufficiency,
        firstQuality.sample_sufficiency,
        tolerance,
      )
    )
  ) {
    reasons.push("prediction_data_quality_mismatch");
  }
  let recomputed;
  try {
    const baseHazards = exactSnapshots.map((snapshot) => {
      const predictionResult = predictHazard(
        modelArtifact,
        featuresToArray(snapshot.data.features),
      );
      return {
        start: snapshot.data.target.start,
        end: snapshot.data.target.end,
        hazard: predictionResult.probability,
        interval80: predictionResult.interval80,
      };
    });
    let recomputedHazards = baseHazards;
    if (prediction.data.post_outcome_refractory !== undefined) {
      const refractory = conditionPostOutcomeRefractoryHazards({
        hazardEntries: baseHazards,
        signals,
        observations,
        outcomes,
        config,
        knowledgeCutoff: prediction.data.knowledge_cutoff,
      });
      recomputedHazards = refractory.hazardEntries;
      if (
        hashLabel(refractory.metadata) !==
          hashLabel(prediction.data.post_outcome_refractory)
      ) {
        reasons.push("prediction_post_outcome_refractory_mismatch");
      }
    }
    if (prediction.data.authority_conditioning !== undefined) {
      const conditioned = conditionAuthorityTimingHazards({
        hazardEntries: recomputedHazards,
        signals,
        observations,
        outcomes,
        config,
        knowledgeCutoff: prediction.data.knowledge_cutoff,
      });
      recomputedHazards = conditioned.hazardEntries;
      if (
        hashLabel(conditioned.metadata) !==
          hashLabel(prediction.data.authority_conditioning)
      ) {
        reasons.push("prediction_authority_conditioning_mismatch");
      }
    }
    const expectedAnchor = latestRecurrenceAnchorAsOf({
      signals,
      observations,
      outcomes,
      config,
      knowledgeCutoff: prediction.data.knowledge_cutoff,
    });
    if (
      prediction.data.recurrence_anchor !== undefined &&
      hashLabel(expectedAnchor) !==
        hashLabel(prediction.data.recurrence_anchor)
    ) {
      reasons.push("prediction_recurrence_anchor_mismatch");
    }
    recomputed = deriveProbabilitySlots(recomputedHazards);
  } catch {
    return {
      valid: false,
      reasons: ["prediction_probability_recompute_failed"],
    };
  }
  for (let index = 0; index < slots.length; index += 1) {
    const actual = slots[index];
    const expected = recomputed.slots[index];
    if (
      actual.start !== expected.start ||
      actual.end !== expected.end ||
      !nearlyEqual(actual.hazard, expected.hazard, tolerance) ||
      !nearlyEqual(
        actual.first_reset_probability,
        expected.first_reset_probability,
        tolerance,
      ) ||
      !nearlyEqual(
        actual.reset_by_end_probability,
        expected.reset_by_end_probability,
        tolerance,
      ) ||
      !nullableNumberEqual(
        actual.rolling_4h_probability,
        expected.rolling_4h_probability,
        tolerance,
      ) ||
      !intervalEqual(
        actual.epistemic_interval_80,
        expected.epistemic_interval_80,
        tolerance,
      )
    ) {
      reasons.push("prediction_probability_mismatch");
      break;
    }
  }
  if (
    !nearlyEqual(
      prediction.data.no_reset_probability,
      recomputed.noResetProbability,
      tolerance,
    )
  ) {
    reasons.push("prediction_no_reset_probability_mismatch");
  }
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    checked_feature_snapshot_count: exactSnapshots.length,
    checked_model_version: modelArtifact.model_version ?? null,
    checked_model_artifact_hash: modelArtifact.artifact_hash ?? null,
  };
}
