import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { extractorContract } from "../src/core/extractor-contract.mjs";
import { hashLabel, sha256, stableStringify } from "../src/core/hash.mjs";
import {
  assessEvaluationCompatibility,
  getReadiness,
} from "../src/runtime/readiness.mjs";
import {
  createRequestHandler,
  servingSnapshotConfig,
} from "../src/web/app.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../src/core/outcome-contract.mjs";
import { impactEpisodeContract } from "../src/pipeline/impact-episodes.mjs";
import {
  evaluationArtifactHash,
  evaluationContractHash,
  MODEL_ARTIFACT_VERSION,
  MODEL_VERSION_PREFIX,
  modelContractHash,
} from "../src/model/contract.mjs";
import { recomputeFrozenEvaluationArtifact } from "../src/model/evaluation.mjs";
import { FEATURE_NAMES } from "../src/model/features.mjs";
import { deriveProbabilitySlots } from "../src/model/forecast.mjs";
import {
  COEFFICIENT_PRIOR_POLICY_VERSION,
  FEATURE_TRANSFORM_VERSION,
  predictHazard,
} from "../src/model/logistic-hazard.mjs";

const HOUR_MS = 3_600_000;

test("serving snapshot reuse is bound to the current outcome contract", () => {
  const snapshotConfig = servingSnapshotConfig(config());
  assert.equal(
    snapshotConfig.outcome_label_policy_version,
    OUTCOME_LABEL_POLICY_VERSION,
  );
  assert.equal(
    snapshotConfig.outcome_adjudicator_version,
    OUTCOME_ADJUDICATOR_VERSION,
  );
  assert.match(snapshotConfig.serving_config_hash, /^sha256:[a-f0-9]{64}$/);
});

class MemoryStore {
  constructor({ records = {}, states = {}, models = {}, blobs = {} } = {}) {
    this.records = records;
    this.states = states;
    this.models = models;
    this.blobs = blobs;
  }

  async all(type, { latestOnly = true } = {}) {
    const records = [...(this.records[type] ?? [])];
    if (!latestOnly) return records;
    const latest = new Map();
    for (const record of records) {
      const previous = latest.get(record.record_id);
      if (!previous || record.revision > previous.revision) latest.set(record.record_id, record);
    }
    return [...latest.values()];
  }

  async allByRefs(type, refs) {
    const recordsByRef = new Map(
      (this.records[type] ?? []).map((record) => [
        `${record.record_id}@${record.revision}`,
        record,
      ]),
    );
    return refs
      .map((ref) => recordsByRef.get(`${ref.record_id}@${ref.revision}`))
      .filter(Boolean);
  }

  async readState(name, fallback = {}) {
    return structuredClone(this.states[name] ?? fallback);
  }

  async writeState(name, value) {
    this.states[name] = structuredClone(value);
  }

  async readModel(name) {
    const value = this.models[name] ?? null;
    if (value instanceof Error) throw value;
    return structuredClone(value);
  }

  async readBlob(ref) {
    if (!(ref in this.blobs)) throw new Error(`missing blob: ${ref}`);
    return structuredClone(this.blobs[ref]);
  }
}

function config(overrides = {}) {
  return {
    config_hash: "sha256:test-config",
    feature_schema_version: "features/test",
    deduplication_version: "dedup/test",
    taxonomy_version: "taxonomy/test",
    timezone_database_version: "tzdata-test",
    extractor: {
      model: "deterministic-rules",
      model_version: "test",
      prompt_version: "rules/test",
    },
    providers: {
      x: {
        enabled: true,
        confirmation_identities: [{
          identity_id: "person_tibo_sottiaux",
          source_role: "product_lead",
        }],
        context_identities: [],
        context_queries: [],
      },
    },
    impact_tracking: {
      version: "impact-episode-policy/1",
      enabled: true,
      cluster_gap_hours: 72,
      active_evidence_ttl_hours: 24,
      freshness_half_life_hours: 36,
    },
    model: {
      outcome_coverage_providers: ["x"],
      standardized_feature_clip: 8,
      minimum_live_evaluation_windows: 168,
      minimum_live_evaluation_events: 3,
      maximum_training_days: 180,
      promotion: {
        top_window_hours_per_week: 36,
        minimum_event_window_recall: 0.8,
        require_brier_skill_above: 0,
        maximum_expected_calibration_error: 0.1,
      },
    },
    runtime: {
      forecast_fresh_age_hours: 1.5,
      forecast_stale_age_hours: 3,
    },
    ...overrides,
  };
}

function prediction({
  issuedAt = "2026-07-25T10:05:00.000Z",
  cutoff = "2026-07-25T10:00:00.000Z",
} = {}) {
  const start = Date.parse(cutoff);
  const slots = Array.from({ length: 168 }, (_, index) => ({
    start: new Date(start + index * HOUR_MS).toISOString(),
    end: new Date(start + (index + 1) * HOUR_MS).toISOString(),
    hazard: 0.01,
    first_reset_probability: 0.01 * (0.99 ** index),
    reset_by_end_probability: 1 - 0.99 ** (index + 1),
    rolling_4h_probability: index <= 164 ? 1 - 0.99 ** 4 : null,
    epistemic_interval_80: [0.005, 0.02],
  }));
  return {
    record_id: "pred_test",
    revision: 1,
    data: {
      issued_at: issuedAt,
      knowledge_cutoff: cutoff,
      horizon: {
        start: slots[0].start,
        end: slots.at(-1).end,
      },
      slots,
      no_reset_probability: 0.99 ** 168,
      data_quality: { score: 0.8, provider_coverage: 0.6 },
      model: {
        version: "model/test",
        training_cutoff: "2026-07-20T00:00:00.000Z",
      },
    },
  };
}

function provisionalForecastFixture(appConfig, {
  validationStatus = "provisional",
  issuedAt = "2026-07-25T10:05:00.000Z",
  cutoff = "2026-07-25T10:00:00.000Z",
  eventCount = 3,
} = {}) {
  const dimension = FEATURE_NAMES.length + 1;
  const model = {
    artifact_version: MODEL_ARTIFACT_VERSION,
    family: "ridge_logistic_discrete_time_hazard",
    model_version: `${MODEL_VERSION_PREFIX}-provisional-test`,
    training_cutoff: "2026-07-20T00:00:00.000Z",
    feature_schema_version: appConfig.feature_schema_version,
    model_contract_hash: modelContractHash(appConfig),
    feature_names: FEATURE_NAMES,
    means: FEATURE_NAMES.map(() => 0),
    scales: FEATURE_NAMES.map(() => 1),
    weights: [-4, ...FEATURE_NAMES.map(() => 0)],
    feature_transform: {
      version: FEATURE_TRANSFORM_VERSION,
      standardized_feature_clip: appConfig.model.standardized_feature_clip,
    },
    coefficient_prior_policy: COEFFICIENT_PRIOR_POLICY_VERSION,
    raw_coefficient_priors: Array(dimension).fill(0),
    coefficient_priors: Array(dimension).fill(0),
    covariance: null,
    uncertainty: {
      status: "unavailable",
      reason: "test_fixture",
    },
    event_count: eventCount,
    converged: true,
    stop_reason: "gradient_tolerance",
  };
  model.artifact_hash = sha256(stableStringify(model));
  const extractor = extractorContract(appConfig);
  const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0]));
  const start = Date.parse(cutoff);
  const featureSnapshots = Array.from({ length: 168 }, (_, index) => {
    const slotStart = new Date(start + index * HOUR_MS).toISOString();
    const slotEnd = new Date(start + (index + 1) * HOUR_MS).toISOString();
    return {
      record_id: `feature_provisional_${String(index).padStart(3, "0")}`,
      revision: 1,
      record_type: "feature_snapshot",
      data: {
        knowledge_cutoff: cutoff,
        config_hash: appConfig.config_hash,
        feature_schema_version: appConfig.feature_schema_version,
        taxonomy_version: appConfig.taxonomy_version,
        deduplication_version: appConfig.deduplication_version,
        timezone_database_version: appConfig.timezone_database_version,
        extractor_model: extractor.model,
        extractor_model_version: extractor.model_version,
        extractor_prompt_version: extractor.prompt_version,
        extractor_semantic_policy_hash: extractor.semantic_policy_hash,
        target: {
          start: slotStart,
          end: slotEnd,
          base_slot: "PT1H",
          display_horizon: "PT4H",
        },
        features,
        data_quality: {
          provider_coverage: 1,
          outcome_sample_count: 3,
          sample_sufficiency: 1,
        },
      },
    };
  });
  const probabilities = deriveProbabilitySlots(featureSnapshots.map((snapshot) => {
    const result = predictHazard(model, FEATURE_NAMES.map(() => 0));
    return {
      start: snapshot.data.target.start,
      end: snapshot.data.target.end,
      hazard: result.probability,
      interval80: result.interval80,
    };
  }));
  const forecast = {
    record_id: "pred_provisional",
    revision: 1,
    data: {
      issued_at: issuedAt,
      knowledge_cutoff: cutoff,
      event_process: "first_reset",
      scope: appConfig.target,
      horizon: {
        start: featureSnapshots[0].data.target.start,
        end: featureSnapshots.at(-1).data.target.end,
        boundary: "[start,end)",
      },
      base_slot: "PT1H",
      display_horizon: "PT4H",
      slots: probabilities.slots,
      no_reset_probability: probabilities.noResetProbability,
      data_quality: {
        score: 1,
        provider_coverage: 1,
        outcome_sample_count: 3,
        sample_sufficiency: 1,
      },
      feature_snapshot_refs: featureSnapshots.map((snapshot) => ({
        record_id: snapshot.record_id,
        revision: snapshot.revision,
      })),
      model: {
        version: model.model_version,
        artifact_hash: model.artifact_hash,
        model_contract_hash: model.model_contract_hash,
        training_cutoff: model.training_cutoff,
        validation_status: validationStatus,
      },
    },
  };
  return { model, featureSnapshots, forecast };
}

