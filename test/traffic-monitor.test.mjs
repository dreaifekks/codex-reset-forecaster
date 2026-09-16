import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizedOperationsRequest,
  readProtectedToken,
  TrafficMonitor,
  trafficRouteClass,
} from "../src/operations/traffic-monitor.mjs";
import { createOperationsRuntime } from "../src/operations/runtime.mjs";
import { createRequestHandler } from "../src/web/app.mjs";
import { formatOperationsAlert } from "../src/telegram/format.mjs";

function memoryAdapter(initial = null) {
  let state = initial;
  return {
    async read() {
      return state === null ? null : structuredClone(state);
    },
    async write(value) {
      state = structuredClone(value);
    },
    snapshot() {
      return state === null ? null : structuredClone(state);
    },
  };
}

test("provider failures and recoveries persist once across restarts on the admin stream", async () => {
  const adapter = memoryAdapter();
  const at = new Date("2026-09-16T04:00:00Z");
  let monitor = await new TrafficMonitor({ stateAdapter: adapter, now: () => at }).init();
  const provider = {
    provider_id: "historical_monitor", enabled: true, status: "error",
    required_for_serving: false, last_success_at: null, last_error: "archive markup changed",
  };
  monitor.updateProviderHealth({ providers: { historical_monitor: provider } });
  assert.equal(monitor.listAlerts(0).alerts.length, 0, "unpersisted alerts must not be served");
  await monitor.flush();
  assert.equal(monitor.listAlerts(0).alerts.length, 1);
  monitor = await new TrafficMonitor({ stateAdapter: adapter, now: () => at }).init();
  monitor.updateProviderHealth({ providers: { historical_monitor: provider } });
  await monitor.flush();
  assert.equal(monitor.listAlerts(0).alerts.length, 1);
  const [failure] = monitor.listAlerts(0).alerts;
  assert.equal(failure.alert_type, "provider.failed");
  assert.match(formatOperationsAlert(failure), /historical_monitor[\s\S]*参考来源[\s\S]*不会暂停[\s\S]*archive markup changed/);
  assert.match(formatOperationsAlert(failure, { locale: "en" }), /Reference source/);
  monitor.updateProviderHealth({ providers: { historical_monitor: { ...provider, status: "fresh", last_error: null } } });
  await monitor.flush();
  assert.deepEqual(monitor.listAlerts(0).alerts.map((a) => a.alert_type), ["provider.failed", "provider.recovered"]);
  assert.equal(monitor.listAlerts(0).alerts[1].incident_id, failure.incident_id);
  const v2 = adapter.snapshot();
  v2.schema_version = "traffic-monitor-state/2";
  v2.alerts = v2.alerts.map(({ provider, ...alert }) => ({
    ...alert, alert_type: alert.level === "normal" ? "capacity.recovered" : "capacity.strained",
    incident_id: "capacity:legacy", policy_version: "traffic-capacity-policy/1", policy_hash: monitor.policyHash,
  }));
  delete v2.provider_health;
  await adapter.write(v2);
  monitor = await new TrafficMonitor({ stateAdapter: adapter, now: () => at }).init();
  assert.equal(monitor.listAlerts().cursor, 2);
  assert.deepEqual(monitor.listAlerts(0).alerts, v2.alerts);
  await monitor.flush();
  assert.equal(adapter.snapshot().schema_version, "traffic-monitor-state/3");
});

