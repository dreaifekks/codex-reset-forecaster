import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
  PROBABILITY_PROFILE_WARM_TIMEOUT_MS,
  UI_NOTIFICATION_HORIZON_HOURS,
  createProbabilityProfileWorkerProvider,
} from "../src/query/probability-profile-worker.mjs";
import {
  NOTIFICATION_HORIZON_HOURS,
} from "../public/notification-preferences.js";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { createRequestHandler } from "../src/web/app.mjs";

class FakeWorker extends EventEmitter {
  constructor(onPost = null) {
    super();
    this.onPost = onPost;
    this.messages = [];
    this.terminateCalls = 0;
    this.unrefCalls = 0;
  }

  postMessage(message) {
    this.messages.push(message);
    this.onPost?.(message, this);
  }

  unref() {
    this.unrefCalls += 1;
  }

  async terminate() {
    this.terminateCalls += 1;
    return 0;
  }
}

const MINIMAL_CONFIG = {
  model: {
    minimum_live_evaluation_windows: 1008,
    minimum_live_evaluation_events: 20,
  },
};

test("worker warm horizons stay aligned with the browser slider", () => {
  assert.deepEqual(UI_NOTIFICATION_HORIZON_HOURS, NOTIFICATION_HORIZON_HOURS);
});

const CONTEXT_HASH = `sha256:${"a".repeat(64)}`;

function profileFor(horizonHours, generation = 1) {
  return {
    schema_version: "notification-threshold-calibration/1",
    detail_schema_version: "probability-threshold-profile/1",
    horizon_hours: horizonHours,
    generation,
    points: [],
    distribution_summary: {
      mean_probability: null,
      standard_deviation: null,
      observed_range: { lower: null, upper: null },
      display_range: {
        lower: null,
        upper: null,
        standard_deviations: 4,
        clipped_below: 0,
        clipped_above: 0,
      },
      suggested_threshold: {
        probability: null,
        standard_deviations: 2,
      },
    },
    lineage: { context_generation_hash: CONTEXT_HASH },
  };
}

function successfulResponse(
  message,
  worker,
  contextExpiresAt = 10_000,
  generation = 1,
) {
  const horizons = Array.isArray(message.horizon_hours)
    ? message.horizon_hours
    : [message.horizon_hours];
  queueMicrotask(() => worker.emit("message", {
    type: "probability_profile_response",
    request_id: message.request_id,
    ok: true,
    context_expires_at: contextExpiresAt,
    ...(Array.isArray(message.horizon_hours)
      ? { profiles: horizons.map((horizon) => profileFor(horizon, generation)) }
      : { profile: profileFor(horizons[0], generation) }),
  }));
}

test("worker provider is lazy, singleflights by horizon, and caches within context expiry", async () => {
  let currentTime = 100;
  const workers = [];
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    now: () => currentTime,
    requestTimeoutMs: 1_000,
    contextTtlMs: 1_000,
    profileCacheTtlMs: 1_000,
    workerFactory(_entry, options) {
      assert.equal(options.workerData.context_ttl_ms, 1_000);
      const worker = new FakeWorker((message, instance) =>
        successfulResponse(message, instance, 1_100)
      );
      workers.push(worker);
      return worker;
    },
  });

  assert.equal(workers.length, 0);
  const [left, right] = await Promise.all([provider.get(24), provider.get(24)]);
  assert.deepEqual(left, right);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1);
  assert.equal(workers[0].unrefCalls, 1);

  currentTime = 500;
  assert.equal((await provider.get(24)).horizon_hours, 24);
  assert.equal(workers[0].messages.length, 1);
  assert.equal((await provider.get(48)).horizon_hours, 48);
  assert.equal(workers[0].messages.length, 2);

  currentTime = 1_101;
  await provider.get(24);
  assert.equal(workers[0].messages.length, 3);
  await provider.stop();
  assert.equal(workers[0].terminateCalls, 1);
});

test("worker provider warms every UI horizon in one batch and persists a lineage-bound snapshot", async () => {
  let persisted = null;
  const worker = new FakeWorker((message, instance) =>
    successfulResponse(message, instance, 20_000)
  );
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    now: () => 10_000,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
    onSnapshot(snapshot) {
      persisted = snapshot;
    },
  });

  const profiles = await provider.warm();
  assert.equal(profiles.size, 28);
  assert.deepEqual([...profiles.keys()], UI_NOTIFICATION_HORIZON_HOURS);
  assert.equal(worker.messages.length, 1);
  assert.deepEqual(
    worker.messages[0].horizon_hours,
    UI_NOTIFICATION_HORIZON_HOURS,
  );
  assert.equal(worker.messages[0].force_refresh, false);
  await provider.stop();

  assert.equal(
    persisted.schema_version,
    PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
  );
  assert.equal(persisted.profiles.length, 28);
  assert.ok(persisted.profiles.every((entry) =>
    entry.context_generation_hash ===
      entry.profile.lineage.context_generation_hash
  ));
});

