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
    this.listeners = new Map();
    this.bounds = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this.hidden = false;
    this.open = false;
    this.textContent = "";
    this.innerHTML = "";
    this.checked = false;
    this.disabled = false;
    this.inert = false;
    this.value = "";
    this.focused = false;
    this.pointerCaptures = new Set();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

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

  get href() {
    return this.getAttribute("href") ?? "";
  }

  set href(value) {
    this.setAttribute("href", value);
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

  focus() {
    this.focused = true;
  }

  setPointerCapture(pointerId) {
    this.pointerCaptures.add(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.pointerCaptures.delete(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.pointerCaptures.has(pointerId);
  }

  getBoundingClientRect() {
    return this.bounds;
  }
}

function jsonResponse(data, {
  ok = true,
  status = ok ? 200 : 500,
  headers = {},
} = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    ok,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) ?? null;
      },
    },
    async json() {
      return data;
    },
  };
}

function calibrationResponse(horizonHours, {
  suggestedThreshold = 0.7,
  displayLower = 0.1,
  displayUpper = 0.9,
} = {}) {
  return jsonResponse({
    schema_version: "notification-threshold-calibration-compact/1",
    profile_schema_version: "notification-threshold-calibration/1",
    horizon_hours: horizonHours,
    status: "available",
    sample_count: 40,
    min_sample_count: 20,
    event_count: 4,
    min_event_count: 1,
    distribution_summary: {
      mean_probability: 0.5,
      standard_deviation: 0.1,
      observed_range: { lower: 0.01, upper: 0.99 },
      display_range: {
        lower: displayLower,
        upper: displayUpper,
        standard_deviations: 4,
        clipped_below: 3,
        clipped_above: 2,
      },
      suggested_threshold: {
        probability: suggestedThreshold,
        standard_deviations: 2,
      },
    },
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
  storedPreferences = null,
  probabilityTopicChecked = false,
} = {}) {
  const elements = new Map();
  const probabilityTopic = new FakeElement("input");
  probabilityTopic.checked = probabilityTopicChecked;
  elements.set("#notification-topic-probability", probabilityTopic);
  for (const selector of [
    "#calibration-crosshair",
    "#calibration-marker",
    "#calibration-threshold-range",
  ]) {
    const element = new FakeElement();
    element.hidden = true;
    element.setAttribute("hidden", "");
    elements.set(selector, element);
  }
  const evidenceSections = [
    new FakeElement("section"),
    new FakeElement("section"),
    new FakeElement("section"),
  ];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const observerInstances = [];
  const storage = new Map();
  if (storedPreferences !== null) {
    storage.set(
      "codex-reset-notification-preferences/1",
      JSON.stringify(storedPreferences),
    );
  }
  const localStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
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
  const source = moduleSource
    .replace(
      /^import \{[\s\S]*?\} from "\.\/notification-preferences\.js\?v=[^"]+";\s*/,
      "",
    )
    .replace(
      /^import \{ tr, uiLocale \} from "\.\/i18n\.js\?v=[^"]+";\s*/,
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
  updateProbabilityRule,
  setNotificationBusy,
  openNotificationDialog,
  closeNotificationDialog,
  enableWebPush,
  restoreLocalNotificationPreferences,
  saveLocalNotificationPreferences,
  renderNotificationCalibration,
  calibrationCoordinates,
  calibrationThresholdForEvent,
  selectNotificationHorizon(hours, eventType = "input") {
    notificationHorizon.value = String(nearestHorizonIndex(hours));
    notificationHorizon.dispatchEvent({ type: eventType });
  },
  selectNotificationThreshold(percentage) {
    notificationThreshold.value = String(percentage);
    notificationThreshold.dispatchEvent({ type: "input" });
  },
  toggleProbabilityTopic(checked) {
    notificationProbabilityTopic.checked = checked;
    notificationProbabilityTopic.dispatchEvent({ type: "change" });
  },
  selectCalibrationPoint(clientX) {
    calibrationHitArea.dispatchEvent({ type: "pointerdown", clientX, pointerId: 1 });
    calibrationHitArea.dispatchEvent({ type: "pointerup", clientX, pointerId: 1 });
  },
  moveCalibrationPointer(clientX, pointerId = 1) {
    calibrationHitArea.dispatchEvent({ type: "pointermove", clientX, pointerId });
  },
  startCalibrationDrag(clientX, pointerId = 1) {
    calibrationHitArea.dispatchEvent({ type: "pointerdown", clientX, pointerId });
  },
  endCalibrationDrag(clientX, pointerId = 1) {
    calibrationHitArea.dispatchEvent({ type: "pointerup", clientX, pointerId });
  },
  cancelCalibrationDrag(pointerId = 1) {
    calibrationHitArea.dispatchEvent({ type: "pointercancel", pointerId });
  },
  setNotificationRuntime({ registration, config = null }) {
    notificationRegistration = registration;
    notificationPublicConfig = config;
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
      notificationCalibrationRequests: notificationCalibrationRequests.size,
      notificationThresholdPristine,
      notificationThresholdValue: notificationThreshold.value,
      calibrationSummary: calibrationSummary.textContent,
      calibrationSample: calibrationSample.textContent,
      calibrationPlotState: calibrationPlot.dataset.state,
      calibrationRefreshState: calibrationPlot.dataset.refreshState ?? null,
      calibrationCurvePath: calibrationCurve.getAttribute("d"),
      calibrationAxisLower: calibrationAxisLower.textContent,
      calibrationAxisUpper: calibrationAxisUpper.textContent,
      calibrationMarkerHidden: calibrationMarker.hidden,
      calibrationMarkerHiddenAttribute:
        calibrationMarker.getAttribute("hidden") !== null,
      calibrationCrosshairHidden: calibrationCrosshair.hidden,
      calibrationCrosshairHiddenAttribute:
        calibrationCrosshair.getAttribute("hidden") !== null,
      calibrationCrosshairX: calibrationCrosshair.getAttribute("x1"),
      calibrationCrosshairOutside: calibrationCrosshair.dataset.outside ?? null,
      calibrationThresholdRangeHidden: calibrationThresholdRange.hidden,
      calibrationThresholdRangeHiddenAttribute:
        calibrationThresholdRange.getAttribute("hidden") !== null,
      calibrationThresholdRangeWidth: calibrationThresholdRange.getAttribute("width"),
      calibrationThresholdRangeOutside: calibrationThresholdRange.dataset.outside ?? null,
      calibrationTooltipHidden: calibrationTooltip.hidden,
      calibrationThresholdPinHidden: calibrationThresholdPin.hidden,
      calibrationThresholdPinText: calibrationThresholdPin.textContent,
      calibrationThresholdPinOutside: calibrationThresholdPin.dataset.outside ?? null,
      probabilityRuleHidden: notificationProbabilityRule.hidden,
      probabilityRuleInert: notificationProbabilityRule.inert,
      probabilityRuleEnabled: notificationProbabilityRule.dataset.enabled,
      probabilityTopicExpanded: notificationProbabilityTopic.getAttribute("aria-expanded"),
      notificationHorizonDisabled: notificationHorizon.disabled,
      notificationThresholdDisabled: notificationThreshold.disabled,
      notificationFeedBaselinePending: notificationFeedBaselineRequest !== null,
      personalizedFeedUrl: personalizedFeedUrl.value,
      personalizedFeedCopyDisabled: personalizedFeedCopy.disabled,
      personalizedFeedOpenHref: personalizedFeedOpen.getAttribute("href"),
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
    Notification: {
      permission: "granted",
      async requestPermission() {
        return "granted";
      },
    },
    URL,
    console,
    document,
    fetch: fetchImpl,
    navigator: { onLine: true },
    localStorage,
    NOTIFICATION_HORIZON_HOURS,
    calibrationAt,
    createNotificationCalibrationCache,
    formatNotificationHorizon,
    nearestHorizonIndex,
    normalizeCalibrationPayload,
    tr(chinese) {
      return chinese;
    },
    uiLocale: "zh-CN",
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    window,
  });
  new vm.Script(instrumented, { filename: "public/app.js" }).runInContext(context);
  context.__frontendLazyTest.updateProbabilityRule();
  return {
    app: context.__frontendLazyTest,
    elements,
    localStorage,
    evidenceSections,
    observerInstances,
    documentListeners,
    windowListeners,
  };
}

