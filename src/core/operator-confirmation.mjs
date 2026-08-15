import { hashLabel } from "./hash.mjs";
import { producer } from "./records.mjs";

export const OPERATOR_CONFIRMATION_KIND = "operator_confirmation";
export const OPERATOR_CONFIRMATION_POLICY_VERSION =
  "operator-platform-confirmation/1";
export const OPERATOR_CONFIRMATION_PROVIDER = "operator_manual";
export const OPERATOR_CONFIRMATION_PROVIDER_VERSION = "0.1.0";

export function operatorConfirmationProducer() {
  return producer(
    `${OPERATOR_CONFIRMATION_PROVIDER}-provider`,
    OPERATOR_CONFIRMATION_PROVIDER_VERSION,
    { policy_version: OPERATOR_CONFIRMATION_POLICY_VERSION },
  );
}

export function isOperatorConfirmationObservation(observation) {
  const expectedProducer = operatorConfirmationProducer();
  const data = observation?.data;
  const selection = data?.selection_context;
  const timing = data?.source_timing;
  const text = data?.content?.text;
  return observation?.record_type === "raw_observation" &&
    observation.producer?.name === expectedProducer.name &&
    observation.producer?.version === expectedProducer.version &&
    observation.producer?.config_hash === expectedProducer.config_hash &&
    data?.ingest_provider === OPERATOR_CONFIRMATION_PROVIDER &&
    typeof data?.provider_item_id === "string" &&
    data.provider_item_id.startsWith("operator-confirmation-") &&
    data?.canonical_url === null &&
    typeof data?.author?.identity_id === "string" &&
    data.author.identity_id.startsWith("operator:") &&
    data?.content?.media_type === "text/plain" &&
    typeof text === "string" &&
    text.length > 0 &&
    data.content.content_hash === hashLabel(text) &&
    selection?.feature_eligible === false &&
    selection?.outcome_conditioned === false &&
    selection?.selection_method ===
      "authenticated_operator_platform_confirmation" &&
    Array.isArray(selection?.linked_from) &&
    selection.linked_from.length === 1 &&
    timing?.availability_basis === "authenticated_operator_submission" &&
    timing.source_published_at === data.published_at &&
    timing.provider_observed_at === data.first_seen_at &&
    data.published_at === data.first_seen_at &&
    data.first_seen_at === data.fetched_at;
}
