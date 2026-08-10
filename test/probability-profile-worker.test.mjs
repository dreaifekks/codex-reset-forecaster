import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProbabilityProfileWorkerProvider,
} from "../src/query/probability-profile-worker.mjs";
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

function successfulResponse(message, worker, contextExpiresAt = 10_000) {
  queueMicrotask(() => worker.emit("message", {
    type: "probability_profile_response",
    request_id: message.request_id,
    ok: true,
    context_expires_at: contextExpiresAt,
    profile: {
      schema_version: "notification-threshold-calibration/1",
      horizon_hours: message.horizon_hours,
    },
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
  await provider.stop();
  await rejected;
  await provider.stop();
  assert.equal(worker.terminateCalls, 1);
});

test("real worker reads an existing data directory without initializing or writing it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-readonly-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = createProbabilityProfileWorkerProvider({
    dataDir: directory,
    config: MINIMAL_CONFIG,
    requestTimeoutMs: 5_000,
    contextTtlMs: 1_000,
    profileCacheTtlMs: 1_000,
  });
  t.after(() => provider.stop());

  const profile = await provider.get(4);
  assert.equal(profile.horizon_hours, 4);
  assert.equal(profile.status, "insufficient");
  assert.equal(profile.reason, "issued_evaluation_not_ready");
  assert.deepEqual(await fs.readdir(directory), []);
});

test("calibration route uses its injected provider and maps provider failure to 503", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-web-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const requested = [];
  let fail = false;
  const handler = createRequestHandler({
    store,
    config: { runtime: { public_base_url: "https://reset.example" } },
    probabilityProfileProvider: {
      async get(horizonHours) {
        requested.push(horizonHours);
        if (fail) throw new Error("worker unavailable");
        return {
          schema_version: "notification-threshold-calibration/1",
          horizon_hours: horizonHours,
        };
      },
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const available = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=24`,
  );
  assert.equal(available.status, 200);
  assert.equal((await available.json()).horizon_hours, 24);
  fail = true;
  const unavailable = await fetch(
    `${base}/api/notification-preferences/calibration?horizon_hours=48`,
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "notification_calibration_unavailable");
  assert.deepEqual(requested, [24, 48]);
});