test("notification calibration stays dialog-lazy, debounces horizons, and reuses a session cache", async () => {
  const timers = createManualTimers();
  const calibrationCalls = [];
  const harness = await createHarness(async (url, options) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 7,
      });
    }
    if (url.startsWith("/api/notification-preferences/calibration?")) {
      const requestUrl = new URL(url, "https://forecast.example");
      assert.equal(requestUrl.searchParams.get("view"), "compact");
      const hours = Number(requestUrl.searchParams.get("horizon_hours"));
      calibrationCalls.push({ hours, cache: options.cache });
      return calibrationResponse(hours);
    }
    throw new Error(`unexpected request: ${url}`);
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  assert.deepEqual(calibrationCalls, []);
  assert.equal(timers.count(220), 0, "a closed dialog must not queue calibration work");

  harness.app.openNotificationDialog();
  assert.deepEqual(calibrationCalls, [], "opening queues, but does not bypass the debounce");
  assert.equal(timers.count(220), 1);
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  assert.deepEqual(calibrationCalls, [{ hours: 24, cache: "default" }]);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);

  harness.app.selectNotificationHorizon(28);
  harness.app.selectNotificationHorizon(32);
  assert.deepEqual(calibrationCalls, [{ hours: 24, cache: "default" }]);
  assert.equal(timers.count(220), 1, "rapid input keeps only the final horizon timer");
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  assert.deepEqual(calibrationCalls, [
    { hours: 24, cache: "default" },
    { hours: 32, cache: "default" },
  ]);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 32);

  harness.app.selectNotificationHorizon(24);
  assert.deepEqual(calibrationCalls, [
    { hours: 24, cache: "default" },
    { hours: 32, cache: "default" },
  ]);
  assert.equal(timers.count(220), 0, "a cached horizon renders without another wait");
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);

  harness.app.selectNotificationHorizon(28);
  assert.equal(timers.count(220), 1);
  harness.app.selectNotificationHorizon(28, "change");
  assert.equal(timers.count(220), 0, "change flushes the final slider position");
  await settleAsyncWork();
  assert.deepEqual(calibrationCalls, [
    { hours: 24, cache: "default" },
    { hours: 32, cache: "default" },
    { hours: 28, cache: "default" },
  ]);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 28);

  harness.app.selectNotificationHorizon(36);
  assert.equal(timers.count(220), 1);
  harness.app.closeNotificationDialog();
  assert.equal(timers.count(220), 0, "closing invalidates the pending debounce");
  assert.equal(harness.app.state().notificationDialogOpen, false);
  assert.deepEqual(calibrationCalls, [
    { hours: 24, cache: "default" },
    { hours: 32, cache: "default" },
    { hours: 28, cache: "default" },
  ]);
});

