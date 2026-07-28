import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashLabel } from "./hash.mjs";
import { assertHistoricalDailyLedgerAttestation } from "./coverage-contract.mjs";
import {
  AUTHORITY_TIMING_POLICY_VERSION,
  AUTHORITY_TIMING_RELIABILITY_BASIS,
} from "../model/authority-timing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(base?.[key] ?? {}, value)
      : value;
  }
  return result;
}

function validateXOutcomeExhaustivenessContract(config) {
  const contract = config.providers.x.outcome_exhaustiveness_contract;
  if (contract === null || contract === undefined) return;
  if (
    contract.version !== "x-outcome-exhaustiveness/1" ||
    typeof contract.attestation_file !== "string" ||
    contract.attestation_file.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(contract.attestation_sha256 ?? "")
  ) {
    throw new TypeError(
      "providers.x.outcome_exhaustiveness_contract must use the supported version and a pinned attestation file hash",
    );
  }
  contract.attestation_file = path.resolve(root, contract.attestation_file);
}

function validateHistoricalMonitorCoverage(config) {
  const provider = config.providers.historical_monitor;
  if (
    provider.coverage_adequacy !== "negative_label_eligible" &&
    provider.coverage_completeness_attestation == null
  ) {
    return;
  }
  assertHistoricalDailyLedgerAttestation({
    attestation: provider.coverage_completeness_attestation,
    outcomeDefinition: config.outcome_definition,
    providerName: provider.provider_name ?? "historical_monitor",
    sourceUrl: provider.base_url,
    target: config.target,
    confirmationIdentityIds: (provider.confirmation_identities ?? [])
      .map((identity) => identity.identity_id)
      .filter(Boolean),
  });
}

function validateModelCalibrator(config) {
  const calibrator = config.model?.calibrator;
  if (
    calibrator?.version !== "identity-hourly-hazard/1" ||
    calibrator?.method !== "identity" ||
    calibrator?.fit_source !== "none"
  ) {
    throw new TypeError(
      "model.calibrator must use the supported identity-hourly-hazard/1 policy",
    );
  }
}

function validateModelFeatureTransform(config) {
  const clip = config.model?.standardized_feature_clip;
  if (!Number.isFinite(clip) || clip <= 0) {
    throw new TypeError(
      "model.standardized_feature_clip must be a positive finite number",
    );
  }
}

function validateProvisionalBootstrap(config) {
  const bootstrap = config.runtime?.provisional_bootstrap;
  if (
    typeof bootstrap?.enabled !== "boolean" ||
    !Number.isInteger(bootstrap?.minimum_outcomes) ||
    bootstrap.minimum_outcomes < 1
  ) {
    throw new TypeError(
      "runtime.provisional_bootstrap must declare a boolean enabled flag and a positive integer minimum_outcomes",
    );
  }
}

function validateOutcomeCoverageProviders(config) {
  const providers = config.model?.outcome_coverage_providers;
  if (
    !Array.isArray(providers) ||
    providers.some((provider) =>
      String(provider).startsWith("x_search_gateway_") ||
      String(provider) === "rsshub_x_timeline"
    )
  ) {
    throw new TypeError(
      "model.outcome_coverage_providers cannot use discovery-only gateway or RSSHub timeline providers because finite feeds are not exhaustive coverage",
    );
  }
}

function validateSchedulerInterval(config) {
  const minutes = config.runtime?.scheduler_interval_minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new TypeError(
      "runtime.scheduler_interval_minutes must be an integer from 1 through 60",
    );
  }
}

function validateRsshubXProvider(config) {
  const provider = config.providers?.rsshub_x_timeline;
  const capabilities = new Set(provider?.capabilities ?? []);
  if (
    !provider ||
    provider.provider_name !== "rsshub_x_timeline" ||
    !capabilities.has("exact_evidence") ||
    capabilities.has("outcome_coverage") ||
    provider.include_replies !== true ||
    !Number.isInteger(provider.count) ||
    provider.count < 1 ||
    provider.count > 100 ||
    !Number.isInteger(provider.minimum_items) ||
    provider.minimum_items < 1 ||
    !Number.isFinite(provider.freshness_max_age_hours) ||
    provider.freshness_max_age_hours <= 0 ||
    !Number.isInteger(provider.max_response_bytes) ||
    provider.max_response_bytes < 1 ||
    !Number.isFinite(provider.request_timeout_ms) ||
    provider.request_timeout_ms <= 0 ||
    !Number.isFinite(provider.refresh_interval_minutes) ||
    provider.refresh_interval_minutes <= 0 ||
    !Array.isArray(provider.confirmation_identities) ||
    provider.confirmation_identities.length < 1 ||
    !Array.isArray(provider.context_identities)
  ) {
    throw new TypeError(
      "providers.rsshub_x_timeline must use its fixed exact-evidence, non-coverage contract",
    );
  }
}

