import { hashLabel, sha256 } from "../core/hash.mjs";
import { extractorContract } from "../core/extractor-contract.mjs";
import { FEATURE_NAMES } from "./features.mjs";
import { OUTCOME_LABEL_POLICY_VERSION } from "../core/outcome-contract.mjs";
import { canonicalSourceIdentityPolicy } from "../core/sources.mjs";

const DEFAULT_CALIBRATOR_POLICY = Object.freeze({
  version: "identity-hourly-hazard/1",
  method: "identity",
  fit_source: "none",
});

export function calibratorPolicy(config) {
  return {
    ...DEFAULT_CALIBRATOR_POLICY,
    ...(config.model.calibrator ?? {}),
  };
}

export function modelContractHash(config) {
  return hashLabel({
    target: config.target,
    outcome_definition: config.outcome_definition,
    taxonomy_version: config.taxonomy_version,
    feature_schema_version: config.feature_schema_version,
    deduplication_version: config.deduplication_version,
    timezone_database_version: config.timezone_database_version,
    extractor: extractorContract(config),
    feature_names: FEATURE_NAMES,
    outcome_coverage_providers: config.model.outcome_coverage_providers,
    outcome_coverage_adequacy: "negative_label_eligible",
    outcome_label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
    source_identity_policy: canonicalSourceIdentityPolicy(config),
    as_of_policy: {
      live_outcome_clock: "known_at",
      archive_outcome_clock: "replay_available_at_or_known_at",
      synthetic_outcome_clock:
        "replay_available_at_or_occurred_range_end_or_known_at",
      archive_observation_clock: "attested_initial_availability_then_fetch_time",
      archive_signal_clock: "available_at",
      live_coverage_clock: "asserted_at",
      archive_coverage_clock:
        "independently_attested_replay_available_at_or_asserted_at",
      synthetic_coverage_clock:
        "fixture_manifest_start_for_initial_revision_only",
    },
    signal_recency_basis: "source-published-or-asserted-time/1",
    family: config.model.family,
    authority_timing: config.model.authority_timing,
    lambda: config.model.lambda,
    coefficient_priors: config.model.coefficient_priors,
    maximum_training_days: config.model.maximum_training_days,
    optimizer: {
      implementation: "bfgs-backtracking/2",
      initial_step: config.model.learning_rate,
      gradient_tolerance: config.model.gradient_tolerance,
      objective_tolerance: config.model.objective_tolerance,
      hessian_step: config.model.hessian_step,
      max_iterations: config.model.max_iterations,
    },
    interval_likelihood: "exposure-weighted/1",
    calibrator: {
      ...calibratorPolicy(config),
      minimum_out_of_fold_events:
        config.model.minimum_live_evaluation_events,
    },
    uncertainty_policy:
      "inverse-observed-numerical-hessian-or-explicitly-unavailable/1",
  });
}

export function trainingAlgorithmSignature(config) {
  return hashLabel({
    model_contract_hash: modelContractHash(config),
    trainer: "discrete-time-survival/0.3.0",
    feature_builder: "dual-clock-as-of-purged-label-sources/2",
  });
}

export function evaluationContractHash(config) {
  return hashLabel({
    model_contract_hash: modelContractHash(config),
    evaluation_versions: {
      walk_forward: "reset-evaluation/0.3.0",
      as_issued: "reset-issued-evaluation/0.3.0",
    },
    minimum_outcomes: config.model.minimum_outcomes,
    minimum_live_evaluation_windows:
      config.model.minimum_live_evaluation_windows ?? null,
    minimum_live_evaluation_events:
      config.model.minimum_live_evaluation_events ?? null,
    promotion: {
      minimum_event_window_recall:
        config.model.promotion.minimum_event_window_recall,
      require_brier_skill_above:
        config.model.promotion.require_brier_skill_above,
      maximum_expected_calibration_error:
        config.model.promotion.maximum_expected_calibration_error,
      top_window_hours_per_week:
        config.model.promotion.top_window_hours_per_week,
    },
    fold_length_hours: 168,
    display_window_hours: 4,
    alert_policy: {
      type: "fixed_top_n_per_complete_week",
      budget: config.model.promotion.top_window_hours_per_week,
      tie_breaker: "probability_desc_then_earlier_anchor",
    },
    champion_replacement_policy: {
      same_policy_refit: "paired_non_regression_with_1e-12_tolerance",
      incompatible_policy: "explicit_migration_required_without_bridge_evidence",
    },
  });
}

export function evaluationArtifactHash(evaluation) {
  const { evaluation_artifact_hash: _ignored, ...payload } = evaluation ?? {};
  return hashLabel(payload);
}

export function modelVersionFor({
  fitArtifactHash,
  modelContractHash: contractHash,
  algorithmSignature,
}) {
  const policyHash = sha256({
    artifact_version: "reset-model-artifact/0.3.0",
    fit_artifact_hash: fitArtifactHash,
    model_contract_hash: contractHash,
    training_algorithm_signature: algorithmSignature,
  });
  return {
    modelVersion: `reset-model/0.3.0-${policyHash.slice(0, 12)}`,
    versionPolicyHash: policyHash,
  };
}
