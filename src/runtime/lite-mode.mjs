import { hashLabel } from "../core/hash.mjs";
import { requiredSourceProviderIds } from "../core/sources.mjs";

export const LITE_PACK_STATE_KEY = "lite-pack";
export const LITE_PACK_SCHEMA_VERSION = "lite-pack/1";

// Work a lite instance leaves to the full instance it was exported from.
const PAUSED_STAGES = Object.freeze([
  "reference_source_collection",
  "training",
  "walk_forward_evaluation",
  "prediction_settlement",
  "issued_evaluation",
  "probability_profile_refresh",
]);

// Lite retention rewrites feature_snapshot.jsonl down to one batch, so lite mode
// may only ever touch a data root that export-lite created for that purpose.
export async function readLitePack(store) {
  const pack = await store.readState(LITE_PACK_STATE_KEY, null);
  if (!pack) {
    throw new Error(
      "Lite mode only runs on a data root created by export-lite; this data root has no lite-pack manifest",
    );
  }
  return pack;
}

// The page shows the persisted serving snapshot before the first run. It may
// only show a forecast this data root holds, issued from the model the pack
// names: the exported one, or one a lite run issued afterwards.
export async function assertLiteServingSeed(store, seed) {
  const pack = await readLitePack(store);
  if (!seed?.prediction_ref) return;
  const [prediction] = await store.allByRefs("prediction", [seed.prediction_ref]);
  if (
    !prediction ||
    hashLabel(prediction) !== seed.prediction_hash ||
    prediction.data.model.artifact_hash !== pack.model.artifact_hash
  ) {
    throw new Error(
      `Lite serving snapshot shows forecast ${seed.prediction_ref.record_id}@${seed.prediction_ref.revision}, ` +
      `which this data root does not hold as a forecast of the exported ${pack.model.role} ${pack.model.version}`,
    );
  }
}

export async function liteModeStatus(store, config, prediction = null) {
  if (config.runtime?.lite_mode !== true) return null;
  const pack = await store.readState(LITE_PACK_STATE_KEY, null);
  const model = prediction?.data?.model ?? pack?.model ?? null;
  return {
    enabled: true,
    collected_providers: requiredSourceProviderIds(config),
    paused: PAUSED_STAGES,
    model: model && {
      version: model.version,
      validation_status: model.validation_status,
      training_cutoff: model.training_cutoff,
    },
    pack: pack && {
      exported_at: pack.exported_at,
      source_last_pipeline_success_at: pack.source.last_pipeline_success_at,
    },
  };
}
