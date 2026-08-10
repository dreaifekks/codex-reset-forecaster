import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  NOTIFICATION_HORIZON_HOURS,
  calibrationAt,
  createNotificationCalibrationCache,
  formatNotificationHorizon,
  nearestHorizonIndex,
  normalizeCalibrationPayload,
} from "../public/notification-preferences.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

class FakeClassList {
  #values = new Set();

  add(...values) {
    for (const value of values) this.#values.add(value);
  }

  remove(...values) {
    for (const value of values) this.#values.delete(value);
  }

  contains(value) {
    return this.#values.has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.#values.has(value) : Boolean(force);
    if (enabled) this.#values.add(value);
    else this.#values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.open = false;
    this.textContent = "";
    this.innerHTML = "";
  }

  addEventListener() {}

  append(...children) {
    this.children.push(...children);
  }

  prepend(...children) {
    this.children.unshift(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "open") this.open = true;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "open") this.open = false;
  }

  querySelector() {
    return new FakeElement();
  }

  querySelectorAll() {
    return [];
  }

  contains() {
    return false;
  }

  closest() {
    return null;
  }

  matches() {
    return false;
  }

  focus() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

function jsonResponse(data, { ok = true, status = ok ? 200 : 500 } = {}) {
  return {
    ok,
    status,
    async json() {
      return data;
    },
  };
}

function calibrationResponse(horizonHours) {
  return jsonResponse({
    schema_version: "notification-threshold-calibration/1",
    horizon_hours: horizonHours,
    status: "available",
    sample_count: 40,
    min_sample_count: 20,
    event_count: 4,
    min_event_count: 1,
    points: [
      {
        probability: 0.2,
        density: 0.5,
        confidence_above: 0.4,
        sample_count_above: 30,
        point_sample_gate: {
          minimum_windows: 20,
          evaluated_windows: 30,
          passed: true,
        },
      },
      {
        probability: 0.8,
        density: 0.25,
        confidence_above: 0.7,
        sample_count_above: 20,
        point_sample_gate: {
          minimum_windows: 20,
          evaluated_windows: 20,
          passed: true,
        },
      },
    ],
  });
}

function createManualTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    count(delay) {
      return [...pending.values()].filter((timer) => timer.delay === delay).length;
    },
    runNext(delay) {
      const match = [...pending.entries()].find(([, timer]) => timer.delay === delay);
      if (!match) return false;
      const [id, timer] = match;
      pending.delete(id);
      timer.callback();
      return true;
    },
  };
}

async function settleAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function createHarness(fetchImpl, {
  nowMs = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const elements = new Map();
  const evidenceSections = [
    new FakeElement("section"),
    new FakeElement("section"),
    new FakeElement("section"),
  ];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const observerInstances = [];
  const body = new FakeElement("body");
  const document = {
    body,
    visibilityState: "visible",
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === ".signal-grid, .context-grid, .pending-panel") {
        return evidenceSections;
      }
      return [];
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName);
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  const window = {
    location: {
      href: "https://forecast.example/",
      origin: "https://forecast.example",
    },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    requestAnimationFrame(callback) {
      callback();
    },
  };
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      observerInstances.push(this);
    }

    observe(target) {
      this.observed.push(target);
    }
  }
  window.IntersectionObserver = FakeIntersectionObserver;
  const ContextDate = nowMs === null
    ? Date
    : class ControlledDate extends Date {
        constructor(...args) {
          super(...(args.length === 0 ? [nowMs] : args));
        }

        static now() {
          return nowMs;
        }
      };

  const moduleSource = await fs.readFile(
    path.join(projectRoot, "public", "app.js"),
    "utf8",
  );
  const source = moduleSource.replace(
    /^import \{[\s\S]*?\} from "\.\/notification-preferences\.js";\s*/,
    "",
  );
  assert.notEqual(source, moduleSource, "test harness must bind frontend imports");
  const instrumented = source.replace(
    /\nvoid initializeWebPushControls\(\);\s*\n\s*void load\(\);\s*$/,
    `
globalThis.__frontendLazyTest = {
  predictionRefKey,
  safeSnapshotUrl,
  loadForecastSnapshot,
  forecastWithServing,
  renderDataStatus,
  loadEvidence,
  load,
  scheduleCadenceRefresh,
  loadNotificationCalibration,
  scheduleNotificationCalibration,
  openNotificationDialog,
  closeNotificationDialog,
  selectNotificationHorizon(hours) {
    notificationHorizon.value = String(nearestHorizonIndex(hours));
    renderNotificationValues();
    scheduleNotificationCalibration();
  },
  setEvidenceState({ visible, key, cutoff, loaded = null }) {
    evidenceVisible = visible;
    cachedForecastKey = key;
    latestForecastCutoff = cutoff;
    evidenceLoadedForKey = loaded;
  },
  state() {
    return {
      cachedForecastKey,
      cachedForecast,
      evidenceLoadedForKey,
      evidenceVisible,
      notificationCalibrationHorizon: notificationCalibration?.horizon_hours ?? null,
      notificationCalibrationGeneration,
      notificationDialogOpen: notificationDialog.open,
    };
  },
};`,
  );
  assert.notEqual(instrumented, source, "test harness must suppress automatic load");
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    Date: ContextDate,
    IntersectionObserver: FakeIntersectionObserver,
    URL,
    console,
    document,
    fetch: fetchImpl,
    navigator: { onLine: true },
    NOTIFICATION_HORIZON_HOURS,
    calibrationAt,
    createNotificationCalibrationCache,
    formatNotificationHorizon,
    nearestHorizonIndex,
    normalizeCalibrationPayload,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    window,
  });
  new vm.Script(instrumented, { filename: "public/app.js" }).runInContext(context);
  return {
    app: context.__frontendLazyTest,
    elements,
    evidenceSections,
    observerInstances,
    documentListeners,
    windowListeners,
  };
}

