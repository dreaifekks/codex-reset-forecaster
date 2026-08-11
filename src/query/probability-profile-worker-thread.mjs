import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { JsonlStore } from "../store/jsonl-store.mjs";
import {
  buildProbabilityThresholdProfileFromContext,
  loadProbabilityThresholdProfileContext,
  parseProbabilityProfileHorizon,
} from "./probability-threshold-profile.mjs";

const REQUEST_TYPE = "probability_profile_request";
const RESPONSE_TYPE = "probability_profile_response";

if (!parentPort) {
  throw new Error("Probability profile worker requires a parent port");
}

const dataDir = path.resolve(String(workerData?.data_dir ?? ""));
const config = workerData?.config;
const contextTtlMs = Number(workerData?.context_ttl_ms);

if (!workerData?.data_dir || !config || !Number.isFinite(contextTtlMs) || contextTtlMs < 1) {
  throw new TypeError("Probability profile worker data is invalid");
}

// Deliberately do not call JsonlStore.init(): this worker is a read-only
// consumer of the serving process' data directory and must never create or
// repair runtime paths.
let dataDirectoryReadable = null;
let cachedContext = null;
let contextExpiresAt = 0;
let contextInFlight = null;
let forceContextInFlight = null;

function createReadOnlyStore(root) {
  const store = new JsonlStore(root);
  return Object.freeze({
    all: store.all.bind(store),
    allAudit: store.allAudit.bind(store),
    allByRefs: store.allByRefs.bind(store),
    readBlob: store.readBlob.bind(store),
    readState: store.readState.bind(store),
  });
}

async function generateContext() {
  dataDirectoryReadable ??= fs.access(dataDir, fsConstants.R_OK);
  await dataDirectoryReadable;
  // JsonlStore caches fully scanned record files. A fresh read-only instance
  // at each context generation makes the refresh observe newly appended
  // outcomes, signals, observations, and coverage assertions.
  const store = createReadOnlyStore(dataDir);
  const context = await loadProbabilityThresholdProfileContext(store, config);
  cachedContext = context;
  contextExpiresAt = Date.now() + contextTtlMs;
  return { context, expiresAt: contextExpiresAt };
}

async function loadContext({ force = false } = {}) {
  if (force) {
    if (forceContextInFlight) return forceContextInFlight;
    forceContextInFlight = (async () => {
      if (contextInFlight) {
        try {
          await contextInFlight;
        } catch {
          // A forced refresh still gets one independent attempt after a failed
          // ordinary generation.
        }
      }
      cachedContext = null;
      contextExpiresAt = 0;
      contextInFlight = generateContext();
      try {
        return await contextInFlight;
      } finally {
        contextInFlight = null;
      }
    })().finally(() => {
      forceContextInFlight = null;
    });
    return forceContextInFlight;
  }
  if (forceContextInFlight) return forceContextInFlight;
  const requestedAt = Date.now();
  if (cachedContext !== null && requestedAt < contextExpiresAt) {
    return {
      context: cachedContext,
      expiresAt: contextExpiresAt,
    };
  }
  if (contextInFlight) return contextInFlight;
  contextInFlight = generateContext().finally(() => {
    contextInFlight = null;
  });
  return contextInFlight;
}

function serializedError(error) {
  return {
    name: error?.name ?? "Error",
    code: typeof error?.code === "string" ? error.code : null,
    message: error?.message ?? String(error),
  };
}

parentPort.on("message", async (message) => {
  if (
    message?.type !== REQUEST_TYPE ||
    !Number.isSafeInteger(message.request_id) ||
    message.request_id < 1
  ) {
    return;
  }
  try {
    const batch = Array.isArray(message.horizon_hours);
    const sourceHorizons = batch
      ? message.horizon_hours
      : [message.horizon_hours];
    if (sourceHorizons.length === 0) {
      throw new TypeError("Probability profile batch must not be empty");
    }
    const horizons = [
      ...new Set(sourceHorizons.map(parseProbabilityProfileHorizon)),
    ];
    if (horizons.length !== sourceHorizons.length) {
      throw new TypeError("Probability profile batch horizons must be unique");
    }
    const { context, expiresAt } = await loadContext({
      force: message.force_refresh === true,
    });
    const profiles = horizons.map((horizonHours) =>
      buildProbabilityThresholdProfileFromContext(context, { horizonHours })
    );
    parentPort.postMessage({
      type: RESPONSE_TYPE,
      request_id: message.request_id,
      ok: true,
      context_expires_at: expiresAt,
      ...(batch ? { profiles } : { profile: profiles[0] }),
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