test("an unchecked probability topic hides and disables its whole rule without loading", async () => {
  const timers = createManualTimers();
  const calls = [];
  const harness = await createHarness(async (url) => {
    calls.push(url);
    return jsonResponse({
      schema_version: "notification-feed-baseline/1",
      cursor: 4,
    });
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: false,
  });

  harness.app.openNotificationDialog();
  await settleAsyncWork();
  const hidden = harness.app.state();
  assert.equal(hidden.probabilityRuleHidden, true);
  assert.equal(hidden.probabilityRuleInert, true);
  assert.equal(hidden.probabilityRuleEnabled, "false");
  assert.equal(hidden.probabilityTopicExpanded, "false");
  assert.equal(hidden.notificationHorizonDisabled, true);
  assert.equal(hidden.notificationThresholdDisabled, true);
  assert.deepEqual(calls, []);
  assert.equal(timers.count(220), 0);

  harness.app.setNotificationBusy(true);
  harness.app.setNotificationBusy(false);
  assert.equal(
    harness.app.state().notificationThresholdDisabled,
    true,
    "busy cleanup must not re-enable a hidden probability rule",
  );

  harness.app.toggleProbabilityTopic(true);
  await settleAsyncWork();
  const shown = harness.app.state();
  assert.equal(shown.probabilityRuleHidden, false);
  assert.equal(shown.probabilityRuleInert, false);
  assert.equal(shown.probabilityTopicExpanded, "true");
  assert.equal(shown.notificationHorizonDisabled, false);
  assert.equal(shown.notificationThresholdDisabled, false);
  assert.deepEqual(calls, ["/api/notification-preferences/baseline"]);
  assert.equal(timers.count(220), 1);
});