test("traffic monitor stores bounded origin aggregates without request identity", async () => {
  const adapter = memoryAdapter();
  let current = new Date("2026-08-10T12:00:00.000Z");
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
  }).init();
  for (let offset = 8; offset >= 2; offset -= 1) {
    current = new Date(`2026-08-${String(10 - offset).padStart(2, "0")}T12:00:00.000Z`);
    for (let index = 0; index < 100; index += 1) {
      monitor.recordObservation({ category: "page", status: 200, latencyMs: 10 });
    }
  }
  current = new Date("2026-08-09T12:00:00.000Z");
  for (let index = 0; index < 400; index += 1) {
    monitor.recordObservation({ category: "interactive_api", status: 200, latencyMs: 20 });
  }
  current = new Date("2026-08-10T12:00:00.000Z");
  monitor.recordObservation({ category: "page", status: 200, latencyMs: 12 });
  monitor.recordObservation({ category: "internal_health", status: 503, latencyMs: 1 });
  monitor.recordObservation({ category: "delivery_poll", status: 200, latencyMs: 2 });
  monitor.recordObservation({ category: "interactive_api", status: 500, latencyMs: 30 });
  const summary = monitor.summary();
  assert.equal(summary.scope, "origin_only");
  assert.equal(summary.traffic.current.requests, 2);
  assert.equal(summary.traffic.current.total_origin_requests, 4);
  assert.equal(summary.traffic.yesterday.requests, 400);
  assert.equal(summary.traffic.seven_days.median_daily_requests, 100);
  assert.equal(summary.traffic.growth.status, "watch");
  assert.equal(summary.traffic.growth.watch, true);
  assert.equal(summary.privacy.stores_ip, false);
  assert.equal(summary.privacy.stores_query, false);
  await monitor.flush();
  const serialized = JSON.stringify(adapter.snapshot());
  assert.doesNotMatch(serialized, /secret-query|user-agent|client-ip/i);
  assert.equal(trafficRouteClass("/api/forecast/current?secret-query=1"), "interactive_api");
  assert.equal(
    trafficRouteClass(
      "/feeds/probability.xml?horizon_hours=24&probability_threshold=0.5",
    ),
    "feed",
  );
});

test("capacity alerts require sustained pressure and recover without entering publication", async () => {
  const adapter = memoryAdapter();
  let current = new Date("2026-08-10T00:00:00.000Z");
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 3,
      criticalWindows: 2,
      recoveryWindows: 2,
    },
  }).init();
  for (let minute = 0; minute < 3; minute += 1) {
    current = new Date(Date.parse("2026-08-10T00:00:00.000Z") + minute * 60_000);
    monitor.recordObservation({
      category: "interactive_api",
      status: 200,
      latencyMs: 1_000,
    });
    monitor.recordRuntimeSample({ lagMs: 200, elu: 0.8, heapRatio: 0.2 });
    monitor.evaluate();
  }
  assert.equal(monitor.summary().capacity.level, "strained");
  await monitor.flush();
  const baseline = monitor.listAlerts();
  assert.deepEqual(baseline.alerts, []);
  assert.equal(baseline.cursor, 1);
  const opened = monitor.listAlerts(0);
  assert.equal(opened.alerts.length, 1);
  assert.equal(opened.alerts[0].alert_type, "capacity.opened");
  assert.match(opened.alerts[0].summary, /interactive_p95/);
  const incidentId = opened.alerts[0].incident_id;
  assert.match(incidentId, /^capacity:/);

  for (let minute = 3; minute < 5; minute += 1) {
    current = new Date(Date.parse("2026-08-10T00:00:00.000Z") + minute * 60_000);
    monitor.recordObservation({ category: "interactive_api", status: 200, latencyMs: 10 });
    monitor.recordRuntimeSample({ lagMs: 5, elu: 0.1, heapRatio: 0.2 });
    monitor.evaluate();
  }
  assert.equal(monitor.summary().capacity.level, "normal");
  await monitor.flush();
  const recovered = monitor.listAlerts(1);
  assert.equal(recovered.alerts.length, 1);
  assert.equal(recovered.alerts[0].alert_type, "capacity.recovered");
  assert.equal(recovered.alerts[0].incident_id, incidentId);
  assert.equal("topic" in recovered.alerts[0], false);
});

