import { XProvider } from "../providers/x-provider.mjs";
import { XSearchGatewayProvider } from "../providers/x-search-gateway-provider.mjs";
import { HistoricalMonitorProvider } from "../providers/historical-monitor-provider.mjs";
import { RsshubXProvider } from "../providers/rsshub-x-provider.mjs";
import { reviewResetClaims } from "../semantic-assistance/reset-review.mjs";
import { normalizeNewObservations } from "./extract.mjs";
import { linkEventCandidates } from "./link.mjs";
import { buildImpactEpisodes } from "./impact-episodes.mjs";
import { adjudicateOutcomes } from "./outcomes.mjs";
import { trainChallenger } from "../model/training.mjs";
import {
  EVALUATION_WAITING_SCHEMA_VERSION,
  evaluateWalkForward,
  evaluationWaitingFromError,
  promoteChallenger,
} from "../model/evaluation.mjs";
import { issueForecast } from "../model/forecast.mjs";
import { ceilHour, floorHour } from "../core/time.mjs";
import { evaluateIssuedForecasts } from "../model/issued-evaluation.mjs";
import { settleIssuedPredictions } from "../model/settlement.mjs";
import {
  FEATURE_NAMES,
  buildForecastFeatureSnapshots,
} from "../model/features.mjs";
import { assertModelCompatibility } from "../model/logistic-hazard.mjs";
import { modelContractHash } from "../model/contract.mjs";
import {
  assessLiveForecastPromotionGuard,
} from "../model/live-forecast-guard.mjs";
import { adequateCoverageIntervals } from "./coverage.mjs";
import {
  aggregateCoverageWaiting,
  normalizeProviderCoverageWaiting,
} from "../core/coverage-waiting.mjs";

function providerStateKey(name) {
  return `${name.replaceAll("_", "-")}-provider`;
}

async function configuredCoverageWaiting(store, config, collection, now) {
  const requiredProviders = new Set(
    config.model.outcome_coverage_providers ?? [],
  );
  const collectionWaiting = Object.values(collection ?? {})
    .filter((entry) => entry?.required === true)
    .map((entry) => entry.coverage_waiting);
  const providerWaiting = await Promise.all(
    Object.entries(config.providers ?? {})
      .filter(([, provider]) =>
        provider &&
        typeof provider === "object" &&
        !Array.isArray(provider) &&
        provider.enabled
      )
      .map(async ([name]) => {
        const state = await store.readState(providerStateKey(name), {});
        const waiting = normalizeProviderCoverageWaiting(state.coverage_waiting);
        return waiting && requiredProviders.has(waiting.provider_id)
          ? waiting
          : null;
      }),
  );
  return aggregateCoverageWaiting(
    [...collectionWaiting, ...providerWaiting],
    { now },
  );
}

export async function processRecords(store, config, { now = new Date() } = {}) {
  const normalized = await normalizeNewObservations(store, config, { now });
  const resetReview = await reviewResetClaims(store, config, { now });
  const processedAt = resetReview.completed_at
    ? new Date(Math.max(new Date(now).getTime(), Date.parse(resetReview.completed_at))) : now;
  const impactEpisodes = await buildImpactEpisodes(store, config, {
    asOf: processedAt,
  });
  const linked = await linkEventCandidates(store, config, { asOf: processedAt });
  const outcomes = await adjudicateOutcomes(store, config, { now: processedAt });
  return { normalized, resetReview, impactEpisodes, linked, outcomes };
}

function assertCompatibleModel(model, config) {
  assertModelCompatibility(model, {
    featureNames: FEATURE_NAMES,
    featureSchemaVersion: config.feature_schema_version,
    modelContractHash: modelContractHash(config),
    requireConverged: true,
  });
  return model;
}

async function compatibleStoredModel(store, name, config) {
  const model = await store.readModel(name, { invalidAsNull: true });
  if (!model) return null;
  try {
    return assertCompatibleModel(model, config);
  } catch {
    return null;
  }
}

function eligibleProvisionalBootstrapModel(model, config) {
  const policy = config.runtime?.provisional_bootstrap;
  return Boolean(
    policy?.enabled === true &&
    Number.isInteger(policy.minimum_outcomes) &&
    policy.minimum_outcomes > 0 &&
    Number.isInteger(model?.event_count) &&
    model.event_count >= policy.minimum_outcomes,
  );
}

