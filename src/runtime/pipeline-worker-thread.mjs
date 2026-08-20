import { parentPort, workerData } from "node:worker_threads";
import { runPipeline } from "../pipeline/run.mjs";
import { JsonlStore } from "../store/jsonl-store.mjs";
import { materializeServingSnapshot } from "../web/app.mjs";
import { projectPipelineSchedulerResult } from "./pipeline-worker.mjs";

const REQUEST_TYPE = "pipeline_worker_request";
const RESPONSE_TYPE = "pipeline_worker_response";

if (!parentPort) {
  throw new Error("Pipeline worker requires a parent port");
}
if (
  typeof workerData?.data_dir !== "string" ||
  !workerData?.config ||
  typeof workerData.config !== "object" ||
  Array.isArray(workerData.config)
) {
  throw new TypeError("Pipeline worker data is invalid");
}

const config = workerData.config;
const store = await new JsonlStore(workerData.data_dir).init();
let requestQueue = Promise.resolve();

function serializedError(error) {
  return {
    name: error?.name ?? "Error",
    code: typeof error?.code === "string" ? error.code : null,
    message: error?.message ?? String(error),
  };
}

async function execute(message) {
  if (message.action === "run_pipeline") {
    const fixedNow = message.payload?.now === null ||
        message.payload?.now === undefined
      ? null
      : new Date(message.payload.now);
    const result = await runPipeline(store, config, {
      now: fixedNow,
      collect: message.payload?.collect !== false,
      retrain: message.payload?.retrain === true,
    });
    return projectPipelineSchedulerResult(result);
  }
  if (message.action === "materialize_serving_snapshot") {
    return materializeServingSnapshot(store, config, {
      materializedAt: new Date(message.payload?.materialized_at),
      persist: true,
    });
  }
  throw new TypeError(`Unsupported pipeline worker action: ${message.action}`);
}

parentPort.on("message", (message) => {
  if (
    message?.type !== REQUEST_TYPE ||
    !Number.isSafeInteger(message.request_id) ||
    message.request_id < 1
  ) return;
  requestQueue = requestQueue.then(async () => {
    try {
      const value = await execute(message);
      parentPort.postMessage({
        type: RESPONSE_TYPE,
        request_id: message.request_id,
        ok: true,
        value,
      });
    } catch (error) {
      parentPort.postMessage({
        type: RESPONSE_TYPE,
        request_id: message.request_id,
        ok: false,
        error: serializedError(error),
      });
    }
  });
});
