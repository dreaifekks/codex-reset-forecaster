import fs from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

export const TRAFFIC_MONITOR_STATE_VERSION = "traffic-monitor-state/2";
export const TRAFFIC_MONITOR_SUMMARY_VERSION = "traffic-monitor-summary/1";
export const TRAFFIC_ALERT_POLICY_VERSION = "traffic-capacity-policy/1";
const LEGACY_TRAFFIC_MONITOR_STATE_VERSION = "traffic-monitor-state/1";

export class OperationsAlertCursorResetError extends TypeError {
  constructor(reason, cursor) {
    super("Operations alert cursor requires a new baseline");
    this.name = "OperationsAlertCursorResetError";
    this.code = "operations_alert_cursor_reset_required";
    this.reason = reason;
    this.cursor = cursor;
  }
}

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 750, 1_000, 2_000, 3_000, 5_000, 10_000];
const MINUTE_RETENTION = 60;
const DAY_RETENTION = 35;
const ALERT_RETENTION = 256;
const OPERATIONS_TOKEN_MINIMUM_BYTES = 32;
const DEFAULTS = Object.freeze({
  sampleIntervalMs: 5_000,
  flushIntervalMs: 30_000,
  windowMinutes: 5,
  minimumRequests: 100,
  minimumInteractiveRequests: 20,
  strainedWindows: 3,
  criticalWindows: 2,
  recoveryWindows: 6,
});

