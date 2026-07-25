import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../core/config.mjs";
import {
  assessPredictionFreshness,
  assessEvaluationCompatibility,
  getReadiness,
} from "../runtime/readiness.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import { verifiedCoverageAssertionRevisions } from "../pipeline/coverage.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import { verifyEvaluationArtifact } from "../model/evaluation.mjs";
import {
  verifyIssuedEvaluationArtifact,
} from "../model/issued-evaluation.mjs";

const PUBLIC_DIR = path.join(projectRoot, "public");
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json; charset=utf-8"],
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function securityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
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
      },
    );
    if (compatibility.compatible) {
      return {
        evaluation,
        compatibility,
        invalidated,
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

function providerStateKey(name) {
  return `${name.replaceAll("_", "-")}-provider`;
}

function exactRecordKey(recordOrRef) {
  return `${recordOrRef.record_id}@${recordOrRef.revision}`;
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
  return isCoreSignal(signal, observation, configuredConfirmationIdentityIds(config))
    ? "core"
    : "community";
}

function uniqueEvidenceRoots(signals) {
  const seen = new Set();
  return signals.filter((signal) => {
    const key = signal.data.provenance.independence_group_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/"
    ? "index.html"
    : pathname === "/accuracy"
      ? "accuracy.html"
      : pathname.replace(/^\//, "");
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`)) return false;
  try {
    const content = await fs.readFile(target);
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(target)) ?? "application/octet-stream",
      "cache-control": path.extname(target) === ".html" ? "no-cache" : "public, max-age=300",
    });
    response.end(content);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function createRequestHandler({ store, config, now = () => new Date() }) {
  return async function requestHandler(request, response) {
    securityHeaders(response);
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/health") {
        const providerEntries = Object.entries(config.providers ?? {})
          .filter(([, provider]) => provider && typeof provider === "object");
        const requestNow = now();
        const [prediction, providerStates, runtimeState, evaluationResult, readiness] = await Promise.all([
          latestPrediction(store),
          Promise.all(providerEntries.map(async ([name, provider]) => [
            name,
            provider,
            await store.readState(providerStateKey(name), {}),
          ])),
          store.readState("runtime", {}),
          currentEvaluation(store, config),
          getReadiness(store, config, { now: requestNow }),
        ]);
        const providers = readiness.provider_freshness.providers;
        const states = providerStates.map(([, , state]) => state);
        const forecastStatus = readiness.current_forecast.status;
        const contextStatus = readiness.provider_freshness.groups.context.status;
        const optionalContextDegraded = !["fresh", "disabled"].includes(contextStatus);
        const status = !prediction
          ? "not_ready"
          : ["stale", "invalid"].includes(forecastStatus)
            ? "stale"
            : readiness.publication_ready && !optionalContextDegraded
              ? "ok"
              : "degraded";
        sendJson(response, ["not_ready", "stale"].includes(status) ? 503 : 200, {
          status,
          effective_stale: status !== "ok",
          now: requestNow.toISOString(),
          forecast_issued_at: prediction?.data.issued_at ?? null,
          knowledge_cutoff: prediction?.data.knowledge_cutoff ?? null,
          forecast: readiness.current_forecast,
          provider_last_success_at: latestProviderSuccess(...states),
          provider_last_error: latestProviderError(...states),
          providers,
          provider_freshness: readiness.provider_freshness.groups,
          pipeline_last_success_at: runtimeState.last_success_at ?? null,
          pipeline_last_failure_at: runtimeState.last_failure_at ?? null,
          pipeline_last_error: runtimeState.last_error ?? null,
          evaluation_gate_passed: evaluationResult.evaluation?.gate?.passed ?? false,
          evaluation_invalidated: evaluationResult.invalidated,
          publication_ready: readiness.publication_ready,
          publication_blockers: readiness.publication_blockers,
        });
        return;
      }
      if (url.pathname === "/api/forecast/current") {
        const requestNow = now();
        const [prediction, readiness] = await Promise.all([
          latestPrediction(store),
          getReadiness(store, config, { now: requestNow }),
        ]);
        if (!prediction) {
          sendJson(response, 503, {
            error: "forecast_not_ready",
            message: "No promoted model forecast has been issued yet.",
          });
          return;
        }
        const freshness = assessPredictionFreshness(prediction, config, requestNow);
        const incompatible = readiness.publication_blockers.some((blocker) =>
          [
            "champion_missing",
            "champion_incompatible",
            "forecast_model_mismatch",
            "forecast_model_artifact_mismatch",
            "forecast_model_contract_mismatch",
            "champion_artifact_missing",
          ].includes(blocker)
        );
        const stale = ["stale", "invalid"].includes(freshness.status);
        const syntheticDemo = Boolean(
          readiness.synthetic_only &&
          readiness.forecast_available &&
          !stale &&
          !incompatible
        );
        const notPublishable = !readiness.publication_ready && !syntheticDemo;
        const unavailable = stale || incompatible || notPublishable;
        const serving = {
          ...freshness,
          status: syntheticDemo
            ? "synthetic_demo"
            : notPublishable && !stale && !incompatible
              ? "not_publishable"
              : freshness.status,
          publication_ready: readiness.publication_ready,
          publication_blockers: readiness.publication_blockers,
          synthetic_demo: syntheticDemo,
        };
        sendJson(response, unavailable ? 503 : 200, {
          ...prediction,
          serving,
          ...(unavailable ? {
            error: incompatible
              ? "forecast_incompatible"
              : stale
                ? "forecast_stale"
                : "forecast_not_publishable",
            message: incompatible
              ? "The latest saved forecast was produced by an incompatible model contract."
              : stale
                ? "The latest saved forecast is no longer a current rolling 168-hour forecast."
                : `Forecast publication is blocked: ${readiness.publication_blockers.join(", ")}.`,
          } : {}),
        });
        return;
      }
      if (url.pathname === "/api/readiness") {
        sendJson(response, 200, await getReadiness(store, config, { now: now() }));
        return;
      }
      if (url.pathname === "/api/evaluation/summary") {
        const result = await currentEvaluation(store, config);
        const evaluation = result.evaluation;
        if (!evaluation) {
          sendJson(response, 503, {
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
        const [outcomes, observations, signals, evaluationResult] = await Promise.all([
          store.all("reset_outcome", { latestOnly: false }),
          store.all("raw_observation", { latestOnly: false }),
          store.all("normalized_signal", { latestOnly: false }),
          currentEvaluation(store, config),
        ]);
        const evaluation = evaluationResult.evaluation;
        const observationByRef = new Map(
          observations.map((item) => [exactRecordKey(item), item]),
        );
        const outcomeByRef = new Map(outcomes.map((item) => [exactRecordKey(item), item]));
        const evaluationByRef = new Map(
          (evaluation?.events ?? []).map((item) => [exactRecordKey(item.outcome_ref), item]),
        );
        const referencedOutcomes = (evaluation?.events ?? [])
          .map((item) => outcomeByRef.get(exactRecordKey(item.outcome_ref)))
          .filter(Boolean);
        const outcomeEligibility = buildOutcomeEligibilityContext({
          observations,
          signals,
          config,
        });
        const latestConfirmed = [...Map.groupBy(outcomes, (item) => item.record_id).values()]
          .map((revisions) => [...revisions].sort((left, right) => left.revision - right.revision).at(-1))
          .filter((outcome) => isEligibleConfirmedOutcome(outcome, {
            ...outcomeEligibility,
            confirmationIdentityIds: configuredConfirmationIdentityIds(config),
          }));
        const selectedOutcomes = [
          ...new Map(
            [...referencedOutcomes, ...latestConfirmed]
              .map((outcome) => [exactRecordKey(outcome), outcome]),
          ).values(),
        ];
        const rows = selectedOutcomes
          .sort((left, right) => right.data.occurred_time_range.start.localeCompare(left.data.occurred_time_range.start))
          .map((outcome) => {
            const verificationRef = outcome.data.verification[0]?.observation_ref;
            const source = verificationRef
              ? observationByRef.get(exactRecordKey(verificationRef))
              : null;
            return {
              outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
              occurred_time_range: outcome.data.occurred_time_range,
              known_at: outcome.data.known_at,
              label_grade: outcome.data.label_grade,
              source: source ? {
                canonical_url: source.data.canonical_url,
                display_handle: source.data.author.display_handle,
                text: source.data.content.text,
                published_at: source.data.published_at,
              } : null,
              evaluation: evaluationByRef.get(exactRecordKey(outcome)) ?? null,
            };
          });
        sendJson(response, 200, { events: rows });
        return;
      }
      if (url.pathname === "/api/evidence/recent") {
        const [signals, observations, prediction] = await Promise.all([
          store.all("normalized_signal", { latestOnly: false }),
          store.all("raw_observation", { latestOnly: false }),
          latestPrediction(store),
        ]);
        const observationsByRef = new Map(
          observations.map((item) => [exactRecordKey(item), item]),
        );
        const knowledgeCutoff = prediction?.data.knowledge_cutoff ?? now().toISOString();
        const cutoffMs = Date.parse(knowledgeCutoff);
        const current = uniqueEvidenceRoots(selectCurrentSignals(
          signals.filter((signal) =>
            Date.parse(signal.data.available_at) <= cutoffMs &&
            Date.parse(signal.created_at) <= cutoffMs,
          ),
        )
          .sort((left, right) => right.data.available_at.localeCompare(left.data.available_at)));
        const pending = uniqueEvidenceRoots(
          selectCurrentSignals(signals)
            .filter((signal) =>
              Date.parse(signal.data.available_at) > cutoffMs ||
              Date.parse(signal.created_at) > cutoffMs,
            )
            .sort((left, right) => right.data.available_at.localeCompare(left.data.available_at)),
        );
        const withTier = (items) => items.map((signal) => {
          const observation = observationsByRef.get(
            exactRecordKey(signal.data.observation_refs[0]),
          );
          return {
            signal,
            core: evidenceTierForSignal(signal, observation, config) === "core",
          };
        });
        const toItem = (signal, pendingNextForecast = false) => {
          const observation = observationsByRef.get(
            exactRecordKey(signal.data.observation_refs[0]),
          );
          return {
            signal_ref: { record_id: signal.record_id, revision: signal.revision },
            available_at: signal.data.available_at,
            created_at: signal.created_at,
            included_in_forecast: !pendingNextForecast,
            pending_next_forecast: pendingNextForecast,
            event_type: signal.data.claim.event_type,
            phase: signal.data.claim.phase,
            scope: signal.data.claim.scope,
            source_role: signal.data.provenance.source_role,
            source_identity_id: signal.data.provenance.source_identity_id,
            derivation: signal.data.provenance.derivation,
            independence_group_id: signal.data.provenance.independence_group_id,
            source: observation ? {
              canonical_url: observation.data.canonical_url,
              display_handle: observation.data.author.display_handle,
              text: observation.data.content.text,
              published_at: observation.data.published_at,
            } : null,
          };
        };
        const partition = (tiered, pendingNextForecast) => {
          const core = tiered.filter((item) => item.core)
            .map((item) => item.signal)
            .slice(0, 6)
            .map((signal) => toItem(signal, pendingNextForecast));
          const community = tiered.filter((item) => !item.core)
            .map((item) => item.signal)
            .slice(0, 6)
            .map((signal) => toItem(signal, pendingNextForecast));
          return {
            core,
            community,
            items: [...core, ...community]
              .sort((left, right) => right.available_at.localeCompare(left.available_at)),
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
                community: [...forecastEvidence.community, ...pendingEvidence.community],
                items: [...forecastEvidence.items, ...pendingEvidence.items]
                  .sort((left, right) => right.available_at.localeCompare(left.available_at)),
              }
            : forecastEvidence;
        sendJson(response, 200, {
          knowledge_cutoff: knowledgeCutoff,
          aligned_to_latest_prediction: Boolean(prediction),
          view,
          ...selected,
          post_cutoff: pendingEvidence,
          pending_next_forecast: pendingEvidence,
        });
        return;
      }
      if (await serveStatic(response, url.pathname)) return;
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  };
}