test("a baseline response arriving after uncheck cannot recreate a personalized Atom link", async () => {
  const timers = createManualTimers();
  let releaseBaseline;
  let baselineSignal;
  const pendingBaseline = new Promise((resolve) => {
    releaseBaseline = resolve;
  });
  const harness = await createHarness(async (url, options) => {
    assert.equal(url, "/api/notification-preferences/baseline");
    baselineSignal = options.signal;
    return pendingBaseline;
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.openNotificationDialog();
  await Promise.resolve();
  assert.equal(harness.app.state().notificationFeedBaselinePending, true);
  harness.app.toggleProbabilityTopic(false);
  assert.equal(baselineSignal.aborted, true);
  assert.equal(harness.app.state().personalizedFeedUrl, "");
  assert.equal(harness.app.state().personalizedFeedCopyDisabled, true);
  assert.equal(harness.app.state().personalizedFeedOpenHref, null);

  releaseBaseline(jsonResponse({
    schema_version: "notification-feed-baseline/1",
    cursor: 99,
  }));
  await settleAsyncWork();
  const settled = harness.app.state();
  assert.equal(settled.notificationFeedBaselinePending, false);
  assert.equal(settled.personalizedFeedUrl, "");
  assert.equal(settled.personalizedFeedCopyDisabled, true);
  assert.equal(settled.personalizedFeedOpenHref, null);
});

test("a personalized Atom baseline timeout leaves an explicit unavailable state", async () => {
  const timers = createManualTimers();
  const harness = await createHarness(async (url, options) => {
    assert.equal(url, "/api/notification-preferences/baseline");
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      }, { once: true });
    });
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.openNotificationDialog();
  await Promise.resolve();
  assert.equal(timers.count(8_000), 1);
  assert.equal(timers.runNext(8_000), true);
  await settleAsyncWork();

  const settled = harness.app.state();
  assert.equal(settled.notificationFeedBaselinePending, false);
  assert.equal(settled.personalizedFeedUrl, "");
  assert.equal(settled.personalizedFeedCopyDisabled, true);
  assert.equal(settled.personalizedFeedOpenHref, null);
  assert.match(
    harness.elements.get("#personalized-feed-status").textContent,
    /链接不可用：请求超时/,
  );
});

test("unchecking during calibration invalidates rendering but preserves the exact cache", async () => {
  const timers = createManualTimers();
  let releaseCalibration;
  let calibrationSignal;
  let calibrationCalls = 0;
  const pendingCalibration = new Promise((resolve) => {
    releaseCalibration = resolve;
  });
  const harness = await createHarness(async (url, options) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 5,
      });
    }
    calibrationCalls += 1;
    calibrationSignal = options.signal;
    return pendingCalibration;
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  assert.equal(timers.runNext(220), true);
  await Promise.resolve();
  assert.equal(calibrationCalls, 1);

  harness.app.toggleProbabilityTopic(false);
  const hidden = harness.app.state();
  assert.equal(hidden.probabilityRuleHidden, true);
  assert.equal(hidden.notificationThresholdDisabled, true);
  assert.equal(calibrationSignal.aborted, false, "calibration remains available for exact-cache fill");
  assert.equal(timers.count(220), 0);

  releaseCalibration(calibrationResponse(24));
  await settleAsyncWork();
  assert.equal(
    harness.app.state().notificationCalibrationHorizon,
    null,
    "a completed hidden-rule request must not render",
  );

  harness.app.toggleProbabilityTopic(true);
  await settleAsyncWork();
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);
  assert.equal(calibrationCalls, 1, "re-enabling renders the exact cached horizon");
  assert.equal(timers.count(220), 0);
});