function iso(value, name) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${name} must be a valid timestamp`);
  }
  return date.toISOString();
}

function minuteKey(value) {
  return `${iso(value, "minute").slice(0, 16)}:00.000Z`;
}

function dayKey(value) {
  return iso(value, "day").slice(0, 10);
}

function shiftedDay(value, offset) {
  const base = new Date(`${dayKey(value)}T00:00:00.000Z`);
  return new Date(base.getTime() + offset * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function finiteRatio(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function emptyHistogram() {
  return {
    count: 0,
    sum_ms: 0,
    max_ms: 0,
    buckets: Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
  };
}

function addHistogram(histogram, value) {
  const numeric = Math.max(0, Number(value));
  if (!Number.isFinite(numeric)) return;
  histogram.count += 1;
  histogram.sum_ms += numeric;
  histogram.max_ms = Math.max(histogram.max_ms, numeric);
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => numeric <= bound);
  histogram.buckets[index < 0 ? LATENCY_BUCKETS_MS.length : index] += 1;
}

function mergeHistogram(target, source) {
  target.count += source.count;
  target.sum_ms += source.sum_ms;
  target.max_ms = Math.max(target.max_ms, source.max_ms);
  for (let index = 0; index < target.buckets.length; index += 1) {
    target.buckets[index] += source.buckets[index] ?? 0;
  }
}

function percentile(histogram, quantile) {
  if (!histogram.count) return null;
  const target = Math.ceil(histogram.count * quantile);
  let cumulative = 0;
  for (let index = 0; index < histogram.buckets.length; index += 1) {
    cumulative += histogram.buckets[index];
    if (cumulative >= target) {
      return index < LATENCY_BUCKETS_MS.length
        ? LATENCY_BUCKETS_MS[index]
        : histogram.max_ms;
    }
  }
  return histogram.max_ms;
}

function emptyMinute(key) {
  return {
    minute: key,
    requests: 0,
    public_requests: 0,
    true_errors: 0,
    aborted: 0,
    max_in_flight: 0,
    by_route: {},
    interactive_latency: emptyHistogram(),
    event_loop_lag: emptyHistogram(),
    elu_max: null,
    heap_ratio_max: null,
    cgroup_memory_ratio_max: null,
  };
}

function emptyDay(key) {
  return {
    day: key,
    requests: 0,
    public_requests: 0,
    true_errors: 0,
    aborted: 0,
    by_route: {},
  };
}

function defaultPressure(now) {
  return {
    level: "normal",
    reasons: [],
    incident_id: null,
    opened_at: null,
    last_transition_at: iso(now, "pressure time"),
    last_evaluated_minute: null,
    strained_windows: 0,
    critical_windows: 0,
    healthy_windows: 0,
  };
}

function defaultState(now, activePolicyHash) {
  const timestamp = iso(now, "state time");
  return {
    schema_version: TRAFFIC_MONITOR_STATE_VERSION,
    active_policy_hash: activePolicyHash,
    created_at: timestamp,
    updated_at: timestamp,
    minutes: {},
    days: {},
    pressure: defaultPressure(now),
    next_alert_sequence: 1,
    alerts: [],
  };
}

function migrateState(state, now) {
  if (state?.schema_version !== LEGACY_TRAFFIC_MONITOR_STATE_VERSION) {
    return state;
  }
  const migrated = structuredClone(state);
  migrated.schema_version = TRAFFIC_MONITOR_STATE_VERSION;
  migrated.active_policy_hash = null;
  migrated.pressure = defaultPressure(now);
  migrated.next_alert_sequence = 1;
  migrated.alerts = [];
  migrated.updated_at = iso(now, "traffic state migration time");
  return migrated;
}

function routeClass(urlValue) {
  let pathname = "/";
  try {
    pathname = new URL(urlValue ?? "/", "http://localhost").pathname;
  } catch {
    return "other";
  }
  if (["/api/live", "/api/health"].includes(pathname)) return "internal_health";
  if (pathname.startsWith("/api/operations/")) return "operations";
  if (pathname === "/api/notifications/events") return "delivery_poll";
  if (
    ["/feed.xml", "/feeds/experimental.xml", "/feeds/probability.xml"]
      .includes(pathname)
  ) return "feed";
  if (pathname === "/api/web-push/subscriptions") return "web_push_control";
  if (pathname.startsWith("/api/")) return "interactive_api";
  if (/\.[a-z0-9]{1,12}$/i.test(pathname)) return "static";
  if (["/", "/accuracy", "/accuracy.html"].includes(pathname)) return "page";
  return "other";
}

function isPublicRoute(category) {
  return !["internal_health", "operations", "delivery_poll"].includes(category);
}

function isInteractiveRoute(category) {
  return ["page", "feed", "interactive_api", "web_push_control"].includes(category);
}

function trimRecord(record, maximum) {
  const entries = Object.entries(record).sort(([left], [right]) => right.localeCompare(left));
  return Object.fromEntries(entries.slice(0, maximum));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateMinutes(minutes) {
  const aggregate = {
    requests: 0,
    public_requests: 0,
    true_errors: 0,
    aborted: 0,
    max_in_flight: 0,
    interactive_latency: emptyHistogram(),
    event_loop_lag: emptyHistogram(),
    elu_max: null,
    heap_ratio_max: null,
    cgroup_memory_ratio_max: null,
  };
  for (const bucket of minutes) {
    aggregate.requests += bucket.requests;
    aggregate.public_requests += bucket.public_requests;
    aggregate.true_errors += bucket.true_errors;
    aggregate.aborted += bucket.aborted;
    aggregate.max_in_flight = Math.max(aggregate.max_in_flight, bucket.max_in_flight);
    mergeHistogram(aggregate.interactive_latency, bucket.interactive_latency);
    mergeHistogram(aggregate.event_loop_lag, bucket.event_loop_lag);
    for (const field of ["elu_max", "heap_ratio_max", "cgroup_memory_ratio_max"]) {
      if (Number.isFinite(bucket[field])) {
        aggregate[field] = Math.max(aggregate[field] ?? 0, bucket[field]);
      }
    }
  }
  return aggregate;
}

function pressureSignals(window, options) {
  const p95LatencyMs = percentile(window.interactive_latency, 0.95);
  const p95LagMs = percentile(window.event_loop_lag, 0.95);
  const trueErrorRate = window.public_requests >= options.minimumRequests
    ? window.true_errors / window.public_requests
    : null;
  const abortedRate = window.public_requests >= options.minimumRequests
    ? window.aborted / window.public_requests
    : null;
  const user = [];
  const resource = [];
  const severe = [];
  if (
    window.interactive_latency.count >= options.minimumInteractiveRequests &&
    p95LatencyMs > 750
  ) user.push(`interactive_p95_${Math.round(p95LatencyMs)}ms`);
  if (window.true_errors >= 5 || (trueErrorRate !== null && trueErrorRate > 0.01)) {
    user.push(`true_errors_${window.true_errors}`);
  }
  if (abortedRate !== null && abortedRate > 0.01) {
    user.push(`aborted_${(abortedRate * 100).toFixed(1)}pct`);
  }
  if (window.event_loop_lag.count >= 3 && p95LagMs > 100) {
    resource.push(`event_loop_lag_p95_${Math.round(p95LagMs)}ms`);
  }
  if (window.elu_max !== null && window.elu_max > 0.75) {
    resource.push(`event_loop_utilization_${window.elu_max.toFixed(2)}`);
  }
  if (window.cgroup_memory_ratio_max !== null && window.cgroup_memory_ratio_max > 0.75) {
    resource.push(`cgroup_memory_${window.cgroup_memory_ratio_max.toFixed(2)}`);
  } else if (window.heap_ratio_max !== null && window.heap_ratio_max > 0.80) {
    resource.push(`node_heap_${window.heap_ratio_max.toFixed(2)}`);
  }
  if (window.max_in_flight > 12) resource.push(`in_flight_${window.max_in_flight}`);

  if (
    window.interactive_latency.count >= options.minimumInteractiveRequests &&
    p95LatencyMs !== null &&
    p95LatencyMs > 3_000
  ) severe.push("interactive_latency_critical");
  if (window.true_errors >= 10 || (trueErrorRate !== null && trueErrorRate > 0.05)) {
    severe.push("true_errors_critical");
  }
  const enoughRuntimeSamples =
    window.event_loop_lag.count >= options.minimumRuntimeSamples;
  if (enoughRuntimeSamples && p95LagMs !== null && p95LagMs > 500) {
    severe.push("event_loop_lag_critical");
  }
  if (enoughRuntimeSamples && window.elu_max !== null && window.elu_max > 0.90) {
    severe.push("event_loop_utilization_critical");
  }
  if (
    enoughRuntimeSamples &&
    window.cgroup_memory_ratio_max !== null &&
    window.cgroup_memory_ratio_max > 0.90
  ) {
    severe.push("cgroup_memory_critical");
  }
  if (
    window.interactive_latency.count >= options.minimumInteractiveRequests &&
    window.max_in_flight > 50 &&
    p95LatencyMs !== null &&
    p95LatencyMs > 1_000
  ) {
    severe.push("concurrency_critical");
  }
  return {
    user,
    resource,
    severe,
    p95_latency_ms: p95LatencyMs,
    p95_event_loop_lag_ms: p95LagMs,
    true_error_rate: trueErrorRate,
    aborted_rate: abortedRate,
  };
}

function policyHash(options) {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    version: TRAFFIC_ALERT_POLICY_VERSION,
    windowMinutes: options.windowMinutes,
    minimumRequests: options.minimumRequests,
    minimumInteractiveRequests: options.minimumInteractiveRequests,
    minimumRuntimeSamples: options.minimumRuntimeSamples,
    strainedWindows: options.strainedWindows,
    criticalWindows: options.criticalWindows,
    recoveryWindows: options.recoveryWindows,
  })).digest("hex")}`;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertHistogram(value, label) {
  if (
    !value ||
    !nonnegativeInteger(value.count) ||
    !Number.isFinite(value.sum_ms) || value.sum_ms < 0 ||
    !Number.isFinite(value.max_ms) || value.max_ms < 0 ||
    !Array.isArray(value.buckets) ||
    value.buckets.length !== LATENCY_BUCKETS_MS.length + 1 ||
    value.buckets.some((count) => !nonnegativeInteger(count)) ||
    value.buckets.reduce((sum, count) => sum + count, 0) !== value.count
  ) throw new TypeError(`Invalid ${label} histogram`);
}

