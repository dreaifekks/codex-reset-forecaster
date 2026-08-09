#!/usr/bin/env node

import http from "node:http";
import { loadConfig } from "./core/config.mjs";
import { DEMO_CONFIG_OVERRIDES } from "./demo/config.mjs";
import { JsonlStore } from "./store/jsonl-store.mjs";
import { createRequestHandler } from "./web/app.mjs";
import { startScheduler } from "./runtime/scheduler.mjs";

const demoMode = process.argv.includes("--demo");
const config = await loadConfig({
  overrides: demoMode ? DEMO_CONFIG_OVERRIDES : {},
});
const store = await new JsonlStore(config.runtime.data_dir).init();
const requestHandler = createRequestHandler({ store, config });
const server = http.createServer(requestHandler);
let scheduler = null;
let shuttingDown = false;

async function initializeRuntime() {
  try {
    await requestHandler.refreshServingSnapshot(new Date());
  } catch (error) {
    process.stderr.write(
      `Serving snapshot warmup failed: ${error.stack ?? error.message}\n`,
    );
  }
  if (shuttingDown || !config.runtime.scheduler_enabled) return;
  scheduler = startScheduler({
    store,
    config,
    afterState: ({ finished_at: finishedAt }) =>
      requestHandler.refreshServingSnapshot(new Date(finishedAt)),
  });
}

void initializeRuntime();

server.listen(config.runtime.port, config.runtime.host, () => {
  process.stdout.write(`Codex Reset Forecaster listening on http://${config.runtime.host}:${config.runtime.port}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${signal}: closing server\n`);
  shuttingDown = true;
  scheduler?.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