test("horizon changes keep the previous chart visible until the exact target is ready", async () => {
  const timers = createManualTimers();
  const calibrationCalls = [];
  let releaseHorizon28;
  const horizon28Response = new Promise((resolve) => {
    releaseHorizon28 = resolve;
  });
  const harness = await createHarness(async (url) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 11,
      });
    }
    const requestUrl = new URL(url, "https://forecast.example");
    const hours = Number(requestUrl.searchParams.get("horizon_hours"));
    calibrationCalls.push(hours);
    return hours === 28 ? horizon28Response : calibrationResponse(hours);
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  const previous = harness.app.state();
  assert.equal(previous.calibrationPlotState, "ready");
  assert.equal(previous.notificationCalibrationHorizon, 24);
  assert.equal(previous.notificationThresholdValue, "70");

  harness.app.selectNotificationHorizon(28);
  let pending = harness.app.state();
  assert.equal(pending.calibrationPlotState, "ready", "debounce must not show the empty loading state");
  assert.equal(pending.calibrationRefreshState, "updating");
  assert.equal(pending.calibrationCurvePath, previous.calibrationCurvePath);
  assert.equal(pending.calibrationAxisLower, previous.calibrationAxisLower);
  assert.equal(pending.calibrationAxisUpper, previous.calibrationAxisUpper);
  assert.match(pending.calibrationSample, /仍显示 1 天（24 小时）.*切换到 28 小时/);
  assert.equal(pending.calibrationMarkerHidden, true);
  assert.equal(
    pending.calibrationCrosshairHidden,
    false,
    "the selected threshold line remains visible on the retained chart",
  );
  assert.equal(pending.calibrationThresholdRangeHidden, false);
  assert.equal(pending.calibrationThresholdPinHidden, false);
  assert.equal(pending.calibrationTooltipHidden, true);

  const hitArea = harness.elements.get("#calibration-hit-area");
  hitArea.bounds = { left: 0, right: 100, width: 100, top: 0, bottom: 100, height: 100 };
  harness.app.selectCalibrationPoint(50);
  assert.equal(
    harness.app.state().notificationThresholdValue,
    "70",
    "the stale chart cannot change the threshold",
  );

  assert.equal(timers.runNext(220), true);
  await Promise.resolve();
  assert.deepEqual(calibrationCalls, [24, 28]);
  pending = harness.app.state();
  assert.equal(pending.calibrationPlotState, "ready", "network wait also preserves the old chart");
  assert.equal(pending.calibrationCurvePath, previous.calibrationCurvePath);

  releaseHorizon28(calibrationResponse(28, {
    suggestedThreshold: 0.8,
    displayLower: 0.05,
    displayUpper: 0.95,
  }));
  await settleAsyncWork();
  const replaced = harness.app.state();
  assert.equal(replaced.notificationCalibrationHorizon, 28);
  assert.equal(replaced.calibrationPlotState, "ready");
  assert.equal(replaced.calibrationRefreshState, null);
  assert.notEqual(replaced.calibrationCurvePath, previous.calibrationCurvePath);
  assert.equal(replaced.calibrationAxisLower, "5%");
  assert.equal(replaced.calibrationAxisUpper, "95%");
  assert.equal(replaced.notificationThresholdValue, "80");

  harness.app.selectNotificationHorizon(24);
  const cached = harness.app.state();
  assert.equal(cached.notificationCalibrationHorizon, 24);
  assert.equal(cached.calibrationPlotState, "ready");
  assert.equal(cached.calibrationRefreshState, null);
  assert.equal(cached.calibrationCurvePath, previous.calibrationCurvePath);
  assert.equal(timers.count(220), 0, "an exact cached target swaps synchronously");
});

test("a stale calibration response seeds only its exact horizon without replacing the view", async () => {
  const timers = createManualTimers();
  const calibrationCalls = [];
  let releaseHorizon24;
  const horizon24Response = new Promise((resolve) => {
    releaseHorizon24 = resolve;
  });
  let horizon24Signal;
  const harness = await createHarness(async (url, options) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 8,
      });
    }
    const requestUrl = new URL(url, "https://forecast.example");
    assert.equal(requestUrl.searchParams.get("view"), "compact");
    const hours = Number(requestUrl.searchParams.get("horizon_hours"));
    calibrationCalls.push(hours);
    if (hours === 24) horizon24Signal = options.signal;
    return hours === 24 ? horizon24Response : calibrationResponse(hours);
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  timers.runNext(220);
  await Promise.resolve();
  assert.deepEqual(calibrationCalls, [24]);

  harness.app.selectNotificationHorizon(28);
  assert.equal(horizon24Signal.aborted, false, "switching horizons keeps the request alive");
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
  assert.equal(timers.count(220), 0, "the completed exact-horizon response is cached");
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);
  assert.deepEqual(calibrationCalls, [24, 28]);
});

test("a cold profile warm retries without leaving the dialog in a permanent error", async () => {
  const timers = createManualTimers();
  let attempts = 0;
  const harness = await createHarness(async (url) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 9,
      });
    }
    attempts += 1;
    if (attempts === 1) {
      return jsonResponse({
        error: "notification_calibration_warming",
        message: "历史可靠度正在后台预热，请几秒后重试。",
      }, {
        ok: false,
        status: 503,
        headers: { "retry-after": "5" },
      });
    }
    return calibrationResponse(24);
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  assert.equal(attempts, 1);
  assert.equal(timers.count(5_000), 1);
  assert.match(
    harness.elements.get("#calibration-state").textContent,
    /后台预热/,
  );

  assert.equal(timers.runNext(5_000), true);
  await settleAsyncWork();
  assert.equal(attempts, 2);
  assert.equal(harness.app.state().notificationCalibrationHorizon, 24);
});

test("unchecking cancels a pending calibration warm retry", async () => {
  const timers = createManualTimers();
  let calibrationCalls = 0;
  const harness = await createHarness(async (url) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 10,
      });
    }
    calibrationCalls += 1;
    return jsonResponse({
      error: "notification_calibration_warming",
      message: "warming",
    }, {
      ok: false,
      status: 503,
      headers: { "retry-after": "5" },
    });
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  assert.equal(calibrationCalls, 1);
  assert.equal(timers.count(5_000), 1);

  harness.app.toggleProbabilityTopic(false);
  assert.equal(timers.count(5_000), 0);
  assert.equal(timers.runNext(5_000), false);
  assert.equal(calibrationCalls, 1);
});