function assertRouteCounts(value, label) {
  if (!value || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label} route counts`);
  }
  for (const [category, count] of Object.entries(value)) {
    if (![
      "page", "static", "interactive_api", "feed", "web_push_control",
      "internal_health", "operations", "delivery_poll", "other",
    ].includes(category) || !nonnegativeInteger(count)) {
      throw new TypeError(`Invalid ${label} route counts`);
    }
  }
}

function assertBucketCounts(bucket, label) {
  if (
    !bucket ||
    !nonnegativeInteger(bucket.requests) ||
    !nonnegativeInteger(bucket.public_requests) ||
    bucket.public_requests > bucket.requests ||
    !nonnegativeInteger(bucket.true_errors) ||
    bucket.true_errors > bucket.public_requests ||
    !nonnegativeInteger(bucket.aborted) ||
    bucket.aborted > bucket.public_requests
  ) throw new TypeError(`Invalid ${label} counts`);
  assertRouteCounts(bucket.by_route, label);
}

function assertRatioOrNull(value, label) {
  if (value !== null && finiteRatio(value) === null) {
    throw new TypeError(`Invalid ${label} ratio`);
  }
}

function assertState(state) {
  if (
    !state ||
    state.schema_version !== TRAFFIC_MONITOR_STATE_VERSION ||
    !state.minutes || Array.isArray(state.minutes) ||
    !state.days || Array.isArray(state.days) ||
    !state.pressure ||
    !["normal", "watch", "strained", "critical"].includes(state.pressure.level) ||
    !Number.isSafeInteger(state.next_alert_sequence) ||
    state.next_alert_sequence < 1 ||
    !Array.isArray(state.alerts)
  ) throw new TypeError("Invalid traffic monitor state");
  iso(state.created_at, "traffic state created_at");
  iso(state.updated_at, "traffic state updated_at");
  if (
    state.active_policy_hash !== undefined &&
    state.active_policy_hash !== null &&
    !/^sha256:[a-f0-9]{64}$/.test(state.active_policy_hash)
  ) throw new TypeError("Invalid traffic monitor policy hash");
  for (const [key, bucket] of Object.entries(state.minutes)) {
    if (bucket?.minute !== key || minuteKey(key) !== key) {
      throw new TypeError("Invalid traffic minute key");
    }
    assertBucketCounts(bucket, `traffic minute ${key}`);
    if (!nonnegativeInteger(bucket.max_in_flight)) {
      throw new TypeError("Invalid traffic minute concurrency");
    }
    assertHistogram(bucket.interactive_latency, `traffic minute ${key} latency`);
    assertHistogram(bucket.event_loop_lag, `traffic minute ${key} lag`);
    assertRatioOrNull(bucket.elu_max, `traffic minute ${key} ELU`);
    assertRatioOrNull(bucket.heap_ratio_max, `traffic minute ${key} heap`);
    assertRatioOrNull(
      bucket.cgroup_memory_ratio_max,
      `traffic minute ${key} cgroup memory`,
    );
  }
  for (const [key, bucket] of Object.entries(state.days)) {
    if (bucket?.day !== key || dayKey(`${key}T00:00:00.000Z`) !== key) {
      throw new TypeError("Invalid traffic day key");
    }
    assertBucketCounts(bucket, `traffic day ${key}`);
  }
  const pressure = state.pressure;
  if (
    !Array.isArray(pressure.reasons) ||
    pressure.reasons.some((reason) => typeof reason !== "string") ||
    !["string", "object"].includes(typeof pressure.incident_id) ||
    (pressure.incident_id !== null && !String(pressure.incident_id).startsWith("capacity:")) ||
    !["string", "object"].includes(typeof pressure.opened_at) ||
    !nonnegativeInteger(pressure.strained_windows) ||
    !nonnegativeInteger(pressure.critical_windows) ||
    !nonnegativeInteger(pressure.healthy_windows)
  ) throw new TypeError("Invalid traffic pressure state");
  if (pressure.opened_at !== null) iso(pressure.opened_at, "pressure opened_at");
  const incidentActive = ["strained", "critical"].includes(pressure.level);
  if (
    (incidentActive &&
      (pressure.incident_id === null || pressure.opened_at === null)) ||
    (!incidentActive &&
      (pressure.incident_id !== null || pressure.opened_at !== null))
  ) throw new TypeError("Invalid traffic pressure incident state");
  iso(pressure.last_transition_at, "pressure transition time");
  if (
    pressure.last_evaluated_minute !== null &&
    minuteKey(pressure.last_evaluated_minute) !== pressure.last_evaluated_minute
  ) throw new TypeError("Invalid traffic pressure evaluation time");
  let previousSequence = 0;
  for (const alert of state.alerts) {
    if (
      !alert ||
      !Number.isSafeInteger(alert.sequence) ||
      alert.sequence <= previousSequence ||
      alert.alert_id !== `traffic:${alert.sequence}` ||
      !String(alert.alert_type ?? "").startsWith("capacity.") ||
      !["normal", "strained", "critical"].includes(alert.level) ||
      typeof alert.incident_id !== "string" ||
      !alert.incident_id.startsWith("capacity:") ||
      typeof alert.title !== "string" ||
      typeof alert.summary !== "string" ||
      !Array.isArray(alert.reasons) ||
      alert.reasons.some((reason) => typeof reason !== "string") ||
      !/^sha256:[a-f0-9]{64}$/.test(alert.policy_hash ?? "")
    ) throw new TypeError("Invalid traffic operations alert");
    const emittedAt = Date.parse(iso(alert.emitted_at, "alert emitted_at"));
    iso(alert.observed_at, "alert observed_at");
    const expiresAt = Date.parse(iso(alert.expires_at, "alert expires_at"));
    if (expiresAt <= emittedAt) throw new TypeError("Invalid traffic alert expiry");
    previousSequence = alert.sequence;
  }
  if (
    (state.alerts.length === 0 && state.next_alert_sequence !== 1) ||
    (state.alerts.length > 0 && previousSequence !== state.next_alert_sequence - 1)
  ) throw new TypeError("Invalid traffic alert tail sequence");
  for (let index = 1; index < state.alerts.length; index += 1) {
    if (state.alerts[index].sequence !== state.alerts[index - 1].sequence + 1) {
      throw new TypeError("Invalid traffic alert sequence gap");
    }
  }
  return state;
}

async function cgroupMemoryRatio(readFile = fs.readFile) {
  try {
    const [currentText, maximumText] = await Promise.all([
      readFile("/sys/fs/cgroup/memory.current", "utf8"),
      readFile("/sys/fs/cgroup/memory.max", "utf8"),
    ]);
    const current = Number(String(currentText).trim());
    const maximumRaw = String(maximumText).trim();
    if (maximumRaw === "max") return null;
    const maximum = Number(maximumRaw);
    return Number.isFinite(current) && Number.isFinite(maximum) && maximum > 0
      ? finiteRatio(current / maximum)
      : null;
  } catch {
    return null;
  }
}

export class TrafficMonitor {
  #state = null;
  #durableAlertTail = 0;
  #writeChain = Promise.resolve();
  #sampleChain = Promise.resolve();
  #sampleTimer = null;
  #flushTimer = null;
  #previousElu = performance.eventLoopUtilization();
  #expectedSampleAt = null;
  #inFlight = 0;
  #stopping = false;

  constructor({
    stateAdapter,
    now = () => new Date(),
    monotonicNow = () => performance.now(),
    timers = { setInterval, clearInterval },
    readFile = fs.readFile,
    logger = console,
    options = {},
  }) {
    if (!stateAdapter?.read || !stateAdapter?.write) {
      throw new TypeError("TrafficMonitor requires a state adapter");
    }
    this.stateAdapter = stateAdapter;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.timers = timers;
    this.readFile = readFile;
    this.logger = logger;
    const sampleIntervalMs = integer(
      options.sampleIntervalMs ?? DEFAULTS.sampleIntervalMs,
      "sampleIntervalMs", 1_000, 60_000,
    );
    this.options = {
      sampleIntervalMs,
      flushIntervalMs: integer(options.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
        "flushIntervalMs", 5_000, 300_000),
      windowMinutes: integer(options.windowMinutes ?? DEFAULTS.windowMinutes,
        "windowMinutes", 1, 15),
      minimumRequests: integer(options.minimumRequests ?? DEFAULTS.minimumRequests,
        "minimumRequests", 1, 100_000),
      minimumInteractiveRequests: integer(
        options.minimumInteractiveRequests ?? DEFAULTS.minimumInteractiveRequests,
        "minimumInteractiveRequests", 1, 100_000,
      ),
      minimumRuntimeSamples: integer(
        options.minimumRuntimeSamples ?? Math.max(3, Math.ceil(60_000 / sampleIntervalMs)),
        "minimumRuntimeSamples", 1, 3_600,
      ),
      strainedWindows: integer(options.strainedWindows ?? DEFAULTS.strainedWindows,
        "strainedWindows", 1, 12),
      criticalWindows: integer(options.criticalWindows ?? DEFAULTS.criticalWindows,
        "criticalWindows", 1, 12),
      recoveryWindows: integer(options.recoveryWindows ?? DEFAULTS.recoveryWindows,
        "recoveryWindows", 1, 24),
    };
    this.policyHash = policyHash(this.options);
  }

  async init() {
    const persisted = await this.stateAdapter.read();
    this.#state = persisted === null || persisted === undefined
      ? defaultState(this.now(), this.policyHash)
      : assertState(migrateState(persisted, this.now()));
    this.#durableAlertTail = this.#state.next_alert_sequence - 1;
    if (this.#state.active_policy_hash !== this.policyHash) {
      const priorPolicyHash = this.#state.active_policy_hash ?? null;
      const priorPressure = this.#state.pressure;
      if (
        ["strained", "critical"].includes(priorPressure.level) &&
        priorPressure.incident_id
      ) {
        this.#appendAlert({
          level: "normal",
          transition: "policy_superseded",
          reasons: ["capacity_policy_changed"],
          incidentId: priorPressure.incident_id,
          previousPolicyHash: priorPolicyHash,
          observedAt: this.now(),
        });
      }
      this.#state.active_policy_hash = this.policyHash;
      this.#state.pressure = defaultPressure(this.now());
      this.#state.updated_at = iso(this.now(), "policy baseline time");
      await this.flush();
    }
    return this;
  }

  #requireState() {
    if (!this.#state) throw new Error("TrafficMonitor is not initialized");
    return this.#state;
  }

  #buckets(at = this.now()) {
    const state = this.#requireState();
    const minute = minuteKey(at);
    const day = dayKey(at);
    state.minutes[minute] ??= emptyMinute(minute);
    state.days[day] ??= emptyDay(day);
    return { minute: state.minutes[minute], day: state.days[day] };
  }

  observe(request, response) {
    const startedAt = this.monotonicNow();
    const category = routeClass(request?.url);
    this.#inFlight += 1;
    this.#buckets().minute.max_in_flight = Math.max(
      this.#buckets().minute.max_in_flight,
      this.#inFlight,
    );
    let settled = false;
    const settle = (aborted) => {
      if (settled) return;
      settled = true;
      this.#inFlight = Math.max(0, this.#inFlight - 1);
      this.recordObservation({
        category,
        status: Number(response?.statusCode ?? 0),
        latencyMs: Math.max(0, this.monotonicNow() - startedAt),
        aborted,
        semanticUnavailable:
          response?.forecasterSemanticUnavailable === true,
      });
    };
    response.once("finish", () => settle(false));
    response.once("close", () => settle(response.writableFinished !== true));
  }

  recordObservation({
    category = "other",
    status = 200,
    latencyMs = 0,
    aborted = false,
    semanticUnavailable = false,
    at = this.now(),
  }) {
    const { minute, day } = this.#buckets(at);
    const normalizedCategory = [
      "page", "static", "interactive_api", "feed", "web_push_control",
      "internal_health", "operations", "delivery_poll", "other",
    ].includes(category) ? category : "other";
    const publicRequest = isPublicRoute(normalizedCategory);
    const trueError = publicRequest && Number(status) >= 500 && !(
      Number(status) === 503 && semanticUnavailable === true
    );
    const publicAbort = publicRequest && aborted;
    for (const bucket of [minute, day]) {
      bucket.requests += 1;
      bucket.public_requests += publicRequest ? 1 : 0;
      bucket.true_errors += trueError ? 1 : 0;
      bucket.aborted += publicAbort ? 1 : 0;
      bucket.by_route[normalizedCategory] =
        (bucket.by_route[normalizedCategory] ?? 0) + 1;
    }
    if (isInteractiveRoute(normalizedCategory)) {
      addHistogram(minute.interactive_latency, latencyMs);
    }
    this.#state.updated_at = iso(at, "observation time");
    this.#trim();
  }

  recordRuntimeSample({
    lagMs = 0,
    elu = null,
    heapRatio = null,
    cgroupMemoryRatio: memoryRatio = null,
    at = this.now(),
  } = {}) {
    const { minute } = this.#buckets(at);
    minute.max_in_flight = Math.max(minute.max_in_flight, this.#inFlight);
    addHistogram(minute.event_loop_lag, lagMs);
    for (const [field, value] of [
      ["elu_max", finiteRatio(elu)],
      ["heap_ratio_max", finiteRatio(heapRatio)],
      ["cgroup_memory_ratio_max", finiteRatio(memoryRatio)],
    ]) {
      if (value !== null) minute[field] = Math.max(minute[field] ?? 0, value);
    }
    this.#state.updated_at = iso(at, "runtime sample time");
    this.#trim();
  }

  #trim() {
    const state = this.#requireState();
    state.minutes = trimRecord(state.minutes, MINUTE_RETENTION);
    state.days = trimRecord(state.days, DAY_RETENTION);
    state.alerts = state.alerts.slice(-ALERT_RETENTION);
  }

  #appendAlert({
    level,
    transition,
    reasons,
    incidentId,
    previousPolicyHash = null,
    observedAt,
  }) {
    const state = this.#requireState();
    const sequence = state.next_alert_sequence;
    state.next_alert_sequence += 1;
    const emittedAt = iso(observedAt, "alert time");
    const expiresAt = new Date(Date.parse(emittedAt) + 24 * 60 * 60 * 1_000)
      .toISOString();
    const title = transition === "policy_superseded"
      ? "源站容量策略已更新"
      : transition === "recovered"
      ? "源站容量压力已恢复"
      : level === "critical"
        ? "源站容量进入严重压力"
        : "源站容量开始吃紧";
    state.alerts.push({
      sequence,
      alert_id: `traffic:${sequence}`,
      alert_type: `capacity.${transition}`,
      incident_id: incidentId,
      level,
      title,
      summary: reasons.length
        ? `触发信号：${reasons.join("、")}`
        : "连续健康窗口已达到恢复条件。",
      reasons: [...reasons],
      policy_version: TRAFFIC_ALERT_POLICY_VERSION,
      policy_hash: this.policyHash,
      ...(previousPolicyHash ? { superseded_policy_hash: previousPolicyHash } : {}),
      emitted_at: emittedAt,
      observed_at: emittedAt,
      expires_at: expiresAt,
    });
    this.#trim();
  }

  evaluate({ at = this.now(), detectedAt = at } = {}) {
    const state = this.#requireState();
    const currentMinute = minuteKey(at);
    const currentMinuteMs = Date.parse(currentMinute);
    const previousEvaluationMs = Date.parse(
      state.pressure.last_evaluated_minute ?? "",
    );
    if (
      Number.isFinite(previousEvaluationMs) &&
      currentMinuteMs - previousEvaluationMs < this.options.windowMinutes * 60_000
    ) {
      return this.summary({ at }).capacity;
    }
    const startMs = Date.parse(currentMinute) -
      (this.options.windowMinutes - 1) * 60_000;
    const selected = Object.values(state.minutes).filter((bucket) => {
      const time = Date.parse(bucket.minute);
      return time >= startMs && time <= Date.parse(currentMinute);
    });
    const window = aggregateMinutes(selected);
    const signals = pressureSignals(window, this.options);
    const hasUserImpact = signals.user.length > 0;
    const hasResourcePressure = signals.resource.length > 0;
    const hasSevere = signals.severe.length > 0;
    const pressure = state.pressure;
    pressure.last_evaluated_minute = currentMinute;
    pressure.strained_windows = hasUserImpact && hasResourcePressure
      ? pressure.strained_windows + 1
      : 0;
    pressure.critical_windows = hasSevere ? pressure.critical_windows + 1 : 0;
    pressure.healthy_windows = !hasUserImpact && !hasResourcePressure
      ? pressure.healthy_windows + 1
      : 0;
    const reasons = [...signals.user, ...signals.resource, ...signals.severe];
    const previousLevel = pressure.level;
    let nextLevel = previousLevel;
    let transition = null;
    if (
      pressure.critical_windows >= this.options.criticalWindows &&
      previousLevel !== "critical"
    ) {
      nextLevel = "critical";
      transition = "escalated";
    } else if (
      pressure.strained_windows >= this.options.strainedWindows &&
      !["strained", "critical"].includes(previousLevel)
    ) {
      nextLevel = "strained";
      transition = "opened";
    } else if (
      ["strained", "critical"].includes(previousLevel) &&
      pressure.healthy_windows >= this.options.recoveryWindows
    ) {
      nextLevel = "normal";
      transition = "recovered";
    } else if (!["strained", "critical"].includes(previousLevel)) {
      nextLevel = hasUserImpact || hasResourcePressure ? "watch" : "normal";
    }
    if (transition) {
      const timestamp = iso(detectedAt, "transition detection time");
      if (transition === "opened" || pressure.incident_id === null) {
        pressure.incident_id = `capacity:${timestamp}`;
        pressure.opened_at = timestamp;
      }
      const incidentId = pressure.incident_id;
      pressure.last_transition_at = timestamp;
      this.#appendAlert({
        level: nextLevel,
        transition,
        reasons: transition === "recovered" ? [] : reasons,
        incidentId,
        observedAt: detectedAt,
      });
      if (transition === "recovered") {
        pressure.incident_id = null;
        pressure.opened_at = null;
      }
    }
    pressure.level = nextLevel;
    pressure.reasons = reasons;
    state.updated_at = iso(detectedAt, "evaluation detection time");
    return this.#capacitySummary(window, signals);
  }

  #window(at) {
    const end = Date.parse(minuteKey(at));
    const start = end - (this.options.windowMinutes - 1) * 60_000;
    return aggregateMinutes(Object.values(this.#requireState().minutes)
      .filter((bucket) => {
        const time = Date.parse(bucket.minute);
        return time >= start && time <= end;
      }));
  }

  #capacitySummary(window, signals = pressureSignals(window, this.options)) {
    const pressure = this.#requireState().pressure;
    return {
      level: pressure.level,
      reasons: [...pressure.reasons],
      incident_id: pressure.incident_id,
      opened_at: pressure.opened_at,
      last_transition_at: pressure.last_transition_at,
      consecutive_windows: {
        strained: pressure.strained_windows,
        critical: pressure.critical_windows,
        healthy: pressure.healthy_windows,
      },
      policy: {
        version: TRAFFIC_ALERT_POLICY_VERSION,
        hash: this.policyHash,
        window_minutes: this.options.windowMinutes,
        minimum_requests: this.options.minimumRequests,
        minimum_interactive_requests: this.options.minimumInteractiveRequests,
        minimum_runtime_samples: this.options.minimumRuntimeSamples,
      },
      rolling_window: {
        requests: window.requests,
        public_requests: window.public_requests,
        interactive_requests: window.interactive_latency.count,
        interactive_p95_ms: signals.p95_latency_ms,
        true_errors: window.true_errors,
        true_error_rate: signals.true_error_rate,
        aborted: window.aborted,
        aborted_rate: signals.aborted_rate,
        max_in_flight: window.max_in_flight,
        event_loop_lag_p95_ms: signals.p95_event_loop_lag_ms,
        event_loop_utilization_max: window.elu_max,
        node_heap_ratio_max: window.heap_ratio_max,
        cgroup_memory_ratio_max: window.cgroup_memory_ratio_max,
      },
    };
  }

  summary({ at = this.now() } = {}) {
    const state = this.#requireState();
    const currentDay = dayKey(at);
    const yesterday = state.days[shiftedDay(at, -1)] ?? null;
    const previous = state.days[shiftedDay(at, -2)] ?? null;
    const baseline = Array.from({ length: 7 }, (_, index) =>
      state.days[shiftedDay(at, -(index + 2))] ?? null
    ).filter(Boolean);
    const sevenDayMedian = median(baseline.map((day) => day.public_requests));
    const dayOverDay = previous?.public_requests > 0 && yesterday
      ? (yesterday.public_requests - previous.public_requests) /
        previous.public_requests
      : null;
    const versusMedian = sevenDayMedian > 0 && yesterday
      ? (yesterday.public_requests - sevenDayMedian) / sevenDayMedian
      : null;
    const growthReady = yesterday !== null &&
      baseline.length >= 7 && sevenDayMedian !== null;
    const growthWatch = growthReady &&
      yesterday.public_requests >= 200 &&
      yesterday.public_requests - sevenDayMedian >= 200 &&
      yesterday.public_requests / sevenDayMedian >= 2;
    const current = state.days[currentDay] ?? emptyDay(currentDay);
    const window = this.#window(at);
    return {
      schema_version: TRAFFIC_MONITOR_SUMMARY_VERSION,
      observed_at: iso(at, "summary time"),
      scope: "origin_only",
      privacy: {
        stores_ip: false,
        stores_user_agent: false,
        stores_query: false,
        stores_raw_path: false,
      },
      traffic: {
        current: {
          day: current.day,
          requests: current.public_requests,
          total_origin_requests: current.requests,
          by_route: structuredClone(current.by_route),
        },
        yesterday: yesterday
          ? { day: yesterday.day, requests: yesterday.public_requests }
          : null,
        seven_days: {
          requests: sevenDayMedian,
          median_daily_requests: sevenDayMedian,
          baseline_days: baseline.length,
        },
        growth: {
          status: growthReady ? (growthWatch ? "watch" : "normal") : "insufficient_data",
          day_over_day: dayOverDay,
          versus_seven_day_median: versusMedian,
          watch: growthWatch,
        },
      },
      capacity: this.#capacitySummary(window),
    };
  }

  listAlerts(after = null, { limit = 100 } = {}) {
    const state = this.#requireState();
    const tail = this.#durableAlertTail;
    const pageLimit = integer(limit, "alert limit", 1, 500);
    if (after === null || after === undefined) {
      return { alerts: [], cursor: tail, next_cursor: String(tail), has_more: false };
    }
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError("Operations alert cursor is invalid");
    }
    if (cursor > tail) {
      throw new OperationsAlertCursorResetError("ahead_of_tail", tail);
    }
    const visibleAlerts = state.alerts.filter((alert) => alert.sequence <= tail);
    const retainedFloor = visibleAlerts[0]?.sequence ?? tail + 1;
    if (cursor < retainedFloor - 1) {
      throw new OperationsAlertCursorResetError(
        "retention_gap",
        retainedFloor - 1,
      );
    }
    const selected = visibleAlerts
      .filter((alert) => alert.sequence > cursor)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, pageLimit);
    const next = selected.at(-1)?.sequence ?? cursor;
    return {
      alerts: structuredClone(selected),
      cursor: next,
      next_cursor: String(next),
      has_more: next < tail,
    };
  }

  async #sampleRuntime() {
    const observedAt = this.now();
    const actual = observedAt.getTime();
    const lagMs = this.#expectedSampleAt === null
      ? 0
      : Math.max(0, actual - this.#expectedSampleAt);
    this.#expectedSampleAt = actual + this.options.sampleIntervalMs;
    const eluSample = performance.eventLoopUtilization(this.#previousElu);
    this.#previousElu = performance.eventLoopUtilization();
    const heap = getHeapStatistics();
    this.recordRuntimeSample({
      lagMs,
      elu: eluSample.utilization,
      heapRatio: heap.heap_size_limit > 0
        ? process.memoryUsage().heapUsed / heap.heap_size_limit
        : null,
      cgroupMemoryRatio: await cgroupMemoryRatio(this.readFile),
      at: observedAt,
    });
    const alertTailBeforeEvaluation =
      this.#requireState().next_alert_sequence - 1;
    this.evaluate({
      at: new Date(observedAt.getTime() - 60_000),
      detectedAt: observedAt,
    });
    if (
      this.#requireState().next_alert_sequence - 1 > alertTailBeforeEvaluation
    ) await this.flush();
  }

  #queueRuntimeSample() {
    if (this.#stopping) return this.#sampleChain;
    const operation = () => this.#sampleRuntime();
    const result = this.#sampleChain.then(operation, operation);
    this.#sampleChain = result.catch((error) => {
      this.logger.error?.(`traffic runtime sample failed: ${error.message}`);
    });
    return result;
  }

  start() {
    this.#requireState();
    if (this.#sampleTimer || this.#flushTimer) return;
    this.#stopping = false;
    this.#expectedSampleAt = this.now().getTime() + this.options.sampleIntervalMs;
    this.#sampleTimer = this.timers.setInterval(
      () => void this.#queueRuntimeSample(),
      this.options.sampleIntervalMs,
    );
    this.#flushTimer = this.timers.setInterval(
      () => void this.flush().catch((error) => {
        this.logger.error?.(`traffic state flush failed: ${error.message}`);
      }),
      this.options.flushIntervalMs,
    );
    this.#sampleTimer?.unref?.();
    this.#flushTimer?.unref?.();
  }

  async flush() {
    const snapshot = structuredClone(this.#requireState());
    const alertTail = snapshot.next_alert_sequence - 1;
    const operation = async () => {
      await this.stateAdapter.write(snapshot);
      this.#durableAlertTail = Math.max(this.#durableAlertTail, alertTail);
    };
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.catch(() => {});
    return result;
  }

  async stop() {
    this.#stopping = true;
    if (this.#sampleTimer) this.timers.clearInterval(this.#sampleTimer);
    if (this.#flushTimer) this.timers.clearInterval(this.#flushTimer);
    this.#sampleTimer = null;
    this.#flushTimer = null;
    await this.#sampleChain;
    await this.flush();
    await this.#writeChain;
  }

  waitForIdle() {
    return Promise.all([this.#sampleChain, this.#writeChain]);
  }
}

export async function readProtectedToken(filePath) {
  if (!String(filePath ?? "").trim()) return null;
  const metadata = await fs.stat(filePath);
  if (!metadata.isFile()) throw new TypeError("Operations token must be a regular file");
  if (![0o400, 0o600].includes(metadata.mode & 0o777)) {
    throw new Error("Operations token file mode must be 0400 or 0600");
  }
  if (metadata.size < OPERATIONS_TOKEN_MINIMUM_BYTES || metadata.size > 1_024) {
    throw new RangeError("Operations token file has an invalid size");
  }
  const token = (await fs.readFile(filePath, "utf8")).trim();
  if (
    Buffer.byteLength(token, "utf8") < OPERATIONS_TOKEN_MINIMUM_BYTES ||
    token.length > 512 ||
    /\s|[\u0000-\u001f\u007f]/.test(token)
  ) throw new TypeError("Operations token file has an invalid value");
  return token;
}

export function authorizedOperationsRequest(request, token) {
  if (!token) return false;
  const header = String(request?.headers?.authorization ?? "");
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const trafficRouteClass = routeClass;
