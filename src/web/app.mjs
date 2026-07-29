import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../core/config.mjs";
import {
  extractorContract,
  matchesExtractorContract,
} from "../core/extractor-contract.mjs";
import {
  assessPredictionFreshness,
  assessEvaluationCompatibility,
  getReadiness,
} from "../runtime/readiness.mjs";
import {
  selectCurrentRelevantSignals,
} from "../pipeline/signal-selection.mjs";
import { verifiedCoverageAssertionRevisions } from "../pipeline/coverage.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import { verifyEvaluationArtifact } from "../model/evaluation.mjs";
import {
  verifyIssuedEvaluationArtifact,
} from "../model/issued-evaluation.mjs";
import {
  timestampFromXSnowflake,
  xStatusIdentity,
} from "../providers/raw.mjs";

const PUBLIC_DIR = path.join(projectRoot, "public");
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json; charset=utf-8"],
]);
const API_COMPUTATION_CACHE_MS = 10_000;

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

function securityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://vibecafe.ai; connect-src 'self' https://vibecafe.ai; base-uri 'none'; frame-ancestors 'none'");
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
  const readinessFor = timedSingleFlight(
    (requestNow) => getReadiness(store, config, { now: requestNow }),
  );
  const evaluationFor = timedSingleFlight(
    () => currentEvaluation(store, config),
    0,
  );
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
          evaluationFor(),
          readinessFor(requestNow),
        ]);
        const providers = readiness.provider_freshness.providers;
        const states = providerStates.map(([, , state]) => state);
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
        sendJson(response, ["not_ready", "stale", "waiting"].includes(status) ? 503 : 200, {
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
          publication_ready: readiness.publication_ready,
          publication_blockers: readiness.publication_blockers,
        });
        return;
      }
      if (url.pathname === "/api/forecast/current") {
        const requestNow = now();
        const [prediction, readiness] = await Promise.all([
          latestPrediction(store),
          readinessFor(requestNow),
        ]);
        if (!prediction) {
          sendJson(response, 503, {
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
          sendJson(response, 503, {
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
        sendJson(response, 200, await readinessFor(now()));
        return;
      }
      if (url.pathname === "/api/evaluation/summary") {
        const result = await evaluationFor();
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
          evaluationFor(),
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
        const expectedExtractor = extractorContract(config);
        const currentExtractorSignals = signals.filter((signal) =>
          matchesExtractorContract(signal, expectedExtractor)
        );
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
