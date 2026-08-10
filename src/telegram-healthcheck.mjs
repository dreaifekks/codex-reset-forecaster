#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { telegramStatePath } from "./telegram/config.mjs";
import { readTelegramStateFile } from "./telegram/state-store.mjs";

export async function checkTelegramHeartbeat({
  env = process.env,
  now = () => new Date(),
} = {}) {
  function maximumAge(name, fallback, minimum = 10) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < minimum || value > 7_200) {
      throw new RangeError(
        `${name} must be an integer from ${minimum} through 7200`,
      );
    }
    return value;
  }
  const requestTimeoutMs = Number(env.TELEGRAM_REQUEST_TIMEOUT_MS ?? 15_000);
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 120_000
  ) throw new RangeError("TELEGRAM_REQUEST_TIMEOUT_MS is invalid");
  function pollMinimum(name, fallbackMs, maximumMs) {
    const value = Number(env[name] ?? fallbackMs);
    if (!Number.isInteger(value) || value < 1_000 || value > maximumMs) {
      throw new RangeError(`${name} has an invalid polling interval`);
    }
    return Math.ceil((value + requestTimeoutMs) / 1_000) + 30;
  }
  const operationsAlertsEnabled = ["true", "1", "yes", "on"].includes(
    String(env.TELEGRAM_OPERATIONS_ALERTS_ENABLED ?? "false")
      .trim()
      .toLowerCase(),
  );
  const state = await readTelegramStateFile(telegramStatePath(env));
  const eventPollMinimum = pollMinimum(
    "TELEGRAM_EVENT_POLL_INTERVAL_MS",
    30_000,
    300_000,
  );
  const forecastInputPollMinimum = pollMinimum(
    "TELEGRAM_FORECAST_INPUT_POLL_INTERVAL_MS",
    30_000,
    300_000,
  );
  const operationsPollMinimum = pollMinimum(
    "TELEGRAM_OPERATIONS_ALERT_POLL_INTERVAL_MS",
    60_000,
    3_600_000,
  );
  const currentMs = now().getTime();
  if (!Number.isFinite(currentMs)) throw new TypeError("Healthcheck clock is invalid");
  for (const [field, label, maxAgeSeconds] of [
    [
      "heartbeat_at",
      "heartbeat",
      maximumAge("TELEGRAM_HEARTBEAT_MAX_AGE_SECONDS", 180),
    ],
    [
      "last_update_poll_at",
      "update poll",
      maximumAge("TELEGRAM_UPDATE_POLL_MAX_AGE_SECONDS", 120),
    ],
    [
      "last_event_poll_at",
      "event poll",
      maximumAge(
        "TELEGRAM_EVENT_POLL_MAX_AGE_SECONDS",
        Math.max(180, eventPollMinimum),
        eventPollMinimum,
      ),
    ],
    [
      "last_forecast_input_poll_at",
      "forecast input poll",
      maximumAge(
        "TELEGRAM_FORECAST_INPUT_POLL_MAX_AGE_SECONDS",
        Math.max(180, forecastInputPollMinimum),
        forecastInputPollMinimum,
      ),
    ],
    ...(operationsAlertsEnabled
      ? [[
          "last_operations_alert_poll_at",
          "operations alert poll",
          maximumAge(
            "TELEGRAM_OPERATIONS_ALERT_POLL_MAX_AGE_SECONDS",
            Math.max(180, operationsPollMinimum),
            operationsPollMinimum,
          ),
        ]]
      : []),
  ]) {
    const observedAt = Date.parse(
      state[field] ??
        (field === "last_operations_alert_poll_at" ? "" : state.created_at) ??
        "",
    );
    const ageMs = currentMs - observedAt;
    if (
      !Number.isFinite(observedAt) ||
      ageMs < 0 ||
      ageMs > maxAgeSeconds * 1_000
    ) {
      throw new Error(`Telegram bot ${label} is missing or stale`);
    }
  }
  const minimumDueAgeSeconds = Math.max(
    60,
    Math.ceil(requestTimeoutMs / 1_000) + 30,
  );
  const dueMaxAgeSeconds = maximumAge(
    "TELEGRAM_OUTBOX_DUE_MAX_AGE_SECONDS",
    minimumDueAgeSeconds,
    minimumDueAgeSeconds,
  );
  const unexpectedDeadMaxAgeSeconds = maximumAge(
    "TELEGRAM_UNEXPECTED_DEAD_MAX_AGE_SECONDS",
    900,
  );
  const dueJobs = state.outbox.filter((job) =>
    ["pending", "retry", "sending"].includes(job.status) &&
    Date.parse(job.not_before) <= currentMs
  );
  const expiredOperationsAlert = state.outbox.some((job) =>
    job.kind === "operations_alert" &&
    ["pending", "retry", "sending"].includes(job.status) &&
    Number.isFinite(Date.parse(job.expires_at ?? "")) &&
    Date.parse(job.expires_at) <= currentMs
  );
  if (expiredOperationsAlert) {
    throw new Error("Telegram bot missed an operations alert expiry");
  }
  const oldestDueAgeMs = dueJobs.reduce((maximum, job) => {
    const reference = job.status === "sending" ? job.updated_at : job.not_before;
    return Math.max(maximum, currentMs - Date.parse(reference));
  }, 0);
  const operationsDueAgeMs = dueJobs
    .filter((job) => job.kind === "operations_alert")
    .reduce((maximum, job) => {
      const reference = job.status === "sending" ? job.updated_at : job.not_before;
      return Math.max(maximum, currentMs - Date.parse(reference));
    }, 0);
  if (
    operationsDueAgeMs > dueMaxAgeSeconds * 1_000 ||
    (dueJobs.length >= 20 && oldestDueAgeMs > dueMaxAgeSeconds * 1_000) ||
    oldestDueAgeMs > 300_000
  ) throw new Error("Telegram bot outbox dispatch is stale");
  const unexpectedOperationsDead = state.outbox.some((job) =>
    job.kind === "operations_alert" &&
    job.status === "dead" &&
    !["recipient_not_authorized", "subscription_removed"].includes(job.last_error) &&
    currentMs - Date.parse(job.updated_at) <= unexpectedDeadMaxAgeSeconds * 1_000
  );
  const persistedFailureAt = Date.parse(
    state.last_operations_delivery_failure_at ?? "",
  );
  const persistedFailureAgeMs = currentMs - persistedFailureAt;
  if (
    unexpectedOperationsDead ||
    (Number.isFinite(persistedFailureAt) && (
      persistedFailureAgeMs < 0 ||
      persistedFailureAgeMs <= unexpectedDeadMaxAgeSeconds * 1_000
    ))
  ) {
    throw new Error("Telegram bot has a recent failed operations alert");
  }
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await checkTelegramHeartbeat();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