function observation(id, revision, text, publishedAt) {
  return {
    record_id: id,
    revision,
    created_at: publishedAt,
    data: {
      canonical_url: `https://x.com/example/status/${id}-${revision}`,
      published_at: publishedAt,
      ingest_provider: "x",
      author: { display_handle: `@source-r${revision}` },
      content: { text },
    },
  };
}

function timelineObservation({
  id,
  statusId,
  text,
  publishedAt,
  identity = "person_tibo_sottiaux",
  provider = "rsshub_x_timeline",
  mediaType = "text/plain",
}) {
  const item = observation(id, 1, text, publishedAt);
  item.data.provider_item_id = statusId;
  item.data.canonical_url = `https://x.com/thsottiaux/status/${statusId}`;
  item.data.ingest_provider = provider;
  item.data.first_seen_at = publishedAt;
  item.data.fetched_at = publishedAt;
  item.data.author = {
    identity_id: identity,
    display_handle: identity === "person_tibo_sottiaux"
      ? "@thsottiaux"
      : "@someone_else",
  };
  item.data.content.media_type = mediaType;
  return item;
}

function impactEpisode(
  id,
  currentPressure,
  lastUpdate,
  runConfig = config(),
) {
  const contractHash = hashLabel(impactEpisodeContract(runConfig));
  const impact = {
    category: "tool_execution",
    severity: "medium",
    lifecycle: "active",
    affected_scope: "multiple_users",
    affected_surfaces: ["cli", "tool_use"],
    workaround: "unknown",
    evidence_basis: "first_party_report",
  };
  return {
    record_id: id,
    revision: 1,
    created_at: lastUpdate,
    producer: {
      name: "impact-episode-builder",
      version: "0.1.0",
      config_hash: contractHash,
    },
    data: {
      as_of: lastUpdate,
      policy_version: "impact-episode-policy/1",
      policy_config_hash: contractHash,
      policy_parameters: {
        cluster_gap_hours: 72,
        active_evidence_ttl_hours: 24,
        freshness_half_life_hours: 36,
      },
      state: "active",
      trend: "rising",
      category: "tool_execution",
      update_kind: "evidence_added",
      current_pressure: currentPressure,
      peak_pressure: Math.max(currentPressure, 0.9),
      pressure_components: {
        independent_evidence_count: 1,
      },
      current_impact: impact,
      peak_impact: impact,
      first_observed_at: "2026-07-24T00:00:00.000Z",
      last_independent_update_at: lastUpdate,
      evidence: [{ record_id: `signal_${id}`, revision: 1 }],
    },
  };
}

function signal({
  id,
  observationRef,
  availableAt,
  role,
  derivation,
  identity = null,
  group = id,
  eventType = "release",
  impact = null,
  competitiveContext = null,
  runConfig = config(),
}) {
  const extractor = extractorContract(runConfig);
  return {
    record_id: id,
    revision: 1,
    created_at: availableAt,
    producer: {
      name: "rule-claim-extractor",
      version: extractor.model_version,
    },
    data: {
      available_at: availableAt,
      observation_refs: [observationRef],
      claim: {
        event_type: eventType,
        phase: "completed",
        scope: { vendor: "openai", product: "codex" },
        impact,
        competitive_context: competitiveContext,
      },
      extraction: {
        model: extractor.model,
        model_version: extractor.model_version,
        prompt_version: extractor.prompt_version,
        semantic_policy_hash: extractor.semantic_policy_hash,
        relevance: {
          policy_version: "reset-topic-relevance/test",
          decision: "relevant",
          reason_code: "test_signal",
          basis: "self",
          matched_segments: [],
          context_refs: [],
        },
      },
      provenance: {
        source_role: role,
        source_identity_id: identity,
        derivation,
        independence_group_id: group,
      },
    },
  };
}

function coverageAssertion() {
  const evidence = {
    method: "test_complete_poll",
    exhausted_at: "2026-07-25T09:59:00.000Z",
    interval: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-25T09:59:00.000Z",
    },
  };
  return {
    assertion_id: "cov_test",
    revision: 1,
    provider: "x",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-25T09:59:00.000Z",
    mode: "explicit_complete_poll",
    adequacy: "negative_label_eligible",
    evidence_refs: [{
      kind: "complete_poll",
      ref: "blob://test/coverage.json",
      sha256: hashLabel(evidence),
      method: evidence.method,
      exhausted_at: evidence.exhausted_at,
    }],
    asserted_at: "2026-07-25T09:59:00.000Z",
  };
}

function coverageBlob() {
  return {
    method: "test_complete_poll",
    exhausted_at: "2026-07-25T09:59:00.000Z",
    interval: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-25T09:59:00.000Z",
    },
  };
}