function sampleEvaluationWaiting(evaluation, promotion) {
  if (promotion?.reason !== "evaluation_sample_threshold_not_met") return null;
  return {
    schema_version: EVALUATION_WAITING_SCHEMA_VERSION,
    status: "waiting_for_evaluation",
    reason_code: promotion.reason,
    evaluation_cutoff: evaluation.evaluation_cutoff,
    accepted_fold_count: evaluation.folds?.length ?? 0,
    rejected_fold_count: evaluation.rejected_folds?.length ?? 0,
    evaluated_windows: evaluation.metrics?.evaluated_windows ?? 0,
    evaluated_events: evaluation.metrics?.evaluated_events ?? 0,
    minimum_evaluation_windows:
      promotion.sample_gate.minimum_live_evaluation_windows,
    minimum_evaluation_events:
      promotion.sample_gate.minimum_live_evaluation_events,
  };
}

export async function trainEvaluatePromote(store, config, {
  now = new Date(),
  train = true,
  onTrained = null,
  promotionGuard = null,
} = {}) {
  const trainingCutoff = new Date(now);
  if (Number.isNaN(trainingCutoff.getTime())) {
    throw new TypeError("Invalid training cutoff");
  }
  if (
    config.model.live_forecast_promotion_guard?.enabled === true &&
    typeof promotionGuard !== "function"
  ) {
    throw new Error(
      "Enabled live forecast promotion guard requires an evaluated live snapshot set",
    );
  }
  const evaluationCutoff = floorHour(trainingCutoff);
  const training = train
    ? await trainChallenger(store, config, {
        trainingCutoff,
        persist: typeof promotionGuard !== "function",
      })
    : null;
  let existingChallenger = null;
  if (!training) {
    existingChallenger = await store.readModel("challenger", {
      invalidAsNull: true,
    });
    if (!existingChallenger) {
      throw new Error("No compatible challenger exists for evaluation");
    }
    assertCompatibleModel(existingChallenger, config);
  }
  const guardSubject = training ?? {
    model: existingChallenger,
    reused_challenger: true,
  };
  const promotionGuardResult = guardSubject && promotionGuard
    ? await promotionGuard(guardSubject)
    : null;
  if (promotionGuardResult?.passed === false) {
    return {
      status: "promotion_blocked",
      training,
      evaluation: null,
      promotion: {
        promoted: false,
        reason: "live_forecast_promotion_guard_rejected",
        model: guardSubject.model,
      },
      promotion_guard: promotionGuardResult,
      evaluation_waiting: null,
    };
  }
  if (
    training &&
    config.model.live_forecast_promotion_guard?.enabled === true &&
    typeof promotionGuardResult?.passed !== "boolean"
  ) {
    throw new Error(
      "Enabled live forecast promotion guard returned no auditable decision",
    );
  }
  if (training && typeof promotionGuard === "function") {
    await store.writeModel("challenger", training.model);
  }
  if (training && onTrained) await onTrained(training);
  let evaluation;
  try {
    evaluation = await evaluateWalkForward(store, config, {
      evaluationCutoff,
    });
  } catch (error) {
    const evaluationWaiting = evaluationWaitingFromError(error);
    if (!evaluationWaiting) throw error;
    return {
      status: "waiting_for_evaluation",
      training,
      evaluation: null,
      promotion: null,
      promotion_guard: promotionGuardResult,
      evaluation_waiting: evaluationWaiting,
    };
  }
  const promotion = await promoteChallenger(store, evaluation, config);
  const evaluationWaiting = sampleEvaluationWaiting(evaluation, promotion);
  return {
    status: evaluationWaiting ? "waiting_for_evaluation" : "completed",
    training,
    evaluation,
    promotion,
    promotion_guard: promotionGuardResult,
    evaluation_waiting: evaluationWaiting,
  };
}