test("notification calibration stays dialog-lazy, debounces horizons, and reuses a session cache", async () => {
  const timers = createManualTimers();
  const calibrationCalls = [];
  const harness = await createHarness(async (url) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 7,
      });
    }
    if (url.startsWith("/api/notification-preferences/calibration?")) {
      const hours = Number(new URL(url, "https://forecast.example").searchParams.get("horizon_hours"));
      calibrationCalls.push(hours);
      return calibrationResponse(hours);
    }
    throw new Error(`unexpected request: ${url}`);
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  harness.app.selectNotificationHorizon(24);
  assert.deepEqual(calibrationCalls, []);
  assert.equal(timers.count(220), 0, "a closed dialog must not queue calibration work");

  harness.app.openNotificationDialog();
  assert.deepEqual(calibrationCalls, [], "opening queues, but does not bypass the debounce");
  assert.equal(timers.count(220), 1);
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  assert.deepEqual(calibrationCalls, [24]);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);

  harness.app.selectNotificationHorizon(28);
  harness.app.selectNotificationHorizon(32);
  assert.deepEqual(calibrationCalls, [24]);
  assert.equal(timers.count(220), 1, "rapid input keeps only the final horizon timer");
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  assert.deepEqual(calibrationCalls, [24, 32]);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 32);

  harness.app.selectNotificationHorizon(24);
  assert.deepEqual(calibrationCalls, [24, 32]);
  assert.equal(timers.count(220), 0, "a cached horizon renders without another wait");
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);

  harness.app.selectNotificationHorizon(28);
  assert.equal(timers.count(220), 1);
  harness.app.closeNotificationDialog();
  assert.equal(timers.count(220), 0, "closing invalidates the pending debounce");
  assert.equal(harness.app.state().notificationDialogOpen, false);
  assert.deepEqual(calibrationCalls, [24, 32]);
});

test("an aborted calibration generation cannot overwrite or seed the selected horizon", async () => {
  const timers = createManualTimers();
  const calibrationCalls = [];
  let releaseHorizon24;
  const horizon24Response = new Promise((resolve) => {
    releaseHorizon24 = resolve;
  });
  const harness = await createHarness(async (url) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 8,
      });
    }
    const hours = Number(new URL(url, "https://forecast.example").searchParams.get("horizon_hours"));
    calibrationCalls.push(hours);
    return hours === 24 ? horizon24Response : calibrationResponse(hours);
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  timers.runNext(220);
  await Promise.resolve();
  assert.deepEqual(calibrationCalls, [24]);

  harness.app.selectNotificationHorizon(28);
  timers.runNext(220);
  await settleAsyncWork();
  assert.deepEqual(calibrationCalls, [24, 28]);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 28);

  releaseHorizon24(calibrationResponse(24));
  await settleAsyncWork();
  assert.equal(
    harness.app.state().notificationCalibrationHorizon,
    28,
    "the old response must not replace the selected horizon",
  );

  harness.app.selectNotificationHorizon(24);
  assert.equal(
    timers.count(220),
    1,
    "a response from an aborted generation must not populate the cache",
  );
});