async function serverFor(t, store, appConfig, now) {
  const server = http.createServer(createRequestHandler({
    store,
    config: appConfig,
    now: () => new Date(now),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function requestThroughProxy(base, {
  path = "/api/live",
  method = "GET",
  headers = {},
} = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      method,
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    request.once("error", reject);
    request.end();
  });
}

test("public HTTP requests redirect to the configured HTTPS origin", async (t) => {
  const publicHost = "codexreset.dreaife.tokyo";
  const base = await serverFor(
    t,
    new MemoryStore(),
    config({
      runtime: {
        public_base_url: `https://${publicHost}`,
        forecast_fresh_age_hours: 1.5,
        forecast_stale_age_hours: 3,
      },
    }),
    "2026-07-25T10:10:00.000Z",
  );

  const redirected = await requestThroughProxy(base, {
    path: "/en/accuracy?ref=gsc%2Fmanual",
    headers: {
      host: publicHost,
      "x-forwarded-proto": "http",
    },
  });
  assert.equal(redirected.statusCode, 308);
  assert.equal(
    redirected.headers.location,
    `https://${publicHost}/en/accuracy?ref=gsc%2Fmanual`,
  );
  assert.equal(redirected.headers["cache-control"], "public, max-age=3600");

  const secure = await requestThroughProxy(base, {
    headers: { host: publicHost, "x-forwarded-proto": "https" },
  });
  assert.equal(secure.statusCode, 200);

  const local = await requestThroughProxy(base, {
    headers: { "x-forwarded-proto": "http" },
  });
  assert.equal(local.statusCode, 200);

  const spoofedForwardedHost = await requestThroughProxy(base, {
    headers: {
      host: "attacker.example",
      "x-forwarded-host": publicHost,
      "x-forwarded-proto": "http",
    },
  });
  assert.equal(spoofedForwardedHost.statusCode, 200);

  const ambiguousProto = await requestThroughProxy(base, {
    headers: {
      host: publicHost,
      "x-forwarded-proto": "http, https",
    },
  });
  assert.equal(ambiguousProto.statusCode, 200);

  const post = await requestThroughProxy(base, {
    method: "POST",
    headers: { host: publicHost, "x-forwarded-proto": "http" },
  });
  assert.equal(post.statusCode, 308);
});

test("exact forecast snapshots are immutable while current forecasts remain no-store", async (t) => {
  const appConfig = config();
  const savedPrediction = prediction();
  const store = new MemoryStore({
    records: { prediction: [savedPrediction] },
  });
  const base = await serverFor(
    t,
    store,
    appConfig,
    "2026-07-25T10:10:00.000Z",
  );
  const healthResponse = await fetch(`${base}/api/health`);
  const health = await healthResponse.json();
  const snapshotUrl =
    `${base}/api/forecast/snapshots/${savedPrediction.record_id}/${savedPrediction.revision}`;
  const response = await fetch(snapshotUrl);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(await response.json(), savedPrediction);

  const conditional = await fetch(snapshotUrl, {
    headers: { "if-none-match": etag },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get("etag"), etag);
  assert.equal(
    conditional.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(await conditional.text(), "");

  const missing = await fetch(
    `${base}/api/forecast/snapshots/${savedPrediction.record_id}/2`,
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  const current = await fetch(`${base}/api/forecast/current`);
  assert.equal(current.headers.get("cache-control"), "no-store");
  assert.deepEqual(health.current_prediction_ref, {
    record_id: savedPrediction.record_id,
    revision: savedPrediction.revision,
    issued_at: savedPrediction.data.issued_at,
    knowledge_cutoff: savedPrediction.data.knowledge_cutoff,
    snapshot_url:
      `/api/forecast/snapshots/${savedPrediction.record_id}/${savedPrediction.revision}`,
  });
  assert.equal(health.synthetic_only, false);
  assert.equal(
    store.states["serving-snapshot"].schema_version,
    "serving-snapshot/2",
  );
  assert.equal(
    store.states["serving-snapshot"].prediction_hash,
    hashLabel(savedPrediction),
  );
  assert.deepEqual(
    store.states["serving-snapshot"].prediction,
    savedPrediction,
  );
  assert.ok(store.states["serving-snapshot"].runtime_watermark.state_hash);
  assert.ok(store.states["serving-snapshot"].readiness);
  assert.ok(store.states["serving-snapshot"].evaluation_result);
  store.allByRefs = async () => {
    throw new Error("exact lookup should use the serving snapshot for current ref");
  };
  const projectedSnapshot = await fetch(snapshotUrl);
  assert.equal(projectedSnapshot.status, 200);
  assert.deepEqual(await projectedSnapshot.json(), savedPrediction);
  const failedLookup = await fetch(
    `${base}/api/forecast/snapshots/pred_unavailable/1`,
  );
  assert.equal(failedLookup.status, 404);
  assert.equal(failedLookup.headers.get("cache-control"), "no-store");
});

test("serving projections singleflight heavy work and refresh volatile health dynamically", async (t) => {
  class CountingStore extends MemoryStore {
    modelReads = 0;
    predictionScans = 0;

    async all(type, options) {
      if (type === "prediction") this.predictionScans += 1;
      return super.all(type, options);
    }

    async readModel(name) {
      this.modelReads += 1;
      return super.readModel(name);
    }
  }

  const appConfig = config({
    runtime: {
      forecast_fresh_age_hours: 1.5,
      forecast_stale_age_hours: 3,
      scheduler_interval_minutes: 10,
    },
  });
  const store = new CountingStore({
    states: {
      "x-provider": {
        last_success_at: "2026-07-25T10:05:00.000Z",
        last_error: null,
      },
      runtime: {
        last_run_started_at: "2026-07-25T10:00:00.000Z",
        last_success_at: "2026-07-25T10:06:00.000Z",
        last_status: "completed",
        last_error: null,
      },
    },
  });
  let requestNow = new Date("2026-07-25T10:10:00.000Z");
  const handler = createRequestHandler({
    store,
    config: appConfig,
    now: () => new Date(requestNow),
  });
  assert.equal(typeof handler.refreshServingSnapshot, "function");
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  await Promise.all([
    fetch(`${base}/api/health`),
    fetch(`${base}/api/forecast/current`),
  ]);
  const firstHeavyReadCount = store.modelReads;
  const firstPredictionScanCount = store.predictionScans;
  assert.equal(firstHeavyReadCount, 3);
  assert.equal(
    store.states["serving-snapshot"].materialized_at,
    requestNow.toISOString(),
  );
  await handler.refreshServingSnapshot(requestNow);
  assert.equal(store.modelReads, firstHeavyReadCount);
  assert.equal(store.predictionScans, firstPredictionScanCount);

  store.states["x-provider"].last_success_at =
    "2026-07-25T04:00:00.000Z";
  const dynamicHealthResponse = await fetch(`${base}/api/health`);
  const dynamicHealth = await dynamicHealthResponse.json();
  assert.equal(dynamicHealth.provider_freshness.exact.status, "stale");
  assert.equal(store.modelReads, firstHeavyReadCount);
  assert.equal(store.predictionScans, firstPredictionScanCount);

  store.states.runtime.current_run_started_at =
    "2026-07-25T10:10:00.000Z";
  store.states.runtime.last_run_started_at =
    "2026-07-25T10:10:00.000Z";
  store.states.runtime.last_retrain_requested_at =
    "2026-07-25T10:10:00.000Z";
  const runningHealthResponse = await fetch(`${base}/api/health`);
  assert.equal((await runningHealthResponse.json()).pipeline_status, "running");
  assert.equal(store.modelReads, firstHeavyReadCount);
  assert.equal(store.predictionScans, firstPredictionScanCount);
  store.states.runtime.current_run_started_at = null;

  requestNow = new Date("2026-07-25T10:40:00.001Z");
  await fetch(`${base}/api/health`);
  assert.ok(store.modelReads > firstHeavyReadCount);
  const afterTtlRefresh = store.modelReads;

  store.states.runtime.last_status = "promotion_blocked";
  store.states.runtime.last_promotion_status = "test_guard_rejected";
  await fetch(`${base}/api/health`);
  assert.ok(store.modelReads > afterTtlRefresh);
  assert.equal(
    store.states["serving-snapshot"].runtime_watermark.last_status,
    "promotion_blocked",
  );
});

test("health returns warming without waiting for cold snapshot materialization", async (t) => {
  let releasePredictionReads;
  let markPredictionReadStarted;
  const predictionReadsReleased = new Promise((resolve) => {
    releasePredictionReads = resolve;
  });
  const predictionReadStarted = new Promise((resolve) => {
    markPredictionReadStarted = resolve;
  });
  let predictionReadMarked = false;
  class SlowPredictionStore extends MemoryStore {
    async all(type, options) {
      if (type === "prediction") {
        if (!predictionReadMarked) {
          predictionReadMarked = true;
          markPredictionReadStarted();
        }
        await predictionReadsReleased;
      }
      return super.all(type, options);
    }
  }

  const savedPrediction = prediction();
  const appConfig = config({
    runtime: {
      forecast_fresh_age_hours: 1.5,
      forecast_stale_age_hours: 3,
      scheduler_interval_minutes: 10,
    },
  });
  const store = new SlowPredictionStore({
    records: { prediction: [savedPrediction] },
    states: {
      "x-provider": {
        last_success_at: "2026-07-25T10:05:00.000Z",
        last_error: null,
      },
      runtime: {
        last_success_at: "2026-07-25T10:06:00.000Z",
        last_status: "completed",
        last_prediction_id: savedPrediction.record_id,
        last_error: null,
      },
    },
  });
  const requestNow = new Date("2026-07-25T10:10:00.000Z");
  const handler = createRequestHandler({
    store,
    config: appConfig,
    now: () => new Date(requestNow),
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  let warmupSettled = false;
  const warmup = handler.refreshServingSnapshot(requestNow).finally(() => {
    warmupSettled = true;
  });
  await predictionReadStarted;
  let timeout;
  let warmingResponse;
  try {
    warmingResponse = await Promise.race([
      fetch(`${base}/api/health`),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("health waited for serving snapshot warmup"));
        }, 250);
      }),
    ]);
    assert.equal(warmingResponse.status, 503);
    assert.equal(warmingResponse.headers.get("cache-control"), "no-store");
    const warming = await warmingResponse.json();
    assert.equal(warming.status, "warming");
    assert.equal(warming.error, "forecast_warming");
    assert.equal(warming.pipeline_status, "warming");
    assert.equal(warming.current_prediction_ref, null);
    assert.deepEqual(warming.serving_blockers, [
      "serving_snapshot_warming",
    ]);
    assert.equal(warmupSettled, false);
  } finally {
    clearTimeout(timeout);
    releasePredictionReads();
  }

  await warmup;
  assert.equal(warmupSettled, true);
  const readyHealthResponse = await fetch(`${base}/api/health`);
  const readyHealth = await readyHealthResponse.json();
  assert.notEqual(readyHealth.status, "warming");
  assert.deepEqual(readyHealth.current_prediction_ref, {
    record_id: savedPrediction.record_id,
    revision: savedPrediction.revision,
    issued_at: savedPrediction.data.issued_at,
    knowledge_cutoff: savedPrediction.data.knowledge_cutoff,
    snapshot_url:
      `/api/forecast/snapshots/${savedPrediction.record_id}/${savedPrediction.revision}`,
  });
  const exactResponse = await fetch(
    `${base}${readyHealth.current_prediction_ref.snapshot_url}`,
  );
  assert.equal(exactResponse.status, 200);
  assert.deepEqual(await exactResponse.json(), savedPrediction);
});

test("recent evidence is aligned to the forecast cutoff and aggregator summaries never become core", async (t) => {
  const before = observation(
    "obs_before",
    1,
    "Codex released a new coding model.",
    "2026-07-25T09:30:00.000Z",
  );
  const afterAggregator = observation(
    "obs_after_aggregator",
    1,
    "Summary of a Tibo Codex update.",
    "2026-07-25T10:01:00.000Z",
  );
  const afterCommunity = observation(
    "obs_after_community",
    1,
    "Community report about Codex.",
    "2026-07-25T10:02:00.000Z",
  );
  const duplicateAggregator = observation(
    "obs_duplicate_aggregator",
    1,
    "Summary of the same exact Codex source.",
    "2026-07-25T09:59:00.000Z",
  );
  const obsolete = observation(
    "obs_obsolete_extractor",
    1,
    "Obsolete extraction that the current topic policy rejects.",
    "2026-07-25T09:58:00.000Z",
  );
  const obsoleteSignal = signal({
    id: "sig_obsolete_extractor",
    observationRef: { record_id: obsolete.record_id, revision: 1 },
    availableAt: obsolete.created_at,
    role: "aggregator",
    derivation: "summarizes",
  });
  obsoleteSignal.producer.version = "old-extractor";
  obsoleteSignal.data.extraction.model_version = "old-extractor";
  obsoleteSignal.data.extraction.prompt_version = "old-rules";
  obsoleteSignal.data.extraction.semantic_policy_hash =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      raw_observation: [
        duplicateAggregator,
        before,
        afterAggregator,
        afterCommunity,
        obsolete,
      ],
      normalized_signal: [
        obsoleteSignal,
        signal({
          id: "sig_duplicate_aggregator",
          observationRef: {
            record_id: duplicateAggregator.record_id,
            revision: 1,
          },
          availableAt: duplicateAggregator.created_at,
          role: "aggregator",
          derivation: "summarizes",
          identity: "person_tibo_sottiaux",
          group: "ind_shared_exact",
        }),
        signal({
          id: "sig_before",
          observationRef: { record_id: before.record_id, revision: 1 },
          availableAt: before.created_at,
          role: "product_lead",
          derivation: "primary_statement",
          identity: "person_tibo_sottiaux",
          group: "ind_shared_exact",
        }),
        signal({
          id: "sig_after_aggregator",
          observationRef: { record_id: afterAggregator.record_id, revision: 1 },
          availableAt: afterAggregator.created_at,
          role: "aggregator",
          derivation: "summarizes",
          identity: "person_tibo_sottiaux",
        }),
        signal({
          id: "sig_after_community",
          observationRef: { record_id: afterCommunity.record_id, revision: 1 },
          availableAt: afterCommunity.created_at,
          role: "community",
          derivation: "independent_observation",
        }),
      ],
    },
  });
  const base = await serverFor(t, store, config(), "2026-07-25T10:10:00.000Z");
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.equal(evidence.knowledge_cutoff, "2026-07-25T10:00:00.000Z");
  assert.deepEqual(evidence.core.map((item) => item.signal_ref.record_id), ["sig_before"]);
  assert.ok(!evidence.community.some((item) =>
    item.signal_ref.record_id === "sig_duplicate_aggregator"
  ));
  assert.ok(!evidence.items.some((item) =>
    item.signal_ref.record_id === "sig_obsolete_extractor"
  ));
  assert.equal(
    evidence.items.filter((item) =>
      item.independence_group_id === "ind_shared_exact"
    ).length,
    1,
  );
  assert.equal(evidence.core[0].source.canonical_url, before.data.canonical_url);
  assert.equal(evidence.core[0].source.published_at, before.data.published_at);
  assert.ok(evidence.items.every((item) => item.available_at <= evidence.knowledge_cutoff));
  assert.deepEqual(
    new Set(evidence.pending_next_forecast.items.map((item) => item.signal_ref.record_id)),
    new Set(["sig_after_aggregator", "sig_after_community"]),
  );
  assert.equal(evidence.pending_next_forecast.core.length, 0);
  assert.ok(evidence.pending_next_forecast.items.every((item) =>
    item.pending_next_forecast && !item.included_in_forecast,
  ));
});