test("warm retries and failures preserve an already rendered horizon", async () => {
  const timers = createManualTimers();
  let targetAttempts = 0;
  const harness = await createHarness(async (url) => {
    if (url === "/api/notification-preferences/baseline") {
      return jsonResponse({
        schema_version: "notification-feed-baseline/1",
        cursor: 12,
      });
    }
    const requestUrl = new URL(url, "https://forecast.example");
    const hours = Number(requestUrl.searchParams.get("horizon_hours"));
    if (hours === 24) return calibrationResponse(24);
    targetAttempts += 1;
    if (targetAttempts === 1) {
      return jsonResponse({
        error: "notification_calibration_warming",
        message: "历史可靠度正在后台预热，请几秒后重试。",
      }, {
        ok: false,
        status: 503,
        headers: { "retry-after": "5" },
      });
    }
    return jsonResponse({ message: "profile unavailable" }, {
      ok: false,
      status: 500,
    });
  }, {
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    probabilityTopicChecked: true,
  });

  harness.app.selectNotificationHorizon(24);
  harness.app.openNotificationDialog();
  assert.equal(timers.runNext(220), true);
  await settleAsyncWork();
  const previous = harness.app.state();

  harness.app.selectNotificationHorizon(28, "change");
  await settleAsyncWork();
  const warming = harness.app.state();
  assert.equal(targetAttempts, 1);
  assert.equal(warming.notificationCalibrationHorizon, 24);
  assert.equal(warming.calibrationPlotState, "ready");
  assert.equal(warming.calibrationRefreshState, "warming");
  assert.equal(warming.calibrationCurvePath, previous.calibrationCurvePath);
  assert.match(warming.calibrationSample, /仍显示 1 天（24 小时）.*后台预热中/);
  assert.equal(timers.count(5_000), 1);

  assert.equal(timers.runNext(5_000), true);
  await settleAsyncWork();
  const failed = harness.app.state();
  assert.equal(targetAttempts, 2);
  assert.equal(failed.notificationCalibrationHorizon, 24);
  assert.equal(failed.calibrationPlotState, "ready");
  assert.equal(failed.calibrationRefreshState, "error");
  assert.equal(failed.calibrationCurvePath, previous.calibrationCurvePath);
  assert.match(failed.calibrationSample, /28 小时.*加载失败.*仍显示 1 天（24 小时）/);
  assert.match(failed.calibrationSummary, /profile unavailable.*当前图表未被替换/);
  assert.equal(failed.notificationThresholdValue, "70");
  assert.equal(failed.calibrationMarkerHidden, true);
});

test("a profile suggestion initializes only a pristine threshold", async () => {
  const harness = await createHarness(async () => jsonResponse({}));
  const first = normalizeCalibrationPayload(
    await calibrationResponse(24, { suggestedThreshold: 0.7 }).json(),
    24,
  );
  harness.app.renderNotificationCalibration(first);
  assert.equal(harness.app.state().notificationThresholdValue, "70");
  assert.equal(harness.app.state().notificationThresholdPristine, true);

  harness.app.selectNotificationThreshold(65);
  const next = normalizeCalibrationPayload(
    await calibrationResponse(28, { suggestedThreshold: 0.8 }).json(),
    28,
  );
  harness.app.renderNotificationCalibration(next);
  assert.equal(harness.app.state().notificationThresholdValue, "65");
  assert.equal(harness.app.state().notificationThresholdPristine, false);
});