test("persistent snapshot ignores non-slider calibration horizons", async () => {
  let persisted = null;
  const worker = new FakeWorker((message, instance) =>
    successfulResponse(message, instance, 20_000)
  );
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    now: () => 10_000,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
    onSnapshot(snapshot) {
      persisted = snapshot;
    },
  });

  assert.equal((await provider.get(13)).horizon_hours, 13);
  await provider.stop();
  assert.equal(persisted, null);
});

test("HTTP-style reads fail fast while a cold background warm keeps running", async () => {
  let releaseWarm = null;
  const worker = new FakeWorker((message, instance) => {
    releaseWarm = () => successfulResponse(message, instance, 20_000);
  });
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    now: () => 10_000,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
  });

  const warming = provider.warm();
  await assert.rejects(
    provider.get(24, { waitForWarm: false }),
    (error) => error.code === "probability_profile_warming",
  );
  assert.equal(worker.messages.length, 1, "the background batch must stay single-flight");
  releaseWarm();
  await warming;
  assert.equal((await provider.get(24, { waitForWarm: false })).horizon_hours, 24);
  await provider.stop();
});

test("expired last-good profile returns immediately and forces a background refresh", async () => {
  let currentTime = 100;
  let deferredRefresh = null;
  const worker = new FakeWorker((message, instance) => {
    if (instance.messages.length === 1) {
      successfulResponse(message, instance, 1_100, 1);
      return;
    }
    deferredRefresh = () => successfulResponse(message, instance, 2_100, 2);
  });
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    now: () => currentTime,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
  });

  assert.equal((await provider.get(24)).generation, 1);
  currentTime = 1_101;
  const stale = await provider.get(24);
  assert.equal(stale.generation, 1);
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].force_refresh, true);
  assert.deepEqual(
    worker.messages[1].horizon_hours,
    UI_NOTIFICATION_HORIZON_HOURS,
  );

  deferredRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await provider.get(24)).generation, 2);
  await provider.stop();
});

test("a valid persistent snapshot seeds last-good values and rejects broken lineage binding", async () => {
  const validProfile = profileFor(24, 7);
  const snapshot = {
    schema_version: PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
    generated_at: "1970-01-01T00:00:01.000Z",
    profiles: [
      {
        horizon_hours: 24,
        cached_at: "1970-01-01T00:00:01.000Z",
        expires_at: "1970-01-01T00:00:02.000Z",
        context_generation_hash: CONTEXT_HASH,
        profile: validProfile,
      },
      {
        horizon_hours: 48,
        cached_at: "1970-01-01T00:00:01.000Z",
        expires_at: "1970-01-01T00:00:02.000Z",
        context_generation_hash: `sha256:${"b".repeat(64)}`,
        profile: profileFor(48, 8),
      },
    ],
  };
  const worker = new FakeWorker();
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    seedSnapshot: snapshot,
    now: () => 1_500,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
  });

  assert.equal((await provider.get(24)).generation, 7);
  assert.equal(worker.messages.length, 0, "unexpired seed must be served directly");
  const invalidSeedRequest = provider.get(48);
  assert.equal(worker.messages.length, 1, "mismatched lineage must not seed the cache");
  await provider.stop();
  await assert.rejects(
    invalidSeedRequest,
    (error) => error.code === "probability_profile_provider_stopped",
  );
});

test("persistent snapshot seed rejects an old profile detail schema", async () => {
  const oldProfile = profileFor(24, 9);
  oldProfile.detail_schema_version = "probability-threshold-profile/0";
  const worker = new FakeWorker();
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    seedSnapshot: {
      schema_version: PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
      generated_at: "1970-01-01T00:00:01.000Z",
      profiles: [{
        horizon_hours: 24,
        cached_at: "1970-01-01T00:00:01.000Z",
        expires_at: "1970-01-01T00:00:02.000Z",
        context_generation_hash: CONTEXT_HASH,
        profile: oldProfile,
      }],
    },
    now: () => 1_500,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
  });

  const request = provider.get(24);
  assert.equal(worker.messages.length, 1, "old detail schema must be cold-loaded");
  await provider.stop();
  await assert.rejects(
    request,
    (error) => error.code === "probability_profile_provider_stopped",
  );
});