test("forecast snapshot loader validates same-origin refs, singleflights, and replaces cache atomically", async () => {
  const calls = [];
  let releaseFirst;
  const firstResponse = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const harness = await createHarness(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/prediction-a/1")) return firstResponse;
    return jsonResponse({
      record_type: "prediction",
      record_id: "prediction-a",
      revision: 1,
      data: {},
    });
  });
  const { app } = harness;
  const referenceA = {
    record_id: "prediction-a",
    revision: 1,
    snapshot_url: "/api/forecast/snapshots/prediction-a/1",
  };

  assert.equal(app.predictionRefKey(referenceA), "prediction-a@1");
  assert.equal(
    app.safeSnapshotUrl({ ...referenceA, snapshot_url: "https://evil.example/api/forecast/snapshots/a/1" }),
    null,
  );

  const first = app.loadForecastSnapshot(referenceA);
  const concurrent = app.loadForecastSnapshot(referenceA);
  await Promise.resolve();
  assert.equal(calls.length, 1, "same exact ref should share one in-flight request");
  assert.equal(calls[0].options.cache, "default");
  releaseFirst(jsonResponse({
    record_type: "prediction",
    record_id: "prediction-a",
    revision: 1,
    data: {},
  }));
  assert.equal((await first).ok, true);
  assert.equal((await concurrent).ok, true);

  assert.equal((await app.loadForecastSnapshot(referenceA)).ok, true);
  assert.equal(calls.length, 1, "resolved exact ref should use the in-memory snapshot");

  const referenceB = {
    record_id: "prediction-b",
    revision: 2,
    snapshot_url: "/api/forecast/snapshots/prediction-b/2",
  };
  const rejected = await app.loadForecastSnapshot(referenceB);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /版本不一致/);
  assert.equal(app.state().cachedForecastKey, "prediction-a@1");
  assert.equal(app.state().cachedForecast.record_id, "prediction-a");
});

