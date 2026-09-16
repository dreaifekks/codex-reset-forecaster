#!/usr/bin/env node

import http from "node:http";
import { loadConfig } from "./core/config.mjs";
import { DEMO_CONFIG_OVERRIDES } from "./demo/config.mjs";
import { JsonlStore } from "./store/jsonl-store.mjs";
import {
  SERVING_SNAPSHOT_SCHEMA_VERSION,
  SERVING_SNAPSHOT_STATE_KEY,
  createRequestHandler,
  isServingSnapshotUsable,
} from "./web/app.mjs";
import { startScheduler } from "./runtime/scheduler.mjs";
import { createPipelineWorker } from "./runtime/pipeline-worker.mjs";
import {
  createServingSnapshotProvider,
} from "./runtime/serving-snapshot-provider.mjs";
import {
  completedRunOwnsServingSnapshot,
} from "./runtime/startup-projection.mjs";
import { createPublicationLedger } from "./notifications/ledger.mjs";
import { createPublicationProjector } from "./notifications/projector.mjs";
import {
  createForecastInputProjector,
  createForecastInputStream,
} from "./notifications/forecast-input.mjs";
import { createWebPushRuntime } from "./web-push/runtime.mjs";
import { createOperationsRuntime } from "./operations/runtime.mjs";
import {
  PROBABILITY_PROFILE_SNAPSHOT_STATE_KEY,
  createProbabilityProfileWorkerProvider,
} from "./query/probability-profile-worker.mjs";

const demoMode = process.argv.includes("--demo");
const config = await loadConfig({
  overrides: demoMode ? DEMO_CONFIG_OVERRIDES : {},
});
const store = await new JsonlStore(config.runtime.data_dir).init();
let probabilityProfileSeed = null;
let servingSnapshotSeed = null;
try {
  probabilityProfileSeed = await store.readState(
    PROBABILITY_PROFILE_SNAPSHOT_STATE_KEY,
    null,
  );
} catch (error) {
  process.stderr.write(
    `Probability profile snapshot seed failed: ${error.stack ?? error.message}\n`,
  );
}
try {
  servingSnapshotSeed = await store.readState(
    SERVING_SNAPSHOT_STATE_KEY,
    null,
  );
} catch (error) {
  process.stderr.write(
    `Serving snapshot seed failed: ${error.stack ?? error.message}\n`,
  );
}
const servingSnapshotProvider = createServingSnapshotProvider(
  servingSnapshotSeed,
);
const pipelineWorker = createPipelineWorker({
  dataDir: config.runtime.data_dir,
  config,
});
const operationsRuntime = await createOperationsRuntime({ store, config });
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
  seedSnapshot: probabilityProfileSeed,
  onSnapshot: (snapshot) => store.writeState(
    PROBABILITY_PROFILE_SNAPSHOT_STATE_KEY,
    snapshot,
  ).catch((error) => {
    process.stderr.write(
      `Probability profile snapshot persistence failed: ${error.stack ?? error.message}\n`,
    );
  }),
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
  servingSnapshotProvider,
});
const server = http.createServer(requestHandler);
let scheduler = null;
let shuttingDown = false;

function refreshProbabilityProfiles({ force = false, reason }) {
  void probabilityProfileProvider.warm(undefined, { force }).catch((error) => {
    if (shuttingDown) return;
    process.stderr.write(
      `Probability profile ${reason} failed: ${error.stack ?? error.message}\n`,
    );
  });
}

async function initializeRuntime() {
  refreshProbabilityProfiles({ reason: "startup warmup" });
  let snapshot = servingSnapshotProvider.get();
  if (snapshot?.schema_version !== SERVING_SNAPSHOT_SCHEMA_VERSION ||
      !isServingSnapshotUsable(snapshot, { config })) {
    try {
      snapshot = servingSnapshotProvider.publish(
        await pipelineWorker.materializeServingSnapshot(new Date()),
      );
    } catch (error) {
      process.stderr.write(
        `Serving snapshot warmup failed: ${error.stack ?? error.message}\n`,
      );
    }
  }
  try {
    const runtimeState = await store.readState("runtime", {});
    const forecastBelongsToCompletedRun =
      completedRunOwnsServingSnapshot(runtimeState, snapshot);
    if (forecastBelongsToCompletedRun) {
      await publicationProjector.project({
        snapshot,
        emittedAt: new Date(),
        allowInitialize: true,
      });
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
  if (!config.runtime.scheduler_enabled) {
    try {
      servingSnapshotProvider.publish(
        await pipelineWorker.materializeServingSnapshot(new Date()),
      );
    } catch (error) {
      process.stderr.write(
        `Serving snapshot warmup failed: ${error.stack ?? error.message}\n`,
      );
    }
    return;
  }
  scheduler = startScheduler({
    store,
    config,
    run: (_store, _config, options) => pipelineWorker.run({
      collect: options.collect,
      retrain: options.retrain,
    }),
    afterState: async ({ finished_at: finishedAt, status }) => {
      const finished = new Date(finishedAt);
      if (status !== "success") return;
      const currentSnapshot = await pipelineWorker.materializeServingSnapshot(
        finished,
      );
      servingSnapshotProvider.publish(currentSnapshot);
      refreshProbabilityProfiles({
        force: true,
        reason: "post-pipeline refresh",
      });
      const publication = await publicationProjector.project({
        snapshot: currentSnapshot,
        emittedAt: finished,
        allowInitialize: true,
      });
      const forecastInput = await forecastInputProjector.project({
        snapshot: currentSnapshot,
        emittedAt: finished,
      });
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
  const pipelineWorkerStop = Promise.resolve(scheduler?.waitForIdle?.())
    .then(() => pipelineWorker.stop());
  shutdownPromise = Promise.allSettled([
    serverClosed,
    initializationPromise,
    pipelineWorkerStop,
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