test("recent evidence partitions experience impact and competition by semantics", async (t) => {
  const experienceObservation = observation(
    "obs_experience",
    1,
    "Codex CLI hangs during MCP tool execution.",
    "2026-07-25T09:20:00.000Z",
  );
  const competitionObservation = observation(
    "obs_competition",
    1,
    "Anthropic released Claude Code 5.",
    "2026-07-25T09:25:00.000Z",
  );
  const experience = signal({
    id: "sig_experience",
    observationRef: { record_id: experienceObservation.record_id, revision: 1 },
    availableAt: experienceObservation.created_at,
    role: "community",
    derivation: "independent_observation",
    eventType: "experience_issue",
    impact: {
      category: "tool_execution",
      severity: "medium",
      lifecycle: "active",
      affected_scope: "individual",
      affected_surfaces: ["cli", "mcp"],
      workaround: "unknown",
      evidence_basis: "first_party_report",
    },
  });
  experience.data.provenance.feature_eligible = false;
  const competition = signal({
    id: "sig_competition",
    observationRef: { record_id: competitionObservation.record_id, revision: 1 },
    availableAt: competitionObservation.created_at,
    role: "official",
    derivation: "primary_statement",
    eventType: "competitor_model_release",
    competitiveContext: {
      kind: "coding_agent_release",
      relevance: "direct",
      stage: "rolled_out",
    },
  });
  competition.data.claim.scope = {
    vendor: "other",
    product: "competing_model",
  };
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      raw_observation: [experienceObservation, competitionObservation],
      normalized_signal: [experience, competition],
    },
  });
  const base = await serverFor(t, store, config(), "2026-07-25T10:10:00.000Z");
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.deepEqual(
    evidence.experience.map((item) => item.signal_ref.record_id),
    ["sig_experience"],
  );
  assert.deepEqual(
    evidence.competition.map((item) => item.signal_ref.record_id),
    ["sig_competition"],
  );
  assert.equal(evidence.experience[0].impact.severity, "medium");
  assert.equal(evidence.experience[0].forecast_feature_eligible, false);
  assert.equal(evidence.experience[0].known_at_forecast_cutoff, true);
  assert.equal(evidence.experience[0].included_in_forecast, false);
  assert.equal(evidence.competition[0].included_in_forecast, true);
  assert.equal(
    evidence.competition[0].competitive_context.relevance,
    "direct",
  );
  assert.deepEqual(
    new Set(evidence.community.map((item) => item.signal_ref.record_id)),
    new Set(["sig_experience", "sig_competition"]),
  );
});