test("evidence stays viewport-lazy and ignores a response from another forecast cutoff", async () => {
  const calls = [];
  let evidencePayload = {
    knowledge_cutoff: "2026-08-09T10:10:00.000Z",
    items: [],
  };
  const harness = await createHarness(async (url) => {
    calls.push(url);
    return jsonResponse(evidencePayload);
  });
  const { app, observerInstances, evidenceSections } = harness;
  assert.equal(observerInstances.length, 1);
  const [observer] = observerInstances;
  assert.equal(observer.options.rootMargin, "200px 0px");
  assert.deepEqual(observer.observed, evidenceSections);

  app.setEvidenceState({
    visible: false,
    key: "prediction-current@1",
    cutoff: "2026-08-09T10:00:00.000Z",
  });
  assert.equal(await app.loadEvidence(), null);
  assert.deepEqual(calls, []);

  observer.callback([{ target: evidenceSections[0], isIntersecting: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["/api/evidence/recent"]);
  assert.equal(
    app.state().evidenceLoadedForKey,
    null,
    "a response aligned to a newer forecast must not settle the old view",
  );

  evidencePayload = {
    knowledge_cutoff: "2026-08-09T10:00:00.000Z",
    items: [],
    core: [],
    experience: [],
    competition: [],
    pending_next_forecast: { items: [] },
    timeline: [],
    impact_episodes: [],
    impact_tracking: {},
  };
  await app.loadEvidence();
  assert.deepEqual(calls, ["/api/evidence/recent", "/api/evidence/recent"]);
  assert.equal(app.state().evidenceLoadedForKey, "prediction-current@1");
  assert.match(
    harness.elements.get("#evidence-cutoff").textContent,
    /^仅显示信息截止 .+ 前已知的信号。$/,
  );
});

test("evidence retries the current prediction after an older in-flight request is discarded", async () => {
  let releaseOldResponse;
  const oldResponse = new Promise((resolve) => {
    releaseOldResponse = resolve;
  });
  const calls = [];
  const harness = await createHarness(async (url) => {
    calls.push(url);
    if (calls.length === 1) return oldResponse;
    return jsonResponse({
      knowledge_cutoff: "2026-08-09T10:10:00.000Z",
      items: [],
      core: [],
      experience: [],
      competition: [],
      pending_next_forecast: { items: [] },
      timeline: [],
      impact_episodes: [],
      impact_tracking: {},
    });
  });
  const { app } = harness;
  app.setEvidenceState({
    visible: true,
    key: "prediction-old@1",
    cutoff: "2026-08-09T10:00:00.000Z",
  });
  const oldLoad = app.loadEvidence();
  await Promise.resolve();
  assert.equal(calls.length, 1);

  app.setEvidenceState({
    visible: true,
    key: "prediction-current@1",
    cutoff: "2026-08-09T10:10:00.000Z",
  });
  const joinedOldLoad = app.loadEvidence();
  releaseOldResponse(jsonResponse({
    knowledge_cutoff: "2026-08-09T10:00:00.000Z",
    items: [],
  }));
  await Promise.all([oldLoad, joinedOldLoad]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["/api/evidence/recent", "/api/evidence/recent"]);
  assert.equal(app.state().evidenceLoadedForKey, "prediction-current@1");
});

test("evidence fails closed when the response omits its knowledge cutoff", async () => {
  const harness = await createHarness(async () => jsonResponse({ items: [] }));
  const { app } = harness;
  app.setEvidenceState({
    visible: true,
    key: "prediction-current@1",
    cutoff: "2026-08-09T10:10:00.000Z",
  });
  await app.loadEvidence();
  assert.equal(app.state().evidenceLoadedForKey, null);
  assert.equal(
    harness.elements.get("#evidence-cutoff")?.textContent ?? "",
    "",
  );
});

test("data status requires every serving freshness group before reporting normal", async () => {
  const harness = await createHarness(async () => jsonResponse({}));
  const forecast = {
    data: {
      data_quality: {
        outcome_sample_count: 3,
        sample_sufficiency: 0.5,
      },
    },
  };
  harness.app.renderDataStatus(
    forecast,
    { provider_freshness: { exact: { status: "fresh" } } },
    {},
  );
  assert.equal(
    harness.elements.get("#data-quality").textContent,
    "实时来源待更新",
  );

  harness.app.renderDataStatus(
    forecast,
    {
      provider_freshness: {
        required_outcome: { status: "fresh" },
        exact: { status: "fresh" },
      },
    },
    {},
  );
  assert.equal(
    harness.elements.get("#data-quality").textContent,
    "实时来源正常",
  );
});

test("cadence refresh remains ten-minute UTC aligned across a fall DST transition", async () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const delays = [];
    const nowMs = Date.parse("2026-11-01T05:55:00.000Z");
    const harness = await createHarness(
      async () => jsonResponse({}),
      {
        nowMs,
        setTimeoutImpl(_callback, delay) {
          delays.push(delay);
          return delays.length;
        },
        clearTimeoutImpl() {},
      },
    );
    harness.app.setEvidenceState({
      visible: false,
      key: null,
      cutoff: "2026-11-01T05:50:00.000Z",
    });
    harness.app.scheduleCadenceRefresh();
    assert.deepEqual(delays, [5 * 60_000 + 12_000]);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("health and exact-snapshot failures use a bounded retry instead of waiting for the next cadence", async () => {
  for (const scenario of ["health", "snapshot"]) {
    const delays = [];
    const calls = [];
    const harness = await createHarness(
      async (url) => {
        calls.push(url);
        if (scenario === "health") {
          return jsonResponse(
            { error: "forecast_not_ready" },
            { ok: false, status: 503 },
          );
        }
        if (url === "/api/health") {
          return jsonResponse({
            serving_ready: true,
            synthetic_only: false,
            current_prediction_ref: {
              record_id: "prediction-current",
              revision: 1,
              knowledge_cutoff: "2026-08-09T10:10:00.000Z",
              snapshot_url:
                "/api/forecast/snapshots/prediction-current/1",
            },
            forecast: { status: "fresh" },
            provider_freshness: {
              required_outcome: { status: "fresh" },
              exact: { status: "fresh" },
            },
            publication_ready: true,
          });
        }
        return jsonResponse({
          record_type: "prediction",
          record_id: "a-different-prediction",
          revision: 1,
          data: {},
        });
      },
      {
        setTimeoutImpl(_callback, delay) {
          delays.push(delay);
          return delays.length;
        },
        clearTimeoutImpl() {},
      },
    );

    await harness.app.load();
    assert.equal(calls[0], "/api/health");
    assert.equal(calls.length, scenario === "health" ? 1 : 2);
    assert.deepEqual(delays, [30_000], `${scenario} should retry after 30 seconds`);
  }
});