test("saved thresholds remain authoritative in restored and current page state", async () => {
  const saved = {
    topics: ["experimental_probability"],
    preferences: {
      schema_version: "notification-preferences/1",
      horizon_hours: 24,
      probability_threshold: 0.55,
    },
  };
  const restored = await createHarness(async () => jsonResponse({}), {
    storedPreferences: saved,
  });
  assert.equal(restored.app.restoreLocalNotificationPreferences(), true);
  restored.app.renderNotificationCalibration(normalizeCalibrationPayload(
    await calibrationResponse(24, { suggestedThreshold: 0.7 }).json(),
    24,
  ));
  assert.equal(restored.app.state().notificationThresholdValue, "55");
  assert.equal(restored.app.state().notificationThresholdPristine, false);

  const current = await createHarness(async () => jsonResponse({}));
  current.app.renderNotificationCalibration(normalizeCalibrationPayload(
    await calibrationResponse(24, { suggestedThreshold: 0.7 }).json(),
    24,
  ));
  current.app.saveLocalNotificationPreferences();
  current.app.renderNotificationCalibration(normalizeCalibrationPayload(
    await calibrationResponse(28, { suggestedThreshold: 0.8 }).json(),
    28,
  ));
  assert.equal(current.app.state().notificationThresholdValue, "70");
  assert.equal(current.app.state().notificationThresholdPristine, false);

  const hiddenSaved = await createHarness(async () => jsonResponse({}), {
    storedPreferences: {
      topics: ["authority"],
      preferences: {
        schema_version: "notification-preferences/1",
        horizon_hours: 24,
        probability_threshold: 0.55,
      },
    },
  });
  assert.equal(hiddenSaved.app.restoreLocalNotificationPreferences(), true);
  hiddenSaved.app.updateProbabilityRule();
  assert.equal(hiddenSaved.app.state().probabilityRuleHidden, true);
  assert.equal(hiddenSaved.app.state().notificationThresholdValue, "55");
  hiddenSaved.app.toggleProbabilityTopic(true);
  hiddenSaved.app.renderNotificationCalibration(normalizeCalibrationPayload(
    await calibrationResponse(24, { suggestedThreshold: 0.8 }).json(),
    24,
  ));
  assert.equal(
    hiddenSaved.app.state().notificationThresholdValue,
    "55",
    "hiding a saved rule must not make its threshold pristine again",
  );
});