test("recent evidence exposes unclassified Tibo originals and ranked impact episodes", async (t) => {
  const matched = timelineObservation({
    id: "obs_timeline_matched",
    statusId: "2075657265508647008",
    text: "Codex released an exact product update.",
    publishedAt: "2026-07-25T09:30:00.000Z",
  });
  const unmatched = timelineObservation({
    id: "obs_timeline_unmatched",
    statusId: "2075657266508647008",
    text: "A Tibo post with no reset or extraction keywords.",
    publishedAt: "2026-07-25T09:35:00.000Z",
  });
  const duplicate = timelineObservation({
    id: "obs_timeline_duplicate",
    statusId: "2075657266508647008",
    text: "Historical duplicate of the same Tibo post.",
    publishedAt: "2026-07-25T09:35:00.000Z",
    provider: "historical_monitor",
  });
  duplicate.data.first_seen_at = "2026-07-25T09:20:00.000Z";
  const otherIdentity = timelineObservation({
    id: "obs_timeline_other",
    statusId: "2075657267508647008",
    text: "Another identity should not enter the Tibo timeline.",
    publishedAt: "2026-07-25T09:40:00.000Z",
    identity: "someone_else",
  });
  const quarantined = timelineObservation({
    id: "obs_timeline_quarantined",
    statusId: "2075657267608647008",
    text: JSON.stringify({
      schema_version: "rsshub-x-relation-quarantine/1",
      reason_code: "ambiguous_reply_metadata",
      reason: "reply marker lacks an exact parent",
      source_text: "Re @someone relation awaiting exact context.",
    }),
    publishedAt: "2026-07-25T09:42:00.000Z",
    mediaType: "application/vnd.reset-provider-quarantine+json",
  });
  const summary = timelineObservation({
    id: "obs_timeline_summary",
    statusId: "2075657268508647008",
    text: "A summary is not an exact original post.",
    publishedAt: "2026-07-25T09:45:00.000Z",
    mediaType: "application/vnd.x-search-summary+text",
  });
  const matchedSignal = signal({
    id: "sig_timeline_matched",
    observationRef: { record_id: matched.record_id, revision: 1 },
    availableAt: matched.created_at,
    role: "product_lead",
    derivation: "primary_statement",
    identity: "person_tibo_sottiaux",
    eventType: "release",
  });
  const episodes = [
    impactEpisode("episode_newer", 0.9, "2026-07-25T09:50:00.000Z"),
    impactEpisode("episode_older", 0.9, "2026-07-25T09:40:00.000Z"),
    ...Array.from({ length: 8 }, (_, index) =>
      impactEpisode(
        `episode_${index}`,
        0.8 - index * 0.1,
        `2026-07-25T0${index + 1}:00:00.000Z`,
      )
    ),
  ];
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      raw_observation: [
        matched,
        duplicate,
        unmatched,
        quarantined,
        otherIdentity,
        summary,
      ],
      normalized_signal: [matchedSignal],
      impact_episode: episodes,
    },
  });
  const base = await serverFor(t, store, config(), "2026-07-25T10:10:00.000Z");
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();

  assert.deepEqual(
    evidence.timeline.map((item) => item.status_id),
    [
      "2075657267608647008",
      "2075657266508647008",
      "2075657265508647008",
    ],
  );
  assert.equal(evidence.timeline[0].matched_signal, false);
  assert.equal(evidence.timeline[0].event_type, null);
  assert.equal(evidence.timeline[0].relevance, "pending_context");
  assert.equal(evidence.timeline[0].relevance_reason, "ambiguous_reply_metadata");
  assert.equal(evidence.timeline[0].quarantined_relation, true);
  assert.equal(
    evidence.timeline[0].text,
    "Re @someone relation awaiting exact context.",
  );
  assert.equal(evidence.timeline[0].forecast_feature_eligible, false);
  assert.equal(evidence.timeline[0].ingest_provider, "rsshub_x_timeline");
  assert.equal(evidence.timeline[1].first_seen_at, duplicate.data.first_seen_at);
  assert.equal(evidence.timeline[1].quarantined_relation, false);
  assert.equal(evidence.timeline[2].matched_signal, true);
  assert.equal(evidence.timeline[2].event_type, "release");
  assert.equal(evidence.timeline[2].relevance, "relevant");

  assert.equal(evidence.impact_episodes.length, 8);
  assert.deepEqual(evidence.impact_tracking, {
    enabled: true,
    policy_version: "impact-episode-policy/1",
    contract_hash: hashLabel(impactEpisodeContract(config())),
    latest_episode_as_of: "2026-07-25T09:50:00.000Z",
    episode_count: 8,
  });
  assert.equal(evidence.impact_episodes[0].category, "tool_execution");
  assert.equal(
    evidence.impact_episodes[0].as_of,
    "2026-07-25T09:50:00.000Z",
  );
  assert.deepEqual(
    evidence.impact_episodes.slice(0, 2).map((item) =>
      item.episode_ref.record_id
    ),
    ["episode_newer", "episode_older"],
  );
  assert.ok(
    evidence.impact_episodes.every((item, index, all) =>
      index === 0 ||
      Number(all[index - 1].current_pressure) >= Number(item.current_pressure)
    ),
  );
});

test("disabled impact tracking does not surface stale append-only episodes", async (t) => {
  const appConfig = config({
    impact_tracking: {
      version: "impact-episode-policy/1",
      enabled: false,
      cluster_gap_hours: 72,
      active_evidence_ttl_hours: 24,
      freshness_half_life_hours: 36,
    },
  });
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      impact_episode: [
        impactEpisode(
          "episode_stale",
          0.95,
          "2026-07-24T09:50:00.000Z",
        ),
      ],
    },
  });
  const base = await serverFor(
    t,
    store,
    appConfig,
    "2026-07-25T10:10:00.000Z",
  );
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.deepEqual(evidence.impact_episodes, []);
  assert.deepEqual(evidence.impact_tracking, {
    enabled: false,
    policy_version: "impact-episode-policy/1",
    contract_hash: hashLabel(impactEpisodeContract(appConfig)),
    latest_episode_as_of: null,
    episode_count: 0,
  });
});

