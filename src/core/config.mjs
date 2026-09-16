import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashLabel } from "./hash.mjs";
import { assertHistoricalDailyLedgerAttestation } from "./coverage-contract.mjs";
import {
  AUTHORITY_TIMING_POLICY_VERSION,
  AUTHORITY_TIMING_RELIABILITY_BASIS,
  AUTHORITY_TIMING_WITHIN_WINDOW_MASS_BASIS,
} from "../model/authority-timing.mjs";
import {
  assertPostOutcomeRefractoryPolicy,
} from "../model/post-outcome-refractory.mjs";
import {
  assertPostOutcomeEvidencePolicy,
} from "../model/evidence-epoch.mjs";
import {
  assertLiveForecastPromotionGuardPolicy,
} from "../model/live-forecast-guard.mjs";
import {
  assertFeatureSupportPolicy,
} from "../model/feature-support.mjs";

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

function validateSourcePolicies(config) {
  const required = config.runtime?.required_source_providers;
  const policy = config.live_evidence_policy;
  const validIds = (ids) => Array.isArray(ids) && ids.length > 0 &&
    new Set(ids).size === ids.length && ids.every((id) =>
      typeof id === "string" && Object.entries(config.providers).some(([name, provider]) =>
        id === (provider.provider_name ?? name) ||
        (name === "x_search_gateway" && id === `x_search_gateway_${provider.upstream_provider}`)
      )
    );
  if (required != null && !validIds(required)) {
    throw new TypeError("runtime.required_source_providers must name non-empty configured provider IDs");
  }
  if (policy && (policy.version !== "primary-full-text/1" ||
      !validIds(policy.primary_providers) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(policy.effective_at) ||
      !Number.isFinite(Date.parse(policy.effective_at)))) {
    throw new TypeError("live_evidence_policy must declare primary-full-text/1, primary providers and a UTC effective_at");
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

function validateSemanticAssistance(config) {
  const policy = config.extractor?.semantic_assistance;
  let baseUrl;
  try {
    baseUrl = new URL(policy?.base_url);
  } catch {
    throw new TypeError(
      "extractor.semantic_assistance.base_url must be an absolute HTTP(S) URL",
    );
  }
  const localHttp = baseUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);
  if (
    policy?.policy_version !== "semantic-timing-assistance/1" ||
    typeof policy.enabled !== "boolean" ||
    policy.protocol !== "openai-compatible-chat-completions/1" ||
    !["https:", "http:"].includes(baseUrl.protocol) ||
    (baseUrl.protocol === "http:" && !localHttp) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    typeof policy.model !== "string" ||
    policy.model.trim().length === 0 ||
    ![undefined, "enabled", "disabled"].includes(policy.thinking) ||
    ![null, "string"].includes(
      policy.token_file === null ? null : typeof policy.token_file,
    ) ||
    policy.prompt_version !== "authority-quote-timing/1" ||
    !Number.isInteger(policy.request_timeout_ms) ||
    policy.request_timeout_ms < 100 ||
    policy.request_timeout_ms > 60_000 ||
    !Number.isInteger(policy.maximum_input_chars) ||
    policy.maximum_input_chars < 256 ||
    policy.maximum_input_chars > 20_000 ||
    !Number.isInteger(policy.maximum_output_bytes) ||
    policy.maximum_output_bytes < 1_024 ||
    policy.maximum_output_bytes > 1_048_576 ||
    !Number.isInteger(policy.max_tokens) ||
    policy.max_tokens < 32 ||
    policy.max_tokens > 2_048 ||
    !Number.isFinite(policy.minimum_confidence) ||
    policy.minimum_confidence < 0 ||
    policy.minimum_confidence > 1 ||
    !Number.isFinite(policy.maximum_observation_age_hours) ||
    policy.maximum_observation_age_hours <= 0 ||
    policy.maximum_observation_age_hours > 168
  ) {
    throw new TypeError(
      "extractor.semantic_assistance must use the supported bounded fail-closed policy",
    );
  }
  if (
    policy.enabled &&
    (typeof policy.token_file !== "string" || policy.token_file.trim().length === 0)
  ) {
    throw new TypeError(
      "Enabled extractor semantic assistance requires a token_file",
    );
  }
  policy.base_url = baseUrl.toString().replace(/\/$/, "");
  policy.model = policy.model.trim();
  if (typeof policy.token_file === "string") {
    policy.token_file = path.resolve(root, policy.token_file);
  }
}

function validateResetReview(config) {
  const policy = config.extractor.reset_review;
  if (!policy || policy.policy_version !== "authority-reset-review/1" ||
      typeof policy.enabled !== "boolean" ||
      (policy.enabled && config.outcome_definition.event_semantics !== "qualifying_authority_completion_statement") ||
      !Number.isFinite(policy.minimum_confidence) || policy.minimum_confidence < 0.5 || policy.minimum_confidence > 1 ||
      [["window_hours", 1, 48], ["background_days", 1, 90], ["lookback_days", 1, 30],
       ["refresh_interval_hours", 1, 24], ["maximum_posts", 4, 40], ["maximum_reviews_per_run", 1, 8]]
        .some(([key, min, max]) => !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max)) {
    throw new TypeError("extractor.reset_review must use the bounded authority-reset-review/1 policy");
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

function validateXSearchGatewayProvider(config) {
  const provider = config.providers?.x_search_gateway;
  const queries = provider?.queries;
  const queryNames = Array.isArray(queries)
    ? queries.map((query) => query?.name)
    : [];
  if (
    !provider ||
    typeof provider.enabled !== "boolean" ||
    !Number.isFinite(provider.freshness_max_age_hours) ||
    provider.freshness_max_age_hours <= 0 ||
    !Number.isFinite(provider.refresh_interval_minutes) ||
    provider.refresh_interval_minutes <= 0 ||
    provider.refresh_interval_minutes > 1_440 ||
    !Number.isInteger(provider.quota_exhaustion_cooldown_minutes) ||
    provider.quota_exhaustion_cooldown_minutes < 1 ||
    provider.quota_exhaustion_cooldown_minutes > 1_440 ||
    typeof provider.base_url !== "string" ||
    !/^https?:\/\//i.test(provider.base_url) ||
    typeof provider.upstream_provider !== "string" ||
    provider.upstream_provider.trim().length === 0 ||
    !Number.isInteger(provider.request_timeout_ms) ||
    provider.request_timeout_ms <= 0 ||
    provider.request_timeout_ms > 600_000 ||
    !Number.isInteger(provider.limit) ||
    provider.limit < 1 ||
    provider.limit > 100 ||
    typeof provider.state_prefix !== "string" ||
    provider.state_prefix.trim().length === 0 ||
    !Array.isArray(provider.confirmation_identities) ||
    provider.confirmation_identities.length < 1 ||
    !Array.isArray(provider.context_identities) ||
    !Array.isArray(queries) ||
    queries.length < 1 ||
    new Set(queryNames).size !== queryNames.length ||
    queries.some((query) =>
      typeof query?.name !== "string" ||
      query.name.trim().length === 0 ||
      typeof query.query !== "string" ||
      query.query.trim().length === 0 ||
      (
        query.handles !== undefined &&
        (
          !Array.isArray(query.handles) ||
          query.handles.some((handle) => typeof handle !== "string")
        )
      ) ||
      (
        query.limit !== undefined &&
        (
          !Number.isInteger(query.limit) ||
          query.limit < 1 ||
          query.limit > 100
        )
      ) ||
      (
        query.search_type !== undefined &&
        (
          typeof query.search_type !== "string" ||
          query.search_type.trim().length === 0
        )
      )
    )
  ) {
    throw new TypeError(
      "providers.x_search_gateway must declare a bounded refresh, non-empty uniquely named queries, and a valid gateway endpoint",
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
    policy.within_window_mass_basis !==
      AUTHORITY_TIMING_WITHIN_WINDOW_MASS_BASIS ||
    !Number.isFinite(policy.within_window_baseline_power) ||
    policy.within_window_baseline_power < 0 ||
    policy.within_window_baseline_power > 1 ||
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

function validatePostOutcomeRefractory(config) {
  assertPostOutcomeRefractoryPolicy(
    config.model?.post_outcome_refractory,
  );
}

function validatePostOutcomeEvidence(config) {
  assertPostOutcomeEvidencePolicy(
    config.model?.evidence_carryover,
  );
}

function validateLiveForecastPromotionGuard(config) {
  assertLiveForecastPromotionGuardPolicy(
    config.model?.live_forecast_promotion_guard,
  );
}

function validateFeatureSupport(config) {
  assertFeatureSupportPolicy(config.model?.feature_support);
}

function validateImpactTracking(config) {
  const policy = config.impact_tracking;
  if (
    policy?.version !== "impact-episode-policy/1" ||
    typeof policy.enabled !== "boolean" ||
    !Number.isFinite(policy.cluster_gap_hours) ||
    policy.cluster_gap_hours <= 0 ||
    policy.cluster_gap_hours > 336 ||
    !Number.isFinite(policy.active_evidence_ttl_hours) ||
    policy.active_evidence_ttl_hours <= 0 ||
    policy.active_evidence_ttl_hours > 168 ||
    !Number.isFinite(policy.freshness_half_life_hours) ||
    policy.freshness_half_life_hours <= 0 ||
    policy.freshness_half_life_hours > 336
  ) {
    throw new TypeError(
      "impact_tracking must use the supported bounded impact-episode-policy/1",
    );
  }
}

function validatePublicationRuntime(config) {
  const runtime = config.runtime ?? {};
  let publicBaseUrl;
  try {
    publicBaseUrl = new URL(runtime.public_base_url);
  } catch {
    throw new TypeError("runtime.public_base_url must be an absolute HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(publicBaseUrl.protocol) ||
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    !["", "/"].includes(publicBaseUrl.pathname) ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new TypeError("runtime.public_base_url must be a credential-free HTTP(S) origin");
  }
  runtime.public_base_url = publicBaseUrl.origin;

  const publication = runtime.publication;
  const probability = publication?.probability_alert;
  if (
    publication?.policy_version !== "publication-policy/2" ||
    typeof publication.enabled !== "boolean" ||
    publication.bootstrap_mode !== "baseline_only" ||
    !Number.isFinite(publication.outcome_max_delivery_delay_hours) ||
    publication.outcome_max_delivery_delay_hours <= 0 ||
    !Number.isFinite(publication.authority_max_delivery_delay_hours) ||
    publication.authority_max_delivery_delay_hours <= 0 ||
    typeof probability?.enabled !== "boolean" ||
    !Number.isFinite(probability.open_threshold) ||
    !Number.isFinite(probability.close_threshold) ||
    probability.close_threshold < 0 ||
    probability.open_threshold > 1 ||
    probability.close_threshold >= probability.open_threshold ||
    !["provisional", "validated"].includes(probability.minimum_stage) ||
    !Number.isFinite(probability.max_delivery_delay_minutes) ||
    probability.max_delivery_delay_minutes <= 0
  ) {
    throw new TypeError(
      "runtime.publication must use the supported bounded publication-policy/2 contract",
    );
  }

  const webPush = runtime.web_push;
  if (
    typeof webPush?.enabled !== "boolean" ||
    ![null, "string"].includes(
      webPush.vapid_keys_file === null ? null : typeof webPush.vapid_keys_file,
    ) ||
    ![null, "string"].includes(
      webPush.vapid_subject === null ? null : typeof webPush.vapid_subject,
    ) ||
    !Number.isInteger(webPush.dispatch_interval_seconds) ||
    webPush.dispatch_interval_seconds < 1 ||
    webPush.dispatch_interval_seconds > 3600 ||
    !Number.isInteger(webPush.max_subscriptions) ||
    webPush.max_subscriptions < 1 ||
    webPush.max_subscriptions > 100_000
  ) {
    throw new TypeError("runtime.web_push must declare bounded runtime-only settings");
  }
}

function semanticConfigHash(config) {
  const {
    runtime: _runtime,
    config_hash: _configHash,
    ...semanticConfig
  } = config;
  const semanticAssistance = semanticConfig.extractor?.semantic_assistance;
  return hashLabel({
    ...semanticConfig,
    extractor: {
      ...semanticConfig.extractor,
      semantic_assistance: {
        ...semanticAssistance,
        token_file: semanticAssistance?.enabled === true &&
          semanticAssistance.token_file
          ? "configured-file"
          : null,
      },
    },
  });
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
  config.runtime.public_base_url = process.env.RESET_PUBLIC_BASE_URL ??
    config.runtime.public_base_url;
  if (process.env.RESET_PUBLICATION_ENABLED !== undefined) {
    config.runtime.publication.enabled =
      process.env.RESET_PUBLICATION_ENABLED === "true";
  }
  if (process.env.WEB_PUSH_ENABLED !== undefined) {
    config.runtime.web_push.enabled = process.env.WEB_PUSH_ENABLED === "true";
  }
  config.runtime.web_push.vapid_keys_file =
    process.env.WEB_PUSH_VAPID_KEYS_FILE ??
    config.runtime.web_push.vapid_keys_file;
  if (process.env.WEB_PUSH_VAPID_SUBJECT?.trim()) {
    config.runtime.web_push.vapid_subject =
      process.env.WEB_PUSH_VAPID_SUBJECT.trim();
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
  if (process.env.RESET_SEMANTIC_ASSISTANCE_ENABLED !== undefined) {
    config.extractor.semantic_assistance.enabled =
      process.env.RESET_SEMANTIC_ASSISTANCE_ENABLED === "true";
  }
  config.extractor.semantic_assistance.base_url =
    process.env.RESET_SEMANTIC_ASSISTANCE_BASE_URL ??
    config.extractor.semantic_assistance.base_url;
  config.extractor.semantic_assistance.model =
    process.env.RESET_SEMANTIC_ASSISTANCE_MODEL ??
    config.extractor.semantic_assistance.model;
  if (process.env.RESET_SEMANTIC_ASSISTANCE_TOKEN_FILE?.trim()) {
    config.extractor.semantic_assistance.token_file =
      process.env.RESET_SEMANTIC_ASSISTANCE_TOKEN_FILE.trim();
  }
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
  validateSourcePolicies(config);
  validateOutcomeCoverageProviders(config);
  validateAuthorityTiming(config);
  validatePostOutcomeRefractory(config);
  validatePostOutcomeEvidence(config);
  validateLiveForecastPromotionGuard(config);
  validateFeatureSupport(config);
  validateImpactTracking(config);
  validatePublicationRuntime(config);
  validateSchedulerInterval(config);
  validateSemanticAssistance(config);
  validateResetReview(config);
  validateXSearchGatewayProvider(config);
  validateRsshubXProvider(config);
  config.config_hash = semanticConfigHash(config);
  return config;
}

export { root as projectRoot, semanticConfigHash };