test("an in-flight save freezes one threshold for the server and local mirror", async () => {
  let releaseSave = null;
  let submitted = null;
  const pendingSave = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const harness = await createHarness(async (url, options) => {
    if (url === "/api/web-push/subscriptions" && options.method === "POST") {
      submitted = JSON.parse(options.body);
      return pendingSave;
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const subscription = {
    toJSON() {
      return {
        endpoint: "https://push.example/subscription",
        keys: { p256dh: "key", auth: "auth" },
      };
    },
    async unsubscribe() {
      return true;
    },
  };
  harness.app.setNotificationRuntime({
    registration: {
      pushManager: {
        async getSubscription() {
          return subscription;
        },
      },
    },
  });
  harness.elements.get("#notification-topic-probability").checked = true;
  harness.elements.get("#notification-horizon").value = String(
    nearestHorizonIndex(24),
  );
  harness.elements.get("#notification-threshold").value = "50";

  const saving = harness.app.enableWebPush();
  await settleAsyncWork();
  assert.equal(submitted.preferences.probability_threshold, 0.5);
  assert.equal(harness.app.state().notificationThresholdPristine, false);
  assert.equal(harness.elements.get("#notification-horizon").disabled, true);
  assert.equal(harness.elements.get("#notification-threshold").disabled, true);
  assert.equal(
    harness.elements.get("#notification-topic-probability").disabled,
    true,
  );

  harness.app.renderNotificationCalibration(normalizeCalibrationPayload(
    await calibrationResponse(24, { suggestedThreshold: 0.2 }).json(),
    24,
  ));
  assert.equal(
    harness.app.state().notificationThresholdValue,
    "50",
    "a late profile must not rewrite the submitted threshold",
  );

  releaseSave(jsonResponse({ ok: true }));
  await saving;
  const local = JSON.parse(harness.localStorage.getItem(
    "codex-reset-notification-preferences/1",
  ));
  assert.equal(local.preferences.probability_threshold, 0.5);
  assert.deepEqual(local.preferences, submitted.preferences);
  assert.equal(harness.elements.get("#notification-threshold").disabled, false);
});

test("the chart changes only the real threshold while dragging and keeps keyboard range semantics", async () => {
  const harness = await createHarness(async () => jsonResponse({}), {
    probabilityTopicChecked: true,
  });
  harness.app.selectNotificationHorizon(24);
  harness.app.renderNotificationCalibration(normalizeCalibrationPayload(
    await calibrationResponse(24, {
      suggestedThreshold: 0.7,
      displayLower: 0.1,
      displayUpper: 0.9,
    }).json(),
    24,
  ));
  const hitArea = harness.elements.get("#calibration-hit-area");
  hitArea.bounds = { left: 0, right: 100, width: 100, top: 0, bottom: 100, height: 100 };

  harness.app.moveCalibrationPointer(100);
  assert.equal(
    harness.app.state().notificationThresholdValue,
    "70",
    "passive pointer movement must not impersonate the selected threshold",
  );

  harness.app.startCalibrationDrag(100);
  assert.equal(harness.app.state().notificationThresholdValue, "80");
  assert.equal(hitArea.hasPointerCapture(1), true);
  harness.app.moveCalibrationPointer(0);
  assert.equal(harness.app.state().notificationThresholdValue, "20");
  harness.app.cancelCalibrationDrag();
  assert.equal(hitArea.hasPointerCapture(1), false);
  harness.app.moveCalibrationPointer(100);
  assert.equal(
    harness.app.state().notificationThresholdValue,
    "20",
    "pointercancel ends the drag and ignores later movement",
  );
  assert.equal(
    harness.app.state().calibrationThresholdPinText,
    "触发阈值 · 20%",
  );
  assert.equal(harness.app.state().calibrationCrosshairHidden, false);
  assert.equal(harness.app.state().calibrationCrosshairHiddenAttribute, false);
  assert.equal(harness.app.state().calibrationThresholdRangeHidden, false);
  assert.equal(harness.app.state().calibrationThresholdRangeHiddenAttribute, false);

  harness.app.startCalibrationDrag(100);
  assert.equal(hitArea.hasPointerCapture(1), true);
  harness.app.toggleProbabilityTopic(false);
  assert.equal(hitArea.hasPointerCapture(1), false, "uncheck releases pointer capture");
  harness.app.toggleProbabilityTopic(true);

  harness.app.selectNotificationThreshold(99);
  const outside = harness.app.state();
  assert.equal(outside.notificationThresholdValue, "99");
  assert.equal(outside.calibrationMarkerHidden, true);
  assert.equal(outside.calibrationCrosshairHidden, false);
  assert.equal(outside.calibrationCrosshairHiddenAttribute, false);
  assert.equal(outside.calibrationCrosshairX, "580.00");
  assert.equal(outside.calibrationCrosshairOutside, "true");
  assert.equal(outside.calibrationThresholdRangeHidden, false);
  assert.equal(outside.calibrationThresholdRangeHiddenAttribute, false);
  assert.equal(outside.calibrationThresholdRangeWidth, "560.00");
  assert.equal(outside.calibrationThresholdRangeOutside, "true");
  assert.equal(outside.calibrationThresholdPinHidden, false);
  assert.equal(outside.calibrationThresholdPinOutside, "true");
  assert.equal(outside.calibrationThresholdPinText, "触发阈值 · 99% · 图外");
  assert.equal(
    harness.elements.get("#notification-threshold").getAttribute("aria-valuetext"),
    "99%",
  );
  assert.equal(
    Number(harness.elements.get("#notification-threshold").value),
    99,
    "the native form state retains an out-of-display-domain threshold",
  );
});

test("a saved threshold outside the cropped chart is reported without edge snapping", async () => {
  const harness = await createHarness(async () => jsonResponse({}), {
    storedPreferences: {
      topics: ["experimental_probability"],
      preferences: {
        schema_version: "notification-preferences/1",
        horizon_hours: 24,
        probability_threshold: 0.5,
      },
    },
  });
  harness.app.restoreLocalNotificationPreferences();
  harness.app.renderNotificationCalibration({
    schema_version: "notification-threshold-calibration-compact/1",
    horizon_hours: 24,
    status: "available",
    sample_count: 100,
    min_sample_count: 20,
    event_count: 10,
    min_event_count: 1,
    distribution_summary: {
      mean_probability: 0.2,
      standard_deviation: 0.025,
      observed_range: { lower: 0.01, upper: 0.8 },
      display_range: {
        lower: 0.1,
        upper: 0.3,
        standard_deviations: 4,
        clipped_below: 1,
        clipped_above: 1,
      },
      suggested_threshold: { probability: 0.25, standard_deviations: 2 },
    },
    points: [
      { probability: 0.1, density: 0.2 },
      { probability: 0.2, density: 1 },
      { probability: 0.3, density: 0.2 },
    ],
  });

  const state = harness.app.state();
  assert.equal(state.notificationThresholdValue, "50");
  assert.equal(state.calibrationMarkerHidden, true);
  assert.equal(state.calibrationCrosshairHidden, false);
  assert.equal(state.calibrationCrosshairX, "580.00");
  assert.equal(state.calibrationCrosshairOutside, "true");
  assert.equal(state.calibrationThresholdRangeHidden, false);
  assert.equal(state.calibrationThresholdRangeWidth, "560.00");
  assert.equal(state.calibrationThresholdPinHidden, false);
  assert.equal(state.calibrationThresholdPinText, "触发阈值 · 50% · 图外");
  assert.equal(state.calibrationThresholdPinOutside, "true");
  assert.match(state.calibrationSummary, /50%.*10%–30%.*仍按 50% 触发/);
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