test("recent evidence sorts reprocessed exact sources by publication time before slicing", async (t) => {
  const availableAt = "2026-07-25T09:58:00.000Z";
  const exactObservations = Array.from({ length: 7 }, (_, index) => observation(
    `obs_exact_${index + 1}`,
    1,
    `Exact Codex source ${index + 1}.`,
    `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  ));
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      raw_observation: exactObservations,
      normalized_signal: exactObservations.map((item, index) => signal({
        id: `sig_exact_${index + 1}`,
        observationRef: { record_id: item.record_id, revision: 1 },
        availableAt,
        role: "product_lead",
        derivation: "primary_statement",
        identity: "person_tibo_sottiaux",
        group: `ind_exact_${index + 1}`,
      })),
    },
  });

  const base = await serverFor(t, store, config(), "2026-07-25T10:10:00.000Z");
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.deepEqual(
    evidence.core.map((item) => item.signal_ref.record_id),
    [
      "sig_exact_7",
      "sig_exact_6",
      "sig_exact_5",
      "sig_exact_4",
      "sig_exact_3",
      "sig_exact_2",
    ],
  );
  assert.deepEqual(
    evidence.core.map((item) => item.source.published_at),
    [...evidence.core.map((item) => item.source.published_at)].sort().reverse(),
  );
});

test("recent evidence derives a stable X publication time when a summary timestamp varies", async (t) => {
  const statusId = "2075657265508647008";
  const summary = observation(
    "obs_summary_without_time",
    1,
    "Community summary about a Codex release.",
    "2026-07-25T09:30:00.000Z",
  );
  summary.data.canonical_url = `https://x.com/example/status/${statusId}`;
  summary.data.published_at = "2026-07-25T00:00:00.000Z";
  const store = new MemoryStore({
    records: {
      prediction: [prediction()],
      raw_observation: [summary],
      normalized_signal: [signal({
        id: "sig_summary_without_time",
        observationRef: { record_id: summary.record_id, revision: 1 },
        availableAt: summary.created_at,
        role: "aggregator",
        derivation: "summarizes",
        group: "ind_summary_without_time",
      })],
    },
  });

  const base = await serverFor(t, store, config(), "2026-07-25T10:10:00.000Z");
  const response = await fetch(`${base}/api/evidence/recent`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.equal(evidence.community.length, 1);
  assert.equal(
    evidence.community[0].source.published_at,
    "2026-07-10T19:03:50.601Z",
  );
  assert.equal(
    evidence.community[0].available_at,
    "2026-07-25T09:30:00.000Z",
  );
});

test("a fresh compatible challenger forecast is served provisionally without claiming publication readiness", async (t) => {
  const appConfig = config({
    target: {
      vendor: "openai",
      product: "codex",
      population: "paid_plans",
      plans: ["plus"],
      regions: ["global"],
      quota_bucket: "platform",
    },
    runtime: {
      forecast_fresh_age_hours: 1.5,
      forecast_stale_age_hours: 3,
      provisional_bootstrap: {
        enabled: true,
        minimum_outcomes: 3,
      },
    },
  });
  const fixture = provisionalForecastFixture(appConfig);
  const store = new MemoryStore({
    records: {
      prediction: [fixture.forecast],
      feature_snapshot: fixture.featureSnapshots,
      raw_observation: [observation(
        "obs_provisional",
        1,
        "Exact X source",
        "2026-07-25T09:30:00.000Z",
      )],
    },
    states: {
      "x-provider": {
        last_success_at: "2026-07-25T09:55:00.000Z",
        last_error: null,
      },
      runtime: {
        last_success_at: "2026-07-25T10:06:00.000Z",
        last_error: null,
      },
    },
    models: {
      champion: new Error("stored champion artifact hash mismatch"),
      challenger: fixture.model,
    },
  });
  const now = new Date("2026-07-25T10:10:00.000Z");
  const readiness = await getReadiness(store, appConfig, { now });
  assert.equal(readiness.forecast_available, true);
  assert.equal(readiness.serving_ready, true);
  assert.equal(readiness.serving_stage, "provisional");
  assert.deepEqual(readiness.serving_blockers, []);
  assert.equal(readiness.publication_ready, false);
  assert.ok(readiness.publication_blockers.includes("champion_incompatible"));
  assert.ok(readiness.publication_blockers.includes("forecast_not_validated"));
  assert.equal(readiness.prediction_integrity.valid, true);
  assert.equal(
    readiness.prediction_integrity.checked_model_version,
    fixture.model.model_version,
  );
  assert.equal(readiness.provisional_model.eligibility.enabled, true);
  assert.equal(readiness.provisional_model.eligibility.eligible, true);
  assert.equal(readiness.provisional_model.eligibility.reason, null);
  assert.deepEqual(readiness.provisional_model.eligibility.requirements, {
    no_compatible_champion: true,
    challenger_compatible: true,
    prediction_marked_provisional: true,
    prediction_matches_challenger: true,
    minimum_outcomes: 3,
    challenger_event_count: 3,
    minimum_outcomes_met: true,
    live_guard_passed: true,
    live_guard_source: "disabled",
  });

  const base = await serverFor(t, store, appConfig, now);
  const [forecastResponse, healthResponse, scriptResponse] = await Promise.all([
    fetch(`${base}/api/forecast/current`),
    fetch(`${base}/api/health`),
    fetch(`${base}/app.js`),
  ]);
  assert.equal(forecastResponse.status, 200);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.serving.status, "provisional");
  assert.equal(forecast.serving.ready, true);
  assert.equal(forecast.serving.stage, "provisional");
  assert.equal(forecast.serving.publication_ready, false);
  assert.equal(forecast.data.model.validation_status, "provisional");

  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "degraded");
  assert.equal(health.serving_ready, true);
  assert.equal(health.serving_stage, "provisional");
  assert.equal(health.publication_ready, false);

  const missingChampionStore = new MemoryStore({
    records: store.records,
    states: store.states,
    models: { challenger: fixture.model },
  });
  const missingChampionReadiness = await getReadiness(
    missingChampionStore,
    appConfig,
    { now },
  );
  assert.equal(missingChampionReadiness.serving_ready, true);
  assert.equal(missingChampionReadiness.serving_stage, "provisional");
  assert.equal(
    missingChampionReadiness.provisional_model.eligibility.eligible,
    true,
  );

  const script = await scriptResponse.text();
  assert.match(script, /试用模型/);
  assert.match(script, /严格验证仍在积累中/);

  const legacyForecast = structuredClone(fixture.forecast);
  delete legacyForecast.data.model.validation_status;
  const legacyStore = new MemoryStore({
    records: {
      prediction: [legacyForecast],
      feature_snapshot: fixture.featureSnapshots,
      raw_observation: store.records.raw_observation,
    },
    states: store.states,
    models: store.models,
  });
  const legacyReadiness = await getReadiness(legacyStore, appConfig, { now });
  assert.equal(legacyReadiness.forecast_available, false);
  assert.equal(legacyReadiness.serving_ready, false);
  assert.equal(legacyReadiness.serving_stage, "blocked");
  assert.equal(
    legacyReadiness.provisional_model.eligibility.reason,
    "prediction_validation_status_missing",
  );

  const lowOutcomeFixture = provisionalForecastFixture(appConfig, {
    eventCount: 2,
  });
  const lowOutcomeStore = new MemoryStore({
    records: {
      prediction: [lowOutcomeFixture.forecast],
      feature_snapshot: lowOutcomeFixture.featureSnapshots,
      raw_observation: store.records.raw_observation,
    },
    states: store.states,
    models: { challenger: lowOutcomeFixture.model },
  });
  const lowOutcomeReadiness = await getReadiness(
    lowOutcomeStore,
    appConfig,
    { now },
  );
  assert.equal(lowOutcomeReadiness.forecast_available, false);
  assert.equal(lowOutcomeReadiness.serving_ready, false);
  assert.equal(lowOutcomeReadiness.serving_stage, "blocked");
  assert.equal(
    lowOutcomeReadiness.provisional_model.eligibility.reason,
    "challenger_outcome_sample_insufficient",
  );
  assert.equal(
    lowOutcomeReadiness.provisional_model.eligibility.requirements
      .minimum_outcomes_met,
    false,
  );
});

test("stale forecasts are explicit and cannot make health or publication readiness green", async (t) => {
  const assertion = coverageAssertion();
  const stalePrediction = prediction({
    issuedAt: "2026-07-25T05:05:00.000Z",
    cutoff: "2026-07-25T05:00:00.000Z",
  });
  const appConfig = config();
  const store = new MemoryStore({
    records: {
      prediction: [stalePrediction],
      raw_observation: [observation(
        "obs_x",
        1,
        "Exact X source",
        "2026-07-25T09:30:00.000Z",
      )],
    },
    states: {
      coverage: { providers: { x: [assertion] } },
      "x-provider": {
        last_success_at: "2026-07-25T09:55:00.000Z",
        last_error: null,
      },
      runtime: {
        last_success_at: "2026-07-25T09:56:00.000Z",
        last_error: null,
      },
    },
    models: { champion: { model_version: "model/test" } },
  });
  const readiness = await getReadiness(store, appConfig, {
    now: new Date("2026-07-25T10:10:00.000Z"),
  });
  assert.equal(readiness.current_forecast.status, "stale");
  assert.equal(readiness.current_forecast.effective_stale, true);
  assert.equal(readiness.provider_freshness.groups.exact.status, "fresh");
  assert.equal(readiness.publication_ready, false);
  assert.ok(readiness.publication_blockers.includes("forecast_stale"));

  const base = await serverFor(t, store, appConfig, "2026-07-25T10:10:00.000Z");
  const [forecastResponse, healthResponse] = await Promise.all([
    fetch(`${base}/api/forecast/current`),
    fetch(`${base}/api/health`),
  ]);
  assert.equal(forecastResponse.status, 503);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.serving.status, "stale");
  assert.equal(forecast.data, undefined);
  assert.deepEqual(forecast.saved_prediction_ref, {
    record_id: stalePrediction.record_id,
    revision: stalePrediction.revision,
    issued_at: stalePrediction.data.issued_at,
    knowledge_cutoff: stalePrediction.data.knowledge_cutoff,
  });
  assert.equal(healthResponse.status, 503);
  const health = await healthResponse.json();
  assert.equal(health.status, "stale");
  assert.equal(health.effective_stale, true);
  assert.equal(health.publication_ready, false);
});