test("one severe pulse cannot be recounted by overlapping rolling windows", async () => {
  const adapter = memoryAdapter();
  let current = new Date("2026-08-10T00:00:00.000Z");
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 5,
      minimumInteractiveRequests: 20,
      minimumRuntimeSamples: 12,
      criticalWindows: 2,
    },
  }).init();
  monitor.recordObservation({
    category: "interactive_api",
    status: 200,
    latencyMs: 4_000,
  });
  for (let index = 0; index < 12; index += 1) {
    monitor.recordRuntimeSample({
      lagMs: index === 0 ? 600 : 1,
      elu: index === 0 ? 0.95 : 0.1,
      heapRatio: 0.1,
      cgroupMemoryRatio: index === 0 ? 0.91 : 0.2,
    });
  }
  monitor.evaluate();
  assert.equal(monitor.summary().capacity.consecutive_windows.critical, 1);

  current = new Date("2026-08-10T00:01:00.000Z");
  monitor.recordRuntimeSample({ lagMs: 1, elu: 0.1, heapRatio: 0.1 });
  monitor.evaluate();
  assert.equal(monitor.summary().capacity.consecutive_windows.critical, 1);

  current = new Date("2026-08-10T00:05:00.000Z");
  for (let index = 0; index < 12; index += 1) {
    monitor.recordRuntimeSample({ lagMs: 1, elu: 0.1, heapRatio: 0.1 });
  }
  monitor.evaluate();
  assert.equal(monitor.summary().capacity.level, "normal");
  assert.equal(monitor.summary().capacity.consecutive_windows.critical, 0);
  assert.equal(monitor.listAlerts(0).alerts.length, 0);
});

test("changing the capacity policy resets old streak evidence", async () => {
  const adapter = memoryAdapter();
  let current = new Date("2026-08-10T00:00:00.000Z");
  const first = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 3,
    },
  }).init();
  for (let minute = 0; minute < 2; minute += 1) {
    current = new Date(Date.parse("2026-08-10T00:00:00.000Z") + minute * 60_000);
    first.recordObservation({
      category: "interactive_api",
      status: 200,
      latencyMs: 1_000,
    });
    first.recordRuntimeSample({ lagMs: 200, elu: 0.8, heapRatio: 0.1 });
    first.evaluate();
  }
  assert.equal(first.summary().capacity.consecutive_windows.strained, 2);
  await first.flush();

  const second = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 2,
      strainedWindows: 3,
    },
  }).init();
  assert.equal(second.summary().capacity.level, "normal");
  assert.equal(second.summary().capacity.consecutive_windows.strained, 0);
});

test("an active incident is explicitly superseded when its policy changes", async () => {
  const adapter = memoryAdapter();
  const current = new Date("2026-08-10T00:00:00.000Z");
  const first = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 1,
    },
  }).init();
  first.recordObservation({
    category: "interactive_api",
    status: 200,
    latencyMs: 1_000,
  });
  first.recordRuntimeSample({ lagMs: 200, elu: 0.8, heapRatio: 0.1 });
  first.evaluate();
  await first.flush();
  const opened = first.listAlerts(0).alerts[0];

  const second = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 2,
      strainedWindows: 1,
    },
  }).init();
  assert.equal(second.summary().capacity.level, "normal");
  await second.flush();
  const superseded = second.listAlerts(opened.sequence).alerts[0];
  assert.equal(superseded.alert_type, "capacity.policy_superseded");
  assert.equal(superseded.incident_id, opened.incident_id);
  assert.equal(superseded.superseded_policy_hash, opened.policy_hash);
});

test("legacy traffic state migrates without trusting old alert semantics", async () => {
  const adapter = memoryAdapter();
  const current = new Date("2026-08-10T00:00:00.000Z");
  const first = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 1,
    },
  }).init();
  first.recordObservation({ category: "interactive_api", latencyMs: 1_000 });
  first.recordRuntimeSample({ lagMs: 200, elu: 0.8, heapRatio: 0.1 });
  first.evaluate();
  await first.flush();
  const legacy = adapter.snapshot();
  legacy.schema_version = "traffic-monitor-state/1";
  delete legacy.active_policy_hash;
  delete legacy.alerts[0].incident_id;
  await adapter.write(legacy);

  const second = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
  }).init();
  assert.equal(second.summary().capacity.level, "normal");
  assert.equal(second.listAlerts().cursor, 0);
  assert.equal(adapter.snapshot().schema_version, "traffic-monitor-state/3");
});

