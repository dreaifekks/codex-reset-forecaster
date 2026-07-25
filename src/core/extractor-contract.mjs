import { hashLabel } from "./hash.mjs";
import { canonicalSourceIdentityPolicy } from "./sources.mjs";

export const AUTHORITY_SCOPE_POLICY =
  "explicit-platform-or-authority-general-codex/1";

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

function normalizedAuthorityScopePolicy(outcomeDefinition) {
  return {
    outcome_definition_version: outcomeDefinition?.version ?? null,
    event_semantics: outcomeDefinition?.event_semantics ?? null,
    authority_identity_ids: [
      ...(outcomeDefinition?.authority_identity_ids ?? []),
    ].sort(),
    scope_policy: outcomeDefinition?.scope_policy ?? null,
  };
}

export function extractionSemanticPolicy(config) {
  return {
    version: "extractor-semantic-policy/2",
    target: normalizedTarget(config?.target),
    source_identity_policy: canonicalSourceIdentityPolicy(config),
    authority_scope_policy: normalizedAuthorityScopePolicy(config?.outcome_definition),
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
