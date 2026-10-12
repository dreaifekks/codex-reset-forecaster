import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import { modelContractHash } from "../model/contract.mjs";
import { createPublicationProjector } from "../notifications/projector.mjs";
import {
  LITE_PACK_SCHEMA_VERSION,
  LITE_PACK_STATE_KEY,
} from "../runtime/lite-mode.mjs";
import { JsonlStore } from "../store/jsonl-store.mjs";

// Inference replays every revision of these small record types.
const COMPLETE_RECORD_TYPES = [
  "raw_observation",
  "normalized_signal",
  "event_candidate",
  "reset_outcome",
];
const PACK_RECORD_TYPES = [
  ...COMPLETE_RECORD_TYPES,
  "impact_episode",
  "prediction",
  "feature_snapshot",
];
const AUDIT_TYPES = ["coverage_assertion", "publication-event"];
const STATE_KEYS = [
  "runtime",
  "normalization",
  "reset-review",
  "publication-projection",
  "notification-forecast-inputs",
  "probability-profile-snapshot",
  "serving-snapshot",
];
// Record id prefixes of the types a pack carries.
const PACK_RECORD_ID_PREFIXES = new Set([
  "obs",
  "sig",
  "evt",
  "imp",
  "out",
  "feat",
  "pred",
]);
const BLOB_REFERENCE = /^blob:\/\/([a-zA-Z0-9_-]+)\/([a-f0-9]{64}\.json)$/;
const PREDICTION_TAIL_BYTES = 8 * 1024 * 1024;
const FEATURE_SNAPSHOT_TAIL_BYTES = 64 * 1024 * 1024;
const DEFAULT_WAIT_MS = 15 * 60_000;
// The settled instant between two runs can be seconds long when runs fill the
// scheduler cadence, so polling has to be finer than that.
const DEFAULT_POLL_MS = 1_000;

function exactKey(record) {
  return `${record.record_id}@${record.revision}`;
}