test("traffic state rejects a non-contiguous or fictional alert tail", async () => {
  const adapter = memoryAdapter();
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 1,
    },
  }).init();
  monitor.recordObservation({ category: "interactive_api", latencyMs: 1_000 });
  monitor.recordRuntimeSample({ lagMs: 200, elu: 0.8, heapRatio: 0.1 });
  monitor.evaluate();
  await monitor.flush();
  const broken = adapter.snapshot();
  broken.next_alert_sequence = 10;
  await adapter.write(broken);
  await assert.rejects(
    new TrafficMonitor({ stateAdapter: adapter }).init(),
    /alert tail sequence/,
  );
});

test("traffic state rejects pressure levels without a coherent incident", async () => {
  const adapter = memoryAdapter();
  const monitor = await new TrafficMonitor({ stateAdapter: adapter }).init();
  await monitor.flush();
  const broken = adapter.snapshot();
  broken.pressure.level = "critical";
  broken.pressure.incident_id = null;
  broken.pressure.opened_at = null;
  await adapter.write(broken);
  await assert.rejects(
    new TrafficMonitor({ stateAdapter: adapter }).init(),
    /pressure incident state/,
  );
});

test("a retention gap rebases to the earliest still replayable alert", async () => {
  const adapter = memoryAdapter();
  let current = new Date("2026-08-10T00:00:00.000Z");
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    options: {
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 1,
      recoveryWindows: 1,
    },
  }).init();
  for (let sequence = 0; sequence < 258; sequence += 1) {
    current = new Date(Date.parse("2026-08-10T00:00:00.000Z") + sequence * 60_000);
    if (sequence % 2 === 0) {
      monitor.recordObservation({
        category: "interactive_api",
        latencyMs: 1_000,
      });
      monitor.recordRuntimeSample({ lagMs: 200, elu: 0.8, heapRatio: 0.1 });
    } else {
      monitor.recordRuntimeSample({ lagMs: 1, elu: 0.1, heapRatio: 0.1 });
    }
    monitor.evaluate();
  }
  await monitor.flush();
  assert.throws(
    () => monitor.listAlerts(0),
    (error) =>
      error.code === "operations_alert_cursor_reset_required" &&
      error.reason === "retention_gap" &&
      error.cursor === 2,
  );
  const replay = monitor.listAlerts(2);
  assert.equal(replay.alerts[0].sequence, 3);
  assert.equal(replay.has_more, true);
});

test("response finish and close settle one request and semantic health 503 is not a true error", async () => {
  const adapter = memoryAdapter();
  const monitor = await new TrafficMonitor({ stateAdapter: adapter }).init();
  const response = new EventEmitter();
  response.statusCode = 503;
  response.writableFinished = true;
  monitor.observe({
    url: "/api/health?ignored=yes",
    headers: { "user-agent": "private-agent", "cf-connecting-ip": "192.0.2.1" },
  }, response);
  response.emit("finish");
  response.emit("close");
  monitor.recordObservation({
    category: "interactive_api",
    status: 503,
    semanticUnavailable: true,
  });
  monitor.recordObservation({ category: "interactive_api", status: 503 });
  const summary = monitor.summary();
  assert.equal(summary.traffic.current.total_origin_requests, 3);
  assert.equal(summary.traffic.current.requests, 2);
  assert.equal(summary.capacity.rolling_window.true_errors, 1);
  await monitor.flush();
  const persisted = JSON.stringify(adapter.snapshot());
  assert.doesNotMatch(persisted, /private-agent|192\.0\.2\.1|ignored/);
});

test("runtime-only sampling stays bounded and a missing yesterday never invents growth", async () => {
  const adapter = memoryAdapter();
  let current = new Date("2026-08-10T00:00:00.000Z");
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
  }).init();
  for (let minute = 0; minute < 100; minute += 1) {
    current = new Date(Date.parse("2026-08-10T00:00:00.000Z") + minute * 60_000);
    monitor.recordRuntimeSample({ lagMs: 1, elu: 0.1, heapRatio: 0.1 });
  }
  await monitor.flush();
  assert.equal(Object.keys(adapter.snapshot().minutes).length, 60);
  current = new Date("2026-08-20T00:00:00.000Z");
  assert.equal(monitor.summary().traffic.growth.status, "insufficient_data");
  assert.equal(monitor.summary().traffic.growth.watch, false);
});

