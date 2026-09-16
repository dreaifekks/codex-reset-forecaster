import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../core/config.mjs";
import { hashLabel } from "../core/hash.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../core/outcome-contract.mjs";
import {
  extractorContract,
  matchesExtractorContract,
} from "../core/extractor-contract.mjs";
import {
  assessPredictionFreshness,
  assessEvaluationCompatibility,
  getProviderFreshness,
  getReadiness,
  sourceFreshnessBlockers,
} from "../runtime/readiness.mjs";
import {
  selectCurrentRelevantSignals,
} from "../pipeline/signal-selection.mjs";
import {
  impactEpisodeContract,
} from "../pipeline/impact-episodes.mjs";
import { verifiedCoverageAssertionRevisions } from "../pipeline/coverage.mjs";
import {
  confirmedOutcomeHistoryRow,
  exactRecordKey,
  latestEligibleConfirmedOutcomes,
  loadConfirmedHistoryResults,
} from "../query/history-results.mjs";
import {
  parseProbabilityProfileHorizon,
} from "../query/probability-threshold-profile.mjs";
import {
  assessEvaluationSampleGate,
  verifyEvaluationArtifact,
} from "../model/evaluation.mjs";
import {
  buildIssuedEvaluationReportingView,
  verifyIssuedEvaluationArtifact,
} from "../model/issued-evaluation.mjs";
import {
  timestampFromXSnowflake,
  xStatusIdentity,
} from "../providers/raw.mjs";
import {
  RSSHUB_X_QUARANTINE_MEDIA_TYPE,
} from "../providers/rsshub-x-provider.mjs";
import { createPublicationLedger } from "../notifications/ledger.mjs";
import { renderPublicationAtom } from "../notifications/feed.mjs";
import {
  normalizedNotificationPreferences,
  renderProbabilityAtom,
} from "../notifications/probability-feed.mjs";

const PUBLIC_DIR = path.join(projectRoot, "public");
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".xml", "application/xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);
const STATIC_ROUTE_FILES = new Map([
  ["/", "index.html"],
  ["/accuracy", "accuracy.html"],
  ["/en", "en/index.html"],
  ["/en/accuracy", "en/accuracy.html"],
]);
const CANONICAL_STATIC_REDIRECTS = new Map([
  ["/index.html", "/"],
  ["/accuracy/", "/accuracy"],
  ["/accuracy.html", "/accuracy"],
  ["/en/", "/en"],
  ["/en/index.html", "/en"],
  ["/en/accuracy/", "/en/accuracy"],
  ["/en/accuracy.html", "/en/accuracy"],
]);
const MAX_WEB_PUSH_REQUEST_BYTES = 16 * 1024;
const API_COMPUTATION_CACHE_MS = 10_000;
const HISTORY_RESULTS_CACHE_MS = 30_000;
export const SERVING_SNAPSHOT_SCHEMA_VERSION = "serving-snapshot/3";
const SUPPORTED_SERVING_SNAPSHOT_SCHEMA_VERSIONS = new Set([
  "serving-snapshot/2",
  SERVING_SNAPSHOT_SCHEMA_VERSION,
]);
export const SERVING_SNAPSHOT_STATE_KEY = "serving-snapshot";
const SERVING_SNAPSHOT_DEFAULT_CADENCE_MINUTES = 10;
const SERVING_SNAPSHOT_CADENCE_MULTIPLIER = 3;
const IMMUTABLE_SNAPSHOT_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
const NOTIFICATION_CALIBRATION_CACHE_CONTROL =
  "public, max-age=600, stale-while-revalidate=3600";
const NOTIFICATION_CALIBRATION_COMPACT_VERSION =
  "notification-threshold-calibration-compact/1";
const DYNAMIC_FORECAST_BLOCKERS = new Set([
  "forecast_missing",
  "forecast_fresh",
  "forecast_degraded",
  "forecast_stale",
  "forecast_invalid",
]);
const DYNAMIC_SOURCE_BLOCKERS = new Set([
  "required_source_not_fresh",
  "required_outcome_source_not_fresh",
  "exact_source_not_fresh",
]);
const FORECAST_INPUT_VIEW_SCHEMA_VERSION =
  "notification-forecast-input-view/1";

function requestedForecastInputHorizons(searchParams) {
  const values = searchParams.getAll("horizon_hours");
  if (values.length === 0) return null;
  const horizons = values.map(parseProbabilityProfileHorizon);
  if (new Set(horizons).size !== horizons.length) {
    throw new TypeError("Forecast input horizon_hours values must be unique");
  }
  return horizons.sort((left, right) => left - right);
}

function projectForecastInputHorizons(input, horizons) {
  if (!Array.isArray(input?.probabilities) || input.probabilities.length !== 168) {
    throw new TypeError("Forecast input projection requires 168 probabilities");
  }
  const { probabilities, schema_version: sourceSchemaVersion, ...metadata } = input;
  return {
    ...structuredClone(metadata),
    schema_version: FORECAST_INPUT_VIEW_SCHEMA_VERSION,
    source_schema_version: sourceSchemaVersion,
    horizon_probabilities: horizons.map((horizonHours) => ({
      horizon_hours: horizonHours,
      probability: probabilities[horizonHours - 1],
    })),
  };
}

function projectForecastInputPage(page, horizons) {
  if (horizons === null) return page;
  return {
    ...page,
    horizon_hours: horizons,
    inputs: page.inputs.map((input) =>
      projectForecastInputHorizons(input, horizons)
    ),
  };
}