function validateAuthorityTiming(config) {
  const policy = config.model?.authority_timing;
  const reliabilities = policy?.phase_reliability;
  if (
    policy?.version !== AUTHORITY_TIMING_POLICY_VERSION ||
    typeof policy.enabled !== "boolean" ||
    policy.reliability_basis !== AUTHORITY_TIMING_RELIABILITY_BASIS ||
    !reliabilities ||
    !["scheduled", "expected", "started"].every((phase) =>
      Number.isFinite(reliabilities[phase]) &&
      reliabilities[phase] >= 0 &&
      reliabilities[phase] <= 1
    ) ||
    !Array.isArray(policy.eligible_source_roles) ||
    policy.eligible_source_roles.length === 0 ||
    policy.eligible_source_roles.some((role) =>
      !["official", "product_lead", "product_team_member"].includes(role)
    ) ||
    !Number.isFinite(policy.maximum_asserted_duration_hours) ||
    policy.maximum_asserted_duration_hours <= 0
  ) {
    throw new TypeError(
      "model.authority_timing must use the supported first-event mixture policy",
    );
  }
}

function semanticConfigHash(config) {
  const {
    runtime: _runtime,
    config_hash: _configHash,
    ...semanticConfig
  } = config;
  return hashLabel(semanticConfig);
}

export async function loadConfig({ configPath = process.env.RESET_CONFIG, overrides = {} } = {}) {
  const defaultPath = path.join(root, "config", "default.json");
  const defaults = JSON.parse(await fs.readFile(defaultPath, "utf8"));
  let fileConfig = {};
  if (configPath) fileConfig = JSON.parse(await fs.readFile(path.resolve(configPath), "utf8"));
  const config = merge(merge(defaults, fileConfig), overrides);
  config.runtime.data_dir = path.resolve(root, process.env.RESET_DATA_DIR ?? config.runtime.data_dir);
  config.runtime.host = process.env.HOST ?? config.runtime.host;
  config.runtime.port = Number(process.env.PORT ?? config.runtime.port);
  if (process.env.RESET_SCHEDULER_ENABLED !== undefined) {
    config.runtime.scheduler_enabled = process.env.RESET_SCHEDULER_ENABLED === "true";
  }
  if (process.env.RESET_RUN_ON_START !== undefined) {
    config.runtime.run_on_start = process.env.RESET_RUN_ON_START === "true";
  }
  if (process.env.X_SEARCH_GATEWAY_ENABLED !== undefined) {
    config.providers.x_search_gateway.enabled = process.env.X_SEARCH_GATEWAY_ENABLED === "true";
  }
  config.providers.x_search_gateway.base_url = process.env.X_SEARCH_GATEWAY_URL ??
    config.providers.x_search_gateway.base_url;
  config.providers.x_search_gateway.upstream_provider = process.env.X_SEARCH_GATEWAY_PROVIDER ??
    config.providers.x_search_gateway.upstream_provider;
  config.providers.x_search_gateway.token_file = process.env.X_SEARCH_GATEWAY_TOKEN_FILE ??
    config.providers.x_search_gateway.token_file;
  if (process.env.RSSHUB_X_ENABLED !== undefined) {
    config.providers.rsshub_x_timeline.enabled =
      process.env.RSSHUB_X_ENABLED === "true";
  }
  config.providers.rsshub_x_timeline.base_url = process.env.RSSHUB_BASE_URL ??
    config.providers.rsshub_x_timeline.base_url;
  config.providers.x.token_file = process.env.X_BEARER_TOKEN_FILE ??
    config.providers.x.token_file;
  if (process.env.HISTORICAL_MONITOR_ENABLED !== undefined) {
    config.providers.historical_monitor.enabled = process.env.HISTORICAL_MONITOR_ENABLED === "true";
  }
  config.providers.historical_monitor.base_url = process.env.HISTORICAL_MONITOR_URL ??
    config.providers.historical_monitor.base_url;
  if (config.timezone_database_version === "system") {
    config.timezone_database_version = `tzdata-${process.versions.tz ?? "unknown"}`;
  }
  config.providers.x.enabled = process.env.X_BEARER_TOKEN || process.env.X_BEARER_TOKEN_FILE
    ? true
    : Boolean(config.providers.x.enabled);
  validateXOutcomeExhaustivenessContract(config);
  validateHistoricalMonitorCoverage(config);
  validateModelCalibrator(config);
  validateModelFeatureTransform(config);
  validateProvisionalBootstrap(config);
  validateOutcomeCoverageProviders(config);
  validateAuthorityTiming(config);
  validateSchedulerInterval(config);
  validateRsshubXProvider(config);
  config.config_hash = semanticConfigHash(config);
  return config;
}

export { root as projectRoot, semanticConfigHash };