test("coverage stability observation is a machine-readable wait, not a pipeline error", async (t) => {
  const providerWaiting = {
    schema_version: "coverage-waiting/1",
    status: "observing",
    reason_code: "coverage_stability_observation_pending",
    provider_id: "authority_ledger",
    candidate_count: 180,
    earliest_first_observed_at: "2026-07-25T20:00:00.000Z",
    earliest_recheck_at: "2026-07-26T02:00:00.000Z",
    observed_at: "2026-07-25T20:00:00.000Z",
  };
  const appConfig = config({
    providers: {
      authority_adapter: {
        enabled: true,
        provider_name: "authority_ledger",
        freshness_max_age_hours: 2,
        confirmation_identities: [],
        context_identities: [],
        context_queries: [],
      },
    },
    model: {
      ...config().model,
      outcome_coverage_providers: ["authority_ledger"],
    },
  });
  const store = new MemoryStore({
    states: {
      "authority-adapter-provider": {
        provider: "authority_ledger",
        last_success_at: "2026-07-25T20:00:00.000Z",
        last_error: null,
        coverage_waiting: providerWaiting,
      },
      runtime: {
        last_success_at: "2026-07-25T20:00:00.000Z",
        last_status: "waiting_for_coverage",
        last_error: null,
      },
    },
  });
  const now = new Date("2026-07-25T21:00:00.000Z");
  const readiness = await getReadiness(store, appConfig, { now });
  assert.equal(readiness.pipeline_status, "waiting_for_coverage");
  assert.equal(readiness.outcome_coverage.status, "waiting_for_stability");
  assert.equal(readiness.coverage_waiting.candidate_count, 180);
  assert.equal(
    readiness.coverage_waiting.earliest_first_observed_at,
    "2026-07-25T20:00:00.000Z",
  );
  assert.equal(
    readiness.coverage_waiting.earliest_recheck_at,
    "2026-07-26T02:00:00.000Z",
  );
  assert.equal(readiness.coverage_waiting.recheck_due, false);
  assert.equal(readiness.publication_ready, false);
  assert.ok(
    readiness.publication_blockers.includes("negative_label_coverage_pending"),
  );
  assert.ok(
    !readiness.publication_blockers.includes("negative_label_coverage_missing"),
  );
  assert.ok(!readiness.publication_blockers.includes("pipeline_error"));

  const base = await serverFor(t, store, appConfig, now);
  const [healthResponse, forecastResponse] = await Promise.all([
    fetch(`${base}/api/health`),
    fetch(`${base}/api/forecast/current`),
  ]);
  assert.equal(healthResponse.status, 503);
  const health = await healthResponse.json();
  assert.equal(health.status, "waiting");
  assert.equal(health.pipeline_status, "waiting_for_coverage");
  assert.equal(health.pipeline_last_error, null);
  assert.equal(health.coverage_waiting.candidate_count, 180);
  assert.equal(forecastResponse.status, 503);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.pipeline_status, "waiting_for_coverage");
  assert.equal(forecast.coverage_waiting.candidate_count, 180);
});

test("walk-forward accumulation is exposed as evaluation waiting, not pipeline error", async (t) => {
  const evaluationWaiting = {
    schema_version: "evaluation-waiting/1",
    status: "waiting_for_evaluation",
    reason_code: "walk_forward_fold_pending",
    evaluation_cutoff: "2026-07-25T10:00:00.000Z",
    accepted_fold_count: 0,
    rejected_fold_count: 0,
    evaluated_windows: 0,
    evaluated_events: 0,
    minimum_evaluation_windows: 1008,
    minimum_evaluation_events: 20,
  };
  const assertion = coverageAssertion();
  const appConfig = config();
  const store = new MemoryStore({
    records: {
      raw_observation: [observation(
        "obs_x",
        1,
        "Exact X source",
        "2026-07-25T09:30:00.000Z",
      )],
    },
    states: {
      coverage: { providers: { x: [assertion] } },
      "x-provider": {
        last_success_at: "2026-07-25T09:55:00.000Z",
        last_error: null,
      },
      runtime: {
        last_success_at: "2026-07-25T10:00:00.000Z",
        last_status: "waiting_for_evaluation",
        last_evaluation_waiting: evaluationWaiting,
        last_error: null,
      },
    },
    blobs: {
      "blob://test/coverage.json": coverageBlob(),
    },
  });
  const now = new Date("2026-07-25T10:10:00.000Z");
  const readiness = await getReadiness(store, appConfig, { now });
  assert.equal(readiness.pipeline_status, "waiting_for_evaluation");
  assert.deepEqual(readiness.evaluation_waiting, evaluationWaiting);
  assert.equal(readiness.publication_ready, false);
  assert.ok(readiness.publication_blockers.includes("model_evaluation_pending"));
  assert.ok(!readiness.publication_blockers.includes("pipeline_error"));

  const base = await serverFor(t, store, appConfig, now);
  const [healthResponse, forecastResponse] = await Promise.all([
    fetch(`${base}/api/health`),
    fetch(`${base}/api/forecast/current`),
  ]);
  assert.equal(healthResponse.status, 503);
  const health = await healthResponse.json();
  assert.equal(health.status, "waiting");
  assert.equal(health.pipeline_status, "waiting_for_evaluation");
  assert.deepEqual(health.evaluation_waiting, evaluationWaiting);
  assert.equal(health.pipeline_last_error, null);
  assert.equal(forecastResponse.status, 503);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.pipeline_status, "waiting_for_evaluation");
  assert.deepEqual(forecast.evaluation_waiting, evaluationWaiting);
});

test("a corrupt champion is reported as incompatible instead of crashing health", async (t) => {
  const appConfig = config();
  const store = new MemoryStore({
    models: { champion: new Error("stored artifact hash mismatch") },
  });
  const base = await serverFor(t, store, appConfig, "2026-07-25T10:10:00.000Z");
  const [readinessResponse, healthResponse] = await Promise.all([
    fetch(`${base}/api/readiness`),
    fetch(`${base}/api/health`),
  ]);
  assert.equal(readinessResponse.status, 200);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.model.compatibility.compatible, false);
  assert.match(readiness.model.compatibility.reason, /artifact hash mismatch/);
  assert.ok(readiness.publication_blockers.includes("champion_incompatible"));
  assert.equal(healthResponse.status, 503);
  assert.notEqual((await healthResponse.json()).error, "internal_error");
});

