#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../src/core/outcome-contract.mjs";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { FEATURE_NAMES } from "../src/model/features.mjs";
import {
  MODEL_VERSION_PREFIX,
} from "../src/model/model-version.mjs";
import {
  FORECAST_PRODUCER_NAME,
  FORECAST_PRODUCER_VERSION,
} from "../src/core/prediction-contract.mjs";
import { assertCanonicalRecord } from "../src/core/validate-record.mjs";
import { publicationDeliveryKey } from "../src/notifications/ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "schemas", "reset-intel.schema.json");
const providerSchemaPath = path.join(root, "schemas", "provider-config.schema.json");
const publicationSchemaPath = path.join(
  root,
  "schemas",
  "publication-event.schema.json",
);
const publicationExamplePath = path.join(
  root,
  "examples",
  "publication-event.json",
);
const examplesDir = path.join(root, "examples");
const allowedTypes = new Set([
  "raw_observation",
  "normalized_signal",
  "event_candidate",
  "impact_episode",
  "reset_outcome",
  "feature_snapshot",
  "prediction",
  "prediction_settlement",
]);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${path.relative(root, filePath)} is not valid JSON: ${error.message}`);
  }
}

function isUtc(value) {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function assertProbability(value, label) {
  if (typeof value !== "number" || value < 0 || value > 1) {
    fail(`${label} must be a probability, got ${JSON.stringify(value)}`);
  }
}

function validateEnvelope(record, fileName) {
  if (record.schema_version !== "reset-intel/0.2") fail(`${fileName}: wrong schema_version`);
  if (!allowedTypes.has(record.record_type)) fail(`${fileName}: unsupported record_type`);
  if (!record.record_id || !Number.isInteger(record.revision) || record.revision < 1) {
    fail(`${fileName}: invalid record identity`);
  }
  if (!isUtc(record.created_at)) fail(`${fileName}: created_at must be RFC 3339 UTC`);
  if (!record.producer?.name || !record.producer?.version) fail(`${fileName}: producer is incomplete`);
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
    fail(`${fileName}: data must be an object`);
  }
}

function validateRange(range, label) {
  if (!range) return;
  if (!isUtc(range.start) || !isUtc(range.end)) fail(`${label}: range timestamps must be UTC`);
  if (Date.parse(range.start) >= Date.parse(range.end)) fail(`${label}: range start must precede end`);
  if (range.boundary !== "[start,end)") fail(`${label}: boundary must be [start,end)`);
}

function validateRecordRef(reference, label) {
  if (
    !reference ||
    typeof reference.record_id !== "string" ||
    reference.record_id.length === 0 ||
    !Number.isInteger(reference.revision) ||
    reference.revision < 1
  ) {
    fail(`${label}: invalid exact record reference`);
  }
}

function validatePublicationEvent(event, fileName) {
  const eventContract = new Map([
    ["forecast.authority_window.opened.v1", {
      topic: "authority",
      refs: ["prediction_ref", "signal_ref"],
      supersedes: false,
    }],
    ["forecast.reset_watch.opened.v1", {
      topic: "experimental_probability",
      refs: ["prediction_ref"],
      supersedes: false,
    }],
    ["forecast.reset_watch.closed.v1", {
      topic: "experimental_probability",
      refs: ["prediction_ref"],
      supersedes: true,
    }],
    ["outcome.reset_confirmed.v1", {
      topic: "outcome",
      refs: ["outcome_ref", "verification_ref"],
      supersedes: false,
    }],
    ["outcome.reset_corrected.v1", {
      topic: "outcome",
      refs: ["outcome_ref", "verification_ref"],
      supersedes: true,
    }],
    ["outcome.reset_retracted.v1", {
      topic: "outcome",
      refs: ["outcome_ref"],
      supersedes: true,
    }],
    ["outcome.verification_withdrawn.v1", {
      topic: "outcome",
      refs: ["outcome_ref"],
      supersedes: true,
    }],
  ]).get(event.event_type);
  if (
    event.schema_version !== "publication-event/1" ||
    Object.hasOwn(event, "record_type") ||
    !/^pub_[a-f0-9]{64}$/.test(event.event_id ?? "") ||
    !/^delivery_[a-f0-9]{64}$/.test(event.delivery_key ?? "") ||
    event.delivery_key !== publicationDeliveryKey(event) ||
    !eventContract ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.revision !== 1 ||
    event.supersedes !== null ||
    !isUtc(event.emitted_at) ||
    !isUtc(event.expires_at) ||
    Date.parse(event.expires_at) <= Date.parse(event.emitted_at)
  ) {
    fail(`${fileName}: invalid non-canonical publication envelope`);
  }
  if (event.topic !== eventContract.topic) {
    fail(`${fileName}: event type and publication topic are inconsistent`);
  }
  const hasSupersededEvent = /^pub_[a-f0-9]{64}$/.test(
    event.supersedes_event_id ?? "",
  );
  if (
    hasSupersededEvent !== eventContract.supersedes ||
    (!eventContract.supersedes && event.supersedes_event_id !== null)
  ) {
    fail(`${fileName}: invalid publication correction link`);
  }
  const experimental = event.topic === "experimental_probability";
  if (
    event.experimental !== experimental ||
    event.report?.default_delivery !== !experimental
  ) {
    fail(`${fileName}: topic delivery class is inconsistent`);
  }
  if (
    !["publication-policy/1", "publication-policy/2"].includes(
      event.policy?.version,
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(event.policy?.hash ?? "")
  ) {
    fail(`${fileName}: publication policy binding is invalid`);
  }
  const references = Object.entries(event.source ?? {})
    .filter(([, reference]) => reference !== null);
  if (references.length === 0) {
    fail(`${fileName}: publication source requires an exact canonical reference`);
  }
  for (const [name, reference] of references) {
    validateRecordRef(reference, `${fileName}: source.${name}`);
  }
  for (const name of eventContract.refs) {
    validateRecordRef(event.source?.[name], `${fileName}: source.${name}`);
  }
  if (
    typeof event.notification?.title !== "string" ||
    typeof event.notification?.body !== "string" ||
    typeof event.notification?.url !== "string" ||
    typeof event.notification?.tag !== "string" ||
    event.title !== event.notification.title ||
    event.summary !== event.notification.body ||
    event.url !== event.notification.url
  ) {
    fail(`${fileName}: notification projection is incomplete or inconsistent`);
  }
}

function closeEnough(left, right, tolerance = 1e-9) {
  return Math.abs(left - right) <= tolerance;
}

function validatePrediction(record, fileName) {
  const data = record.data;
  if (
    record.producer.name !== FORECAST_PRODUCER_NAME ||
    record.producer.version !== FORECAST_PRODUCER_VERSION ||
    data.model?.family !== "ridge_logistic_discrete_time_hazard" ||
    typeof data.model?.version !== "string" ||
    !data.model.version.startsWith(`${MODEL_VERSION_PREFIX}-`)
  ) {
    fail(`${fileName}: prediction model or producer version is stale`);
  }
  if (!isUtc(data.issued_at) || !isUtc(data.knowledge_cutoff)) {
    fail(`${fileName}: prediction timestamps must be UTC`);
  }
  validateRange(data.horizon, `${fileName}: horizon`);
  if (Date.parse(data.knowledge_cutoff) > Date.parse(data.issued_at)) {
    fail(`${fileName}: prediction cannot be issued before its knowledge cutoff`);
  }
  if (Date.parse(data.issued_at) > Date.parse(data.horizon.start)) {
    fail(`${fileName}: prediction horizon cannot start before publication`);
  }
  if (data.base_slot !== "PT1H" || data.display_horizon !== "PT4H") {
    fail(`${fileName}: expected PT1H base slot and PT4H display horizon`);
  }
  if (
    !/^[a-f0-9]{64}$/.test(data.model?.artifact_hash ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(data.model?.model_contract_hash ?? "")
  ) {
    fail(`${fileName}: prediction must bind an exact model artifact and contract hash`);
  }
  if (!Array.isArray(data.slots) || data.slots.length === 0 || data.slots.length > 168) {
    fail(`${fileName}: slots must contain 1..168 entries`);
  }
  if (
    data.slots[0].start !== data.horizon.start ||
    data.slots.at(-1).end !== data.horizon.end
  ) {
    fail(`${fileName}: slots must exactly cover the declared horizon`);
  }
  if (
    !Array.isArray(data.feature_snapshot_refs) ||
    data.feature_snapshot_refs.length !== data.slots.length
  ) {
    fail(`${fileName}: one feature snapshot ref is required per slot`);
  }
  if (
    new Set(data.feature_snapshot_refs.map((ref) => `${ref.record_id}@${ref.revision}`)).size !==
    data.feature_snapshot_refs.length
  ) {
    fail(`${fileName}: feature snapshot refs must be unique`);
  }
  if (Date.parse(data.model.training_cutoff) > Date.parse(data.knowledge_cutoff)) {
    fail(`${fileName}: model training cutoff cannot be after forecast knowledge cutoff`);
  }

  let survival = 1;
  let previousEnd = null;
  for (const [index, slot] of data.slots.entries()) {
    validateRange({ start: slot.start, end: slot.end, boundary: "[start,end)" }, `${fileName}: slot ${index}`);
    if (Date.parse(slot.end) - Date.parse(slot.start) !== 60 * 60 * 1000) {
      fail(`${fileName}: slot ${index} is not one hour`);
    }
    if (previousEnd && slot.start !== previousEnd) fail(`${fileName}: slots are not contiguous`);
    previousEnd = slot.end;
    for (const key of ["hazard", "first_reset_probability", "reset_by_end_probability"]) {
      assertProbability(slot[key], `${fileName}: slot ${index}.${key}`);
    }
    if (slot.rolling_4h_probability !== null) {
      assertProbability(
        slot.rolling_4h_probability,
        `${fileName}: slot ${index}.rolling_4h_probability`,
      );
    }
    const expectedFirst = survival * slot.hazard;
    if (!closeEnough(slot.first_reset_probability, expectedFirst, 1e-8)) {
      fail(`${fileName}: slot ${index} first-reset probability is inconsistent with hazard`);
    }
    survival *= 1 - slot.hazard;
    if (!closeEnough(slot.reset_by_end_probability, 1 - survival, 1e-8)) {
      fail(`${fileName}: slot ${index} cumulative probability is inconsistent with hazard`);
    }
  }
  for (let index = 0; index < data.slots.length; index += 1) {
    const slot = data.slots[index];
    if (index + 4 > data.slots.length) {
      if (slot.rolling_4h_probability !== null) {
        fail(`${fileName}: slot ${index} rolling four-hour value must be null without four saved hazards`);
      }
      continue;
    }
    const expectedRolling = 1 - data.slots
      .slice(index, index + 4)
      .reduce((value, item) => value * (1 - item.hazard), 1);
    if (!closeEnough(slot.rolling_4h_probability, expectedRolling, 1e-8)) {
      fail(`${fileName}: slot ${index} rolling four-hour probability is inconsistent with hazards`);
    }
  }
  if (data.event_process === "first_reset") {
    assertProbability(data.no_reset_probability, `${fileName}: no_reset_probability`);
    if (!closeEnough(data.no_reset_probability, survival, 1e-8)) {
      fail(`${fileName}: no_reset_probability is inconsistent with hourly hazards`);
    }
  }
}

const schema = readJson(schemaPath);
if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
  fail("schemas/reset-intel.schema.json must declare JSON Schema draft 2020-12");
}
if (
  !schema.$defs?.envelope ||
  !schema.$defs?.prediction ||
  !schema.$defs?.impactEpisode ||
  !schema.$defs?.impactClassification
) {
  fail("schemas/reset-intel.schema.json is missing core definitions");
}
const providerSchema = readJson(providerSchemaPath);
const publicationSchema = readJson(publicationSchemaPath);
if (
  publicationSchema.$schema !==
    "https://json-schema.org/draft/2020-12/schema" ||
  publicationSchema.$id !== "publication-event.schema.json" ||
  publicationSchema.properties?.schema_version?.const !==
    "publication-event/1" ||
  publicationSchema.properties?.topic?.enum?.length !== 3 ||
  !publicationSchema.$defs?.recordRef
) {
  fail("schemas/publication-event.schema.json is missing the publication contract");
}
if (
  providerSchema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
  !providerSchema.$defs?.xOutcomeExhaustivenessContract ||
  !providerSchema.$defs?.xOutcomeExhaustivenessAttestation ||
  !providerSchema.$defs?.historicalDailyLedgerAttestation ||
  !providerSchema.$defs?.outcomeDefinition ||
  !providerSchema.$defs?.extractorPolicy ||
  !providerSchema.$defs?.semanticAssistancePolicy ||
  !providerSchema.$defs?.impactTrackingPolicy ||
  !providerSchema.$defs?.authorityTimingPolicy
) {
  fail("schemas/provider-config.schema.json is missing an outcome coverage contract");
}
if (
  !providerSchema.properties?.providers?.properties?.rsshub_x_timeline ||
  providerSchema.properties.providers.properties.rsshub_x_timeline
    .properties?.include_replies?.const !== true ||
  !schema.$defs?.normalizedSignal?.properties?.provenance?.properties
    ?.derivation?.enum?.includes("reply") ||
  !schema.$defs?.eventCandidate?.properties?.evidence?.items?.properties
    ?.provenance_relation?.enum?.includes("reply") ||
  !schema.$defs?.normalizedSignal?.properties?.claim?.properties?.event_type?.enum
    ?.includes("experience_issue") ||
  !schema.$defs.normalizedSignal.properties.claim.properties.event_type.enum
    .includes("experience_recovery") ||
  !schema.$defs.normalizedSignal.properties.claim.properties.event_type.enum
    .includes("competitor_model_release") ||
  !schema.$defs.impactClassification.properties.category.enum
    .includes("security_privacy") ||
  !schema.$defs.impactClassification.properties.category.enum
    .includes("data_integrity") ||
  !schema.$defs.impactClassification.properties.category.enum
    .includes("compatibility") ||
  schema.$defs.impactEpisode.properties.policy_version?.const !==
    "impact-episode-policy/1" ||
  !schema.$defs.prediction.properties.authority_conditioning.properties
    ?.policy_version?.enum?.includes(
      "authority-timing-first-event-mixture/2",
    ) ||
  schema.$defs.prediction.properties.authority_conditioning.properties
    ?.within_window_mass_basis?.const !==
      "tempered_baseline_first_event_mass" ||
  providerSchema.$defs?.impactTrackingPolicy?.properties?.version?.const !==
    "impact-episode-policy/1" ||
  providerSchema.$defs?.authorityTimingPolicy?.properties?.version?.const !==
    "authority-timing-first-event-mixture/2" ||
  providerSchema.$defs?.authorityTimingPolicy?.properties
    ?.within_window_mass_basis?.const !==
      "tempered_baseline_first_event_mass" ||
  providerSchema.$defs?.postOutcomeRefractoryPolicy?.properties?.version
    ?.const !==
      "post-outcome-refractory-piecewise-hazard-multiplier/1" ||
  providerSchema.$defs?.evidenceCarryoverPolicy?.properties?.version?.const !==
    "post-outcome-evidence-carryover/1" ||
  providerSchema.$defs?.featureSupportPolicy?.properties?.version?.const !==
    "feature-support-gate/1" ||
  providerSchema.$defs?.liveForecastPromotionGuardPolicy?.properties?.version
    ?.const !== "live-forecast-promotion-guard/2"
) {
  fail("schemas are missing the RSSHub or experience/competition contracts");
}
const defaultConfig = readJson(path.join(root, "config", "default.json"));
const defaultExtractor = extractorContract(defaultConfig);
if (
  defaultConfig.config_version !== "provider-config/0.3.8" ||
  defaultConfig.taxonomy_version !== "reset-taxonomy/0.3.1" ||
  defaultConfig.feature_schema_version !== "reset-features/0.3.1" ||
  defaultConfig.deduplication_version !== "reset-dedup/0.2.3" ||
  defaultExtractor.model_version !== "0.3.4" ||
  defaultExtractor.prompt_version !== "reset-extract/rules-0.3.4" ||
  defaultExtractor.topic_relevance_policy_version !== "reset-topic-relevance/6" ||
  !Array.isArray(defaultConfig.extractor?.authority_reply_identity_ids) ||
  defaultConfig.extractor.authority_reply_identity_ids.length !== 0 ||
  defaultConfig.extractor?.semantic_assistance?.policy_version !==
    "semantic-timing-assistance/1" ||
  defaultConfig.extractor.semantic_assistance.enabled !== false ||
  defaultConfig.model?.standardized_feature_clip !== 3 ||
  defaultConfig.model?.authority_timing?.version !==
    "authority-timing-first-event-mixture/2" ||
  defaultConfig.model?.authority_timing?.within_window_mass_basis !==
    "tempered_baseline_first_event_mass" ||
  defaultConfig.model?.authority_timing?.within_window_baseline_power !== 0.5 ||
  defaultConfig.model?.evidence_carryover?.version !==
    "post-outcome-evidence-carryover/1" ||
  defaultConfig.model?.feature_support?.version !==
    "feature-support-gate/1" ||
  defaultConfig.model?.live_forecast_promotion_guard?.version !==
    "live-forecast-promotion-guard/2"
) {
  fail("config/default.json version contracts are stale");
}
if (
  defaultConfig.impact_tracking?.version !==
    "impact-episode-policy/1" ||
  defaultConfig.impact_tracking?.enabled !== true ||
  typeof defaultConfig.impact_tracking?.cluster_gap_hours !== "number" ||
  defaultConfig.impact_tracking.cluster_gap_hours <= 0 ||
  typeof defaultConfig.impact_tracking?.active_evidence_ttl_hours !==
    "number" ||
  defaultConfig.impact_tracking.active_evidence_ttl_hours <= 0 ||
  typeof defaultConfig.impact_tracking?.freshness_half_life_hours !==
    "number" ||
  defaultConfig.impact_tracking.freshness_half_life_hours <= 0
) {
  fail("config/default.json impact tracking contract is stale");
}
if (!Object.hasOwn(defaultConfig.providers?.x ?? {}, "outcome_exhaustiveness_contract")) {
  fail("config/default.json must fail closed with an explicit X exhaustiveness contract field");
}
if (
  !defaultConfig.outcome_definition?.version ||
  !Object.hasOwn(
    defaultConfig.providers?.historical_monitor ?? {},
    "coverage_completeness_attestation",
  )
) {
  fail("config/default.json must declare its outcome definition and historical coverage policy");
}
if (
  defaultConfig.model?.calibrator?.version !==
    "identity-hourly-hazard/1" ||
  defaultConfig.model?.calibrator?.method !== "identity" ||
  defaultConfig.model?.calibrator?.fit_source !== "none"
) {
  fail("config/default.json must declare the supported versioned identity calibrator");
}
if (
  defaultConfig.providers?.rsshub_x_timeline?.provider_name !==
    "rsshub_x_timeline" ||
  defaultConfig.providers.rsshub_x_timeline.include_replies !== true ||
  !defaultConfig.providers.rsshub_x_timeline.capabilities
    ?.includes("exact_evidence") ||
  defaultConfig.model?.outcome_coverage_providers
    ?.includes("rsshub_x_timeline")
) {
  fail("RSSHub must be configured as exact evidence without outcome coverage");
}
if (
  defaultConfig.runtime?.scheduler_interval_minutes !== 10 ||
  defaultConfig.runtime?.retrain_interval_hours !== 24
) {
  fail("runtime must retain the 10-minute refresh and daily retraining contract");
}
if (
  FEATURE_NAMES.length !== 14 ||
  !FEATURE_NAMES.includes("competitor_model_release_decay") ||
  FEATURE_NAMES.some((name) =>
    ["community_momentum", "community_disagreement"].includes(name)
  )
) {
  fail("model features must exclude community resonance and retain competitor release context");
}

const publicationExample = readJson(publicationExamplePath);
validatePublicationEvent(publicationExample, "publication-event.json");

const exampleFiles = fs.readdirSync(examplesDir)
  .filter((name) => name.endsWith(".json") && name !== "publication-event.json")
  .sort();
if (exampleFiles.length === 0) fail("No JSON examples found");

for (const fileName of exampleFiles) {
  const record = readJson(path.join(examplesDir, fileName));
  validateEnvelope(record, fileName);
  try {
    assertCanonicalRecord(record);
  } catch (error) {
    fail(`${fileName}: ${error.message}`);
  }
  if (record.record_type === "raw_observation") {
    if (record.data.published_at !== null && !isUtc(record.data.published_at)) {
      fail(`${fileName}: published_at must be UTC or null`);
    }
    if (!isUtc(record.data.first_seen_at) || !isUtc(record.data.fetched_at)) {
      fail(`${fileName}: collection timestamps must be UTC`);
    }
    const attestation = record.data.availability_attestation;
    if (attestation !== null) {
      if (!isUtc(attestation.available_at) || !isUtc(attestation.verified_at)) {
        fail(`${fileName}: availability attestation timestamps must be UTC`);
      }
      if (Date.parse(attestation.available_at) > Date.parse(record.data.fetched_at)) {
        fail(`${fileName}: attested availability cannot be after fetch time`);
      }
      if (!["direct_source_publication", "archive_snapshot", "provider_first_seen"].includes(attestation.basis)) {
        fail(`${fileName}: availability attestation basis invalid`);
      }
      if (!attestation.attestor_url || !attestation.verification) {
        fail(`${fileName}: availability attestation is incomplete`);
      }
    }
  }
  if (record.record_type === "normalized_signal") {
    if (!isUtc(record.data.available_at)) fail(`${fileName}: available_at must be UTC`);
    if (
      record.producer.name !== "rule-claim-extractor" ||
      record.producer.version !== defaultExtractor.model_version ||
      record.data.taxonomy_version !== defaultConfig.taxonomy_version ||
      record.data.extraction?.model !== defaultExtractor.model ||
      record.data.extraction?.model_version !== defaultExtractor.model_version ||
      record.data.extraction?.prompt_version !== defaultExtractor.prompt_version ||
      record.data.extraction?.semantic_policy_hash !==
        defaultExtractor.semantic_policy_hash ||
      record.data.extraction?.relevance?.policy_version !==
        defaultExtractor.topic_relevance_policy_version
    ) {
      fail(`${fileName}: normalized signal extractor contract is stale`);
    }
    if (
      !Object.hasOwn(record.data.claim ?? {}, "impact") ||
      !Object.hasOwn(record.data.claim ?? {}, "competitive_context")
    ) {
      fail(`${fileName}: normalized signal must demonstrate semantic context fields`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(record.data.extraction?.semantic_policy_hash ?? "")) {
      fail(`${fileName}: signal extraction semantic policy hash invalid`);
    }
    validateRange(record.data.claim?.asserted_time_range, `${fileName}: asserted_time_range`);
    assertProbability(record.data.extraction?.confidence, `${fileName}: extraction confidence`);
  }
  if (record.record_type === "reset_outcome") {
    if (!isUtc(record.data.known_at)) fail(`${fileName}: known_at must be UTC`);
    if (
      record.data.replay_available_at !== undefined &&
      record.data.replay_available_at !== null &&
      !isUtc(record.data.replay_available_at)
    ) {
      fail(`${fileName}: replay_available_at must be UTC or null`);
    }
    validateRange(record.data.occurred_time_range, `${fileName}: occurred_time_range`);
    if (
      record.data.status === "confirmed" &&
      (
        record.data.label_policy_version !== OUTCOME_LABEL_POLICY_VERSION ||
        typeof record.data.event_identity !== "string" ||
        record.data.event_identity.length === 0 ||
        !record.data.occurred_time_range ||
        !Array.isArray(record.data.candidate_refs) ||
        record.data.candidate_refs.length === 0 ||
        record.producer.name !== "outcome-adjudicator" ||
        record.producer.version !== OUTCOME_ADJUDICATOR_VERSION
      )
    ) {
      fail(`${fileName}: confirmed outcome contract incomplete`);
    }
  }
  if (record.record_type === "event_candidate") {
    if (!isUtc(record.data.as_of)) fail(`${fileName}: candidate as_of must be UTC`);
    validateRange(record.data.hypothesized_time_range, `${fileName}: hypothesized_time_range`);
    for (const [index, evidence] of (record.data.evidence ?? []).entries()) {
      assertProbability(evidence.link_confidence, `${fileName}: evidence ${index} link confidence`);
    }
  }
  if (record.record_type === "impact_episode") {
    if (
      record.producer.name !== "impact-episode-builder" ||
      record.producer.version !== "0.1.0" ||
      record.data.policy_version !== "impact-episode-policy/1" ||
      record.data.policy_config_hash !== record.producer.config_hash
    ) {
      fail(`${fileName}: impact episode policy binding is stale`);
    }
    assertProbability(
      record.data.current_pressure,
      `${fileName}: current pressure`,
    );
    assertProbability(
      record.data.peak_pressure,
      `${fileName}: peak pressure`,
    );
  }
  if (record.record_type === "feature_snapshot") {
    if (!isUtc(record.data.knowledge_cutoff)) fail(`${fileName}: feature cutoff must be UTC`);
    if (
      record.producer.name !== "as-of-feature-builder" ||
      record.producer.version !== "0.3.2" ||
      record.data.feature_schema_version !== defaultConfig.feature_schema_version ||
      record.data.taxonomy_version !== defaultConfig.taxonomy_version ||
      record.data.deduplication_version !== defaultConfig.deduplication_version ||
      record.data.extractor_model !== defaultExtractor.model ||
      record.data.extractor_model_version !== defaultExtractor.model_version ||
      record.data.extractor_prompt_version !== defaultExtractor.prompt_version ||
      record.data.extractor_semantic_policy_hash !==
        defaultExtractor.semantic_policy_hash
    ) {
      fail(`${fileName}: feature snapshot provenance contract is stale`);
    }
    if (
      !/^sha256:[a-f0-9]{64}$/.test(record.data.config_hash ?? "") ||
      !record.data.feature_schema_version ||
      !record.data.taxonomy_version ||
      !record.data.deduplication_version ||
      !record.data.timezone_database_version ||
      !record.data.extractor_model ||
      !record.data.extractor_model_version ||
      !record.data.extractor_prompt_version ||
      !/^sha256:[a-f0-9]{64}$/.test(record.data.extractor_semantic_policy_hash ?? "")
    ) {
      fail(`${fileName}: feature provenance versions incomplete`);
    }
    if (!isUtc(record.data.target?.start) || !isUtc(record.data.target?.end)) {
      fail(`${fileName}: feature target timestamps must be UTC`);
    }
    assertProbability(record.data.data_quality?.provider_coverage, `${fileName}: provider coverage`);
    if (!Array.isArray(record.data.coverage_assertion_refs)) {
      fail(`${fileName}: feature coverage assertion refs missing`);
    }
    const missingFeatures = FEATURE_NAMES.filter(
      (name) => !Object.hasOwn(record.data.features ?? {}, name),
    );
    if (missingFeatures.length > 0) {
      fail(
        `${fileName}: feature vector is missing ${missingFeatures.join(", ")}`,
      );
    }
    for (const removed of ["community_momentum", "community_disagreement"]) {
      if (Object.hasOwn(record.data.features ?? {}, removed)) {
        fail(`${fileName}: removed community feature ${removed} is still present`);
      }
    }
    if (!Array.isArray(record.data.coverage_assertion_refs)) {
      fail(`${fileName}: feature coverage assertion refs missing`);
    }
    for (const [index, ref] of record.data.coverage_assertion_refs.entries()) {
      if (
        typeof ref.assertion_id !== "string" ||
        ref.assertion_id.length === 0 ||
        !Number.isInteger(ref.revision) ||
        ref.revision < 1
      ) {
        fail(`${fileName}: feature coverage assertion ref ${index} invalid`);
      }
    }
  }
  if (record.record_type === "prediction") validatePrediction(record, fileName);
  if (record.record_type === "prediction_settlement") {
    if (!isUtc(record.data.settled_at)) fail(`${fileName}: settlement time must be UTC`);
    validateRange(record.data.window, `${fileName}: settlement window`);
    if (!["positive", "negative", "pending", "censored"].includes(record.data.status)) {
      fail(`${fileName}: settlement status invalid`);
    }
  }
}

console.log(
  `Validated schemas, ${exampleFiles.length} canonical example records, and ` +
  "1 non-canonical publication event.",
);
