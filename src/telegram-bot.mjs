#!/usr/bin/env node

import { loadTelegramConfig } from "./telegram/config.mjs";
import {
  ForecasterClient,
  TelegramClient,
  redactSecrets,
} from "./telegram/client.mjs";
import { TelegramBotRuntime } from "./telegram/runtime.mjs";
import { TelegramStateStore } from "./telegram/state-store.mjs";

let runtime = null;
let config = null;
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${signal}: stopping Telegram bot\n`);
  await runtime?.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  config = await loadTelegramConfig();
  const stateStore = new TelegramStateStore({ directory: config.stateDir });
  const telegram = new TelegramClient({
    token: config.token,
    apiBase: config.botApiBase,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const forecaster = new ForecasterClient({
    apiBase: config.forecasterApiBase,
    operationsToken: config.operationsToken,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  runtime = new TelegramBotRuntime({
    telegram,
    forecaster,
    stateStore,
    config,
  });
  await runtime.start();
  process.stdout.write("Codex Reset Forecaster Telegram bot started\n");
} catch (error) {
  const message = redactSecrets(error?.stack ?? error?.message ?? error, [
    config?.token,
    config?.operationsToken,
  ]);
  process.stderr.write(`Telegram bot startup failed: ${message}\n`);
  process.exitCode = 1;
}