export async function collectConfiguredProviders(store, config, { instances = {} } = {}) {
  const collections = {};
  const outcomeProviders = new Set(config.model.outcome_coverage_providers ?? []);
  const descriptors = [];
  const addProvider = (name, providerName, provider, { mutatesCoverage = false } = {}) => {
    descriptors.push({
      name,
      providerName,
      provider,
      required: outcomeProviders.has(providerName),
      mutatesCoverage,
    });
  };
  const collectProvider = async ({ name, providerName, provider, required }) => {
    try {
      const providerResult = await provider.collect(store);
      collections[name] = {
        ok: true,
        fetched: true,
        required,
        provider: providerName,
        ...providerResult,
      };
    } catch (error) {
      collections[name] = {
        ok: false,
        fetched: false,
        required,
        provider: providerName,
        error: error.message,
      };
    }
  };
  if (config.providers.x.enabled) {
    addProvider(
      "x",
      "x",
      instances.x ?? new XProvider({ config: config.providers.x, target: config.target }),
      { mutatesCoverage: true },
    );
  }
  if (config.providers.x_search_gateway.enabled) {
    const provider = instances.x_search_gateway ?? new XSearchGatewayProvider({
      config: config.providers.x_search_gateway,
    });
    addProvider(
      "x_search_gateway",
      provider.providerName,
      provider,
    );
  }
  if (config.providers.rsshub_x_timeline.enabled) {
    const provider = instances.rsshub_x_timeline ?? new RsshubXProvider({
      config: config.providers.rsshub_x_timeline,
    });
    addProvider(
      "rsshub_x_timeline",
      provider.providerName,
      provider,
    );
  }
  if (config.providers.historical_monitor.enabled) {
    const provider = instances.historical_monitor ?? new HistoricalMonitorProvider({
      config: config.providers.historical_monitor,
      target: config.target,
      outcomeDefinition: config.outcome_definition,
    });
    addProvider(
      "historical_monitor",
      provider.providerName,
      provider,
      { mutatesCoverage: true },
    );
  }
  const required = descriptors.filter((descriptor) => descriptor.required);
  const optionalCoverage = descriptors.filter((descriptor) =>
    !descriptor.required && descriptor.mutatesCoverage
  );
  const optionalContext = descriptors.filter((descriptor) =>
    !descriptor.required && !descriptor.mutatesCoverage
  );
  for (const descriptor of required) await collectProvider(descriptor);
  for (const descriptor of optionalCoverage) await collectProvider(descriptor);
  await Promise.all(optionalContext.map(collectProvider));
  return Object.keys(collections).length > 0 ? collections : null;
}

