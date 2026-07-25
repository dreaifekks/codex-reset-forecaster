import { createRecord, producer, recordRef } from "../core/records.mjs";
import { ceilHour, clamp, halfOpenRange } from "../core/time.mjs";
import { FEATURE_NAMES, buildForecastFeatureSnapshots, dataQualityScore, featuresToArray } from "./features.mjs";
import { assertModelCompatibility, predictHazard } from "./logistic-hazard.mjs";
import { modelContractHash } from "./contract.mjs";

export function deriveProbabilitySlots(hazardEntries, {
  publishedSlotCount = hazardEntries.length,
  rollingHours = 4,
} = {}) {
  if (!Number.isInteger(publishedSlotCount) || publishedSlotCount < 1 ||
      publishedSlotCount > hazardEntries.length) {
    throw new RangeError("Published slot count must fit inside the hazard entries");
  }
  let survival = 1;
  const slots = hazardEntries.map((entry) => {
    const hazard = clamp(entry.hazard, 0, 1);
    const firstResetProbability = survival * hazard;
    survival *= 1 - hazard;
    return {
      start: entry.start,
      end: entry.end,
      hazard,
      first_reset_probability: firstResetProbability,
      reset_by_end_probability: 1 - survival,
      rolling_4h_probability: null,
      epistemic_interval_80: Array.isArray(entry.interval80)
        ? entry.interval80.map((value) => clamp(value, 0, 1))
        : null,
    };
  });
  for (let index = 0; index < publishedSlotCount; index += 1) {
    if (index + rollingHours > slots.length) continue;
    let rollingSurvival = 1;
    for (let offset = 0; offset < rollingHours; offset += 1) {
      rollingSurvival *= 1 - slots[index + offset].hazard;
    }
    slots[index].rolling_4h_probability = 1 - rollingSurvival;
  }
  return {
    slots: slots.slice(0, publishedSlotCount),
    noResetProbability: 1 - slots[publishedSlotCount - 1].reset_by_end_probability,
  };
}

export async function issueForecast(store, config, {
  model = null,
  knowledgeCutoff = new Date(),
  horizonStart = null,
  clock = () => new Date(),
} = {}) {
  const champion = model ?? await store.readModel("champion");
  if (!champion) throw new Error("No champion model is available; train and promote a model first");
  assertModelCompatibility(champion, {
    featureNames: FEATURE_NAMES,
    featureSchemaVersion: config.feature_schema_version,
    modelContractHash: modelContractHash(config),
  });
  const cutoff = new Date(knowledgeCutoff);
  if (Number.isNaN(cutoff.getTime())) throw new TypeError("Invalid forecast knowledge cutoff");
  let firstTarget = horizonStart === null ? ceilHour(cutoff) : new Date(horizonStart);
  if (Number.isNaN(firstTarget.getTime())) throw new TypeError("Invalid forecast horizon start");
  if (firstTarget.getTime() < cutoff.getTime() || ceilHour(firstTarget).getTime() !== firstTarget.getTime()) {
    throw new RangeError("Forecast horizon start must be an hourly boundary at or after knowledge cutoff");
  }
  let issued = new Date(clock());
  if (Number.isNaN(issued.getTime())) throw new TypeError("Forecast clock returned an invalid time");
  if (issued.getTime() < cutoff.getTime()) {
    throw new RangeError("Forecast issued_at cannot precede its knowledge cutoff");
  }
  if (issued.getTime() > firstTarget.getTime()) firstTarget = ceilHour(issued);

  const existingPredictions = await store.all("prediction");
  let snapshots = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = existingPredictions.find((prediction) =>
    prediction.data.knowledge_cutoff === cutoff.toISOString() &&
    prediction.data.model.version === champion.model_version &&
    prediction.data.model.artifact_hash === champion.artifact_hash &&
    prediction.data.horizon.start === firstTarget.toISOString(),
    );
    if (existing) return { prediction: existing, inserted: false };
    ({ snapshots } = await buildForecastFeatureSnapshots(store, config, {
      knowledgeCutoff: cutoff,
      horizonStart: firstTarget,
      horizonHours: 168,
      createdAt: issued,
    }));
    issued = new Date(clock());
    if (Number.isNaN(issued.getTime())) throw new TypeError("Forecast clock returned an invalid time");
    if (issued.getTime() < cutoff.getTime()) {
      throw new RangeError("Forecast issued_at cannot precede its knowledge cutoff");
    }
    if (issued.getTime() <= firstTarget.getTime()) break;
    firstTarget = ceilHour(issued);
    snapshots = null;
  }
  if (!snapshots || issued.getTime() > firstTarget.getTime()) {
    throw new Error("Forecast computation repeatedly crossed its next hourly horizon boundary");
  }
  const hazardEntries = snapshots.map((snapshot) => {
    const prediction = predictHazard(champion, featuresToArray(snapshot.data.features));
    return {
      start: snapshot.data.target.start,
      end: snapshot.data.target.end,
      hazard: prediction.probability,
      interval80: prediction.interval80,
    };
  });
  const probabilities = deriveProbabilitySlots(hazardEntries);
  const publishedSnapshots = snapshots;
  const qualityScore = publishedSnapshots.reduce(
    (sum, snapshot) => sum + dataQualityScore(snapshot),
    0,
  ) / publishedSnapshots.length;
  const signalsById = new Map(
    (await store.all("normalized_signal")).map((signal) => [signal.record_id, signal]),
  );
  const sourceGroups = new Set();
  for (const ref of snapshots.flatMap((snapshot) => snapshot.data.source_record_refs)) {
    const group = signalsById.get(ref.record_id)?.data.provenance.independence_group_id;
    if (group) sourceGroups.add(group);
  }
  const record = createRecord({
    recordType: "prediction",
    naturalKey: `${champion.model_version}:${champion.artifact_hash}:${cutoff.toISOString()}:${firstTarget.toISOString()}`,
    createdAt: issued,
    producer: producer("reset-forecaster", "0.3.0", {
      model_version: champion.model_version,
      feature_schema_version: config.feature_schema_version,
    }),
    data: {
      issued_at: issued.toISOString(),
      knowledge_cutoff: cutoff.toISOString(),
      event_process: "first_reset",
      scope: config.target,
      horizon: halfOpenRange(
        publishedSnapshots[0].data.target.start,
        publishedSnapshots.at(-1).data.target.end,
        "hour",
      ),
      base_slot: "PT1H",
      display_horizon: "PT4H",
      slots: probabilities.slots,
      no_reset_probability: probabilities.noResetProbability,
      data_quality: {
        score: clamp(qualityScore, 0, 1),
        provider_coverage: publishedSnapshots[0].data.data_quality.provider_coverage,
        outcome_sample_count:
          publishedSnapshots[0].data.data_quality.outcome_sample_count,
        sample_sufficiency:
          publishedSnapshots[0].data.data_quality.sample_sufficiency,
        independent_evidence_groups: sourceGroups.size,
      },
      feature_snapshot_refs: snapshots.map(recordRef),
      model: {
        family: champion.family,
        version: champion.model_version,
        artifact_hash: champion.artifact_hash,
        model_contract_hash: champion.model_contract_hash,
        training_cutoff: champion.training_cutoff,
        calibrator_version: champion.calibrator_version ?? null,
        training_data_hash: `sha256:${champion.training_data_hash}`,
      },
    },
  });
  const result = await store.append(record);
  return { prediction: record, inserted: result.inserted };
}