test("worker crash fails the current request and the next request lazily recovers", async () => {
  const workers = [];
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 1_000,
    workerFactory() {
      const worker = workers.length === 0
        ? new FakeWorker((_message, instance) => {
            queueMicrotask(() => instance.emit("error", new Error("boom")));
          })
        : new FakeWorker((message, instance) =>
            successfulResponse(message, instance, Date.now() + 1_000)
          );
      workers.push(worker);
      return worker;
    },
  });

  await assert.rejects(
    provider.get(4),
    (error) => error.code === "probability_profile_worker_crashed",
  );
  assert.equal((await provider.get(4)).horizon_hours, 4);
  assert.equal(workers.length, 2);
  await provider.stop();
});

test("worker request timeout is bounded and terminates the stuck worker", async () => {
  const worker = new FakeWorker();
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 20,
    workerFactory: () => worker,
  });

  await assert.rejects(
    provider.get(4),
    (error) => error.code === "probability_profile_worker_timeout",
  );
  assert.equal(worker.terminateCalls, 1);
  await provider.stop();
});

test("background batch warm has an independent longer timeout budget", async () => {
  assert.equal(PROBABILITY_PROFILE_WARM_TIMEOUT_MS, 120_000);
  const worker = new FakeWorker();
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 1_000,
    warmRequestTimeoutMs: 20,
    workerFactory: () => worker,
  });

  await assert.rejects(
    provider.warm([4, 24]),
    (error) =>
      error.code === "probability_profile_worker_timeout" &&
      error.message.includes("20 ms"),
  );
  assert.equal(worker.terminateCalls, 1);
  await provider.stop();
});

test("graceful stop rejects in-flight work and terminates the worker once", async () => {
  const worker = new FakeWorker();
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
  });

  const rejected = assert.rejects(
    provider.get(168),
    (error) => error.code === "probability_profile_provider_stopped",
  );
  const firstStop = provider.stop();
  assert.equal(provider.stop(), firstStop, "concurrent stops must share completion");
  await firstStop;
  await rejected;
  await provider.stop();
  assert.equal(worker.terminateCalls, 1);
  await assert.rejects(
    provider.get(168),
    (error) => error.code === "probability_profile_provider_stopped",
  );
});

test("stop wins a response race without repopulating the cache", async () => {
  const worker = new FakeWorker((message, instance) => {
    instance.emit("message", {
      type: "probability_profile_response",
      request_id: message.request_id,
      ok: true,
      context_expires_at: 10_000,
      profile: profileFor(message.horizon_hours),
    });
  });
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: "/tmp/probability-profile-worker-fixture",
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 1_000,
    workerFactory: () => worker,
  });

  const request = provider.get(4);
  await provider.stop();
  await assert.rejects(
    request,
    (error) => error.code === "probability_profile_provider_stopped",
  );
  await assert.rejects(
    provider.get(4),
    (error) => error.code === "probability_profile_provider_stopped",
  );
});

test("real worker batches one context without initializing or writing the data directory", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-readonly-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: directory,
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 5_000,
    warmRequestTimeoutMs: 5_000,
    contextTtlMs: 1_000,
    profileCacheTtlMs: 1_000,
  });
  t.after(() => provider.stop());

  const profiles = await provider.warm([4, 24]);
  const profile = profiles.get(4);
  assert.equal(profile.horizon_hours, 4);
  assert.equal(profile.status, "insufficient");
  assert.equal(profile.reason, "issued_evaluation_not_ready");
  assert.equal(
    profile.lineage.context_generation_hash,
    profiles.get(24).lineage.context_generation_hash,
  );
  assert.deepEqual(await fs.readdir(directory), []);
});

test("real worker force refresh discards its cached context", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-force-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: directory,
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 5_000,
    contextTtlMs: 60_000,
    profileCacheTtlMs: 60_000,
  });
  t.after(() => provider.stop());

  const initial = await provider.get(4);
  assert.equal(initial.reason, "issued_evaluation_not_ready");
  await store.writeState("issued-evaluation-summary", {
    evaluation_cutoff: "invalid",
    evaluation_artifact_hash: "changed-artifact",
  });
  const refreshed = (await provider.refresh([4], { force: true })).get(4);
  assert.equal(refreshed.reason, "issued_evaluation_incompatible");
  assert.notEqual(
    refreshed.lineage.context_generation_hash,
    initial.lineage.context_generation_hash,
  );
});

