import path from "node:path";
import { Worker } from "node:worker_threads";
import { parseProbabilityProfileHorizon } from "./probability-threshold-profile.mjs";

const REQUEST_TYPE = "probability_profile_request";
const RESPONSE_TYPE = "probability_profile_response";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const WORKER_ENTRY = new URL(
  "./probability-profile-worker-thread.mjs",
  import.meta.url,
);

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

export function createProbabilityProfileWorkerProvider({
  dataDir,
  config,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  contextTtlMs = DEFAULT_CACHE_TTL_MS,
  profileCacheTtlMs = DEFAULT_CACHE_TTL_MS,
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
  assertPositiveDuration(requestTimeoutMs, "requestTimeoutMs");
  assertPositiveDuration(contextTtlMs, "contextTtlMs");
  assertPositiveDuration(profileCacheTtlMs, "profileCacheTtlMs");

  const resolvedDataDir = path.resolve(dataDir);
  const workerConfig = structuredClone(config);
  const cache = new Map();
  const pending = new Map();
  let activeWorker = null;
  let nextRequestId = 1;
  let stopped = false;

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
    if (
      !message.profile ||
      !Number.isFinite(message.context_expires_at)
    ) {
      request.reject(unavailable(
        "Probability profile worker returned an incomplete result",
        { code: "probability_profile_worker_protocol_error" },
      ));
      return;
    }
    request.resolve({
      profile: message.profile,
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

  function requestProfile(horizonHours) {
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
          `Probability profile worker exceeded ${requestTimeoutMs} ms`,
          { code: "probability_profile_worker_timeout" },
        );
        failWorker(worker, error, { terminate: true });
      }, requestTimeoutMs);
      pending.set(requestId, { worker, timer, resolve, reject });
      try {
        worker.postMessage({
          type: REQUEST_TYPE,
          request_id: requestId,
          horizon_hours: horizonHours,
        });
      } catch (error) {
        failWorker(worker, unavailable(
          "Probability profile request could not be sent to the worker",
          { cause: error, code: "probability_profile_worker_send_failed" },
        ), { terminate: true });
      }
    });
  }

  async function get(horizonValue) {
    const horizonHours = parseProbabilityProfileHorizon(horizonValue);
    const requestedAt = now();
    const existing = cache.get(horizonHours);
    if (existing?.value !== undefined && requestedAt < existing.expiresAt) {
      return existing.value;
    }
    if (existing?.inFlight) return existing.inFlight;
    const entry = existing ?? {
      value: undefined,
      expiresAt: 0,
      inFlight: null,
    };
    entry.inFlight = requestProfile(horizonHours)
      .then(({ profile, contextExpiresAt }) => {
        entry.value = profile;
        entry.expiresAt = Math.min(
          now() + profileCacheTtlMs,
          contextExpiresAt,
        );
        return profile;
      })
      .finally(() => {
        entry.inFlight = null;
      });
    cache.set(horizonHours, entry);
    return entry.inFlight;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    cache.clear();
    const worker = activeWorker;
    activeWorker = null;
    if (!worker) return;
    rejectPendingFor(worker, unavailable(
      "Probability profile provider stopped during a request",
      { code: "probability_profile_provider_stopped" },
    ));
    if (typeof worker.terminate === "function") await worker.terminate();
  }

  return { get, stop };
}
