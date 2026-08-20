import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";
import {
  createPipelineWorker,
  projectPipelineSchedulerResult,
} from "../src/runtime/pipeline-worker.mjs";

class FakeWorker extends EventEmitter {
  messages = [];
  unrefCalls = 0;
  terminateCalls = 0;

  postMessage(message) {
    this.messages.push(message);
    this.emit("posted", message);
  }

  unref() {
    this.unrefCalls += 1;
  }

  terminate() {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

function nextPosted(worker) {
  const existing = worker.messages.shift();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => worker.once("posted", () => {
    resolve(worker.messages.shift());
  }));
}

function respond(worker, request, value) {
  worker.emit("message", {
    type: "pipeline_worker_response",
    request_id: request.request_id,
    ok: true,
    value,
  });
}

test("pipeline worker returns the scheduler contract without cloning model artifacts", () => {
  const guard = { passed: false, blockers: ["test_guard"] };
  const result = projectPipelineSchedulerResult({
    status: "waiting_for_evaluation",
    collection: { exact: { ok: true } },
    training: {
      status: "waiting_for_evaluation",
      succeeded: true,
      skipped: false,
      reused_challenger: false,
      evaluation: { huge_rows: [1, 2, 3] },
      promotion: { promoted: false, reason: "sample_pending", model: {} },
      promotion_guard: guard,
      model: { huge_weights: [1, 2, 3] },
    },
    promotion_guard: guard,
    forecast: {
      prediction: { record_id: "pred_test", revision: 2, data: { slots: [] } },
    },
    coverage_waiting: null,
    evaluation_waiting: { evaluated_windows: 2 },
    timing: { completed_at: "2026-08-20T10:04:19.390Z" },
  });
  assert.deepEqual(result, {
    status: "waiting_for_evaluation",
    collection: { exact: { ok: true } },
    training: {
      status: "waiting_for_evaluation",
      succeeded: true,
      skipped: false,
      reused_challenger: false,
      reason_code: null,
      error: null,
      evaluation: { available: true },
      promotion: { promoted: false, reason: "sample_pending" },
      promotion_guard: guard,
    },
    promotion_guard: guard,
    forecast: { prediction: { record_id: "pred_test", revision: 2 } },
    coverage_waiting: null,
    evaluation_waiting: { evaluated_windows: 2 },
    timing: { completed_at: "2026-08-20T10:04:19.390Z" },
  });
});

test("pipeline worker serializes heavy runs and serving snapshot publication", async () => {
  const worker = new FakeWorker();
  const runner = createPipelineWorker({
    dataDir: "/tmp/pipeline-worker-test",
    config: { runtime: {} },
    workerFactory: () => worker,
  });

  const run = runner.run({ collect: true, retrain: false });
  const materialize = runner.materializeServingSnapshot(
    "2026-08-20T10:04:19.390Z",
  );
  const runRequest = await nextPosted(worker);
  assert.equal(runRequest.action, "run_pipeline");
  assert.deepEqual(runRequest.payload, {
    collect: true,
    retrain: false,
    now: null,
  });
  assert.equal(worker.messages.length, 0);
  respond(worker, runRequest, { status: "completed" });
  assert.deepEqual(await run, { status: "completed" });

  const snapshotRequest = await nextPosted(worker);
  assert.equal(snapshotRequest.action, "materialize_serving_snapshot");
  assert.equal(
    snapshotRequest.payload.materialized_at,
    "2026-08-20T10:04:19.390Z",
  );
  respond(worker, snapshotRequest, { schema_version: "serving-snapshot/3" });
  assert.deepEqual(await materialize, {
    schema_version: "serving-snapshot/3",
  });
  assert.equal(worker.unrefCalls, 0);

  await runner.stop();
  assert.equal(worker.terminateCalls, 1);
});

test("pipeline worker failure rejects only its request and lazily starts a replacement", async () => {
  const workers = [];
  const runner = createPipelineWorker({
    dataDir: "/tmp/pipeline-worker-recovery-test",
    config: { runtime: {} },
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  const firstRun = runner.run();
  while (workers.length < 1) await new Promise((resolve) => setImmediate(resolve));
  await nextPosted(workers[0]);
  const crash = new Error("synthetic worker crash");
  workers[0].emit("error", crash);
  await assert.rejects(
    firstRun,
    (error) => error.code === "pipeline_worker_crashed",
  );

  const secondRun = runner.run();
  while (workers.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const secondRequest = await nextPosted(workers[1]);
  respond(workers[1], secondRequest, { status: "completed" });
  assert.deepEqual(await secondRun, { status: "completed" });
  assert.equal(workers.length, 2);
  await runner.stop();
});

test("CPU-bound worker activity does not delay the serving event loop", async () => {
  const runner = createPipelineWorker({
    dataDir: "/tmp/pipeline-worker-isolation-test",
    config: { runtime: {} },
    workerFactory: () => {
      const worker = new NodeWorker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", (message) => {
          const deadline = Date.now() + 300;
          while (Date.now() < deadline) {}
          parentPort.postMessage({
            type: "pipeline_worker_response",
            request_id: message.request_id,
            ok: true,
            value: { status: "completed" },
          });
        });
      `, { eval: true });
      return worker;
    },
  });

  let runSettled = false;
  const run = runner.run().finally(() => {
    runSettled = true;
  });
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const timerDelay = Date.now() - startedAt;
  assert.equal(runSettled, false);
  assert.ok(timerDelay < 150, `serving timer was delayed by ${timerDelay}ms`);
  assert.deepEqual(await run, { status: "completed" });
  await runner.stop();
});
