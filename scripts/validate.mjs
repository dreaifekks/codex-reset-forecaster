#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { FEATURE_NAMES, FEATURE_SNAPSHOT_PRODUCER_VERSION } from "../src/model/features.mjs";
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
  try {
    assertCanonicalRecord(record);
  } catch (error) {
    fail(`${fileName}: ${error.message}`);
  }
  // Runtime validation owns record invariants; examples also bind the current
  // producer/configuration and demonstrate the fields required by the contract.
  if (record.record_type === "normalized_signal") {
    if (
      record.producer.name !== "rule-claim-extractor" ||
      record.producer.version !== defaultExtractor.model_version ||
      record.data.taxonomy_version !== defaultConfig.taxonomy_version ||
      record.data.extraction?.model !== defaultExtractor.model ||
      record.data.extraction?.model_version !== defaultExtractor.model_version ||
      record.data.extraction?.prompt_version !== defaultExtractor.prompt_version ||
      record.data.extraction?.semantic_policy_hash !== defaultExtractor.semantic_policy_hash ||
      record.data.extraction?.relevance?.policy_version !== defaultExtractor.topic_relevance_policy_version
    ) {
      fail(`${fileName}: normalized signal extractor contract is stale`);
    }
    if (
      !Object.hasOwn(record.data.claim ?? {}, "impact") ||
      !Object.hasOwn(record.data.claim ?? {}, "competitive_context")
    ) {
      fail(`${fileName}: normalized signal must demonstrate semantic context fields`);
    }
  }
  if (record.record_type === "event_candidate") {
    for (const [index, evidence] of record.data.evidence.entries()) {
      assertProbability(evidence.link_confidence, `${fileName}: evidence ${index} link confidence`);
    }
  }
  if (record.record_type === "feature_snapshot") {
    if (
      record.producer.name !== "as-of-feature-builder" ||
      record.producer.version !== FEATURE_SNAPSHOT_PRODUCER_VERSION ||
      record.data.feature_schema_version !== defaultConfig.feature_schema_version ||
      record.data.taxonomy_version !== defaultConfig.taxonomy_version ||
      record.data.deduplication_version !== defaultConfig.deduplication_version ||
      record.data.extractor_model !== defaultExtractor.model ||
      record.data.extractor_model_version !== defaultExtractor.model_version ||
      record.data.extractor_prompt_version !== defaultExtractor.prompt_version ||
      record.data.extractor_semantic_policy_hash !== defaultExtractor.semantic_policy_hash
    ) {
      fail(`${fileName}: feature snapshot provenance contract is stale`);
    }
    const names = Object.keys(record.data.features ?? {});
    if (names.length !== FEATURE_NAMES.length || FEATURE_NAMES.some((name) => !names.includes(name))) {
      fail(`${fileName}: feature vector must contain exactly the model inputs`);
    }
  }
  if (record.record_type === "prediction") {
    if (
      record.producer.name !== FORECAST_PRODUCER_NAME ||
      record.producer.version !== FORECAST_PRODUCER_VERSION ||
      record.data.model.family !== "ridge_logistic_discrete_time_hazard" ||
      !record.data.model.version.startsWith(`${MODEL_VERSION_PREFIX}-`) ||
      !/^sha256:[a-f0-9]{64}$/.test(record.data.model.model_contract_hash)
    ) {
      fail(`${fileName}: prediction model or producer version is stale`);
    }
  }
}

console.log(
  `Validated schemas, ${exampleFiles.length} canonical example records, and ` +
  "1 non-canonical publication event.",
);
