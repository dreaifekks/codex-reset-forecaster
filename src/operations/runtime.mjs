import path from "node:path";
import { getProviderFreshness } from "../runtime/readiness.mjs";
import {
  authorizedOperationsRequest,
  readProtectedToken,
  TrafficMonitor,
} from "./traffic-monitor.mjs";

function boolean(value, name, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new TypeError(`${name} must be a boolean`);
}

function optionalInteger(value, name) {
  if (value === undefined || String(value).trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new TypeError(`${name} must be an integer`);
  return parsed;
}

export async function createOperationsRuntime({
  store,
  config = null,
  env = process.env,
  now = () => new Date(),
  monotonicNow,
  timers,
  logger = console,
} = {}) {
  let enabled;
  try {
    enabled = boolean(
      env.TRAFFIC_MONITOR_ENABLED,
      "TRAFFIC_MONITOR_ENABLED",
      true,
    );
  } catch (error) {
    logger.error?.(`traffic monitor configuration disabled: ${error.message}`);
    return {
      enabled: false,
      tokenFile: null,
      monitor: null,
      initializationError: error.message,
      authorize: () => false,
      start() {},
      async stop() {},
      async waitForIdle() {},
    };
  }
  const tokenFileValue = String(
    env.FORECASTER_OPERATIONS_TOKEN_FILE ?? "",
  ).trim();
  const tokenFile = tokenFileValue ? path.resolve(tokenFileValue) : null;
  if (!enabled) {
    return {
      enabled: false,
      tokenFile,
      monitor: null,
      authorize: () => false,
      start() {},
      async stop() {},
      async waitForIdle() {},
    };
  }
  if (!store?.readState || !store?.writeState) {
    throw new TypeError("Operations runtime requires state storage");
  }
  let token = null;
  let authorizationError = null;
  try {
    token = await readProtectedToken(tokenFile);
  } catch (error) {
    authorizationError = error.message;
    logger.error?.(
      `operations authorization disabled: ${error.message}`,
    );
  }
  let monitor;
  try {
    monitor = await new TrafficMonitor({
      stateAdapter: {
        read: () => store.readState("traffic-monitor", null),
        write: (state) => store.writeState("traffic-monitor", state),
      },
      now,
      ...(config ? { providerFreshness: (at) => getProviderFreshness(store, config, at) } : {}),
      ...(monotonicNow ? { monotonicNow } : {}),
      ...(timers ? { timers } : {}),
      logger,
      options: {
        sampleIntervalMs: optionalInteger(
          env.TRAFFIC_SAMPLE_INTERVAL_MS,
          "TRAFFIC_SAMPLE_INTERVAL_MS",
        ),
        flushIntervalMs: optionalInteger(
          env.TRAFFIC_FLUSH_INTERVAL_MS,
          "TRAFFIC_FLUSH_INTERVAL_MS",
        ),
        minimumRequests: optionalInteger(
          env.TRAFFIC_MINIMUM_REQUESTS,
          "TRAFFIC_MINIMUM_REQUESTS",
        ),
        minimumInteractiveRequests: optionalInteger(
          env.TRAFFIC_MINIMUM_INTERACTIVE_REQUESTS,
          "TRAFFIC_MINIMUM_INTERACTIVE_REQUESTS",
        ),
      },
    }).init();
  } catch (error) {
    logger.error?.(`traffic monitor initialization failed: ${error.message}`);
    return {
      enabled: false,
      tokenFile,
      monitor: null,
      initializationError: error.message,
      authorizationError,
      authorize: (request) => authorizedOperationsRequest(request, token),
      start() {},
      async stop() {},
      async waitForIdle() {},
    };
  }
  return {
    enabled: true,
    tokenFile,
    monitor,
    authorizationError,
    authorize: (request) => authorizedOperationsRequest(request, token),
    start: () => monitor.start(),
    stop: () => monitor.stop(),
    waitForIdle: () => monitor.waitForIdle(),
  };
}