test("evaluation cache compatibility and outcome/source revisions are exact", async (t) => {
  const assertion = coverageAssertion();
  const appConfig = config();
  const outcomeV1 = {
    record_id: "out_test",
    revision: 1,
    data: {
      status: "confirmed",
      occurred_time_range: {
        start: "2026-07-20T10:00:00.000Z",
        end: "2026-07-20T11:00:00.000Z",
        precision: "hour",
      },
      known_at: "2026-07-20T11:05:00.000Z",
      label_grade: "gold",
      verification: [{
        observation_ref: { record_id: "obs_source", revision: 1 },
      }],
    },
  };
  const outcomeV2 = {
    ...outcomeV1,
    revision: 2,
    data: {
      ...outcomeV1.data,
      verification: [{
        observation_ref: { record_id: "obs_source", revision: 2 },
      }],
    },
  };
  const candidateArtifactHash = hashLabel({ fixture: "candidate" });
  const fold = {
    origin: "2026-07-20T00:00:00.000Z",
    end: "2026-07-27T00:00:00.000Z",
    model_version: "walk-model/test",
    coverage_fraction: 1,
  };
  const frozenRows = [
    {
      fold_origin: fold.origin,
      anchor: "2026-07-20T00:00:00.000Z",
      window_end: "2026-07-20T04:00:00.000Z",
      probability: 0.05,
      champion_probability: null,
      baseline_probability: 0.5,
      features_hash: hashLabel({ fixture: "negative-row" }),
      label: 0,
    },
    {
      fold_origin: fold.origin,
      anchor: "2026-07-20T08:00:00.000Z",
      window_end: "2026-07-20T12:00:00.000Z",
      probability: 0.95,
      champion_probability: null,
      baseline_probability: 0.5,
      features_hash: hashLabel({ fixture: "positive-row" }),
      label: 1,
    },
  ];
  fold.evaluated_windows = frozenRows.length;
  fold.evaluated_window_hash = hashLabel(frozenRows);
  const foldDispositions = [{
    origin: fold.origin,
    end: fold.end,
    status: "accepted",
    evaluated_window_hash: fold.evaluated_window_hash,
  }];
  const frozenEvents = [{
    fold_origin: fold.origin,
    outcome_ref: { record_id: "out_test", revision: 1 },
    hit: true,
    settlement: "hit",
    useful_lead_hours: 2,
    maximum_prior_probability: 0.95,
    highest_prior_rank: 1,
    alert_rank_cutoff: 1,
    forecast_issued_at: "2026-07-20T08:00:00.000Z",
    ranked_window: {
      start: "2026-07-20T08:00:00.000Z",
      end: "2026-07-20T12:00:00.000Z",
      probability: 0.95,
    },
    policy_peak_window: {
      start: "2026-07-20T08:00:00.000Z",
      end: "2026-07-20T12:00:00.000Z",
      probability: 0.95,
    },
    occurred_time_range: outcomeV1.data.occurred_time_range,
    model_version: "walk-model/test",
  }];
  const frozenArtifact = {
    artifact_version: "reset-evaluation-rows/0.1.0",
    candidate_artifact_hash: candidateArtifactHash,
    evaluation_contract_hash: evaluationContractHash(appConfig),
    alert_policy: {
      type: "fixed_top_n_per_fold",
      budget: 1,
      tie_breaker: "earlier_anchor",
    },
    thresholds: {
      minimum_event_window_recall:
        appConfig.model.promotion.minimum_event_window_recall,
      require_brier_skill_above:
        appConfig.model.promotion.require_brier_skill_above,
      maximum_expected_calibration_error:
        appConfig.model.promotion.maximum_expected_calibration_error,
      minimum_live_evaluation_windows:
        appConfig.model.minimum_live_evaluation_windows,
      minimum_live_evaluation_events:
        appConfig.model.minimum_live_evaluation_events,
    },
    paired_status: "not_applicable",
    rows: frozenRows,
    alerts: [frozenRows[1]],
    events: frozenEvents,
    folds: [fold],
    fold_dispositions: foldDispositions,
  };
  const recomputed = recomputeFrozenEvaluationArtifact(frozenArtifact);
  const frozenArtifactHash = hashLabel(frozenArtifact);
  const frozenArtifactRef =
    `blob://test/evaluation-${frozenArtifactHash.slice("sha256:".length)}.json`;
  const evaluation = {
    evaluation_version: "reset-evaluation/0.3.0",
    mode: "walk_forward",
    evidence_mode: "historical_walk_forward",
    folds: [fold],
    fold_dispositions: foldDispositions,
    candidate: {
      model_version: "candidate/test",
      artifact_hash: candidateArtifactHash,
      evaluation_sample_hash: recomputed.evaluation_sample_hash,
    },
    metrics: recomputed.metrics,
    calibration: recomputed.calibration,
    events: frozenEvents,
    gate: recomputed.gate,
    paired_comparison: {
      status: "not_applicable",
      fold_signature: recomputed.fold_signature,
      sample_hash: recomputed.evaluation_sample_hash,
      champion_metrics: null,
      metric_deltas: null,
    },
    provenance: {
      config_hash: appConfig.config_hash,
      feature_schema_version: appConfig.feature_schema_version,
      deduplication_version: appConfig.deduplication_version,
      taxonomy_version: appConfig.taxonomy_version,
      model_contract_hash: modelContractHash(appConfig),
      evaluation_contract_hash: evaluationContractHash(appConfig),
      extractor_model: appConfig.extractor.model,
      extractor_model_version: appConfig.extractor.model_version,
      extractor_prompt_version: appConfig.extractor.prompt_version,
      coverage_assertion_refs: [{ assertion_id: assertion.assertion_id, revision: 1 }],
      coverage_assertion_snapshot_hash: hashLabel([assertion]),
      outcome_snapshot_refs: [{
        record_id: outcomeV1.record_id,
        revision: outcomeV1.revision,
        data_hash: hashLabel(outcomeV1.data),
      }],
      outcome_snapshot_hash: hashLabel([{
        record_id: outcomeV1.record_id,
        revision: outcomeV1.revision,
        data_hash: hashLabel(outcomeV1.data),
      }]),
      fold_signature: recomputed.fold_signature,
      fold_disposition_hash: recomputed.fold_disposition_hash,
      fold_disposition_count: foldDispositions.length,
      rejected_fold_count: 0,
      model_versions: ["walk-model/test"],
      row_sample_schema_version: frozenArtifact.artifact_version,
      row_sample_ref: frozenArtifactRef,
      row_sample_hash: frozenArtifactHash,
    },
  };
  evaluation.evaluation_artifact_hash = evaluationArtifactHash(evaluation);
  const unknownFutureEvaluation = structuredClone(evaluation);
  unknownFutureEvaluation.evaluation_version = "reset-evaluation/999.0.0";
  unknownFutureEvaluation.evaluation_artifact_hash =
    evaluationArtifactHash(unknownFutureEvaluation);
  assert.ok(
    assessEvaluationCompatibility(
      unknownFutureEvaluation,
      appConfig,
      [assertion],
      { outcomeRevisions: [outcomeV1] },
    ).reasons.includes("evaluation_version_unsupported"),
  );
  const store = new MemoryStore({
    records: {
      reset_outcome: [outcomeV1],
      raw_observation: [
        observation("obs_source", 1, "original revision", "2026-07-20T11:00:00.000Z"),
        observation("obs_source", 2, "corrected revision", "2026-07-21T11:00:00.000Z"),
      ],
    },
    states: {
      coverage: { providers: { x: [assertion] } },
      "walk-forward-summary": evaluation,
    },
    blobs: {
      "blob://test/coverage.json": coverageBlob(),
      [frozenArtifactRef]: frozenArtifact,
    },
  });
  const readiness = await getReadiness(store, appConfig, {
    now: new Date("2026-07-25T10:10:00.000Z"),
  });
  assert.equal(
    readiness.model.walk_forward_sample_gate.sample_threshold_passed,
    false,
  );
  assert.equal(readiness.model.real_walk_forward_acceptance_proven, false);
  assert.ok(
    readiness.publication_blockers.includes("real_walk_forward_not_proven"),
  );
  const base = await serverFor(t, store, appConfig, "2026-07-25T10:10:00.000Z");
  const [summaryResponse, eventsResponse] = await Promise.all([
    fetch(`${base}/api/evaluation/summary`),
    fetch(`${base}/api/evaluation/events`),
  ]);
  const summary = await summaryResponse.json();
  assert.equal(summaryResponse.status, 200, JSON.stringify(summary));
  assert.equal(summary.compatibility.compatible, true);
  const events = await eventsResponse.json();
  const scoredRevision = events.events.find((event) =>
    event.outcome_ref.record_id === "out_test" && event.outcome_ref.revision === 1,
  );
  assert.equal(scoredRevision.source.text, "original revision");
  assert.equal(scoredRevision.evaluation.outcome_ref.revision, 1);

  store.states["walk-forward-summary"].metrics.brier_score = 0.001;
  const tamperedResponse = await fetch(`${base}/api/evaluation/summary`);
  assert.equal(tamperedResponse.status, 503);
  const tampered = await tamperedResponse.json();
  assert.ok(
    tampered.invalidated[0].reasons.includes("evaluation_artifact_hash_mismatch"),
  );
  store.states["walk-forward-summary"] = structuredClone(evaluation);

  store.records.reset_outcome.push(outcomeV2);
  const supersededResponse = await fetch(`${base}/api/evaluation/summary`);
  assert.equal(supersededResponse.status, 503);
  const superseded = await supersededResponse.json();
  assert.ok(
    superseded.invalidated[0].reasons.includes("outcome_revision_superseded"),
  );

  store.states["walk-forward-summary"] = {
    ...evaluation,
    evaluation_version: "reset-evaluation/0.2.2",
    provenance: undefined,
  };
  const invalidatedResponse = await fetch(`${base}/api/evaluation/summary`);
  assert.equal(invalidatedResponse.status, 503);
  const invalidated = await invalidatedResponse.json();
  assert.equal(invalidated.error, "evaluation_invalidated");
  assert.ok(invalidated.invalidated[0].reasons.includes("evaluation_version_unsupported"));
});
