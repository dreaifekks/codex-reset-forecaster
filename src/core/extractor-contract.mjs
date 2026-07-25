import { hashLabel } from "./hash.mjs";
import { canonicalSourceIdentityPolicy } from "./sources.mjs";

function normalizedTarget(target) {
  return {
    vendor: target?.vendor ?? null,
    product: target?.product ?? null,
    population: target?.population ?? null,
    plans: [...(target?.plans ?? [])].sort(),
    regions: [...(target?.regions ?? [])].sort(),
    quota_bucket: target?.quota_bucket ?? null,
  };
}

export function extractionSemanticPolicy(config) {
  return {
    version: "extractor-semantic-policy/1",
    target: normalizedTarget(config?.target),
    source_identity_policy: canonicalSourceIdentityPolicy(config),
  };
}

export function extractorContract(config) {
  const contract = config?.extractor;
  for (const field of ["model", "model_version", "prompt_version"]) {
    if (typeof contract?.[field] !== "string" || contract[field].trim().length === 0) {
      throw new TypeError(`Extractor contract requires config.extractor.${field}`);
    }
  }
  return {
    model: contract.model,
    model_version: contract.model_version,
    prompt_version: contract.prompt_version,
    semantic_policy_hash: hashLabel(extractionSemanticPolicy(config)),
  };
}