async function readFileIfPresent(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function stamps(files) {
  return JSON.stringify(await Promise.all(files.map(async (file) => {
    try {
      const { size, mtimeMs, ino } = await fs.stat(file);
      return { size, mtimeMs, ino };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  })));
}

// A pack is the data root as it stood at one instant between two pipeline runs.
// The mutable state is read into memory between two identical stat passes over
// every state file and log, which pins all of them to that instant, and the
// instant only counts once the last completed run has been fully projected.
// Returns the captured state, or the reason the data root is not settled yet.
async function captureSettledState(sourceDir, config) {
  const stateKeys = [
    ...STATE_KEYS,
    ...Object.keys(config.providers).map((name) =>
      `${name.replaceAll("_", "-")}-provider`
    ),
  ];
  const stateFile = (key) => path.join(sourceDir, "state", `${key}.json`);
  const logs = [
    ...PACK_RECORD_TYPES.map((type) => path.join("records", `${type}.jsonl`)),
    ...AUDIT_TYPES.map((type) => path.join("audit", `${type}.jsonl`)),
  ];
  const watched = [
    ...stateKeys.map(stateFile),
    ...logs.map((file) => path.join(sourceDir, file)),
  ];
  const before = await stamps(watched);
  const state = new Map();
  const parsed = (key) => JSON.parse(state.get(key) ?? "null");
  // `runtime` is first in the key list: while a run is in flight there is
  // nothing else worth reading.
  let runtime = null;
  for (const key of stateKeys) {
    const text = await readFileIfPresent(stateFile(key));
    if (text) state.set(key, text);
    if (key !== "runtime") continue;
    runtime = parsed("runtime");
    if (runtime?.current_run_started_at) {
      return {
        unsettled:
          `the pipeline run started at ${runtime.current_run_started_at} has not completed`,
      };
    }
  }
  if (await stamps(watched) !== before) {
    return { unsettled: "the data root changed while its state was being read" };
  }
  const issuedAt = runtime?.last_timing?.forecast_issued_at;
  if (runtime?.last_status === "error" || !issuedAt) {
    // The pack may serve only what the full instance's last completed scheduled
    // run served. A run that failed, waited, or was blocked issued nothing, so
    // neither may a lite instance started from that state.
    throw new Error(
      "The last completed pipeline run of this data root issued no forecast " +
      `(status ${runtime?.last_status ?? "none"}${runtime?.last_error ? `: ${runtime.last_error}` : ""}), ` +
      "so a lite instance has no model it may serve",
    );
  }
  const snapshot = parsed("serving-snapshot");
  if (
    snapshot?.runtime_watermark?.last_success_at !== runtime.last_success_at ||
    snapshot.prediction_ref?.record_id !== runtime.last_prediction_id
  ) {
    return {
      unsettled:
        "the serving snapshot has not been materialized for the last completed pipeline run",
    };
  }
  const projection = parsed("publication-projection");
  if (
    config.runtime.publication.enabled &&
    projection &&
    Date.parse(projection.updated_at) < Date.parse(runtime.last_success_at)
  ) {
    return {
      unsettled:
        "the publication projection has not processed the last completed pipeline run",
    };
  }
  const sizes = JSON.parse(before).slice(stateKeys.length);
  return {
    state,
    runtime,
    snapshot,
    logBytes: new Map(logs.map((file, index) => [file, sizes[index]?.size ?? 0])),
  };
}

// A cut may land inside an append; only whole JSONL lines belong to it.
async function completeLineBytes(file, size) {
  if (size === 0) return 0;
  const handle = await fs.open(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(65_536);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline !== -1) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

async function copyLines(source, target, bytes) {
  if (bytes === 0) return;
  await pipeline(
    createReadStream(source, { end: bytes - 1 }),
    createWriteStream(target),
  );
}

async function copyLatestRevisions(source, target, bytes) {
  if (bytes === 0) return;
  const latest = new Map();
  const lines = createInterface({
    input: createReadStream(source, { encoding: "utf8", end: bytes - 1 }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    const { record_id: recordId, revision } = JSON.parse(line);
    if (!latest.has(recordId) || revision > latest.get(recordId).revision) {
      latest.set(recordId, { revision, line });
    }
  }
  await fs.writeFile(
    target,
    [...latest.values()].map(({ line }) => `${line}\n`).join(""),
    "utf8",
  );
}

async function tailRecords(file, bytes, windowBytes) {
  if (bytes === 0) return [];
  const start = Math.max(0, bytes - windowBytes);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytes - start);
    await handle.read(buffer, 0, buffer.length, start);
    const firstLine = start === 0 ? 0 : buffer.indexOf(0x0a) + 1;
    return buffer.subarray(firstLine).toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    await handle.close();
  }
}

function writeRecords(target, records) {
  return fs.writeFile(
    target,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
}

// Coverage verification re-reads every evidence blob an assertion points at,
// including the blobs those blobs reference.
async function copyReferencedBlobs(sourceDir, outputDir, value, copied) {
  if (typeof value === "string") {
    const match = value.match(BLOB_REFERENCE);
    if (!match || copied.has(value)) return;
    copied.add(value);
    const relative = path.join("blobs", match[1], match[2]);
    const target = path.join(outputDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sourceDir, relative), target);
    await copyReferencedBlobs(
      sourceDir,
      outputDir,
      JSON.parse(await fs.readFile(target, "utf8")),
      copied,
    );
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      await copyReferencedBlobs(sourceDir, outputDir, child, copied);
    }
  }
}

function servedPredictionOf(runtime, predictions) {
  const prediction = predictions.find((candidate) =>
    candidate.record_id === runtime.last_prediction_id &&
    candidate.data.issued_at === runtime.last_timing.forecast_issued_at
  );
  if (!prediction) {
    throw new Error(
      `The forecast ${runtime.last_prediction_id} of the last completed pipeline run is missing from the prediction log`,
    );
  }
  return prediction;
}

function* exactReferences(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.record_id === "string" && Number.isInteger(value.revision)) {
    yield value;
  }
  for (const child of Object.values(value)) yield* exactReferences(child);
}

async function assertReferencesResolve(store) {
  const records = new Map();
  for (const type of PACK_RECORD_TYPES) {
    records.set(type, await store.all(type, { latestOnly: false }));
  }
  const present = new Set(
    [...records.values()].flat().map(exactKey),
  );
  for (const [type, typeRecords] of records) {
    for (const record of typeRecords) {
      for (const reference of exactReferences(record.data)) {
        if (
          PACK_RECORD_ID_PREFIXES.has(reference.record_id.split("_")[0]) &&
          !present.has(exactKey(reference))
        ) {
          throw new Error(
            `Lite pack is not closed: ${type} ${exactKey(record)} references missing ${exactKey(reference)}`,
          );
        }
      }
    }
  }
}

// Whatever the publication projection would still emit for the captured round
// is a change the full instance has not published itself. A pack must not
// publish on its behalf, so this always runs and its result decides the export.
async function unpublishedEventTypes(store, config, snapshot, now) {
  const readOnly = new Proxy(store, {
    get(target, key) {
      if (key === "appendAudit") {
        return async (_type, event) => ({ inserted: true, event });
      }
      if (key === "writeState") return async () => {};
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { events } = await createPublicationProjector({
    store: readOnly,
    config,
  }).project({ snapshot, emittedAt: now, allowInitialize: true });
  return events.map((event) => event.event_type);
}

async function writeLitePack({ sourceDir, outputDir, config, now }) {
  const captured = await captureSettledState(sourceDir, config);
  if (captured.unsettled) return captured;
  const { state, runtime, snapshot, logBytes } = captured;
  const source = (...parts) => path.join(sourceDir, ...parts);
  const output = (...parts) => path.join(outputDir, ...parts);
  await Promise.all(
    ["records", "state", "audit", "models/artifacts", "blobs"].map((directory) =>
      fs.mkdir(output(directory), { recursive: true })
    ),
  );
  for (const [key, text] of state) {
    await fs.writeFile(output("state", `${key}.json`), text, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  // Appends that land after the captured instant are simply outside the cut.
  const bytes = new Map();
  for (const [file, size] of logBytes) {
    bytes.set(file, await completeLineBytes(source(file), size));
  }
  const cutBytes = (directory, type) =>
    bytes.get(path.join(directory, `${type}.jsonl`));

  for (const type of AUDIT_TYPES) {
    await copyLines(
      source("audit", `${type}.jsonl`),
      output("audit", `${type}.jsonl`),
      cutBytes("audit", type),
    );
  }
  for (const type of COMPLETE_RECORD_TYPES) {
    await copyLines(
      source("records", `${type}.jsonl`),
      output("records", `${type}.jsonl`),
      cutBytes("records", type),
    );
  }
  await copyLatestRevisions(
    source("records", "impact_episode.jsonl"),
    output("records", "impact_episode.jsonl"),
    cutBytes("records", "impact_episode"),
  );

  const prediction = servedPredictionOf(runtime, await tailRecords(
    source("records", "prediction.jsonl"),
    cutBytes("records", "prediction"),
    PREDICTION_TAIL_BYTES,
  ));
  const wanted = new Set(prediction.data.feature_snapshot_refs.map(exactKey));
  const snapshots = (await tailRecords(
    source("records", "feature_snapshot.jsonl"),
    cutBytes("records", "feature_snapshot"),
    FEATURE_SNAPSHOT_TAIL_BYTES,
  )).filter((snapshot) => wanted.delete(exactKey(snapshot)));
  if (wanted.size > 0) {
    throw new Error(
      `Forecast ${exactKey(prediction)} has ${wanted.size} feature snapshots outside the exported tail`,
    );
  }
  await writeRecords(output("records", "prediction.jsonl"), [prediction]);
  await writeRecords(output("records", "feature_snapshot.jsonl"), snapshots);

  // The pointer is written from the immutable artifact the served forecast
  // names, so pointer and artifact cannot come from different promotions.
  const servedModel = prediction.data.model;
  const role = servedModel.validation_status === "provisional"
    ? "challenger"
    : "champion";
  const artifact = await fs.readFile(
    source("models", "artifacts", `${servedModel.artifact_hash}.json`),
    "utf8",
  );
  await fs.writeFile(
    output("models", "artifacts", `${servedModel.artifact_hash}.json`),
    artifact,
    "utf8",
  );
  await fs.writeFile(output("models", `${role}.json`), artifact, "utf8");

  const assertions = (await readFileIfPresent(
    output("audit", "coverage_assertion.jsonl"),
  )).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const copiedBlobs = new Set();
  await copyReferencedBlobs(sourceDir, outputDir, assertions, copiedBlobs);

  const store = new JsonlStore(outputDir);
  await assertReferencesResolve(store);
  const unpublished = await unpublishedEventTypes(store, config, snapshot, now);
  if (unpublished.length > 0) {
    return {
      unsettled:
        `the data root holds changes its own publication projection has not emitted (${unpublished.join(", ")})`,
    };
  }

  const files = (await fs.readdir(outputDir, {
    recursive: true,
    withFileTypes: true,
  })).filter((entry) => entry.isFile());
  let packBytes = 0;
  for (const entry of files) {
    packBytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
  }
  const manifest = {
    schema_version: LITE_PACK_SCHEMA_VERSION,
    exported_at: new Date(now).toISOString(),
    source: {
      config_hash: config.config_hash,
      model_contract_hash: modelContractHash(config),
      timezone_database_version: config.timezone_database_version,
      last_pipeline_success_at: runtime.last_success_at ?? null,
    },
    prediction_ref: {
      record_id: prediction.record_id,
      revision: prediction.revision,
      issued_at: prediction.data.issued_at,
    },
    model: {
      role,
      version: servedModel.version,
      artifact_hash: servedModel.artifact_hash,
      validation_status: servedModel.validation_status,
      training_cutoff: servedModel.training_cutoff,
    },
    coverage_evidence_blobs: copiedBlobs.size,
    files: files.length,
    bytes: packBytes,
  };
  return { manifest };
}

async function emptyDirectory(directory) {
  for (const entry of await fs.readdir(directory)) {
    await fs.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

export async function exportLitePack({
  sourceDir,
  outputDir,
  config,
  now = null,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
}) {
  await fs.mkdir(outputDir, { recursive: true });
  if ((await fs.readdir(outputDir)).length > 0) {
    throw new Error(`Lite pack output directory is not empty: ${outputDir}`);
  }
  const startedAt = Date.now();
  try {
    for (let attempts = 1; ; attempts += 1) {
      const result = await writeLitePack({
        sourceDir,
        outputDir,
        config,
        now: now ?? new Date(),
      });
      if (result.manifest) {
        const manifest = {
          ...result.manifest,
          capture: { attempts, waited_ms: Date.now() - startedAt },
        };
        // Written last: a lite process refuses a data root without this
        // manifest, so an interrupted export can never be started.
        await fs.writeFile(
          path.join(outputDir, "state", `${LITE_PACK_STATE_KEY}.json`),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        return manifest;
      }
      await emptyDirectory(outputDir);
      if (Date.now() - startedAt >= waitMs) {
        throw new Error(
          `The data root did not settle on one completed pipeline run within ${Math.round(waitMs / 1_000)} s: ${result.unsettled}`,
        );
      }
      await delay(pollMs);
    }
  } catch (error) {
    // A pack that failed its own checks must not be left looking usable.
    await emptyDirectory(outputDir);
    throw error;
  }
}
