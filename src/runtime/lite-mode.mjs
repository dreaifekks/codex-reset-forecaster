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
