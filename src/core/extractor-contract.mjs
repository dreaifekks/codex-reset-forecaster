import { hashLabel } from "./hash.mjs";
import { canonicalSourceIdentityPolicy } from "./sources.mjs";

export const AUTHORITY_SCOPE_POLICY =
  "explicit-platform-or-authority-general-codex/1";
export const DEFAULT_TOPIC_RELEVANCE_POLICY_VERSION =
  "reset-topic-relevance/2";

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
    version: "extractor-semantic-policy/3",
    target: normalizedTarget(config?.target),
    source_identity_policy: canonicalSourceIdentityPolicy(config),
    authority_scope_policy: normalizedAuthorityScopePolicy(config?.outcome_definition),
    topic_relevance_policy_version:
      config?.extractor?.topic_relevance_policy_version ??
      DEFAULT_TOPIC_RELEVANCE_POLICY_VERSION,
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
    topic_relevance_policy_version:
      contract.topic_relevance_policy_version ??
      DEFAULT_TOPIC_RELEVANCE_POLICY_VERSION,
    semantic_policy_hash: hashLabel(extractionSemanticPolicy(config)),
  };
}

export function matchesExtractorContract(signal, expectedExtractor) {
  if (expectedExtractor === null) return true;
  return signal?.producer?.name === "rule-claim-extractor" &&
    signal.producer.version === expectedExtractor.model_version &&
    signal.data?.extraction?.model === expectedExtractor.model &&
    signal.data.extraction.model_version === expectedExtractor.model_version &&
    signal.data.extraction.prompt_version === expectedExtractor.prompt_version &&
    signal.data.extraction.semantic_policy_hash ===
      expectedExtractor.semantic_policy_hash;
}