function timedSingleFlight(loader, ttlMs = API_COMPUTATION_CACHE_MS) {
  let cachedValue = null;
  let expiresAt = 0;
  let inFlight = null;
  return async (...args) => {
    const requestStartedAt = Date.now();
    if (cachedValue !== null && requestStartedAt < expiresAt) {
      return cachedValue;
    }
    if (inFlight) return inFlight;
    inFlight = loader(...args)
      .then((value) => {
        cachedValue = value;
        expiresAt = Date.now() + ttlMs;
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function sendSemanticUnavailable(response, value) {
  response.forecasterSemanticUnavailable = true;
  sendJson(response, 503, value);
}

function sendImmutableJson(request, response, value, etag) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": IMMUTABLE_SNAPSHOT_CACHE_CONTROL,
    etag,
  };
  if (ifNoneMatch(request.headers["if-none-match"], etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : JSON.stringify(value));
}

function sendCacheableJson(request, response, value) {
  const body = JSON.stringify(value);
  const etag = `"${hashLabel(body).slice("sha256:".length)}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": NOTIFICATION_CALIBRATION_CACHE_CONTROL,
    etag,
  };
  if (ifNoneMatch(request.headers["if-none-match"], etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
}

function projectNotificationCalibration(profile) {
  if (!profile || typeof profile !== "object") {
    throw new TypeError("Probability calibration profile is invalid");
  }
  return {
    schema_version: NOTIFICATION_CALIBRATION_COMPACT_VERSION,
    profile_schema_version: profile.schema_version,
    detail_schema_version: profile.detail_schema_version,
    reason: profile.reason,
    preliminary: profile.preliminary,
    horizon_hours: profile.horizon_hours,
    evaluation_cutoff: profile.evaluation_cutoff,
    model_release: profile.model_release,
    status: profile.status,
    sample_count: profile.sample_count,
    min_sample_count: profile.min_sample_count,
    event_count: profile.event_count,
    min_event_count: profile.min_event_count,
    sample_gate: profile.sample_gate,
    distribution_summary: profile.distribution_summary,
    points: (Array.isArray(profile.points) ? profile.points : []).map((point) => ({
      probability: point.probability,
      density: point.density,
      confidence_above: point.confidence_above,
      historical_hit_rate_above: point.historical_hit_rate_above,
      sample_count_above: point.sample_count_above,
      confidence_interval: point.confidence_interval,
      point_sample_gate: point.point_sample_gate,
    })),
  };
}

function sendAtom(request, response, value) {
  const headers = {
    "content-type": "application/atom+xml; charset=utf-8",
    "cache-control": "no-cache",
    etag: value.etag,
  };
  if (ifNoneMatch(request.headers["if-none-match"], value.etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : value.body);
}

async function readJsonBody(request, limit = MAX_WEB_PUSH_REQUEST_BYTES) {
  if (!String(request.headers["content-type"] ?? "")
    .toLowerCase().startsWith("application/json")) {
    const error = new Error("Request content type must be application/json");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error("Request body exceeds 16 KiB");
    error.code = "payload_too_large";
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error("Request body exceeds 16 KiB");
      error.code = "payload_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON");
    error.code = "invalid_json";
    throw error;
  }
}

function webPushErrorStatus(error) {
  return ({
    unsupported_media_type: 415,
    payload_too_large: 413,
    invalid_json: 400,
    invalid_subscription: 400,
    endpoint_not_allowed: 400,
    origin_not_allowed: 403,
    web_push_disabled: 503,
    subscription_limit_reached: 503,
  })[error?.code] ?? 500;
}

function ifNoneMatch(header, etag) {
  if (typeof header !== "string") return false;
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

function securityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://vibecafe.ai https://static.cloudflareinsights.com/beacon.min.js https://static.cloudflareinsights.com/beacon.min.js/; connect-src 'self' https://vibecafe.ai; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function configuredPublicHttpsUrl(config) {
  const publicBaseUrl = config?.runtime?.public_base_url;
  if (typeof publicBaseUrl !== "string") return null;
  try {
    const url = new URL(publicBaseUrl);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function publicHttpsRedirectLocation(request, url, publicHttpsUrl) {
  if (!publicHttpsUrl) return null;
  const host = request.headers.host;
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (
    typeof host !== "string" ||
    host.trim().toLowerCase() !== publicHttpsUrl.host.toLowerCase() ||
    typeof forwardedProto !== "string" ||
    forwardedProto.trim().toLowerCase() !== "http"
  ) return null;
  return `${publicHttpsUrl.origin}${url.pathname}${url.search}`;
}

async function latestPrediction(store) {
  return (await store.all("prediction"))
    .sort((left, right) => left.data.issued_at.localeCompare(right.data.issued_at))
    .at(-1) ?? null;
}

async function currentEvaluation(store, config) {
  const championRead = store.readModel("champion")
    .then((model) => ({ model, error: null }))
    .catch((error) => ({ model: null, error }));
  const [
    issued,
    championEvaluation,
    walkForward,
    legacy,
    assertions,
    championResult,
    outcomeRevisions,
    predictionRevisions,
    settlementRevisions,
  ] = await Promise.all([
    store.readState("issued-evaluation-summary", null),
    store.readState("champion-evaluation", null),
    store.readState("walk-forward-summary", null),
    store.readState("evaluation-summary", null),
    verifiedCoverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
    championRead,
    store.all("reset_outcome", { latestOnly: false }),
    store.all("prediction", { latestOnly: false }),
    store.all("prediction_settlement", { latestOnly: false }),
  ]);
  const champion = championResult.model;
  const liveThresholdReached = Boolean(
    issued &&
    issued.metrics.evaluated_windows >= config.model.minimum_live_evaluation_windows &&
    issued.metrics.evaluated_events >= config.model.minimum_live_evaluation_events
  );
  const candidates = [
    ...(liveThresholdReached ? [["issued", issued]] : []),
    ["champion", championEvaluation],
    ["walk_forward", walkForward],
    ["legacy", legacy],
    ...(!liveThresholdReached && issued ? [["issued_preliminary", issued]] : []),
  ].filter(([, evaluation]) => evaluation);
  const invalidated = [];
  for (const [name, evaluation] of candidates) {
    const evaluationArtifactVerification = evaluation.mode === "as_issued"
      ? await verifyIssuedEvaluationArtifact(store, evaluation)
      : await verifyEvaluationArtifact(store, evaluation);
    const compatibility = assessEvaluationCompatibility(
      evaluation,
      config,
      assertions,
      {
        champion,
        outcomeRevisions,
        predictionRevisions,
        settlementRevisions,
        evaluationArtifactVerification,
        allowAsIssuedBaselineSuperseded: name === "issued_preliminary",
      },
    );
    if (compatibility.compatible) {
      const sampleGate = evaluation.mode === "as_issued"
        ? assessEvaluationSampleGate(evaluation.metrics, config.model)
        : null;
      const preliminary = name === "issued_preliminary" ||
        compatibility.warnings?.length > 0;
      const baselineCurrent = !compatibility.warnings?.some((warning) =>
        [
          "baseline_coverage_assertion_revision_superseded",
          "baseline_outcome_revision_superseded",
        ].includes(warning)
      );
      const reportingView = evaluation.mode === "as_issued" &&
          evaluationArtifactVerification.valid
        ? buildIssuedEvaluationReportingView(
          evaluationArtifactVerification.artifact,
          {
            sourceEvaluationArtifactHash:
              evaluation.evaluation_artifact_hash,
          },
        )
        : null;
      if (reportingView?.status === "available") {
        reportingView.sample_gate = assessEvaluationSampleGate(
          reportingView.metrics,
          config.model,
        );
        reportingView.metric_availability = {
          brier_skill: baselineCurrent,
        };
      }
      return {
        evaluation,
        compatibility,
        invalidated,
        reporting_status: preliminary ? "preliminary" : "mature",
        sample_gate: sampleGate,
        metric_availability: {
          brier_skill: baselineCurrent,
        },
        reporting_view: reportingView,
        champion_error: championResult.error?.message ?? null,
      };
    }
    invalidated.push({ name, ...compatibility });
  }
  return {
    evaluation: null,
    compatibility: null,
    invalidated,
    champion_error: championResult.error?.message ?? null,
  };
}

export async function buildEvaluationEventViews(
  store,
  config,
  evaluationResult,
) {
  const [outcomes, observations, signals] = await Promise.all([
    store.all("reset_outcome", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    store.all("normalized_signal", { latestOnly: false }),
  ]);
  const observationByRef = new Map(
    observations.map((item) => [exactRecordKey(item), item]),
  );
  const outcomeByRef = new Map(
    outcomes.map((item) => [exactRecordKey(item), item]),
  );
  const latestConfirmed = latestEligibleConfirmedOutcomes({
    outcomes,
    observations,
    signals,
    config,
  }).map((item) => item.outcome);

  const rowsFor = (reportingScope) => {
    const evaluation = evaluationResult.evaluation;
    const scoredEvents = reportingScope
      ? evaluationResult.reporting_view?.status === "available"
        ? evaluationResult.reporting_view.events
        : []
      : evaluation?.events ?? [];
    const evaluationByRef = new Map(
      scoredEvents.map((item) => [exactRecordKey(item.outcome_ref), item]),
    );
    const referencedOutcomes = scoredEvents
      .map((item) => outcomeByRef.get(exactRecordKey(item.outcome_ref)))
      .filter(Boolean);
    const selectedOutcomes = reportingScope
      ? referencedOutcomes
      : [
          ...new Map(
            [...referencedOutcomes, ...latestConfirmed]
              .map((outcome) => [exactRecordKey(outcome), outcome]),
          ).values(),
        ];
    return [...selectedOutcomes]
      .sort((left, right) =>
        right.data.occurred_time_range.start.localeCompare(
          left.data.occurred_time_range.start,
        )
      )
      .map((outcome) => ({
        ...confirmedOutcomeHistoryRow(outcome, observationByRef),
        evaluation: evaluationByRef.get(exactRecordKey(outcome)) ?? null,
      }));
  };

  return {
    all_history: rowsFor(false),
    reporting: rowsFor(true),
  };
}

export function servingSnapshotConfig(config) {
  const servingRuntime = {
    required_source_providers: config.runtime?.required_source_providers ?? null,
    forecast_fresh_age_hours:
      config.runtime?.forecast_fresh_age_hours ?? null,
    forecast_stale_age_hours:
      config.runtime?.forecast_stale_age_hours ?? null,
    provisional_bootstrap: config.runtime?.provisional_bootstrap ?? null,
    scheduler_interval_minutes:
      config.runtime?.scheduler_interval_minutes ?? null,
  };
  const snapshotConfig = {
    config_hash: config.config_hash ?? hashLabel(config),
    config_version: config.config_version ?? null,
    feature_schema_version: config.feature_schema_version ?? null,
    outcome_label_policy_version: OUTCOME_LABEL_POLICY_VERSION,
    outcome_adjudicator_version: OUTCOME_ADJUDICATOR_VERSION,
    runtime: servingRuntime,
  };
  return {
    ...snapshotConfig,
    serving_config_hash: hashLabel(snapshotConfig),
  };
}

function servingSnapshotMaxAgeMs(config) {
  const configuredMinutes = Number(
    config.runtime?.scheduler_interval_minutes ??
      SERVING_SNAPSHOT_DEFAULT_CADENCE_MINUTES,
  );
  const cadenceMinutes = Number.isFinite(configuredMinutes) &&
      configuredMinutes > 0
    ? configuredMinutes
    : SERVING_SNAPSHOT_DEFAULT_CADENCE_MINUTES;
  return cadenceMinutes * SERVING_SNAPSHOT_CADENCE_MULTIPLIER * 60_000;
}

function completedRuntimeState(runtimeState) {
  if (!runtimeState || typeof runtimeState !== "object") return {};
  return {
    last_success_at: runtimeState.last_success_at ?? null,
    last_failure_at: runtimeState.last_failure_at ?? null,
    last_run_duration_ms: runtimeState.last_run_duration_ms ?? null,
    last_status: runtimeState.last_status ?? null,
    last_waiting: runtimeState.last_waiting ?? null,
    last_evaluation_waiting: runtimeState.last_evaluation_waiting ?? null,
    last_training_at: runtimeState.last_training_at ?? null,
    last_evaluation_at: runtimeState.last_evaluation_at ?? null,
    last_promotion_status: runtimeState.last_promotion_status ?? null,
    last_promotion_guard: runtimeState.last_promotion_guard ?? null,
    last_prediction_id: runtimeState.last_prediction_id ?? null,
    last_collection: runtimeState.last_collection ?? null,
    last_timing: runtimeState.last_timing ?? null,
    last_error: runtimeState.last_error ?? null,
  };
}

function runtimeWatermark(runtimeState) {
  const completed = completedRuntimeState(runtimeState);
  return {
    last_success_at: completed.last_success_at ?? null,
    last_failure_at: completed.last_failure_at ?? null,
    last_status: completed.last_status ?? null,
    last_prediction_id: completed.last_prediction_id ?? null,
    state_hash: hashLabel(completed),
  };
}

function predictionReference(prediction) {
  return prediction ? {
    record_id: prediction.record_id,
    revision: prediction.revision,
  } : null;
}

function samePredictionReference(left, right) {
  return left?.record_id === right?.record_id &&
    left?.revision === right?.revision;
}

export function isServingSnapshotUsable(snapshot, { config }) {
  const expectedConfig = servingSnapshotConfig(config);
  if (
    !snapshot ||
    !SUPPORTED_SERVING_SNAPSHOT_SCHEMA_VERSIONS.has(snapshot.schema_version) ||
    snapshot.config_hash !== expectedConfig.config_hash ||
    snapshot.serving_config_hash !== expectedConfig.serving_config_hash ||
    !Number.isFinite(Date.parse(snapshot.materialized_at))
  ) return false;
  if (
    !samePredictionReference(
      snapshot.prediction_ref,
      predictionReference(snapshot.prediction),
    ) ||
    snapshot.prediction_hash !== (
      snapshot.prediction ? hashLabel(snapshot.prediction) : null
    )
  ) return false;
  return true;
}

function isServingSnapshotCurrent(snapshot, {
  config,
  runtimeState,
  requestNow,
}) {
  if (!isServingSnapshotUsable(snapshot, { config })) return false;
  const materializedAt = Date.parse(snapshot.materialized_at);
  const ageMs = requestNow.getTime() - materializedAt;
  if (
    !Number.isFinite(materializedAt) ||
    ageMs < 0 ||
    ageMs > servingSnapshotMaxAgeMs(config)
  ) return false;
  return snapshot.runtime_watermark?.state_hash ===
    runtimeWatermark(runtimeState).state_hash;
}

function withoutDynamicBlockers(blockers, { includePipeline = false } = {}) {
  return (blockers ?? []).filter((blocker) =>
    !DYNAMIC_FORECAST_BLOCKERS.has(blocker) &&
    !DYNAMIC_SOURCE_BLOCKERS.has(blocker) &&
    (includePipeline || blocker !== "pipeline_error")
  );
}

function appendDynamicSourceBlockers(blockers, providerFreshness) {
  blockers.push(...sourceFreshnessBlockers(providerFreshness));
}

function runtimeFailureIsCurrent(runtimeState) {
  if (!runtimeState?.last_error) return false;
  const successAt = Date.parse(runtimeState.last_success_at ?? "");
  const failureAt = Date.parse(runtimeState.last_failure_at ?? "");
  return !Number.isFinite(failureAt) ||
    !Number.isFinite(successAt) ||
    failureAt >= successAt;
}

function projectDynamicReadiness({
  readiness,
  prediction,
  providerFreshness,
  runtimeState,
  config,
  requestNow,
}) {
  const currentForecast = assessPredictionFreshness(
    prediction,
    config,
    requestNow,
  );
  const servingBlockers = withoutDynamicBlockers(
    readiness.serving_blockers,
    { includePipeline: true },
  );
  if (!prediction) servingBlockers.push("forecast_missing");
  else if (["stale", "invalid", "missing"].includes(currentForecast.status)) {
    servingBlockers.push(`forecast_${currentForecast.status}`);
  }
  appendDynamicSourceBlockers(servingBlockers, providerFreshness);
  const uniqueServingBlockers = [...new Set(servingBlockers)];
  const forecastAvailable = Boolean(
    prediction &&
    readiness.prediction_integrity?.valid &&
    !["stale", "invalid", "missing"].includes(currentForecast.status) &&
    withoutDynamicBlockers(readiness.serving_blockers, {
      includePipeline: true,
    }).length === 0,
  );
  const servingReady = forecastAvailable && uniqueServingBlockers.length === 0;

  const publicationBlockers = withoutDynamicBlockers(
    readiness.publication_blockers,
  );
  if (!prediction) publicationBlockers.push("forecast_missing");
  else if (currentForecast.status !== "fresh") {
    publicationBlockers.push(`forecast_${currentForecast.status}`);
  }
  appendDynamicSourceBlockers(publicationBlockers, providerFreshness);
  const failureIsCurrent = runtimeFailureIsCurrent(runtimeState);
  if (failureIsCurrent) publicationBlockers.push("pipeline_error");
  const uniquePublicationBlockers = [...new Set(publicationBlockers)];

  const pipelineStatus = runtimeState.current_run_started_at
    ? "running"
    : failureIsCurrent
      ? "error"
      : readiness.coverage_waiting
        ? "waiting_for_coverage"
        : readiness.evaluation_waiting
          ? "waiting_for_evaluation"
          : runtimeState.last_status === "promotion_blocked"
            ? "promotion_blocked"
            : runtimeState.last_success_at
              ? "completed"
              : "idle";
  return {
    ...readiness,
    generated_at: requestNow.toISOString(),
    current_forecast: currentForecast,
    forecast_available: forecastAvailable,
    serving_ready: servingReady,
    serving_stage: !servingReady
      ? "blocked"
      : readiness.provisional_model?.eligibility?.eligible
        ? "provisional"
        : "validated",
    serving_blockers: uniqueServingBlockers,
    provider_freshness: providerFreshness,
    publication_ready: uniquePublicationBlockers.length === 0,
    publication_blockers: uniquePublicationBlockers,
    pipeline_status: pipelineStatus,
    last_pipeline_success_at: runtimeState.last_success_at ?? null,
    last_pipeline_failure_at: runtimeState.last_failure_at ?? null,
    last_pipeline_error: runtimeState.last_error ?? null,
  };
}

function exactPrediction(snapshot, recordId, revision) {
  if (
    snapshot?.prediction_ref?.record_id === recordId &&
    snapshot.prediction_ref.revision === revision &&
    snapshot.prediction?.record_id === recordId &&
    snapshot.prediction.revision === revision &&
    snapshot.prediction_hash === hashLabel(snapshot.prediction)
  ) return snapshot.prediction;
  return null;
}

function forecastSnapshotPath(pathname) {
  const match = pathname.match(
    /^\/api\/forecast\/snapshots\/([^/]+)\/([1-9][0-9]*)$/,
  );
  if (!match) return null;
  try {
    const recordId = decodeURIComponent(match[1]);
    const revision = Number(match[2]);
    if (
      !/^[a-zA-Z0-9_-]+$/.test(recordId) ||
      !Number.isSafeInteger(revision)
    ) return null;
    return { recordId, revision };
  } catch {
    return null;
  }
}

function latestProviderSuccess(...states) {
  return states
    .map((state) => state.last_success_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function latestProviderError(...states) {
  return states
    .filter((state) => state.last_error)
    .sort((left, right) =>
      String(left.last_failure_at ?? "").localeCompare(String(right.last_failure_at ?? "")),
    )
    .at(-1)?.last_error ?? null;
}

const CORE_SIGNAL_ROLES = new Set(["official", "product_lead", "product_team_member"]);
const CORE_PRODUCT_EVENTS = new Set(["release", "incident", "capacity_restore"]);
const CORE_PRODUCTS = new Set(["codex", "chatgpt", "chatgpt_work"]);
const CORE_PRODUCT_MENTION = /\b(?:codex|chatgpt(?:\s+work)?)\b/i;

function configuredConfirmationIdentityIds(config) {
  return new Set(
    Object.values(config.providers ?? {})
      .flatMap((provider) => provider?.confirmation_identities ?? [])
      .map((identity) => identity.identity_id)
      .filter(Boolean),
  );
}

function isCoreSignal(signal, observation, confirmationIdentityIds) {
  const { claim, provenance } = signal.data;
  if (
    provenance.source_role === "aggregator" ||
    (provenance.derivation && provenance.derivation !== "primary_statement")
  ) return false;
  if (confirmationIdentityIds.has(provenance.source_identity_id)) return true;
  return (
    CORE_SIGNAL_ROLES.has(provenance.source_role) &&
    claim.scope.vendor === "openai" &&
    CORE_PRODUCTS.has(claim.scope.product) &&
    CORE_PRODUCT_EVENTS.has(claim.event_type) &&
    CORE_PRODUCT_MENTION.test(observation?.data.content.text ?? "")
  );
}

export function evidenceTierForSignal(signal, observation, config) {
  if (signal.data.claim.impact) return "experience";
  if (signal.data.claim.competitive_context) return "competition";
  return isCoreSignal(signal, observation, configuredConfirmationIdentityIds(config))
    ? "core"
    : "other_context";
}

const EVIDENCE_SOURCE_RANK = new Map([
  ["official", 5],
  ["product_lead", 4],
  ["product_team_member", 3],
  ["employee", 2],
  ["community", 1],
  ["media", 1],
  ["aggregator", 0],
  ["unknown", 0],
]);
const EVIDENCE_DERIVATION_RANK = new Map([
  ["primary_statement", 3],
  ["independent_observation", 3],
  ["quotes", 1],
  ["repost", 1],
  ["reply", 1],
  ["summarizes", 1],
  ["unknown", 0],
]);

function evidencePreference(signal) {
  const provenance = signal.data.provenance;
  return [
    EVIDENCE_SOURCE_RANK.get(provenance.source_role) ?? 0,
    EVIDENCE_DERIVATION_RANK.get(provenance.derivation) ?? 0,
    Number.isFinite(Date.parse(provenance.source_published_at)) ? 1 : 0,
    signal.data.available_at,
    signal.created_at,
    signal.record_id,
  ];
}

function compareEvidencePreference(left, right) {
  const leftRank = evidencePreference(left);
  const rightRank = evidencePreference(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] > rightRank[index]) return 1;
    if (leftRank[index] < rightRank[index]) return -1;
  }
  return 0;
}

function uniqueEvidenceRoots(signals) {
  const selected = new Map();
  for (const signal of signals) {
    const key = signal.data.provenance.independence_group_id;
    const previous = selected.get(key);
    if (!previous || compareEvidencePreference(signal, previous) > 0) {
      selected.set(key, signal);
    }
  }
  return [...selected.values()];
}

function observationPublishedAt(observation) {
  const statusId = xStatusIdentity(observation?.data.canonical_url);
  if (statusId) {
    try {
      return timestampFromXSnowflake(statusId);
    } catch {
      // Fall through to the stored source timestamp for non-snowflake IDs.
    }
  }
  return observation?.data.published_at ?? null;
}

function evidenceDisplayTime(signal, observationsByRef) {
  const observation = observationsByRef.get(
    exactRecordKey(signal.data.observation_refs[0]),
  );
  return observationPublishedAt(observation) ??
    signal.data.provenance.source_published_at ??
    signal.data.available_at;
}

function sortEvidenceForDisplay(signals, observationsByRef) {
  return [...signals].sort((left, right) =>
    evidenceDisplayTime(right, observationsByRef)
      .localeCompare(evidenceDisplayTime(left, observationsByRef)) ||
    right.data.available_at.localeCompare(left.data.available_at) ||
    right.created_at.localeCompare(left.created_at) ||
    right.record_id.localeCompare(left.record_id)
  );
}

function sortEvidenceItems(items) {
  return [...items].sort((left, right) =>
    (right.source?.published_at ?? right.available_at)
      .localeCompare(left.source?.published_at ?? left.available_at) ||
    right.available_at.localeCompare(left.available_at) ||
    right.created_at.localeCompare(left.created_at) ||
    right.signal_ref.record_id.localeCompare(left.signal_ref.record_id)
  );
}

const TIMELINE_PROVIDER_RANK = new Map([
  ["x", 4],
  ["rsshub_x_timeline", 3],
  ["timeline_jsonl", 2],
  ["historical_monitor", 1],
]);

function quarantinedTimelinePayload(observation) {
  if (
    observation.data.content?.media_type !==
      RSSHUB_X_QUARANTINE_MEDIA_TYPE
  ) return null;
  try {
    const payload = JSON.parse(observation.data.content.text);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
  } catch {
    return null;
  }
}

function timelineObservationText(observation) {
  if (observation.data.content?.media_type === "text/plain") {
    return String(observation.data.content.text ?? "").trim();
  }
  const payload = quarantinedTimelinePayload(observation);
  return typeof payload?.source_text === "string"
    ? payload.source_text.trim()
    : "";
}

function compareTimelineObservations(left, right) {
  const safeRelationRank = Number(
    left.data.content?.media_type !== RSSHUB_X_QUARANTINE_MEDIA_TYPE,
  ) - Number(
    right.data.content?.media_type !== RSSHUB_X_QUARANTINE_MEDIA_TYPE,
  );
  if (safeRelationRank !== 0) return safeRelationRank;
  const providerRank = (
    TIMELINE_PROVIDER_RANK.get(left.data.ingest_provider) ?? 0
  ) - (
    TIMELINE_PROVIDER_RANK.get(right.data.ingest_provider) ?? 0
  );
  if (providerRank !== 0) return providerRank;
  if (left.revision !== right.revision) return left.revision - right.revision;
  return String(left.data.fetched_at ?? left.created_at ?? "")
    .localeCompare(String(right.data.fetched_at ?? right.created_at ?? ""));
}

function compareTimelineSignals(left, right) {
  return left.created_at.localeCompare(right.created_at) ||
    left.revision - right.revision ||
    left.record_id.localeCompare(right.record_id);
}

function confirmationTimeline(observations, signals, config) {
  const confirmationIds = configuredConfirmationIdentityIds(config);
  const signalsByObservationRef = new Map();
  for (const signal of signals) {
    const reference = signal.data.observation_refs?.[0];
    if (!reference) continue;
    const key = exactRecordKey(reference);
    const previous = signalsByObservationRef.get(key);
    if (!previous || compareTimelineSignals(previous, signal) < 0) {
      signalsByObservationRef.set(key, signal);
    }
  }

  const observationsByStatus = new Map();
  for (const observation of observations) {
    const displayText = timelineObservationText(observation);
    if (
      !confirmationIds.has(observation.data.author?.identity_id) ||
      !displayText
    ) {
      continue;
    }
    const statusId = xStatusIdentity(
      observation.data.canonical_url ?? observation.data.provider_item_id,
    );
    if (!statusId) continue;
    const group = observationsByStatus.get(statusId) ?? [];
    group.push(observation);
    observationsByStatus.set(statusId, group);
  }

  return [...observationsByStatus.entries()]
    .map(([statusId, groupedObservations]) => {
      const selectedObservation = [...groupedObservations]
        .sort(compareTimelineObservations)
        .at(-1);
      const matchedSignal = groupedObservations
        .map((observation) =>
          signalsByObservationRef.get(exactRecordKey(observation))
        )
        .filter(Boolean)
        .sort(compareTimelineSignals)
        .at(-1) ?? null;
      const relevance = matchedSignal?.data.extraction?.relevance ?? null;
      const quarantine = quarantinedTimelinePayload(selectedObservation);
      const earliestFirstSeenAt = groupedObservations
        .map((observation) => observation.data.first_seen_at)
        .filter((value) =>
          typeof value === "string" && Number.isFinite(Date.parse(value))
        )
        .sort()
        .at(0) ?? selectedObservation.data.first_seen_at ?? null;
      return {
        observation_ref: {
          record_id: selectedObservation.record_id,
          revision: selectedObservation.revision,
        },
        status_id: statusId,
        canonical_url: selectedObservation.data.canonical_url,
        published_at: observationPublishedAt(selectedObservation),
        first_seen_at: earliestFirstSeenAt,
        fetched_at: selectedObservation.data.fetched_at ?? null,
        display_handle: selectedObservation.data.author.display_handle ?? null,
        text: timelineObservationText(selectedObservation),
        ingest_provider: selectedObservation.data.ingest_provider,
        matched_signal: Boolean(matchedSignal),
        reset_review_status: matchedSignal?.data.extraction?.reset_review?.decision ?? null,
        reset_review_reason: matchedSignal?.data.extraction?.reset_review?.reason ?? null,
        matched_signal_ref: matchedSignal
          ? { record_id: matchedSignal.record_id, revision: matchedSignal.revision }
          : null,
        event_type: matchedSignal?.data.claim?.event_type ?? null,
        relevance: relevance?.decision ?? (
          quarantine ? "pending_context" : "unclassified"
        ),
        relevance_reason:
          relevance?.reason_code ?? quarantine?.reason_code ?? null,
        quarantined_relation: Boolean(quarantine),
        forecast_feature_eligible:
          matchedSignal?.data.provenance?.feature_eligible !== false &&
          Boolean(matchedSignal),
      };
    })
    .sort((left, right) =>
      String(right.published_at ?? "").localeCompare(
        String(left.published_at ?? ""),
      ) ||
      right.status_id.localeCompare(left.status_id)
    )
    .slice(0, 12);
}

function matchesImpactPolicy(episode, policy, expectedContractHash) {
  const parameters = episode.data.policy_parameters;
  return policy?.enabled === true &&
    episode.producer?.config_hash === expectedContractHash &&
    episode.data.policy_config_hash === expectedContractHash &&
    episode.data.policy_version === policy.version &&
    parameters?.cluster_gap_hours === policy.cluster_gap_hours &&
    parameters?.active_evidence_ttl_hours ===
      policy.active_evidence_ttl_hours &&
    parameters?.freshness_half_life_hours ===
      policy.freshness_half_life_hours;
}

function latestImpactEpisodes(episodes, policy, expectedContractHash) {
  return episodes
    .filter((episode) =>
      matchesImpactPolicy(episode, policy, expectedContractHash)
    )
    .sort((left, right) => {
      const pressureDifference =
        (Number.isFinite(Number(right.data.current_pressure))
          ? Number(right.data.current_pressure)
          : Number.NEGATIVE_INFINITY) -
        (Number.isFinite(Number(left.data.current_pressure))
          ? Number(left.data.current_pressure)
          : Number.NEGATIVE_INFINITY);
      if (pressureDifference !== 0) return pressureDifference;
      return String(right.data.last_independent_update_at ?? "")
        .localeCompare(String(left.data.last_independent_update_at ?? "")) ||
        right.revision - left.revision ||
        right.record_id.localeCompare(left.record_id);
    })
    .slice(0, 8)
    .map((episode) => ({
      episode_ref: {
        record_id: episode.record_id,
        revision: episode.revision,
      },
      state: episode.data.state,
      trend: episode.data.trend,
      category:
        episode.data.category ?? episode.data.current_impact?.category ?? null,
      as_of: episode.data.as_of,
      policy_version: episode.data.policy_version,
      policy_config_hash: episode.data.policy_config_hash,
      update_kind: episode.data.update_kind,
      current_pressure: episode.data.current_pressure,
      peak_pressure: episode.data.peak_pressure,
      pressure_components: episode.data.pressure_components,
      current_impact: episode.data.current_impact,
      first_observed_at: episode.data.first_observed_at,
      last_independent_update_at: episode.data.last_independent_update_at,
      evidence: episode.data.evidence,
    }));
}

function combinedEvidencePartition(forecastEvidence, pendingEvidence) {
  return {
    core: [...forecastEvidence.core, ...pendingEvidence.core],
    experience: [
      ...forecastEvidence.experience,
      ...pendingEvidence.experience,
    ],
    competition: [
      ...forecastEvidence.competition,
      ...pendingEvidence.competition,
    ],
    other_context: [
      ...forecastEvidence.other_context,
      ...pendingEvidence.other_context,
    ],
    community: [
      ...forecastEvidence.community,
      ...pendingEvidence.community,
    ],
    items: sortEvidenceItems([
      ...forecastEvidence.items,
      ...pendingEvidence.items,
    ]),
  };
}

export async function buildRecentEvidenceProjection(
  store,
  config,
  { prediction = null, at = new Date() } = {},
) {
  const [signals, observations, impactEpisodes] = await Promise.all([
    store.all("normalized_signal", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    config.impact_tracking?.enabled === true
      ? store.all("impact_episode")
      : Promise.resolve([]),
  ]);
  const observationsByRef = new Map(
    observations.map((item) => [exactRecordKey(item), item]),
  );
  const expectedExtractor = extractorContract(config);
  const currentExtractorSignals = signals.filter((signal) =>
    matchesExtractorContract(signal, expectedExtractor)
  );
  const timeline = confirmationTimeline(
    observations,
    currentExtractorSignals,
    config,
  );
  const impactEpisodeContractHash = hashLabel(impactEpisodeContract(config));
  const currentImpactEpisodes = latestImpactEpisodes(
    impactEpisodes,
    config.impact_tracking,
    impactEpisodeContractHash,
  );
  const latestImpactAsOf = currentImpactEpisodes
    .map((episode) => episode.as_of)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const materializedAt = at instanceof Date ? new Date(at) : new Date(at);
  if (!Number.isFinite(materializedAt.getTime())) {
    throw new TypeError("Invalid evidence projection time");
  }
  const knowledgeCutoff = prediction?.data.knowledge_cutoff ??
    materializedAt.toISOString();
  const cutoffMs = Date.parse(knowledgeCutoff);
  const current = sortEvidenceForDisplay(uniqueEvidenceRoots(
    selectCurrentRelevantSignals(
      currentExtractorSignals.filter((signal) =>
        Date.parse(signal.data.available_at) <= cutoffMs &&
        Date.parse(signal.created_at) <= cutoffMs
      ),
    ),
  ), observationsByRef);
  const pending = sortEvidenceForDisplay(uniqueEvidenceRoots(
    selectCurrentRelevantSignals(currentExtractorSignals)
      .filter((signal) =>
        Date.parse(signal.data.available_at) > cutoffMs ||
        Date.parse(signal.created_at) > cutoffMs
      ),
  ), observationsByRef);
  const withTier = (items) => items.map((signal) => {
    const observation = observationsByRef.get(
      exactRecordKey(signal.data.observation_refs[0]),
    );
    return {
      signal,
      tier: evidenceTierForSignal(signal, observation, config),
    };
  });
  const toItem = (signal, pendingNextForecast = false) => {
    const observation = observationsByRef.get(
      exactRecordKey(signal.data.observation_refs[0]),
    );
    const forecastFeatureEligible =
      signal.data.provenance.feature_eligible !== false;
    return {
      signal_ref: { record_id: signal.record_id, revision: signal.revision },
      available_at: signal.data.available_at,
      created_at: signal.created_at,
      known_at_forecast_cutoff: !pendingNextForecast,
      included_in_forecast: !pendingNextForecast && forecastFeatureEligible,
      pending_next_forecast: pendingNextForecast,
      event_type: signal.data.claim.event_type,
      phase: signal.data.claim.phase,
      scope: signal.data.claim.scope,
      impact: signal.data.claim.impact ?? null,
      competitive_context: signal.data.claim.competitive_context ?? null,
      category: evidenceTierForSignal(signal, observation, config),
      forecast_feature_eligible: forecastFeatureEligible,
      source_role: signal.data.provenance.source_role,
      source_identity_id: signal.data.provenance.source_identity_id,
      derivation: signal.data.provenance.derivation,
      independence_group_id: signal.data.provenance.independence_group_id,
      source: observation ? {
        canonical_url: observation.data.canonical_url,
        display_handle: observation.data.author.display_handle,
        text: observation.data.content.text,
        published_at: observationPublishedAt(observation),
        first_seen_at: observation.data.first_seen_at,
        ingest_provider: observation.data.ingest_provider,
      } : null,
    };
  };
  const partition = (tiered, pendingNextForecast) => {
    const byTier = (tier) => tiered.filter((item) => item.tier === tier)
      .map((item) => item.signal)
      .slice(0, 6)
      .map((signal) => toItem(signal, pendingNextForecast));
    const core = byTier("core");
    const experience = byTier("experience");
    const competition = byTier("competition");
    const otherContext = byTier("other_context");
    const communityCompatibility = [
      ...experience,
      ...competition,
      ...otherContext,
    ];
    return {
      core,
      experience,
      competition,
      other_context: otherContext,
      community: communityCompatibility,
      items: sortEvidenceItems([...core, ...communityCompatibility]),
    };
  };
  const forecast = partition(withTier(current), false);
  const pendingNextForecast = partition(withTier(pending), true);
  return {
    knowledge_cutoff: knowledgeCutoff,
    aligned_to_latest_prediction: Boolean(prediction),
    forecast,
    pending_next_forecast: pendingNextForecast,
    all: combinedEvidencePartition(forecast, pendingNextForecast),
    timeline,
    impact_episodes: currentImpactEpisodes,
    impact_tracking: {
      enabled: config.impact_tracking?.enabled === true,
      policy_version: config.impact_tracking?.version ?? null,
      contract_hash: impactEpisodeContractHash,
      latest_episode_as_of: latestImpactAsOf,
      episode_count: currentImpactEpisodes.length,
    },
  };
}

function evidenceResponseForView(projection, view = "forecast") {
  const selected = view === "pending_next_forecast"
    ? projection.pending_next_forecast
    : view === "all"
      ? projection.all
      : projection.forecast;
  return {
    knowledge_cutoff: projection.knowledge_cutoff,
    aligned_to_latest_prediction: projection.aligned_to_latest_prediction,
    view,
    ...selected,
    timeline: projection.timeline,
    impact_episodes: projection.impact_episodes,
    impact_tracking: projection.impact_tracking,
    post_cutoff: projection.pending_next_forecast,
    pending_next_forecast: projection.pending_next_forecast,
  };
}

export async function materializeServingSnapshot(
  store,
  config,
  { materializedAt = new Date(), persist = true } = {},
) {
  const snapshotTime = materializedAt instanceof Date
    ? new Date(materializedAt)
    : new Date(materializedAt);
  if (!Number.isFinite(snapshotTime.getTime())) {
    throw new TypeError("Invalid serving snapshot time");
  }
  const snapshotConfig = servingSnapshotConfig(config);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [beforePrediction, beforeRuntime] = await Promise.all([
      latestPrediction(store),
      store.readState("runtime", {}),
    ]);
    const [readiness, evaluationResult, historyResults, evidenceProjection] =
      await Promise.all([
        getReadiness(store, config, { now: snapshotTime }),
        currentEvaluation(store, config),
        loadConfirmedHistoryResults(store, config),
        buildRecentEvidenceProjection(store, config, {
          prediction: beforePrediction,
          at: snapshotTime,
        }),
      ]);
    const evaluationEventViews = await buildEvaluationEventViews(
      store,
      config,
      evaluationResult,
    );
    const [prediction, runtimeState] = await Promise.all([
      latestPrediction(store),
      store.readState("runtime", {}),
    ]);
    const stablePrediction = samePredictionReference(
      predictionReference(beforePrediction),
      predictionReference(prediction),
    ) && (beforePrediction ? hashLabel(beforePrediction) : null) ===
      (prediction ? hashLabel(prediction) : null);
    const stableRuntime = runtimeWatermark(beforeRuntime).state_hash ===
      runtimeWatermark(runtimeState).state_hash;
    if (!stablePrediction || !stableRuntime) continue;
    const snapshot = {
      schema_version: SERVING_SNAPSHOT_SCHEMA_VERSION,
      config_hash: snapshotConfig.config_hash,
      serving_config_hash: snapshotConfig.serving_config_hash,
      config: snapshotConfig,
      materialized_at: snapshotTime.toISOString(),
      runtime_watermark: runtimeWatermark(runtimeState),
      prediction_ref: predictionReference(prediction),
      prediction_hash: prediction ? hashLabel(prediction) : null,
      prediction,
      readiness,
      evaluation_result: evaluationResult,
      evaluation_event_views: evaluationEventViews,
      history_results: historyResults,
      evidence_projection: evidenceProjection,
    };
    if (persist && typeof store.writeState === "function") {
      await store.writeState(SERVING_SNAPSHOT_STATE_KEY, snapshot);
    }
    return snapshot;
  }
  throw new Error("Serving snapshot inputs changed while materializing");
}

async function serveStatic(response, pathname) {
  const relative = STATIC_ROUTE_FILES.get(pathname) ?? pathname.replace(/^\//, "");
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`)) return false;
  try {
    const content = await fs.readFile(target);
    const extension = path.extname(target);
    const mustRevalidate = [
      ".html",
      ".js",
      ".css",
      ".xml",
      ".txt",
      ".webmanifest",
    ].includes(extension);
    const headers = {
      "content-type": MIME_TYPES.get(extension) ?? "application/octet-stream",
      "cache-control": mustRevalidate ? "no-cache" : "public, max-age=300",
    };
    if (extension === ".html") {
      headers["content-language"] = relative.startsWith("en/") ? "en" : "zh-CN";
    }
    response.writeHead(200, headers);
    response.end(content);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function createRequestHandler({
  store,
  config,
  now = () => new Date(),
  publicationLedger = null,
  forecastInputStream = null,
  webPushService = null,
  trafficMonitor = null,
  operationsService = null,
  probabilityProfileProvider = null,
  servingSnapshotProvider = null,
}) {
  if (
    probabilityProfileProvider !== null &&
    typeof probabilityProfileProvider?.get !== "function"
  ) {
    throw new TypeError("probabilityProfileProvider must expose get(horizonHours)");
  }
  if (
    servingSnapshotProvider !== null &&
    typeof servingSnapshotProvider?.get !== "function"
  ) {
    throw new TypeError("servingSnapshotProvider must expose get()");
  }
  const externalServingSnapshot = servingSnapshotProvider !== null;
  const publicHttpsUrl = configuredPublicHttpsUrl(config);
  const notifications = publicationLedger ?? (
    typeof store?.allAudit === "function" &&
      typeof store?.appendAudit === "function"
      ? createPublicationLedger(store)
      : {
          all: async () => [],
          getCursor: async () => 0,
          listAfter: async (cursor = 0, { limit = 100 } = {}) => {
            const numericCursor = Number(cursor);
            if (
              numericCursor !== 0 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 500
            ) {
              throw new TypeError("Invalid empty publication ledger page");
            }
            return {
              events: [],
              cursor: 0,
              next_cursor: "0",
              has_more: false,
            };
          },
        }
  );
  const evaluationFor = timedSingleFlight(
    () => currentEvaluation(store, config),
    0,
  );
  const historyResultsFor = timedSingleFlight(
    () => loadConfirmedHistoryResults(store, config),
    HISTORY_RESULTS_CACHE_MS,
  );
  const probabilityProfileFor = probabilityProfileProvider === null
    ? async () => {
        const error = new Error("Probability calibration provider is unavailable");
        error.code = "probability_profile_provider_unavailable";
        throw error;
      }
    : (horizonHours) => probabilityProfileProvider.get(horizonHours, {
        waitForWarm: false,
      });
  let servingSnapshotInFlight = null;

  async function readServingSnapshot() {
    return externalServingSnapshot
      ? servingSnapshotProvider.get()
      : store.readState(SERVING_SNAPSHOT_STATE_KEY, null);
  }

  async function refreshServingSnapshot(refreshNow = now()) {
    const materializedAt = refreshNow instanceof Date
      ? new Date(refreshNow)
      : new Date(refreshNow);
    if (!Number.isFinite(materializedAt.getTime())) {
      throw new TypeError("Invalid serving snapshot time");
    }
    if (externalServingSnapshot) {
      if (typeof servingSnapshotProvider.refresh === "function") {
        return servingSnapshotProvider.refresh(materializedAt);
      }
      const snapshot = await readServingSnapshot();
      if (isServingSnapshotUsable(snapshot, { config })) return snapshot;
      const error = new Error("Serving snapshot is not available yet");
      error.code = "serving_snapshot_unavailable";
      throw error;
    }
    if (!servingSnapshotInFlight) {
      const [persisted, runtimeState] = await Promise.all([
        readServingSnapshot(),
        store.readState("runtime", {}),
      ]);
      if (isServingSnapshotCurrent(persisted, {
        config,
        runtimeState,
        requestNow: materializedAt,
      })) return persisted;
    }
    if (servingSnapshotInFlight) {
      const snapshot = await servingSnapshotInFlight;
      const runtimeState = await store.readState("runtime", {});
      if (isServingSnapshotCurrent(snapshot, {
        config,
        runtimeState,
        requestNow: materializedAt,
      })) return snapshot;
    }
    if (servingSnapshotInFlight) return servingSnapshotInFlight;
    servingSnapshotInFlight = materializeServingSnapshot(store, config, {
      materializedAt,
      persist: true,
    })
      .finally(() => {
        servingSnapshotInFlight = null;
      });
    return servingSnapshotInFlight;
  }

  async function servingSnapshotFor(requestNow) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [snapshot, runtimeState] = await Promise.all([
        readServingSnapshot(),
        store.readState("runtime", {}),
      ]);
      const current = isServingSnapshotCurrent(snapshot, {
        config,
        runtimeState,
        requestNow,
      });
      if (
        current ||
        (externalServingSnapshot && isServingSnapshotUsable(snapshot, { config }))
      ) {
        return {
          snapshot,
          prediction: snapshot.prediction,
          runtimeState,
          snapshotCurrent: current,
        };
      }
      if (externalServingSnapshot) break;
      await refreshServingSnapshot(requestNow);
    }
    const error = new Error("Unable to obtain a usable serving snapshot");
    error.code = "serving_snapshot_unavailable";
    throw error;
  }

  async function dynamicServingProjection(requestNow) {
    const [{
      snapshot,
      prediction,
      runtimeState,
      snapshotCurrent,
    }, providerFreshness] =
      await Promise.all([
        servingSnapshotFor(requestNow),
        getProviderFreshness(store, config, requestNow),
      ]);
    const readiness = projectDynamicReadiness({
      readiness: snapshot.readiness,
      prediction,
      providerFreshness,
      runtimeState,
      config,
      requestNow,
    });
    return {
      snapshot,
      snapshotCurrent,
      prediction,
      runtimeState,
      evaluationResult: snapshot.evaluation_result,
      readiness: {
        ...readiness,
        serving_snapshot: {
          status: snapshotCurrent ? "current" : "last_good",
          materialized_at: snapshot.materialized_at,
          runtime_watermark: snapshot.runtime_watermark,
        },
      },
    };
  }

  async function servingWarmupFor(requestNow) {
    if (!externalServingSnapshot && !servingSnapshotInFlight) return null;
    const [snapshot, runtimeState, providerFreshness] = await Promise.all([
      readServingSnapshot(),
      store.readState("runtime", {}),
      getProviderFreshness(store, config, requestNow),
    ]);
    if (externalServingSnapshot) {
      if (isServingSnapshotUsable(snapshot, { config })) return null;
    } else if (isServingSnapshotCurrent(snapshot, {
      config,
      runtimeState,
      requestNow,
    })) {
      return null;
    }
    return { runtimeState, providerFreshness };
  }

  const requestHandler = async function requestHandler(request, response) {
    try {
      trafficMonitor?.observe?.(request, response);
    } catch {
      // Operations telemetry must never make the model/UI request path fail.
    }
    securityHeaders(response);
    try {
      const url = new URL(request.url, "http://localhost");
      const httpsRedirect = publicHttpsRedirectLocation(
        request,
        url,
        publicHttpsUrl,
      );
      if (httpsRedirect) {
        response.writeHead(308, {
          location: httpsRedirect,
          "cache-control": "public, max-age=3600",
        });
        response.end();
        return;
      }
      if (url.pathname === "/api/live") {
        if (!["GET", "HEAD"].includes(request.method)) {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if ([
        "/api/operations/traffic",
        "/api/operations/traffic/alerts",
      ].includes(url.pathname)) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (!operationsService?.authorize?.(request)) {
          sendJson(response, 401, { error: "operations_unauthorized" });
          return;
        }
        if (!trafficMonitor) {
          sendSemanticUnavailable(response, { error: "traffic_monitor_disabled" });
          return;
        }
        if (url.pathname === "/api/operations/traffic") {
          sendJson(response, 200, trafficMonitor.summary({ at: now() }));
          return;
        }
        try {
          const after = url.searchParams.has("after")
            ? url.searchParams.get("after")
            : null;
          if (after === "") throw new TypeError("empty cursor");
          const limit = url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : 100;
          sendJson(response, 200, trafficMonitor.listAlerts(after, { limit }));
        } catch (error) {
          if (error?.code === "operations_alert_cursor_reset_required") {
            sendJson(response, 409, {
              error: error.code,
              reason: error.reason,
              cursor: error.cursor,
              next_cursor: String(error.cursor),
              has_more: false,
            });
            return;
          }
          sendJson(response, 400, { error: "invalid_operations_alert_cursor" });
        }
        return;
      }
      if (
        url.pathname === "/api/web-push/subscriptions" &&
        ["POST", "DELETE"].includes(request.method)
      ) {
        if (!webPushService) {
          sendSemanticUnavailable(response, { error: "web_push_disabled" });
          return;
        }
        if (
          request.headers["sec-fetch-site"] &&
          request.headers["sec-fetch-site"] !== "same-origin"
        ) {
          sendJson(response, 403, { error: "origin_not_allowed" });
          return;
        }
        try {
          const payload = await readJsonBody(request);
          const context = { origin: request.headers.origin };
          const result = request.method === "POST"
            ? await webPushService.subscribe(payload, context)
            : await webPushService.unsubscribe(payload, context);
          sendJson(response, request.method === "POST" ? 201 : 200, result);
        } catch (error) {
          const status = webPushErrorStatus(error);
          if (status === 503 && error.code === "web_push_disabled") {
            response.forecasterSemanticUnavailable = true;
          }
          sendJson(response, status, {
            error: error.code ?? "internal_error",
            message: error.message,
          });
        }
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (url.pathname === "/api/web-push/config") {
        sendJson(response, 200, webPushService?.getPublicConfig() ?? {
          enabled: false,
          application_server_key: null,
          default_topics: ["authority", "outcome"],
          optional_topics: ["experimental_probability"],
        });
        return;
      }
      if (url.pathname === "/api/notification-preferences/baseline") {
        if ([...url.searchParams.keys()].length > 0) {
          sendJson(response, 400, {
            error: "invalid_probability_feed_baseline_request",
            message: "The probability feed baseline endpoint takes no parameters",
          });
          return;
        }
        try {
          const cursor = typeof forecastInputStream?.getCursor === "function"
            ? await forecastInputStream.getCursor()
            : (await forecastInputStream?.tail?.())?.cursor;
          if (!Number.isSafeInteger(cursor) || cursor < 0) {
            throw new TypeError("Personalized forecast input stream is unavailable");
          }
          sendJson(response, 200, {
            schema_version: "notification-feed-baseline/1",
            cursor,
            next_cursor: String(cursor),
          });
        } catch (error) {
          sendSemanticUnavailable(response, {
            error: "probability_feed_baseline_unavailable",
            message: error.message,
          });
        }
        return;
      }
      if (url.pathname === "/api/notification-preferences/calibration") {
        try {
          if (
            !url.searchParams.has("horizon_hours") ||
            url.searchParams.getAll("horizon_hours").length !== 1 ||
            url.searchParams.getAll("view").length > 1 ||
            [...url.searchParams.keys()].some((key) =>
              !["horizon_hours", "view"].includes(key)
            )
          ) {
            throw new RangeError("horizon_hours is required");
          }
          const view = url.searchParams.get("view");
          if (view !== null && view !== "compact") {
            throw new RangeError("view must be compact when provided");
          }
          const horizonHours = parseProbabilityProfileHorizon(
            url.searchParams.get("horizon_hours"),
          );
          const profile = await probabilityProfileFor(horizonHours);
          sendCacheableJson(
            request,
            response,
            view === "compact"
              ? projectNotificationCalibration(profile)
              : profile,
          );
        } catch (error) {
          if (error instanceof RangeError) {
            sendJson(response, 400, {
              error: "invalid_notification_horizon",
              message: error.message,
            });
            return;
          }
          const warming = error?.code === "probability_profile_warming";
          if (warming) {
            response.setHeader("retry-after", "5");
          }
          sendSemanticUnavailable(response, {
            error: warming
              ? "notification_calibration_warming"
              : "notification_calibration_unavailable",
            message: warming
              ? "历史可靠度正在后台预热，请几秒后重试。"
              : error.message,
          });
        }
        return;
      }
      if (url.pathname === "/api/notifications/forecast-inputs") {
        if (
          typeof forecastInputStream?.tail !== "function" ||
          typeof forecastInputStream?.listAfter !== "function"
        ) {
          sendSemanticUnavailable(response, {
            error: "notification_forecast_inputs_unavailable",
            message: "Personalized forecast input stream is unavailable",
          });
          return;
        }
        let horizonHours = null;
        try {
          if ([...url.searchParams.keys()].some((key) =>
            !["after", "limit", "horizon_hours"].includes(key)
          ) || ["after", "limit"].some((key) =>
            url.searchParams.getAll(key).length > 1
          )) {
            throw new TypeError("Unsupported forecast input query parameter");
          }
          horizonHours = requestedForecastInputHorizons(url.searchParams);
          if (!url.searchParams.has("after")) {
            if (url.searchParams.has("limit")) {
              throw new TypeError("Forecast input limit requires an after cursor");
            }
            const tail = await forecastInputStream.tail();
            sendJson(response, 200, {
              inputs: [],
              cursor: tail.cursor,
              next_cursor: String(tail.cursor),
              has_more: false,
              outcome_revision_gate: tail.outcome_revision_gate,
              ...(horizonHours === null
                ? {}
                : { horizon_hours: horizonHours }),
            });
            return;
          }
          const rawAfter = url.searchParams.get("after");
          if (!/^(?:0|[1-9][0-9]*)$/.test(rawAfter ?? "")) {
            throw new TypeError("Forecast input cursor must be an explicit integer");
          }
          const rawLimit = url.searchParams.get("limit") ?? "100";
          if (!/^[1-9][0-9]*$/.test(rawLimit)) {
            throw new TypeError("Forecast input limit must be an explicit positive integer");
          }
          const limit = Number(rawLimit);
          const page = await forecastInputStream.listAfter(Number(rawAfter), {
            limit,
          });
          sendJson(response, 200, projectForecastInputPage(page, horizonHours));
        } catch (error) {
          if (error?.code === "forecast_input_cursor_reset_required") {
            const outcomeRevisionGate =
              typeof forecastInputStream.currentOutcomeRevisionGate === "function"
                ? await forecastInputStream.currentOutcomeRevisionGate()
                : null;
            sendJson(response, 409, {
              error: error.code,
              reason: error.reason,
              cursor: error.cursor,
              next_cursor: String(error.cursor),
              has_more: false,
              outcome_revision_gate: outcomeRevisionGate,
              ...(horizonHours === null
                ? {}
                : { horizon_hours: horizonHours }),
            });
            return;
          }
          sendJson(response, 400, {
            error: "invalid_forecast_input_cursor",
            message: error.message,
          });
        }
        return;
      }
      if (url.pathname === "/api/notifications/events") {
        try {
          if (!url.searchParams.has("after")) {
            const cursor = await notifications.getCursor();
            sendJson(response, 200, {
              events: [],
              cursor,
              next_cursor: String(cursor),
              has_more: false,
            });
            return;
          }
          const rawAfter = url.searchParams.get("after");
          if (!/^(?:0|[1-9][0-9]*)$/.test(rawAfter ?? "")) {
            throw new TypeError("Publication cursor must be an explicit integer");
          }
          const after = Number(rawAfter);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const page = await notifications.listAfter(after, { limit });
          sendJson(response, 200, page);
        } catch (error) {
          sendJson(response, 400, {
            error: "invalid_notification_cursor",
            message: error.message,
          });
        }
        return;
      }
      if (["/feed.xml", "/feeds/experimental.xml"].includes(url.pathname)) {
        const feed = renderPublicationAtom(await notifications.all(), {
          publicBaseUrl: config.runtime.public_base_url,
          includeExperimental: url.pathname === "/feeds/experimental.xml",
          now: now(),
        });
        sendAtom(request, response, feed);
        return;
      }
      if (url.pathname === "/feeds/probability.xml") {
        let preferences;
        let baselineSequence;
        try {
          if (
            !url.searchParams.has("horizon_hours") ||
            !url.searchParams.has("probability_threshold") ||
            !url.searchParams.has("after") ||
            [...url.searchParams.keys()].some((key) =>
              !["horizon_hours", "probability_threshold", "after"].includes(key)
            ) ||
            ["horizon_hours", "probability_threshold", "after"].some(
              (key) => url.searchParams.getAll(key).length !== 1
            )
          ) {
            throw new TypeError("All three probability feed parameters are required exactly once");
          }
          preferences = normalizedNotificationPreferences({
            schema_version: "notification-preferences/1",
            horizon_hours: parseProbabilityProfileHorizon(
              url.searchParams.get("horizon_hours"),
            ),
            probability_threshold: (() => {
              const raw = url.searchParams.get("probability_threshold") ?? "";
              if (!/^0\.[0-9]+$/.test(raw)) {
                throw new TypeError(
                  "probability_threshold must be an explicit decimal from 0.01 through 0.99",
                );
              }
              return Number(raw);
            })(),
          });
          const rawAfter = url.searchParams.get("after") ?? "";
          if (!/^(?:0|[1-9][0-9]*)$/.test(rawAfter)) {
            throw new TypeError("after must be an explicit non-negative integer");
          }
          baselineSequence = Number(rawAfter);
        } catch (error) {
          sendJson(response, 400, {
            error: "invalid_probability_feed_preferences",
            message: error.message,
          });
          return;
        }
        if (typeof forecastInputStream?.all !== "function") {
          sendSemanticUnavailable(response, {
            error: "probability_feed_unavailable",
            message: "Personalized forecast input stream is unavailable",
          });
          return;
        }
        try {
          const [inputs, outcomeRevisionGate] = await Promise.all([
            forecastInputStream.all(),
            typeof forecastInputStream.currentOutcomeRevisionGate === "function"
              ? forecastInputStream.currentOutcomeRevisionGate()
              : Promise.resolve({
                  revision_token: null,
                  latest_known_at: null,
                  closes_episode: false,
                  current_outcomes: [],
                }),
          ]);
          sendAtom(request, response, renderProbabilityAtom(inputs, preferences, {
            publicBaseUrl: config.runtime.public_base_url,
            now: now(),
            baselineSequence,
            outcomeRevisionGate,
          }));
        } catch (error) {
          if (error?.code === "probability_feed_baseline_ahead") {
            sendJson(response, 409, {
              error: error.code,
              cursor: error.cursor,
              next_cursor: String(error.cursor),
            });
            return;
          }
          sendSemanticUnavailable(response, {
            error: "probability_feed_unavailable",
            message: error.message,
          });
        }
        return;
      }
      if (url.pathname.startsWith("/api/forecast/snapshots/")) {
        const reference = forecastSnapshotPath(url.pathname);
        if (!reference) {
          sendJson(response, 404, { error: "forecast_snapshot_not_found" });
          return;
        }
        const prediction = exactPrediction(
          await readServingSnapshot(),
          reference.recordId,
          reference.revision,
        );
        if (!prediction) {
          sendJson(response, 404, { error: "forecast_snapshot_not_found" });
          return;
        }
        const etag = `"${hashLabel(prediction).slice("sha256:".length)}"`;
        sendImmutableJson(request, response, prediction, etag);
        return;
      }
      if (url.pathname === "/api/health") {
        const requestNow = now();
        const warmup = await servingWarmupFor(requestNow);
        if (warmup) {
          const states = Object.values(warmup.providerFreshness.providers);
          sendSemanticUnavailable(response, {
            status: "warming",
            error: "forecast_warming",
            message: "Forecast serving snapshot is warming.",
            effective_stale: true,
            now: requestNow.toISOString(),
            forecast_issued_at: null,
            knowledge_cutoff: null,
            current_prediction_ref: null,
            display_available: false,
            display_snapshot_status: "warming",
            display_snapshot_materialized_at: null,
            forecast: null,
            provider_last_success_at: latestProviderSuccess(...states),
            provider_last_error: latestProviderError(...states),
            providers: warmup.providerFreshness.providers,
            provider_freshness: warmup.providerFreshness.groups,
            pipeline_last_success_at:
              warmup.runtimeState.last_success_at ?? null,
            pipeline_last_failure_at:
              warmup.runtimeState.last_failure_at ?? null,
            pipeline_last_error: warmup.runtimeState.last_error ?? null,
            pipeline_status: "warming",
            coverage_waiting: null,
            evaluation_waiting: null,
            serving_ready: false,
            serving_stage: "blocked",
            serving_blockers: ["serving_snapshot_warming"],
            synthetic_only: false,
            publication_ready: false,
            publication_blockers: ["serving_snapshot_warming"],
          });
          return;
        }
        const {
          snapshot,
          snapshotCurrent,
          prediction,
          runtimeState,
          evaluationResult,
          readiness,
        } = await dynamicServingProjection(requestNow);
        const providers = readiness.provider_freshness.providers;
        const states = Object.values(providers);
        const forecastStatus = readiness.current_forecast.status;
        const contextStatus = readiness.provider_freshness.groups.context.status;
        const optionalContextDegraded = !["fresh", "disabled"].includes(contextStatus);
        const waitingForPipeline = [
          "waiting_for_coverage",
          "waiting_for_evaluation",
        ].includes(readiness.pipeline_status);
        const syntheticDemo = Boolean(
          readiness.synthetic_only &&
          readiness.forecast_available,
        );
        const status = waitingForPipeline && !prediction
          ? "waiting"
          : !prediction
            ? "not_ready"
          : ["stale", "invalid"].includes(forecastStatus)
            ? "stale"
            : !readiness.serving_ready && !syntheticDemo
              ? "not_ready"
            : readiness.publication_ready && !optionalContextDegraded
              ? "ok"
              : "degraded";
        if (["not_ready", "stale", "waiting"].includes(status)) {
          response.forecasterSemanticUnavailable = true;
        }
        sendJson(response, ["not_ready", "stale", "waiting"].includes(status) ? 503 : 200, {
          status,
          effective_stale: status !== "ok",
          now: requestNow.toISOString(),
          forecast_issued_at: prediction?.data.issued_at ?? null,
          knowledge_cutoff: prediction?.data.knowledge_cutoff ?? null,
          current_prediction_ref: prediction ? {
            record_id: prediction.record_id,
            revision: prediction.revision,
            issued_at: prediction.data.issued_at,
            knowledge_cutoff: prediction.data.knowledge_cutoff,
            snapshot_url:
              `/api/forecast/snapshots/${encodeURIComponent(prediction.record_id)}/${prediction.revision}`,
          } : null,
          display_available: Boolean(prediction),
          display_snapshot_status: snapshotCurrent ? "current" : "last_good",
          display_snapshot_materialized_at: snapshot.materialized_at,
          forecast: readiness.current_forecast,
          provider_last_success_at: latestProviderSuccess(...states),
          provider_last_error: latestProviderError(...states),
          providers,
          provider_freshness: readiness.provider_freshness.groups,
          pipeline_last_success_at: runtimeState.last_success_at ?? null,
          pipeline_last_failure_at: runtimeState.last_failure_at ?? null,
          pipeline_last_error: runtimeState.last_error ?? null,
          pipeline_status: readiness.pipeline_status,
          coverage_waiting: readiness.coverage_waiting,
          evaluation_waiting: readiness.evaluation_waiting,
          promotion_guard: readiness.promotion_guard,
          evaluation_gate_passed: evaluationResult.evaluation?.gate?.passed ?? false,
          evaluation_invalidated: evaluationResult.invalidated,
          serving_ready: readiness.serving_ready,
          serving_stage: readiness.serving_stage,
          serving_blockers: readiness.serving_blockers,
          provisional_model: readiness.provisional_model,
          synthetic_only: readiness.synthetic_only,
          publication_ready: readiness.publication_ready,
          publication_blockers: readiness.publication_blockers,
        });
        return;
      }
      if (url.pathname === "/api/forecast/current") {
        const requestNow = now();
        const { prediction, readiness } = await dynamicServingProjection(
          requestNow,
        );
        if (!prediction) {
          sendSemanticUnavailable(response, {
            error: "forecast_not_ready",
            message: readiness.coverage_waiting
              ? "Outcome coverage candidates are still completing their stability observation."
              : readiness.evaluation_waiting
                ? "The model is waiting for enough causal walk-forward evaluation data."
                : "No promoted model forecast has been issued yet.",
            pipeline_status: readiness.pipeline_status,
            coverage_waiting: readiness.coverage_waiting,
            evaluation_waiting: readiness.evaluation_waiting,
            publication_blockers: readiness.publication_blockers,
          });
          return;
        }
        const freshness = assessPredictionFreshness(prediction, config, requestNow);
        const incompatible = readiness.serving_blockers.some((blocker) =>
          [
            "active_model_unavailable",
            "forecast_integrity_failed",
            "forecast_validation_status_invalid",
            "forecast_validation_status_missing",
            "provisional_model_ineligible",
            "provisional_guard_rejected",
          ].includes(blocker)
        );
        const stale = ["stale", "invalid"].includes(freshness.status);
        const syntheticDemo = Boolean(
          readiness.synthetic_only &&
          readiness.forecast_available &&
          !stale &&
          !incompatible
        );
        const provisional = Boolean(
          readiness.serving_ready &&
          readiness.serving_stage === "provisional"
        );
        const unavailable =
          stale ||
          incompatible ||
          (!readiness.serving_ready && !syntheticDemo);
        const notServing = unavailable && !stale && !incompatible;
        const serving = {
          ...freshness,
          status: provisional
            ? "provisional"
            : syntheticDemo
              ? "synthetic_demo"
              : notServing
              ? "not_publishable"
              : freshness.status,
          ready: readiness.serving_ready || syntheticDemo,
          serving_ready: readiness.serving_ready || syntheticDemo,
          stage: provisional
            ? "provisional"
            : syntheticDemo
              ? "validated"
              : readiness.serving_stage,
          serving_stage: provisional
            ? "provisional"
            : syntheticDemo
              ? "validated"
              : readiness.serving_stage,
          blockers: readiness.serving_blockers,
          serving_blockers: readiness.serving_blockers,
          publication_ready: readiness.publication_ready,
          publication_blockers: readiness.publication_blockers,
          synthetic_demo: syntheticDemo,
          provisional_model: readiness.provisional_model,
        };
        if (unavailable) {
          sendSemanticUnavailable(response, {
            error: incompatible
              ? "forecast_incompatible"
              : stale
                ? "forecast_stale"
                : "forecast_not_publishable",
            message: incompatible
              ? "The latest saved forecast was produced by an incompatible model contract."
              : stale
                ? "The latest saved forecast is no longer a current rolling 168-hour forecast."
                : `Forecast serving is blocked: ${readiness.serving_blockers.join(", ")}.`,
            saved_prediction_ref: {
              record_id: prediction.record_id,
              revision: prediction.revision,
              issued_at: prediction.data.issued_at,
              knowledge_cutoff: prediction.data.knowledge_cutoff,
            },
            serving,
            pipeline_status: readiness.pipeline_status,
            coverage_waiting: readiness.coverage_waiting,
            evaluation_waiting: readiness.evaluation_waiting,
          });
          return;
        }
        sendJson(response, 200, {
          ...prediction,
          serving,
        });
        return;
      }
      if (url.pathname === "/api/readiness") {
        const { readiness } = await dynamicServingProjection(now());
        sendJson(response, 200, readiness);
        return;
      }
      if (url.pathname === "/api/history/results") {
        if (externalServingSnapshot) {
          const snapshot = await readServingSnapshot();
          if (Array.isArray(snapshot?.history_results)) {
            sendJson(response, 200, { results: snapshot.history_results });
            return;
          }
          response.setHeader("retry-after", "5");
          sendSemanticUnavailable(response, {
            error: "history_read_model_warming",
            message: "History read model is warming in the background.",
          });
          return;
        }
        sendJson(response, 200, { results: await historyResultsFor() });
        return;
      }
      if (url.pathname === "/api/evaluation/summary") {
        const result = externalServingSnapshot
          ? (await readServingSnapshot())?.evaluation_result ?? null
          : await evaluationFor();
        if (!result) {
          response.setHeader("retry-after", "5");
          sendSemanticUnavailable(response, {
            error: "evaluation_read_model_warming",
            message: "Evaluation read model is warming in the background.",
          });
          return;
        }
        const evaluation = result.evaluation;
        if (!evaluation) {
          sendSemanticUnavailable(response, {
            error: result.invalidated.length > 0
              ? "evaluation_invalidated"
              : "evaluation_not_ready",
            invalidated: result.invalidated,
          });
          return;
        }
        sendJson(response, 200, {
          ...evaluation,
          compatibility: result.compatibility,
          reporting_status: result.reporting_status,
          sample_gate: result.sample_gate,
          metric_availability: result.metric_availability,
          reporting_view: result.reporting_view,
          invalidated_fallbacks: result.invalidated,
          ranking_policy: {
            window_hours: 4,
            top_window_hours_per_week: config.model.promotion.top_window_hours_per_week,
            budget_scope: evaluation.mode === "as_issued"
              ? "shared_per_utc_week"
              : "shared_per_168h_fold",
            selection: "highest_probability_windows",
            recall_definition: "confirmed_event_overlaps_selected_window",
          },
        });
        return;
      }
      if (url.pathname === "/api/evaluation/events") {
        const reportingScope =
          url.searchParams.get("scope") === "reporting";
        let views = externalServingSnapshot
          ? (await readServingSnapshot())?.evaluation_event_views ?? null
          : null;
        if (!externalServingSnapshot) {
          views = await buildEvaluationEventViews(
            store,
            config,
            await evaluationFor(),
          );
        }
        if (!views) {
          response.setHeader("retry-after", "5");
          sendSemanticUnavailable(response, {
            error: "evaluation_events_read_model_warming",
            message: "Evaluation event read model is warming in the background.",
          });
          return;
        }
        sendJson(response, 200, {
          scope: reportingScope ? "reporting" : "all_history",
          events: reportingScope ? views.reporting : views.all_history,
        });
        return;
      }
      if (url.pathname === "/api/evidence/recent") {
        const requestedEvidenceView =
          url.searchParams.get("view") ?? "forecast";
        if (externalServingSnapshot) {
          const snapshot = await readServingSnapshot();
          if (snapshot?.evidence_projection) {
            sendJson(
              response,
              200,
              evidenceResponseForView(
                snapshot.evidence_projection,
                requestedEvidenceView,
              ),
            );
            return;
          }
          response.setHeader("retry-after", "5");
          sendSemanticUnavailable(response, {
            error: "evidence_read_model_warming",
            message: "Evidence read model is warming in the background.",
          });
          return;
        }
        const [signals, observations, prediction, impactEpisodes] = await Promise.all([
          store.all("normalized_signal", { latestOnly: false }),
          store.all("raw_observation", { latestOnly: false }),
          latestPrediction(store),
          config.impact_tracking?.enabled === true
            ? store.all("impact_episode")
            : Promise.resolve([]),
        ]);
        const observationsByRef = new Map(
          observations.map((item) => [exactRecordKey(item), item]),
        );
        const expectedExtractor = extractorContract(config);
        const currentExtractorSignals = signals.filter((signal) =>
          matchesExtractorContract(signal, expectedExtractor)
        );
        const timeline = confirmationTimeline(
          observations,
          currentExtractorSignals,
          config,
        );
        const impactEpisodeContractHash = hashLabel(
          impactEpisodeContract(config),
        );
        const currentImpactEpisodes = latestImpactEpisodes(
          impactEpisodes,
          config.impact_tracking,
          impactEpisodeContractHash,
        );
        const latestImpactAsOf = currentImpactEpisodes
          .map((episode) => episode.as_of)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;
        const knowledgeCutoff = prediction?.data.knowledge_cutoff ?? now().toISOString();
        const cutoffMs = Date.parse(knowledgeCutoff);
        const current = sortEvidenceForDisplay(uniqueEvidenceRoots(selectCurrentRelevantSignals(
          currentExtractorSignals.filter((signal) =>
            Date.parse(signal.data.available_at) <= cutoffMs &&
            Date.parse(signal.created_at) <= cutoffMs,
          ),
        )), observationsByRef);
        const pending = sortEvidenceForDisplay(uniqueEvidenceRoots(
          selectCurrentRelevantSignals(currentExtractorSignals)
            .filter((signal) =>
              Date.parse(signal.data.available_at) > cutoffMs ||
              Date.parse(signal.created_at) > cutoffMs,
            )
        ), observationsByRef);
        const withTier = (items) => items.map((signal) => {
          const observation = observationsByRef.get(
            exactRecordKey(signal.data.observation_refs[0]),
          );
          return {
            signal,
            tier: evidenceTierForSignal(signal, observation, config),
          };
        });
        const toItem = (signal, pendingNextForecast = false) => {
          const observation = observationsByRef.get(
            exactRecordKey(signal.data.observation_refs[0]),
          );
          const forecastFeatureEligible =
            signal.data.provenance.feature_eligible !== false;
          return {
            signal_ref: { record_id: signal.record_id, revision: signal.revision },
            available_at: signal.data.available_at,
            created_at: signal.created_at,
            known_at_forecast_cutoff: !pendingNextForecast,
            included_in_forecast:
              !pendingNextForecast && forecastFeatureEligible,
            pending_next_forecast: pendingNextForecast,
            event_type: signal.data.claim.event_type,
            phase: signal.data.claim.phase,
            scope: signal.data.claim.scope,
            impact: signal.data.claim.impact ?? null,
            competitive_context: signal.data.claim.competitive_context ?? null,
            category: evidenceTierForSignal(signal, observation, config),
            forecast_feature_eligible: forecastFeatureEligible,
            source_role: signal.data.provenance.source_role,
            source_identity_id: signal.data.provenance.source_identity_id,
            derivation: signal.data.provenance.derivation,
            independence_group_id: signal.data.provenance.independence_group_id,
            source: observation ? {
              canonical_url: observation.data.canonical_url,
              display_handle: observation.data.author.display_handle,
              text: observation.data.content.text,
              published_at: observationPublishedAt(observation),
              first_seen_at: observation.data.first_seen_at,
              ingest_provider: observation.data.ingest_provider,
            } : null,
          };
        };
        const partition = (tiered, pendingNextForecast) => {
          const byTier = (tier) => tiered.filter((item) => item.tier === tier)
            .map((item) => item.signal)
            .slice(0, 6)
            .map((signal) => toItem(signal, pendingNextForecast));
          const core = byTier("core");
          const experience = byTier("experience");
          const competition = byTier("competition");
          const otherContext = byTier("other_context");
          const communityCompatibility = [
            ...experience,
            ...competition,
            ...otherContext,
          ];
          return {
            core,
            experience,
            competition,
            other_context: otherContext,
            community: communityCompatibility,
            items: sortEvidenceItems([...core, ...communityCompatibility]),
          };
        };
        const forecastEvidence = partition(withTier(current), false);
        const pendingEvidence = partition(withTier(pending), true);
        const view = url.searchParams.get("view") ?? "forecast";
        const selected = view === "pending_next_forecast"
          ? pendingEvidence
          : view === "all"
            ? {
                core: [...forecastEvidence.core, ...pendingEvidence.core],
                experience: [
                  ...forecastEvidence.experience,
                  ...pendingEvidence.experience,
                ],
                competition: [
                  ...forecastEvidence.competition,
                  ...pendingEvidence.competition,
                ],
                other_context: [
                  ...forecastEvidence.other_context,
                  ...pendingEvidence.other_context,
                ],
                community: [
                  ...forecastEvidence.community,
                  ...pendingEvidence.community,
                ],
                items: sortEvidenceItems([
                  ...forecastEvidence.items,
                  ...pendingEvidence.items,
                ]),
              }
            : forecastEvidence;
        sendJson(response, 200, {
          knowledge_cutoff: knowledgeCutoff,
          aligned_to_latest_prediction: Boolean(prediction),
          view,
          ...selected,
          timeline,
          impact_episodes: currentImpactEpisodes,
          impact_tracking: {
            enabled: config.impact_tracking?.enabled === true,
            policy_version: config.impact_tracking?.version ?? null,
            contract_hash: impactEpisodeContractHash,
            latest_episode_as_of: latestImpactAsOf,
            episode_count: currentImpactEpisodes.length,
          },
          post_cutoff: pendingEvidence,
          pending_next_forecast: pendingEvidence,
        });
        return;
      }
      const canonicalStaticPath = CANONICAL_STATIC_REDIRECTS.get(url.pathname);
      if (canonicalStaticPath) {
        response.writeHead(308, {
          location: `${canonicalStaticPath}${url.search}`,
          "cache-control": "public, max-age=3600",
        });
        response.end();
        return;
      }
      if (await serveStatic(response, url.pathname)) return;
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  };
  requestHandler.refreshServingSnapshot = refreshServingSnapshot;
  return requestHandler;
}
