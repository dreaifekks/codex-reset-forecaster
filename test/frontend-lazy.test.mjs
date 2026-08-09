import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
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
    location: { origin: "https://forecast.example" },
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

  const source = await fs.readFile(
    path.join(projectRoot, "public", "app.js"),
    "utf8",
  );
  const instrumented = source.replace(
    /\nvoid load\(\);\s*$/,
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
    };
  },
};`,
  );
  assert.notEqual(instrumented, source, "test harness must suppress automatic load");
  const context = vm.createContext({
    AbortSignal,
    Date: ContextDate,
    IntersectionObserver: FakeIntersectionObserver,
    URL,
    console,
    document,
    fetch: fetchImpl,
    navigator: { onLine: true },
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
