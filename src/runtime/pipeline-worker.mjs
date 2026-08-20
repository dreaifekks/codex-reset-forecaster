import path from "node:path";
import { Worker } from "node:worker_threads";

const WORKER_ENTRY = new URL("./pipeline-worker-thread.mjs", import.meta.url);
const REQUEST_TYPE = "pipeline_worker_request";
const RESPONSE_TYPE = "pipeline_worker_response";

function serializedWorkerError(value, fallback) {
  const error = new Error(value?.message ?? fallback);
  error.name = value?.name ?? "Error";
  if (typeof value?.code === "string") error.code = value.code;
  return error;
}

function stoppedError() {
  const error = new Error("Pipeline worker is stopped");
  error.code = "pipeline_worker_stopped";
  return error;
}

export function projectPipelineSchedulerResult(result) {
  const training = result.training ? {
    status: result.training.status ?? null,
    succeeded: result.training.succeeded === true,
    skipped: result.training.skipped === true,
    reused_challenger: result.training.reused_challenger === true,
    reason_code: result.training.reason_code ?? null,
    error: result.training.error ?? null,
    evaluation: result.training.evaluation ? { available: true } : null,
    promotion: result.training.promotion ? {
      promoted: result.training.promotion.promoted === true,
      reason: result.training.promotion.reason ?? null,
    } : null,
    promotion_guard: result.training.promotion_guard ?? null,
  } : null;
  return {
    status: result.status,
    collection: result.collection,
    training,
    promotion_guard: result.promotion_guard ?? null,
    forecast: result.forecast?.prediction ? {
      prediction: {
        record_id: result.forecast.prediction.record_id,
        revision: result.forecast.prediction.revision,
      },
    } : null,
    coverage_waiting: result.coverage_waiting ?? null,
    evaluation_waiting: result.evaluation_waiting ?? null,
    timing: result.timing ?? null,
  };
}

export function createPipelineWorker({
  dataDir,
  config,
  workerFactory = (entry, options) => new Worker(entry, options),
} = {}) {
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new TypeError("Pipeline worker dataDir is required");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Pipeline worker config is required");
  }
  if (typeof workerFactory !== "function") {
    throw new TypeError("Pipeline worker factory must be a function");
  }

  const workerData = {
    data_dir: path.resolve(dataDir),
    config: structuredClone(config),
  };
  const pending = new Map();
  let activeWorker = null;
  let nextRequestId = 1;
  let requestQueue = Promise.resolve();
  let stopped = false;
  let stopPromise = null;

  function rejectPending(worker, error) {
    for (const [requestId, request] of pending) {
      if (request.worker !== worker) continue;
      pending.delete(requestId);
      request.reject(error);
    }
  }

  function detachWorker(worker) {
    if (activeWorker === worker) activeWorker = null;
  }

  function failWorker(worker, error, { terminate = false } = {}) {
    detachWorker(worker);
    rejectPending(worker, error);
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
        serializedWorkerError(
          null,
          "Pipeline worker returned an invalid response",
        ),
        { terminate: true },
      );
      return;
    }
    const request = pending.get(message.request_id);
    if (!request || request.worker !== worker) return;
    pending.delete(message.request_id);
    if (!message.ok) {
      request.reject(serializedWorkerError(
        message.error,
        "Pipeline worker request failed",
      ));
      return;
    }
    request.resolve(message.value);
  }

  function startWorker() {
    if (stopped) throw stoppedError();
    if (activeWorker) return activeWorker;
    let worker;
    try {
      worker = workerFactory(WORKER_ENTRY, { workerData });
    } catch (error) {
      const wrapped = new Error(`Pipeline worker could not start: ${error.message}`);
      wrapped.code = "pipeline_worker_start_failed";
      throw wrapped;
    }
    activeWorker = worker;
    worker.on("message", (message) => handleMessage(worker, message));
    worker.on("error", (error) => {
      const wrapped = new Error(`Pipeline worker crashed: ${error.message}`);
      wrapped.code = "pipeline_worker_crashed";
      failWorker(worker, wrapped);
    });
    worker.on("exit", (code) => {
      if (
        activeWorker !== worker &&
        ![...pending.values()].some((request) => request.worker === worker)
      ) return;
      const error = new Error(
        `Pipeline worker exited before completing requests (code ${code})`,
      );
      error.code = "pipeline_worker_exited";
      failWorker(worker, error);
    });
    return worker;
  }

  function send(action, payload = {}) {
    if (stopped) return Promise.reject(stoppedError());
    const execute = () => {
      const worker = startWorker();
      const requestId = nextRequestId;
      nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER
        ? 1
        : nextRequestId + 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { worker, resolve, reject });
        try {
          worker.postMessage({
            type: REQUEST_TYPE,
            request_id: requestId,
            action,
            payload,
          });
        } catch (error) {
          const wrapped = new Error(
            `Pipeline worker request could not be sent: ${error.message}`,
          );
          wrapped.code = "pipeline_worker_send_failed";
          failWorker(worker, wrapped, { terminate: true });
        }
      });
    };
    const requested = requestQueue.then(execute, execute);
    requestQueue = requested.catch(() => {});
    return requested;
  }

  function run({ collect = true, retrain = false, now = null } = {}) {
    const fixedNow = now === null || now === undefined
      ? null
      : new Date(now).toISOString();
    return send("run_pipeline", {
      collect: collect !== false,
      retrain: retrain === true,
      now: fixedNow,
    });
  }

  function materializeServingSnapshot(at = new Date()) {
    const materializedAt = new Date(at);
    if (!Number.isFinite(materializedAt.getTime())) {
      throw new TypeError("Invalid serving snapshot time");
    }
    return send("materialize_serving_snapshot", {
      materialized_at: materializedAt.toISOString(),
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    const worker = activeWorker;
    activeWorker = null;
    const error = stoppedError();
    if (worker) rejectPending(worker, error);
    stopPromise = Promise.resolve(requestQueue)
      .catch(() => {})
      .then(() => {
        if (!worker || typeof worker.terminate !== "function") return;
        return worker.terminate();
      });
    return stopPromise;
  }

  return Object.freeze({ run, materializeServingSnapshot, stop });
}