test("operations token is file-only, mode-safe, and compared exactly", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "token");
  const token = "t".repeat(48);
  await fs.writeFile(filePath, `${token}\n`, { mode: 0o600 });
  assert.equal(await readProtectedToken(filePath), token);
  assert.equal(authorizedOperationsRequest({
    headers: { authorization: `Bearer ${token}` },
  }, token), true);
  assert.equal(authorizedOperationsRequest({
    headers: { authorization: `Bearer ${token}x` },
  }, token), false);
  await fs.chmod(filePath, 0o644);
  await assert.rejects(readProtectedToken(filePath), /mode must be 0400 or 0600/);
});

test("a corrupt operations state disables monitoring without taking down the model UI", async () => {
  const errors = [];
  const runtime = await createOperationsRuntime({
    store: {
      async readState() {
        throw new SyntaxError("broken traffic state");
      },
      async writeState() {},
    },
    env: { TRAFFIC_MONITOR_ENABLED: "true" },
    logger: { error(message) { errors.push(message); } },
  });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.monitor, null);
  assert.match(runtime.initializationError, /broken traffic state/);
  assert.match(errors[0], /traffic monitor initialization failed/);
});

test("nested corrupt traffic buckets fail closed during initialization", async () => {
  const adapter = memoryAdapter();
  const monitor = await new TrafficMonitor({ stateAdapter: adapter }).init();
  monitor.recordRuntimeSample({ lagMs: 1, elu: 0.1, heapRatio: 0.1 });
  await monitor.flush();
  const broken = adapter.snapshot();
  Object.values(broken.minutes)[0].event_loop_lag.buckets = ["bad"];
  const runtime = await createOperationsRuntime({
    store: {
      async readState() { return broken; },
      async writeState() {},
    },
    env: { TRAFFIC_MONITOR_ENABLED: "true" },
    logger: { error() {} },
  });
  assert.equal(runtime.enabled, false);
  assert.match(runtime.initializationError, /histogram/);
});

test("a bad operations token disables authorization without taking down monitoring", async () => {
  const errors = [];
  const adapter = memoryAdapter();
  const runtime = await createOperationsRuntime({
    store: {
      readState: () => adapter.read(),
      writeState: (_key, state) => adapter.write(state),
    },
    env: {
      TRAFFIC_MONITOR_ENABLED: "true",
      FORECASTER_OPERATIONS_TOKEN_FILE: "/definitely/missing/ops-token",
    },
    logger: { error(message) { errors.push(message); } },
  });
  assert.equal(runtime.enabled, true);
  assert.ok(runtime.monitor);
  assert.match(runtime.authorizationError, /ENOENT/);
  assert.equal(runtime.authorize({ headers: {} }), false);
  assert.match(errors[0], /operations authorization disabled/);
});

test("stop waits for an active runtime sample before the final flush", async () => {
  const adapter = memoryAdapter();
  const callbacks = [];
  let releaseReads;
  const readsReleased = new Promise((resolve) => { releaseReads = resolve; });
  let firstReadStarted;
  const readStarted = new Promise((resolve) => { firstReadStarted = resolve; });
  let readCount = 0;
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    timers: {
      setInterval(callback) {
        callbacks.push(callback);
        return { unref() {} };
      },
      clearInterval() {},
    },
    readFile: async (filePath) => {
      readCount += 1;
      if (readCount === 1) firstReadStarted();
      await readsReleased;
      return filePath.endsWith("memory.max") ? "1000" : "100";
    },
    options: { sampleIntervalMs: 1_000, flushIntervalMs: 5_000 },
  }).init();
  monitor.start();
  callbacks[0]();
  await readStarted;
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseReads();
  await stopping;
  const persisted = adapter.snapshot();
  const sampleCount = Object.values(persisted.minutes)
    .reduce((total, bucket) => total + bucket.event_loop_lag.count, 0);
  assert.equal(sampleCount, 1);
});

