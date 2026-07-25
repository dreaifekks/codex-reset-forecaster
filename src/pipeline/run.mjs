import { XProvider } from "../providers/x-provider.mjs";
import { XSearchGatewayProvider } from "../providers/x-search-gateway-provider.mjs";
import { HistoricalMonitorProvider } from "../providers/historical-monitor-provider.mjs";
import { normalizeNewObservations } from "./extract.mjs";
import { linkEventCandidates } from "./link.mjs";
import { adjudicateOutcomes } from "./outcomes.mjs";
import { trainChallenger } from "../model/training.mjs";
import { evaluateWalkForward, promoteChallenger } from "../model/evaluation.mjs";
import { issueForecast } from "../model/forecast.mjs";
import { ceilHour, floorHour } from "../core/time.mjs";
import { evaluateIssuedForecasts } from "../model/issued-evaluation.mjs";
import { settleIssuedPredictions } from "../model/settlement.mjs";
import { FEATURE_NAMES } from "../model/features.mjs";
import { assertModelCompatibility } from "../model/logistic-hazard.mjs";
import { modelContractHash } from "../model/contract.mjs";

export async function processRecords(store, config, { now = new Date() } = {}) {
  const normalized = await normalizeNewObservations(store, config, { now });
  const linked = await linkEventCandidates(store, config, { asOf: now });
  const outcomes = await adjudicateOutcomes(store, config, { now });
  return { normalized, linked, outcomes };
}

export async function trainEvaluatePromote(store, config, { now = new Date() } = {}) {
  const cutoff = floorHour(now);
  const training = await trainChallenger(store, config, { trainingCutoff: cutoff });
  const evaluation = await evaluateWalkForward(store, config, { evaluationCutoff: cutoff });
  const promotion = await promoteChallenger(store, evaluation);
  return { training, evaluation, promotion };
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
  if (config.providers.historical_monitor.enabled) {
    const provider = instances.historical_monitor ?? new HistoricalMonitorProvider({
      config: config.providers.historical_monitor,
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
    collection: null,
    processing: null,
    training: null,
    forecast: null,
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
  let champion = await store.readModel("champion", { invalidAsNull: true });
  let championCompatible = false;
  if (champion) {
    try {
      assertModelCompatibility(champion, {
        featureNames: FEATURE_NAMES,
        featureSchemaVersion: config.feature_schema_version,
        modelContractHash: modelContractHash(config),
        requireConverged: true,
      });
      championCompatible = true;
    } catch {
      championCompatible = false;
    }
  }
  if (retrain || !champion || !championCompatible) {
    try {
      result.training = {
        succeeded: true,
        ...await trainEvaluatePromote(store, config, { now: currentTime() }),
      };
    } catch (error) {
      if (!champion || !championCompatible) throw error;
      result.training = {
        succeeded: false,
        error: error.message,
      };
    }
    champion = await store.readModel("champion", { invalidAsNull: true });
    if (champion) {
      assertModelCompatibility(champion, {
        featureNames: FEATURE_NAMES,
        featureSchemaVersion: config.feature_schema_version,
        modelContractHash: modelContractHash(config),
        requireConverged: true,
      });
    }
  }
  if (!champion) {
    throw new Error("No model passed the promotion gate; forecast was not published");
  }
  result.forecast = await issueForecast(store, config, {
    model: champion,
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
  result.timing.completed_at = currentTime().toISOString();
  return result;
}