export async function runPipeline(store, config, {
  now = null,
  clock = () => new Date(),
  collect = true,
  retrain = false,
  providerInstances = {},
  assessPromotionGuard = assessLiveForecastPromotionGuard,
} = {}) {
  const fixedNow = now === null || now === undefined ? null : new Date(now);
  if (fixedNow && Number.isNaN(fixedNow.getTime())) {
    throw new TypeError("Invalid fixed pipeline time");
  }
  const currentTime = () => {
    const value = fixedNow ?? new Date(clock());
    if (Number.isNaN(value.getTime())) throw new TypeError("Pipeline clock returned an invalid time");
    return new Date(value);
  };
  const result = {
    status: "running",
    collection: null,
    processing: null,
    training: null,
    promotion_guard: null,
    forecast: null,
    coverage_waiting: null,
    evaluation_waiting: null,
    issuedEvaluation: null,
    settlements: null,
    timing: {
      started_at: currentTime().toISOString(),
      processing_completed_at: null,
      knowledge_cutoff: null,
      horizon_start: null,
      forecast_issued_at: null,
      completed_at: null,
    },
  };
  if (collect) {
    result.collection = await collectConfiguredProviders(store, config, {
      instances: providerInstances,
    });
  }
  result.processing = await processRecords(store, config, { now: currentTime() });
  const knowledgeCutoff = currentTime();
  const horizonStart = ceilHour(knowledgeCutoff);
  result.timing.processing_completed_at = knowledgeCutoff.toISOString();
  result.timing.knowledge_cutoff = knowledgeCutoff.toISOString();
  result.timing.horizon_start = horizonStart.toISOString();
  const coverageWaiting = await configuredCoverageWaiting(
    store,
    config,
    result.collection,
    knowledgeCutoff,
  );
  if (coverageWaiting) {
    const coverage = await adequateCoverageIntervals(
      store,
      config.model.outcome_coverage_providers,
      { config },
    );
    if (coverage.length === 0) {
      result.status = "waiting_for_coverage";
      result.coverage_waiting = coverageWaiting;
      result.training = {
        succeeded: false,
        skipped: true,
        reason_code: coverageWaiting.reason_code,
      };
      result.timing.completed_at = currentTime().toISOString();
      return result;
    }
  }
  let champion = await compatibleStoredModel(store, "champion", config);
  const challenger = await compatibleStoredModel(store, "challenger", config);
  const previousServingModel = champion ?? challenger;
  let provisionalModel = null;
  let guardedRestoredProvisional = null;
  if (retrain || !champion) {
    const train = retrain || !challenger;
    const challengerRestoreModel = train
      ? challenger ?? champion
      : champion;
    let attempt;
    try {
      attempt = await trainEvaluatePromote(store, config, {
        now: knowledgeCutoff,
        train,
        promotionGuard:
          train ||
          config.model.live_forecast_promotion_guard?.enabled === true
          ? async (training) => {
              const { snapshots } = await buildForecastFeatureSnapshots(
                store,
                config,
                {
                  knowledgeCutoff,
                  horizonStart,
                  horizonHours: 168,
                  createdAt: currentTime(),
                },
              );
              return assessPromotionGuard({
                candidate: training.model,
                previous: train ? previousServingModel : champion,
                snapshots,
                policy: config.model.live_forecast_promotion_guard,
              });
            }
          : null,
        onTrained: async (training) => {
          if (
            !champion &&
            eligibleProvisionalBootstrapModel(training.model, config)
          ) {
            result.forecast = await issueForecast(store, config, {
              model: training.model,
              validationStatus: "provisional",
              knowledgeCutoff,
              horizonStart,
              clock: currentTime,
            });
            result.timing.horizon_start =
              result.forecast.prediction.data.horizon.start;
            result.timing.forecast_issued_at =
              result.forecast.prediction.data.issued_at;
          }
        },
      });
    } catch (error) {
      if (!champion) throw error;
      result.training = {
        status: "failed",
        succeeded: false,
        skipped: false,
        reused_challenger: false,
        error: error.message,
      };
    }
    if (attempt) {
      if (attempt.status === "promotion_blocked" && challengerRestoreModel) {
        let restorationGuard = null;
        const restoringProvisional =
          !champion &&
          challengerRestoreModel === challenger;
        if (restoringProvisional) {
          const { snapshots } = await buildForecastFeatureSnapshots(
            store,
            config,
            {
              knowledgeCutoff,
              horizonStart,
              horizonHours: 168,
              createdAt: currentTime(),
            },
          );
          restorationGuard = await assessPromotionGuard({
            candidate: challengerRestoreModel,
            previous: null,
            snapshots,
            policy: config.model.live_forecast_promotion_guard,
          });
          if (restorationGuard.passed) {
            guardedRestoredProvisional = challengerRestoreModel;
          }
        } else {
          await store.writeModel("challenger", challengerRestoreModel);
        }
        attempt.promotion_guard = {
          ...attempt.promotion_guard,
          challenger_restoration: {
            attempted: true,
            restored:
              !restoringProvisional || restorationGuard?.passed === true,
            restored_model_version: challengerRestoreModel.model_version,
            restored_artifact_hash: challengerRestoreModel.artifact_hash,
            source: challenger ? "previous_challenger" : "champion_fallback",
            guard: restorationGuard,
          },
        };
      }
      result.training = {
        succeeded: Boolean(attempt.training),
        skipped: !attempt.training,
        reused_challenger: !attempt.training,
        ...attempt,
      };
      result.promotion_guard = attempt.promotion_guard ?? null;
      result.evaluation_waiting = attempt.evaluation_waiting;
    }
    champion = await compatibleStoredModel(store, "champion", config);
    if (attempt?.status === "promotion_blocked" && !champion) {
      result.status = "promotion_blocked";
      if (!guardedRestoredProvisional) {
        result.timing.completed_at = currentTime().toISOString();
        return result;
      }
      if (
        eligibleProvisionalBootstrapModel(
          guardedRestoredProvisional,
          config,
        )
      ) {
        provisionalModel = guardedRestoredProvisional;
      } else {
        result.timing.completed_at = currentTime().toISOString();
        return result;
      }
    } else if (attempt?.status === "waiting_for_evaluation") {
      result.status = "waiting_for_evaluation";
      if (!champion) {
        const latestChallenger = await compatibleStoredModel(
          store,
          "challenger",
          config,
        );
        if (eligibleProvisionalBootstrapModel(latestChallenger, config)) {
          provisionalModel = latestChallenger;
        } else {
          result.timing.completed_at = currentTime().toISOString();
          return result;
        }
      }
    }
  }
  const forecastModel = champion ?? provisionalModel;
  if (!forecastModel) {
    throw new Error("No model passed the promotion gate; forecast was not published");
  }
  result.forecast = await issueForecast(store, config, {
    model: forecastModel,
    validationStatus: provisionalModel ? "provisional" : "validated",
    knowledgeCutoff,
    horizonStart,
    clock: currentTime,
  });
  result.timing.horizon_start = result.forecast.prediction.data.horizon.start;
  result.timing.forecast_issued_at = result.forecast.prediction.data.issued_at;
  const evaluationCutoff = floorHour(currentTime());
  result.settlements = await settleIssuedPredictions(store, config, {
    settlementCutoff: evaluationCutoff,
  });
  result.issuedEvaluation = await evaluateIssuedForecasts(store, config, {
    evaluationCutoff,
  });
  result.status = result.training?.status === "promotion_blocked"
    ? "promotion_blocked"
    : result.training?.status === "failed"
    ? "completed_with_training_error"
    : result.evaluation_waiting
      ? "waiting_for_evaluation"
      : "completed";
  result.timing.completed_at = currentTime().toISOString();
  return result;
}