test("an automatic capacity transition is persisted before it becomes visible", async () => {
  const adapter = memoryAdapter();
  const callbacks = [];
  const current = new Date("2026-08-10T00:01:00.000Z");
  const monitor = await new TrafficMonitor({
    stateAdapter: adapter,
    now: () => current,
    timers: {
      setInterval(callback) {
        callbacks.push(callback);
        return { unref() {} };
      },
      clearInterval() {},
    },
    readFile: async (filePath) =>
      filePath.endsWith("memory.max") ? "1000" : "100",
    options: {
      sampleIntervalMs: 1_000,
      flushIntervalMs: 5_000,
      windowMinutes: 1,
      minimumRequests: 1,
      minimumInteractiveRequests: 1,
      strainedWindows: 1,
    },
  }).init();
  const evidenceAt = new Date("2026-08-10T00:00:00.000Z");
  monitor.recordObservation({
    category: "interactive_api",
    status: 200,
    latencyMs: 1_000,
    at: evidenceAt,
  });
  monitor.recordRuntimeSample({
    lagMs: 200,
    elu: 0.8,
    heapRatio: 0.1,
    at: evidenceAt,
  });
  monitor.start();
  callbacks[0]();
  await monitor.waitForIdle();
  const persisted = adapter.snapshot();
  assert.equal(persisted.pressure.level, "strained");
  assert.equal(persisted.pressure.last_evaluated_minute,
    "2026-08-10T00:00:00.000Z");
  assert.equal(persisted.pressure.last_transition_at, current.toISOString());
  assert.equal(persisted.pressure.opened_at, current.toISOString());
  assert.equal(persisted.updated_at, current.toISOString());
  assert.equal(persisted.alerts.length, 1);
  assert.equal(persisted.alerts[0].emitted_at, current.toISOString());
  assert.equal(persisted.alerts[0].observed_at, current.toISOString());
  assert.equal(monitor.listAlerts(0).alerts.length, 1);
  await monitor.stop();
});

test("live and operations routes are cheap, protected, and use an independent cursor", async (t) => {
  const adapter = memoryAdapter();
  const now = () => new Date("2026-08-10T12:00:00.000Z");
  const monitor = await new TrafficMonitor({ stateAdapter: adapter, now }).init();
  monitor.recordObservation({ category: "page", status: 200, latencyMs: 10 });
  const handler = createRequestHandler({
    store: {},
    config: { runtime: { public_base_url: "https://reset.example" } },
    now,
    trafficMonitor: monitor,
    operationsService: {
      authorize(request) {
        return request.headers.authorization === "Bearer secret";
      },
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/live`)).status, 200);
  assert.equal((await fetch(`${base}/api/operations/traffic`)).status, 401);
  const traffic = await fetch(`${base}/api/operations/traffic`, {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(traffic.status, 200);
  assert.equal((await traffic.json()).schema_version, "traffic-monitor-summary/1");
  const alerts = await fetch(`${base}/api/operations/traffic/alerts`, {
    headers: { authorization: "Bearer secret" },
  });
  assert.deepEqual(await alerts.json(), {
    alerts: [],
    cursor: 0,
    next_cursor: "0",
    has_more: false,
  });
  const reset = await fetch(`${base}/api/operations/traffic/alerts?after=1`, {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(reset.status, 409);
  assert.deepEqual(await reset.json(), {
    error: "operations_alert_cursor_reset_required",
    reason: "ahead_of_tail",
    cursor: 0,
    next_cursor: "0",
    has_more: false,
  });
});

test("an observation failure cannot fail the website liveness path", async (t) => {
  const handler = createRequestHandler({
    store: {},
    config: { runtime: { public_base_url: "https://reset.example" } },
    trafficMonitor: {
      observe() {
        throw new Error("telemetry broken");
      },
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/live`,
  );
  assert.equal(response.status, 200);
});