test("calibration route preserves the full contract and offers a compact cacheable projection", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-web-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const requested = [];
  let fail = false;
  const handler = createRequestHandler({
    store,
    config: { runtime: { public_base_url: "https://reset.example" } },
    probabilityProfileProvider: {
      async get(horizonHours, options) {
        requested.push({ horizonHours, options });
        if (fail) {
          const error = new Error("worker unavailable");
          if (fail === "warming") error.code = "probability_profile_warming";
          throw error;
        }
        return {
          schema_version: "notification-threshold-calibration/1",
          detail_schema_version: "probability-threshold-profile/1",
          reason: null,
          preliminary: false,
          horizon_hours: horizonHours,
          evaluation_cutoff: "2026-08-11T00:00:00.000Z",
          model_release: "hourly-hazard-v1",
          status: "available",
          sample_count: 100,
          min_sample_count: 20,
          event_count: 10,
          min_event_count: 1,
          sample_gate: {
            minimum_windows: 20,
            minimum_events: 1,
            evaluated_windows: 100,
            evaluated_events: 10,
            windows_passed: true,
            events_passed: true,
            passed: true,
          },
          distribution: { bins: ["must not cross the API"] },
          distribution_summary: {
            mean_probability: 0.3,
            standard_deviation: 0.05,
            observed_range: { lower: 0.1, upper: 0.5 },
            display_range: {
              lower: 0.1,
              upper: 0.5,
              standard_deviations: 4,
              clipped_below: 0,
              clipped_above: 0,
            },
            suggested_threshold: {
              probability: 0.4,
              standard_deviations: 2,
            },
          },
          lineage: { context_generation_hash: CONTEXT_HASH },
          points: [{
            probability: 0.2,
            density: 0.5,
            confidence_above: 0.4,
            historical_hit_rate_above: 0.4,
            sample_count_above: 50,
            confidence_interval: {
              lower: 0.2,
              upper: 0.6,
              level: 0.95,
              method: "wilson_score",
            },
            point_sample_gate: {
              minimum_windows: 20,
              evaluated_windows: 50,
              passed: true,
            },
            event_recall: 1,
          }],
        };
      },
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const full = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=24`,
  );
  assert.equal(full.status, 200);
  assert.equal(
    full.headers.get("cache-control"),
    "public, max-age=600, stale-while-revalidate=3600",
  );
  const fullPayload = await full.json();
  assert.deepEqual(fullPayload.distribution, { bins: ["must not cross the API"] });
  assert.equal(fullPayload.lineage.context_generation_hash, CONTEXT_HASH);
  assert.equal(fullPayload.points[0].event_recall, 1);

  const available = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=24&view=compact`,
  );
  assert.equal(available.status, 200);
  const etag = available.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  const payload = await available.json();
  assert.equal(
    payload.schema_version,
    "notification-threshold-calibration-compact/1",
  );
  assert.equal(
    payload.profile_schema_version,
    "notification-threshold-calibration/1",
  );
  assert.equal(payload.horizon_hours, 24);
  assert.equal(payload.detail_schema_version, "probability-threshold-profile/1");
  assert.equal(payload.reason, null);
  assert.equal(payload.preliminary, false);
  assert.equal(payload.evaluation_cutoff, "2026-08-11T00:00:00.000Z");
  assert.equal(payload.model_release, "hourly-hazard-v1");
  assert.equal(payload.sample_gate.passed, true);
  assert.equal(payload.distribution, undefined);
  assert.equal(payload.distribution_summary.display_range.lower, 0.1);
  assert.equal(payload.lineage, undefined);
  assert.equal(payload.points[0].event_recall, undefined);

  const conditional = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=24&view=compact`,
    { headers: { "if-none-match": etag } },
  );
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get("etag"), etag);
  fail = "warming";
  const warming = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=36&view=compact`,
  );
  assert.equal(warming.status, 503);
  assert.equal(warming.headers.get("retry-after"), "5");
  const warmingPayload = await warming.json();
  assert.equal(warmingPayload.error, "notification_calibration_warming");
  assert.equal(
    warmingPayload.message,
    "历史可靠度正在后台预热，请几秒后重试。",
  );
  fail = true;
  const unavailable = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=48`,
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.equal((await unavailable.json()).error, "notification_calibration_unavailable");
  assert.deepEqual(
    requested.map(({ horizonHours }) => horizonHours),
    [24, 24, 24, 36, 48],
  );
  assert.ok(requested.every(({ options }) => options.waitForWarm === false));
});
