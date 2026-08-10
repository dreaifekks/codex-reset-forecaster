#!/usr/bin/env node

import http from "node:http";
import { loadConfig } from "./core/config.mjs";
import { DEMO_CONFIG_OVERRIDES } from "./demo/config.mjs";
import { JsonlStore } from "./store/jsonl-store.mjs";
import { createRequestHandler } from "./web/app.mjs";
import { startScheduler } from "./runtime/scheduler.mjs";
import { createPublicationLedger } from "./notifications/ledger.mjs";
import { createPublicationProjector } from "./notifications/projector.mjs";
import {
  createForecastInputProjector,
  createForecastInputStream,
} from "./notifications/forecast-input.mjs";
import { createWebPushRuntime } from "./web-push/runtime.mjs";
import { createOperationsRuntime } from "./operations/runtime.mjs";
import {
  createProbabilityProfileWorkerProvider,
} from "./query/probability-profile-worker.mjs";

const demoMode = process.argv.includes("--demo");
const config = await loadConfig({
  overrides: demoMode ? DEMO_CONFIG_OVERRIDES : {},
});
const store = await new JsonlStore(config.runtime.data_dir).init();
const operationsRuntime = await createOperationsRuntime({ store });
const publicationLedger = createPublicationLedger(store);
const publicationProjector = createPublicationProjector({
  store,
  config,
  ledger: publicationLedger,
});
const forecastInputStream = createForecastInputStream(store);
const forecastInputProjector = createForecastInputProjector({
  store,
  config,
  stream: forecastInputStream,
});
const webPushRuntime = await createWebPushRuntime({
  config,
  store,
  publicationLedger,
  forecastInputStream,
});
const probabilityProfileProvider = createProbabilityProfileWorkerProvider({
  dataDir: config.runtime.data_dir,
  config,
});
const requestHandler = createRequestHandler({
  store,
  config,
  publicationLedger,
  forecastInputStream,
  webPushService: webPushRuntime,
  trafficMonitor: operationsRuntime.monitor,
  operationsService: operationsRuntime,
  probabilityProfileProvider,
});
const server = http.createServer(requestHandler);
let scheduler = null;
let shuttingDown = false;

async function initializeRuntime() {
  let snapshot = null;
  try {
    snapshot = await requestHandler.refreshServingSnapshot(new Date());
  } catch (error) {
    process.stderr.write(
      `Serving snapshot warmup failed: ${error.stack ?? error.message}\n`,
    );
  }
  try {
    const runtimeState = await store.readState("runtime", {});
    const hasCompletedRun = Number.isFinite(
      Date.parse(runtimeState.last_success_at),
    );
    const forecastBelongsToCompletedRun = hasCompletedRun &&
      typeof runtimeState.last_prediction_id === "string" &&
      snapshot?.prediction_ref?.record_id === runtimeState.last_prediction_id &&
      Date.parse(snapshot?.prediction?.data?.issued_at) <=
        Date.parse(runtimeState.last_success_at);
    await publicationProjector.project({
      snapshot,
      emittedAt: new Date(),
      allowInitialize: hasCompletedRun,
    });
    if (forecastBelongsToCompletedRun) {
      await forecastInputProjector.project({
        snapshot,
        emittedAt: new Date(),
      });
    }
  } catch (error) {
    process.stderr.write(
      `Publication projection warmup failed: ${error.stack ?? error.message}\n`,
    );
  }
  if (shuttingDown) return;
  operationsRuntime.start();
  webPushRuntime.start();
  if (!config.runtime.scheduler_enabled) return;
  scheduler = startScheduler({
    store,
    config,
    afterState: async ({ finished_at: finishedAt, status }) => {
      const finished = new Date(finishedAt);
      const currentSnapshot = await requestHandler.refreshServingSnapshot(finished);
      const publication = await publicationProjector.project({
        snapshot: currentSnapshot,
        emittedAt: finished,
        allowInitialize: status === "success",
      });
      const forecastInput = status === "success"
        ? await forecastInputProjector.project({
            snapshot: currentSnapshot,
            emittedAt: finished,
          })
        : { inserted: false, reason: "pipeline_not_successful" };
      if (publication.events.length > 0 || forecastInput.inserted) {
        void webPushRuntime.dispatchNow();
      }
    },
  });
}

const initializationPromise = initializeRuntime();

server.listen(config.runtime.port, config.runtime.host, () => {
  process.stdout.write(`Codex Reset Forecaster listening on http://${config.runtime.host}:${config.runtime.port}\n`);
});

let shutdownPromise = null;

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  process.stdout.write(`${signal}: closing server\n`);
  shuttingDown = true;
  scheduler?.stop();
  webPushRuntime.stop();
  const probabilityProfileStop = probabilityProfileProvider.stop();
  const serverClosed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const operationsStop = Promise.allSettled([
    serverClosed,
    initializationPromise,
  ]).then(() => operationsRuntime.stop());
  shutdownPromise = Promise.allSettled([
    serverClosed,
    initializationPromise,
    scheduler?.waitForIdle?.(),
    webPushRuntime.waitForIdle?.(),
    probabilityProfileStop,
    operationsStop,
  ]).then((results) => {
    const failures = results.filter((result) => result.status === "rejected");
    for (const failure of failures) {
      process.stderr.write(
        `Graceful shutdown task failed: ${failure.reason?.stack ?? failure.reason}\n`,
      );
    }
    process.exitCode = failures.length > 0 ? 1 : 0;
  });
  return shutdownPromise;
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
