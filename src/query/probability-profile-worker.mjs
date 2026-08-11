import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
  PROBABILITY_THRESHOLD_PROFILE_VERSION,
  parseProbabilityProfileHorizon,
} from "./probability-threshold-profile.mjs";

const REQUEST_TYPE = "probability_profile_request";
const RESPONSE_TYPE = "probability_profile_response";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const WORKER_ENTRY = new URL(
  "./probability-profile-worker-thread.mjs",
  import.meta.url,
);

export const PROBABILITY_PROFILE_SNAPSHOT_STATE_KEY =
  "probability-profile-snapshot";
export const PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION =
  "probability-profile-snapshot/1";
export const PROBABILITY_PROFILE_WARM_TIMEOUT_MS = 120_000;
export const UI_NOTIFICATION_HORIZON_HOURS = Object.freeze([
  ...Array.from({ length: 12 }, (_, index) => index + 1),
  ...Array.from({ length: 9 }, (_, index) => 16 + index * 4),
  ...Array.from({ length: 4 }, (_, index) => 60 + index * 12),
  ...Array.from({ length: 3 }, (_, index) => 120 + index * 24),
]);
const UI_NOTIFICATION_HORIZONS = new Set(UI_NOTIFICATION_HORIZON_HOURS);

export class ProbabilityProfileUnavailableError extends Error {
  constructor(message, { cause = null, code = "probability_profile_unavailable" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProbabilityProfileUnavailableError";
    this.code = code;
  }
}

function unavailable(message, options = {}) {
  return new ProbabilityProfileUnavailableError(message, options);
}

function assertPositiveDuration(value, name) {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a positive duration in milliseconds`);
  }
  return value;
}

function workerError(value) {
  const error = unavailable(
    value?.message ?? "Probability profile worker failed",
    { code: value?.code ?? "probability_profile_worker_failed" },
  );
  error.workerErrorName = value?.name ?? "Error";
  return error;
}

function normalizedHorizons(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("horizons must contain at least one horizon_hours value");
  }
  return [...new Set(values.map(parseProbabilityProfileHorizon))];
}

function contextGenerationHash(profile) {
  const value = profile?.lineage?.context_generation_hash;
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function finiteTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function seededProfiles(snapshot) {
  if (
    snapshot?.schema_version !== PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION ||
    finiteTimestamp(snapshot.generated_at) === null ||
    !Array.isArray(snapshot.profiles)
  ) return [];
  const profiles = [];
  const seen = new Set();
  for (const entry of snapshot.profiles) {
    let horizonHours;
    try {
      horizonHours = parseProbabilityProfileHorizon(entry?.horizon_hours);
    } catch {
      continue;
    }
    if (!UI_NOTIFICATION_HORIZONS.has(horizonHours)) continue;
    const profile = entry?.profile;
    const generationHash = contextGenerationHash(profile);
    const cachedAt = finiteTimestamp(entry?.cached_at);
    const expiresAt = finiteTimestamp(entry?.expires_at);
    if (
      seen.has(horizonHours) ||
      profile?.schema_version !== NOTIFICATION_THRESHOLD_CALIBRATION_VERSION ||
      profile?.detail_schema_version !==
        PROBABILITY_THRESHOLD_PROFILE_VERSION ||
      profile?.horizon_hours !== horizonHours ||
      !Array.isArray(profile?.points) ||
      !profile?.distribution_summary ||
      typeof profile.distribution_summary !== "object" ||
      Array.isArray(profile.distribution_summary) ||
      generationHash === null ||
      entry?.context_generation_hash !== generationHash ||
      cachedAt === null ||
      expiresAt === null
    ) continue;
    seen.add(horizonHours);
    profiles.push({
      horizonHours,
      value: structuredClone(profile),
      cachedAt,
      expiresAt,
    });
  }
  return profiles;
}

export function createProbabilityProfileWorkerProvider({
  dataDir,
  config,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  warmRequestTimeoutMs = PROBABILITY_PROFILE_WARM_TIMEOUT_MS,
  contextTtlMs = DEFAULT_CACHE_TTL_MS,
  profileCacheTtlMs = DEFAULT_CACHE_TTL_MS,
  seedSnapshot = null,
  onSnapshot = null,
  workerFactory = (entry, options) => new Worker(entry, options),
  now = () => Date.now(),
} = {}) {
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new TypeError("dataDir is required for the probability profile worker");
  }
  if (!config || typeof config !== "object") {
    throw new TypeError("config is required for the probability profile worker");
  }
  if (typeof workerFactory !== "function") {
    throw new TypeError("workerFactory must be a function");
  }
  if (onSnapshot !== null && typeof onSnapshot !== "function") {
    throw new TypeError("onSnapshot must be a function when provided");
  }
  assertPositiveDuration(requestTimeoutMs, "requestTimeoutMs");
  assertPositiveDuration(warmRequestTimeoutMs, "warmRequestTimeoutMs");
  assertPositiveDuration(contextTtlMs, "contextTtlMs");
  assertPositiveDuration(profileCacheTtlMs, "profileCacheTtlMs");

  const resolvedDataDir = path.resolve(dataDir);
  const workerConfig = structuredClone(config);
  const cache = new Map();
  const pending = new Map();
  let activeWorker = null;
  let nextRequestId = 1;
  let stopped = false;
  let stopPromise = null;
  let requestQueue = null;
  let snapshotCallbackQueue = Promise.resolve();

  for (const seeded of seededProfiles(seedSnapshot)) {
    cache.set(seeded.horizonHours, {
      value: seeded.value,
      cachedAt: seeded.cachedAt,
      expiresAt: seeded.expiresAt,
      inFlight: null,
    });
  }

  function rejectPendingFor(worker, error) {
    for (const [requestId, request] of pending) {
      if (request.worker !== worker) continue;
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.reject(error);
    }
  }

  function detachWorker(worker) {
    if (activeWorker !== worker) return;
    activeWorker = null;
  }

  function failWorker(worker, error, { terminate = false } = {}) {
    detachWorker(worker);
    rejectPendingFor(worker, error);
    if (terminate && typeof worker.terminate === "function") {
      Promise.resolve(worker.terminate()).catch(() => {});
    }
  }

  function handleMessage(worker, message) {
    if (
      message?.type !== RESPONSE_TYPE ||
      !Number.isSafeInteger(message.request_id)
    ) {
      failWorker(
        worker,
        unavailable("Probability profile worker returned an invalid response", {
          code: "probability_profile_worker_protocol_error",
        }),
        { terminate: true },
      );
      return;
    }
    const request = pending.get(message.request_id);
    if (!request || request.worker !== worker) return;
    clearTimeout(request.timer);
    pending.delete(message.request_id);
    if (!message.ok) {
      request.reject(workerError(message.error));
      return;
    }
    const returnedProfiles = Array.isArray(message.profiles)
      ? message.profiles
      : message.profile
        ? [message.profile]
        : [];
    const profiles = new Map();
    for (const profile of returnedProfiles) {
      if (
        !profile ||
        !request.horizons.includes(profile.horizon_hours) ||
        profiles.has(profile.horizon_hours)
      ) continue;
      profiles.set(profile.horizon_hours, profile);
    }
    if (
      !Number.isFinite(message.context_expires_at) ||
      profiles.size !== request.horizons.length
    ) {
      request.reject(unavailable(
        "Probability profile worker returned an incomplete result",
        { code: "probability_profile_worker_protocol_error" },
      ));
      return;
    }
    request.resolve({
      profiles,
      contextExpiresAt: message.context_expires_at,
    });
  }

  function startWorker() {
    if (stopped) {
      throw unavailable("Probability profile provider is stopped", {
        code: "probability_profile_provider_stopped",
      });
    }
    if (activeWorker) return activeWorker;
    let worker;
    try {
      worker = workerFactory(WORKER_ENTRY, {
        workerData: {
          data_dir: resolvedDataDir,
          config: workerConfig,
          context_ttl_ms: contextTtlMs,
        },
      });
    } catch (error) {
      throw unavailable("Probability profile worker could not start", {
        cause: error,
        code: "probability_profile_worker_start_failed",
      });
    }
    activeWorker = worker;
    worker.on("message", (message) => handleMessage(worker, message));
    worker.on("error", (error) => {
      failWorker(worker, unavailable("Probability profile worker crashed", {
        cause: error,
        code: "probability_profile_worker_crashed",
      }));
    });
    worker.on("exit", (code) => {
      if (activeWorker !== worker && ![...pending.values()].some(
        (request) => request.worker === worker,
      )) return;
      failWorker(worker, unavailable(
        `Probability profile worker exited before completing requests (code ${code})`,
        { code: "probability_profile_worker_exited" },
      ));
    });
    worker.unref?.();
    return worker;
  }

  function requestProfiles(horizons, {
    force = false,
    timeoutMs = requestTimeoutMs,
  } = {}) {
    let worker;
    try {
      worker = startWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = nextRequestId;
    nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER
      ? 1
      : nextRequestId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = unavailable(
          `Probability profile worker exceeded ${timeoutMs} ms`,
          { code: "probability_profile_worker_timeout" },
        );
        failWorker(worker, error, { terminate: true });
      }, timeoutMs);
      pending.set(requestId, { worker, timer, resolve, reject, horizons });
      try {
        worker.postMessage({
          type: REQUEST_TYPE,
          request_id: requestId,
          horizon_hours: horizons.length === 1 ? horizons[0] : horizons,
          force_refresh: force,
        });
      } catch (error) {
        failWorker(worker, unavailable(
          "Probability profile request could not be sent to the worker",
          { cause: error, code: "probability_profile_worker_send_failed" },
        ), { terminate: true });
      }
    });
  }

  function snapshotFromCache() {
    const profiles = [...cache.entries()]
      .map(([horizonHours, entry]) => {
        if (!UI_NOTIFICATION_HORIZONS.has(horizonHours)) return null;
        const generationHash = contextGenerationHash(entry.value);
        if (generationHash === null) return null;
        return {
          horizon_hours: horizonHours,
          cached_at: new Date(entry.cachedAt).toISOString(),
          expires_at: new Date(entry.expiresAt).toISOString(),
          context_generation_hash: generationHash,
          profile: structuredClone(entry.value),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.horizon_hours - right.horizon_hours);
    if (profiles.length === 0) return null;
    return {
      schema_version: PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
      generated_at: new Date(now()).toISOString(),
      profiles,
    };
  }

  function scheduleSnapshotCallback() {
    if (onSnapshot === null || stopped) return;
    const snapshot = snapshotFromCache();
    if (snapshot === null) return;
    snapshotCallbackQueue = snapshotCallbackQueue
      .then(() => onSnapshot(snapshot))
      .catch(() => {});
  }

  function enqueueProfiles(horizons, {
    force = false,
    timeoutMs = requestTimeoutMs,
  } = {}) {
    const run = () => requestProfiles(horizons, { force, timeoutMs });
    const requested = requestQueue ? requestQueue.then(run, run) : run();
    const queueTail = requested.catch(() => {});
    requestQueue = queueTail;
    void queueTail.finally(() => {
      if (requestQueue === queueTail) requestQueue = null;
    });
    const applied = requested.then(({ profiles, contextExpiresAt }) => {
      if (stopped) {
        throw unavailable("Probability profile provider is stopped", {
          code: "probability_profile_provider_stopped",
        });
      }
      const cachedAt = now();
      const expiresAt = Math.min(
        cachedAt + profileCacheTtlMs,
        contextExpiresAt,
      );
      for (const horizonHours of horizons) {
        const entry = cache.get(horizonHours) ?? {
          value: undefined,
          cachedAt: 0,
          expiresAt: 0,
          inFlight: null,
        };
        entry.value = profiles.get(horizonHours);
        entry.cachedAt = cachedAt;
        entry.expiresAt = expiresAt;
        cache.set(horizonHours, entry);
      }
      if (horizons.some((horizonHours) =>
        UI_NOTIFICATION_HORIZONS.has(horizonHours)
      )) {
        scheduleSnapshotCallback();
      }
      return profiles;
    });
    for (const horizonHours of horizons) {
      const entry = cache.get(horizonHours) ?? {
        value: undefined,
        cachedAt: 0,
        expiresAt: 0,
        inFlight: null,
      };
      const profileRequest = applied.then((profiles) => profiles.get(horizonHours));
      entry.inFlight = profileRequest;
      cache.set(horizonHours, entry);
      profileRequest.finally(() => {
        if (entry.inFlight === profileRequest) entry.inFlight = null;
      }).catch(() => {});
    }
    return applied;
  }

  async function warm(horizonValues = UI_NOTIFICATION_HORIZON_HOURS, {
    force = false,
  } = {}) {
    const horizons = normalizedHorizons(horizonValues);
    if (stopped) {
      throw unavailable("Probability profile provider is stopped", {
        code: "probability_profile_provider_stopped",
      });
    }
    const requestedAt = now();
    if (force) {
      await enqueueProfiles(horizons, {
        force: true,
        timeoutMs: warmRequestTimeoutMs,
      });
    } else {
      const missing = horizons.filter((horizonHours) => {
        const entry = cache.get(horizonHours);
        return !(
          entry?.value !== undefined && requestedAt < entry.expiresAt
        ) && !entry?.inFlight;
      });
      if (missing.length > 0) {
        enqueueProfiles(missing, { timeoutMs: warmRequestTimeoutMs });
      }
      await Promise.all(horizons.map((horizonHours) => {
        const entry = cache.get(horizonHours);
        if (entry?.value !== undefined && requestedAt < entry.expiresAt) {
          return entry.value;
        }
        return entry?.inFlight;
      }));
    }
    return new Map(horizons.map((horizonHours) => [
      horizonHours,
      cache.get(horizonHours)?.value,
    ]));
  }

  async function get(horizonValue, { waitForWarm = true } = {}) {
    const horizonHours = parseProbabilityProfileHorizon(horizonValue);
    if (stopped) {
      throw unavailable("Probability profile provider is stopped", {
        code: "probability_profile_provider_stopped",
      });
    }
    const requestedAt = now();
    const existing = cache.get(horizonHours);
    if (existing?.value !== undefined) {
      if (requestedAt >= existing.expiresAt && !existing.inFlight) {
        const backgroundHorizons =
          UI_NOTIFICATION_HORIZONS.has(horizonHours)
            ? UI_NOTIFICATION_HORIZON_HOURS
            : [...UI_NOTIFICATION_HORIZON_HOURS, horizonHours];
        void warm(backgroundHorizons, { force: true }).catch(() => {});
      }
      return existing.value;
    }
    if (!waitForWarm) {
      if (!existing?.inFlight) {
        const backgroundHorizons = UI_NOTIFICATION_HORIZONS.has(horizonHours)
          ? UI_NOTIFICATION_HORIZON_HOURS
          : [...UI_NOTIFICATION_HORIZON_HOURS, horizonHours];
        void warm(backgroundHorizons).catch(() => {});
      }
      throw unavailable(
        "Probability calibration profile is warming in the background",
        { code: "probability_profile_warming" },
      );
    }
    if (existing?.inFlight) return existing.inFlight;
    const profiles = await enqueueProfiles([horizonHours], {
      timeoutMs: requestTimeoutMs,
    });
    return profiles.get(horizonHours);
  }

  function refresh(horizonValues = UI_NOTIFICATION_HORIZON_HOURS, options = {}) {
    if (!Array.isArray(horizonValues) && typeof horizonValues === "object") {
      options = horizonValues ?? {};
      horizonValues = UI_NOTIFICATION_HORIZON_HOURS;
    }
    return warm(horizonValues, { ...options, force: options.force ?? true });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    cache.clear();
    const worker = activeWorker;
    activeWorker = null;
    let termination = Promise.resolve();
    if (worker) {
      rejectPendingFor(worker, unavailable(
        "Probability profile provider stopped during a request",
        { code: "probability_profile_provider_stopped" },
      ));
      if (typeof worker.terminate === "function") {
        try {
          termination = Promise.resolve(worker.terminate());
        } catch (error) {
          termination = Promise.reject(error);
        }
      }
    }
    stopPromise = Promise.allSettled([
      termination,
      requestQueue ?? Promise.resolve(),
      snapshotCallbackQueue,
    ]).then(([terminationResult]) => {
      if (terminationResult.status === "rejected") {
        throw terminationResult.reason;
      }
    });
    return stopPromise;
  }

  return { get, warm, refresh, stop };
}
