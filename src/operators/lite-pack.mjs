import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { modelContractHash } from "../model/contract.mjs";
import {
  LITE_PACK_SCHEMA_VERSION,
  LITE_PACK_STATE_KEY,
} from "../runtime/lite-mode.mjs";

// Inference replays every revision of these small record types.
const COMPLETE_RECORD_TYPES = [
  "raw_observation",
  "normalized_signal",
  "event_candidate",
  "reset_outcome",
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
const MODEL_NAMES = ["champion", "challenger"];
const BLOB_REFERENCE = /^blob:\/\/([a-zA-Z0-9_-]+)\/([a-f0-9]{64}\.json)$/;
const PREDICTION_TAIL_BYTES = 8 * 1024 * 1024;
const FEATURE_SNAPSHOT_TAIL_BYTES = 64 * 1024 * 1024;

function exactKey(record) {
  return `${record.record_id}@${record.revision}`;
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function copyIfPresent(source, target) {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// The source may have a live writer mid-append; only whole JSONL lines count.
async function completeLineBytes(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  try {
    const chunk = Buffer.allocUnsafe(65_536);
    let end = (await handle.stat()).size;
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

async function copyCompleteLines(source, target) {
  const bytes = await completeLineBytes(source);
  if (bytes === 0) return;
  await pipeline(
    createReadStream(source, { end: bytes - 1 }),
    createWriteStream(target),
  );
}

async function copyLatestRevisions(source, target) {
  const bytes = await completeLineBytes(source);
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

async function tailRecords(file, windowBytes) {
  const bytes = await completeLineBytes(file);
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

export async function exportLitePack({
  sourceDir,
  outputDir,
  config,
  now = new Date(),
}) {
  await fs.mkdir(outputDir, { recursive: true });
  if ((await fs.readdir(outputDir)).length > 0) {
    throw new Error(`Lite pack output directory is not empty: ${outputDir}`);
  }
  const source = (...parts) => path.join(sourceDir, ...parts);
  const output = (...parts) => path.join(outputDir, ...parts);
  await Promise.all(
    ["records", "state", "audit", "models", "blobs"].map((directory) =>
      fs.mkdir(output(directory), { recursive: true })
    ),
  );

  // Mutable cursors are copied before the append-only files they describe, so a
  // run that lands mid-export leaves records ahead of state, never behind it.
  const stateKeys = [
    ...STATE_KEYS,
    ...Object.keys(config.providers).map((name) =>
      `${name.replaceAll("_", "-")}-provider`
    ),
  ];
  for (const key of stateKeys) {
    await copyIfPresent(
      source("state", `${key}.json`),
      output("state", `${key}.json`),
    );
  }
  for (const type of AUDIT_TYPES) {
    await copyCompleteLines(
      source("audit", `${type}.jsonl`),
      output("audit", `${type}.jsonl`),
    );
  }
  for (const name of MODEL_NAMES) {
    const model = await readJsonIfPresent(source("models", `${name}.json`));
    if (!model) continue;
    await fs.copyFile(
      source("models", `${name}.json`),
      output("models", `${name}.json`),
    );
    await copyIfPresent(
      source("models", "artifacts", `${model.artifact_hash}.json`),
      output("models", "artifacts", `${model.artifact_hash}.json`),
    );
  }
  for (const type of COMPLETE_RECORD_TYPES) {
    await copyCompleteLines(
      source("records", `${type}.jsonl`),
      output("records", `${type}.jsonl`),
    );
  }
  await copyLatestRevisions(
    source("records", "impact_episode.jsonl"),
    output("records", "impact_episode.jsonl"),
  );

  const prediction = (await tailRecords(
    source("records", "prediction.jsonl"),
    PREDICTION_TAIL_BYTES,
  )).at(-1) ?? null;
  if (prediction) {
    const wanted = new Set(prediction.data.feature_snapshot_refs.map(exactKey));
    const snapshots = (await tailRecords(
      source("records", "feature_snapshot.jsonl"),
      FEATURE_SNAPSHOT_TAIL_BYTES,
    )).filter((snapshot) => wanted.delete(exactKey(snapshot)));
    if (wanted.size > 0) {
      throw new Error(
        `Latest prediction ${exactKey(prediction)} has ${wanted.size} feature snapshots outside the exported tail`,
      );
    }
    await writeRecords(output("records", "prediction.jsonl"), [prediction]);
    await writeRecords(output("records", "feature_snapshot.jsonl"), snapshots);
  }

  const assertions = (await fs.readFile(
    output("audit", "coverage_assertion.jsonl"),
    "utf8",
  ).catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const copiedBlobs = new Set();
  await copyReferencedBlobs(sourceDir, outputDir, assertions, copiedBlobs);

  const runtime = await readJsonIfPresent(output("state", "runtime.json"));
  const files = (await fs.readdir(outputDir, {
    recursive: true,
    withFileTypes: true,
  })).filter((entry) => entry.isFile());
  let bytes = 0;
  for (const entry of files) {
    bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
  }
  const manifest = {
    schema_version: LITE_PACK_SCHEMA_VERSION,
    exported_at: new Date(now).toISOString(),
    source: {
      config_hash: config.config_hash,
      model_contract_hash: modelContractHash(config),
      timezone_database_version: config.timezone_database_version,
      last_pipeline_success_at: runtime?.last_success_at ?? null,
    },
    prediction_ref: prediction && {
      record_id: prediction.record_id,
      revision: prediction.revision,
      issued_at: prediction.data.issued_at,
    },
    model: prediction && {
      version: prediction.data.model.version,
      validation_status: prediction.data.model.validation_status,
      training_cutoff: prediction.data.model.training_cutoff,
    },
    coverage_evidence_blobs: copiedBlobs.size,
    files: files.length,
    bytes,
  };
  await fs.writeFile(
    output("state", `${LITE_PACK_STATE_KEY}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
