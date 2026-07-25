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
const server = http.createServer(createRequestHandler({ store, config }));
const scheduler = config.runtime.scheduler_enabled
  ? startScheduler({ store, config })
  : null;

server.listen(config.runtime.port, config.runtime.host, () => {
  process.stdout.write(`Codex Reset Forecaster listening on http://${config.runtime.host}:${config.runtime.port}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${signal}: closing server\n`);
  scheduler?.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
