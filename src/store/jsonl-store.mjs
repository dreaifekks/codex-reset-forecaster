import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { assertCanonicalRecord } from "../core/validate-record.mjs";
import { sha256, stableStringify } from "../core/hash.mjs";

const RECORD_TYPES = [
  "raw_observation",
  "normalized_signal",
  "event_candidate",
  "impact_episode",
  "reset_outcome",
  "feature_snapshot",
  "prediction",
  "prediction_settlement",
];

const TARGETED_RECORD_CACHE_LIMIT = 1_024;
const TARGETED_SCAN_TAIL_RECORDS = 512;
const FEATURE_SNAPSHOT_RECORD_TYPE = "feature_snapshot";
const EXACT_INDEX_SCHEMA_VERSION = "jsonl-exact-index/2";
const FEATURE_SNAPSHOT_INDEX_FILE = "feature_snapshot.exact.jsonl";
const FEATURE_SNAPSHOT_INDEX_CHECKPOINT_FILE =
  "feature_snapshot.exact.checkpoint.json";
const INDEX_WRITE_BATCH_RECORDS = 1_024;
const EMPTY_EXACT_INDEX_CHAIN_SHA256 = sha256(
  `${EXACT_INDEX_SCHEMA_VERSION}\0${FEATURE_SNAPSHOT_RECORD_TYPE}\0empty`,
);

function exactRecordKey(record) {
  return `${record.record_id}@${record.revision}`;
}

function featureSnapshotEquivalenceSha256(record) {
  const comparable = structuredClone(record);
  delete comparable.created_at;
  return sha256(stableStringify(comparable));
}

function featureSnapshotsDifferBeyondCreatedAt(left, right) {
  if (
    typeof left?.created_at !== "string" ||
    typeof right?.created_at !== "string"
  ) {
    return true;
  }
  return featureSnapshotEquivalenceSha256(left) !==
    featureSnapshotEquivalenceSha256(right);
}

function extendExactIndexChain(previous, serializedLine) {
  return sha256(`${previous}\0${serializedLine}`);
}

function invalidRecordIndex(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "INVALID_RECORD_INDEX";
  return error;
}

function invalidModelArtifact(message) {
  const error = new Error(message);
  error.code = "INVALID_MODEL_ARTIFACT";
  return error;
}

function assertStoredModelArtifact(model) {
  if (!model?.artifact_hash) return model;
  if (!/^[a-f0-9]{64}$/.test(model.artifact_hash)) {
    throw invalidModelArtifact(
      "Stored model artifact_hash is not a lowercase SHA-256 digest",
    );
  }
  const immutablePayload = structuredClone(model);
  delete immutablePayload.artifact_hash;
  delete immutablePayload.promoted_at;
  delete immutablePayload.promotion_evaluation;
  if (sha256(stableStringify(immutablePayload)) !== model.artifact_hash) {
    throw invalidModelArtifact(
      "Stored model artifact hash does not match its immutable payload",
    );
  }
  return model;
}

export class JsonlStore {
  #appendChain = Promise.resolve();
  #recordsCache = new Map();
  #recordLoadPromises = new Map();
  #targetedRecordsCache = new Map();
  #latestTargetedRecordsCache = new Map();
  #negativeRefScanSizes = new Map();
  #scanChains = new Map();
  #featureSnapshotIndex = null;

  constructor(root) {
    this.root = path.resolve(root);
    this.recordsDir = path.join(this.root, "records");
    this.blobsDir = path.join(this.root, "blobs");
    this.auditDir = path.join(this.root, "audit");
    this.stateDir = path.join(this.root, "state");
    this.modelsDir = path.join(this.root, "models");
    this.modelArtifactsDir = path.join(this.modelsDir, "artifacts");
    this.indexesDir = path.join(this.root, "indexes");
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.recordsDir, { recursive: true }),
      fs.mkdir(this.blobsDir, { recursive: true }),
      fs.mkdir(this.auditDir, { recursive: true }),
      fs.mkdir(this.stateDir, { recursive: true }),
      fs.mkdir(this.modelsDir, { recursive: true }),
      fs.mkdir(this.modelArtifactsDir, { recursive: true }),
      fs.mkdir(this.indexesDir, { recursive: true }),
    ]);
    return this;
  }

  recordPath(type) {
    if (!RECORD_TYPES.includes(type)) throw new TypeError(`Unsupported record type: ${type}`);
    return path.join(this.recordsDir, `${type}.jsonl`);
  }

  #featureSnapshotIndexPath() {
    return path.join(this.indexesDir, FEATURE_SNAPSHOT_INDEX_FILE);
  }

  #featureSnapshotIndexCheckpointPath() {
    return path.join(
      this.indexesDir,
      FEATURE_SNAPSHOT_INDEX_CHECKPOINT_FILE,
    );
  }

  async #writeJsonAtomically(target, value) {
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporary, target);
  }

  #featureSnapshotIndexEntry(record, offset, length, serialized) {
    if (record?.record_type !== FEATURE_SNAPSHOT_RECORD_TYPE) {
      throw invalidRecordIndex(
        "Feature snapshot index encountered another record type",
      );
    }
    return {
      record_id: record.record_id,
      revision: record.revision,
      offset,
      length,
      sha256: sha256(serialized),
    };
  }

  #assertFeatureSnapshotIndexEntry(entry, canonicalBytes) {
    if (
      typeof entry?.record_id !== "string" ||
      entry.record_id.length === 0 ||
      !Number.isInteger(entry.revision) ||
      entry.revision < 1 ||
      !Number.isInteger(entry.offset) ||
      entry.offset < 0 ||
      !Number.isInteger(entry.length) ||
      entry.length < 2 ||
      entry.offset + entry.length > canonicalBytes ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
    ) {
      throw invalidRecordIndex("Feature snapshot index entry is invalid");
    }
    return entry;
  }

  #addFeatureSnapshotIndexEntry(index, entry) {
    const key = exactRecordKey(entry);
    const exact = index.byExactRef.get(key);
    if (exact) {
      if (exact.sha256 !== entry.sha256) {
        throw invalidRecordIndex(
          `Conflicting immutable indexed revision ${key}`,
        );
      }
      return false;
    }
    index.byExactRef.set(key, entry);
    const latest = index.latestById.get(entry.record_id);
    if (!latest || entry.revision > latest.revision) {
      index.latestById.set(entry.record_id, entry);
    }
    return true;
  }

  async *#recordsWithOffsets(type, {
    start = 0,
    endExclusive = null,
  } = {}) {
    const filePath = this.recordPath(type);
    const fileSize = endExclusive ?? await this.#recordFileSize(type);
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(fileSize) ||
      fileSize < start
    ) {
      throw invalidRecordIndex(
        `Invalid ${type} byte range ${start}:${fileSize}`,
      );
    }
    if (start === fileSize) return;
    if (start > 0) {
      const handle = await fs.open(filePath, "r");
      try {
        const boundary = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(
          boundary,
          0,
          1,
          start - 1,
        );
        if (bytesRead !== 1 || boundary[0] !== 0x0a) {
          throw invalidRecordIndex(
            `${type} index checkpoint is not on a JSONL boundary`,
          );
        }
      } finally {
        await handle.close();
      }
    }

    const input = createReadStream(filePath, {
      start,
      end: fileSize - 1,
    });
    let pending = Buffer.alloc(0);
    let pendingOffset = start;
    try {
      for await (const chunk of input) {
        const data = pending.length > 0
          ? Buffer.concat([pending, chunk])
          : chunk;
        const dataOffset = pendingOffset;
        let cursor = 0;
        let newline = data.indexOf(0x0a, cursor);
        while (newline !== -1) {
          const raw = data.subarray(cursor, newline);
          const offset = dataOffset + cursor;
          const length = newline - cursor + 1;
          if (raw.length > 0) {
            const serialized = raw.toString("utf8");
            let record;
            try {
              record = JSON.parse(serialized);
            } catch (error) {
              throw new Error(
                `${type}.jsonl byte ${offset}: ${error.message}`,
                { cause: error },
              );
            }
            yield { record, offset, length, serialized };
          }
          cursor = newline + 1;
          newline = data.indexOf(0x0a, cursor);
        }
        pending = data.subarray(cursor);
        pendingOffset = dataOffset + cursor;
      }
    } finally {
      input.destroy();
    }
    if (pending.length > 0) {
      throw invalidRecordIndex(
        `${type}.jsonl has an incomplete trailing record at byte ${pendingOffset}`,
      );
    }
  }

  async #writeFeatureSnapshotIndexCheckpoint(index, canonicalBytes, indexBytes) {
    const checkpoint = {
      schema_version: EXACT_INDEX_SCHEMA_VERSION,
      record_type: FEATURE_SNAPSHOT_RECORD_TYPE,
      canonical_bytes: canonicalBytes,
      index_bytes: indexBytes,
      exact_entry_count: index.byExactRef.size,
      index_chain_sha256: index.indexChainSha256,
    };
    await this.#writeJsonAtomically(
      this.#featureSnapshotIndexCheckpointPath(),
      checkpoint,
    );
    index.checkpoint = checkpoint;
    return checkpoint;
  }

  async #appendFeatureSnapshotIndexEntries(index, entries, canonicalBytes) {
    const pending = new Map();
    for (const entry of entries) {
      this.#assertFeatureSnapshotIndexEntry(entry, canonicalBytes);
      const key = exactRecordKey(entry);
      const existing = index.byExactRef.get(key) ?? pending.get(key);
      if (existing) {
        if (existing.sha256 !== entry.sha256) {
          throw invalidRecordIndex(
            `Conflicting immutable indexed revision ${key}`,
          );
        }
        continue;
      }
      pending.set(key, entry);
    }
    const additions = [...pending.values()];
    const lines = additions.map((entry) => `${JSON.stringify(entry)}\n`);
    const serialized = lines.join("");
    const indexPath = this.#featureSnapshotIndexPath();
    const checkpoint = index.checkpoint;
    const actualIndexBytes = await fs.stat(indexPath)
      .then((value) => value.size)
      .catch((error) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
    if (actualIndexBytes < checkpoint.index_bytes) {
      throw invalidRecordIndex(
        "Feature snapshot index is shorter than its checkpoint",
      );
    }
    if (actualIndexBytes > checkpoint.index_bytes) {
      await fs.truncate(indexPath, checkpoint.index_bytes);
    }
    if (serialized.length > 0) {
      await fs.appendFile(indexPath, serialized, "utf8");
    }
    const indexBytes = checkpoint.index_bytes + Buffer.byteLength(serialized);
    const nextEntryCount = index.byExactRef.size + additions.length;
    let nextIndexChainSha256 = checkpoint.index_chain_sha256;
    for (const line of lines) {
      nextIndexChainSha256 = extendExactIndexChain(
        nextIndexChainSha256,
        line,
      );
    }
    const nextCheckpoint = {
      schema_version: EXACT_INDEX_SCHEMA_VERSION,
      record_type: FEATURE_SNAPSHOT_RECORD_TYPE,
      canonical_bytes: canonicalBytes,
      index_bytes: indexBytes,
      exact_entry_count: nextEntryCount,
      index_chain_sha256: nextIndexChainSha256,
    };
    await this.#writeJsonAtomically(
      this.#featureSnapshotIndexCheckpointPath(),
      nextCheckpoint,
    );
    for (const entry of additions) {
      this.#addFeatureSnapshotIndexEntry(index, entry);
    }
    index.indexChainSha256 = nextIndexChainSha256;
    index.checkpoint = nextCheckpoint;
    return index;
  }

  async #rebuildFeatureSnapshotIndex() {
    await fs.mkdir(this.indexesDir, { recursive: true });
    const indexPath = this.#featureSnapshotIndexPath();
    const temporary = `${indexPath}.${process.pid}.tmp`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const canonicalBytes = await this.#recordFileSize(
        FEATURE_SNAPSHOT_RECORD_TYPE,
      );
      const index = {
        byExactRef: new Map(),
        latestById: new Map(),
        checkpoint: null,
        indexChainSha256: EMPTY_EXACT_INDEX_CHAIN_SHA256,
      };
      await fs.writeFile(temporary, "", "utf8");
      let indexBytes = 0;
      let buffered = [];
      let canonicalHandle = null;
      const flush = async () => {
        if (buffered.length === 0) return;
        const payload = buffered.join("");
        await fs.appendFile(temporary, payload, "utf8");
        indexBytes += Buffer.byteLength(payload);
        buffered = [];
      };
      try {
        for await (const item of this.#recordsWithOffsets(
          FEATURE_SNAPSHOT_RECORD_TYPE,
          { endExclusive: canonicalBytes },
        )) {
          const entry = this.#featureSnapshotIndexEntry(
            item.record,
            item.offset,
            item.length,
            item.serialized,
          );
          this.#assertFeatureSnapshotIndexEntry(entry, canonicalBytes);
          const key = exactRecordKey(entry);
          const existing = index.byExactRef.get(key);
          if (existing) {
            if (existing.sha256 !== entry.sha256) {
              canonicalHandle ??= await fs.open(
                this.recordPath(FEATURE_SNAPSHOT_RECORD_TYPE),
                "r",
              );
              const existingRecord = await this.#readFeatureSnapshotIndexEntry(
                existing,
                canonicalHandle,
              );
              if (featureSnapshotsDifferBeyondCreatedAt(
                existingRecord,
                item.record,
              )) {
                throw invalidRecordIndex(
                  `Conflicting immutable indexed revision ${key}`,
                );
              }
            }
            continue;
          }
          this.#addFeatureSnapshotIndexEntry(index, entry);
          const line = `${JSON.stringify(entry)}\n`;
          index.indexChainSha256 = extendExactIndexChain(
            index.indexChainSha256,
            line,
          );
          buffered.push(line);
          if (buffered.length >= INDEX_WRITE_BATCH_RECORDS) await flush();
        }
        await flush();
        if (
          await this.#recordFileSize(FEATURE_SNAPSHOT_RECORD_TYPE) !==
            canonicalBytes
        ) {
          continue;
        }
        await fs.rename(temporary, indexPath);
        await this.#writeFeatureSnapshotIndexCheckpoint(
          index,
          canonicalBytes,
          indexBytes,
        );
        this.#featureSnapshotIndex = index;
        return index;
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      } finally {
        await canonicalHandle?.close();
      }
    }
    await fs.unlink(temporary).catch(() => {});
    throw invalidRecordIndex(
      "Feature snapshot JSONL kept changing while its index was rebuilt",
    );
  }

  async #loadFeatureSnapshotIndex(checkpoint, canonicalBytes) {
    const indexPath = this.#featureSnapshotIndexPath();
    const indexSize = await fs.stat(indexPath).then((value) => value.size);
    if (
      checkpoint?.schema_version !== EXACT_INDEX_SCHEMA_VERSION ||
      checkpoint.record_type !== FEATURE_SNAPSHOT_RECORD_TYPE ||
      !Number.isInteger(checkpoint.canonical_bytes) ||
      checkpoint.canonical_bytes < 0 ||
      checkpoint.canonical_bytes > canonicalBytes ||
      !Number.isInteger(checkpoint.index_bytes) ||
      checkpoint.index_bytes < 0 ||
      checkpoint.index_bytes > indexSize ||
      !Number.isInteger(checkpoint.exact_entry_count) ||
      checkpoint.exact_entry_count < 0 ||
      !/^[a-f0-9]{64}$/.test(checkpoint.index_chain_sha256 ?? "")
    ) {
      throw invalidRecordIndex("Feature snapshot index checkpoint is invalid");
    }
    if (indexSize > checkpoint.index_bytes) {
      await fs.truncate(indexPath, checkpoint.index_bytes);
    }
    const index = {
      byExactRef: new Map(),
      latestById: new Map(),
      checkpoint: { ...checkpoint },
      indexChainSha256: EMPTY_EXACT_INDEX_CHAIN_SHA256,
    };
    if (checkpoint.index_bytes > 0) {
      const input = createReadStream(indexPath, {
        encoding: "utf8",
        start: 0,
        end: checkpoint.index_bytes - 1,
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let lineNumber = 0;
      try {
        for await (const line of lines) {
          lineNumber += 1;
          if (!line) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch (error) {
            throw invalidRecordIndex(
              `${FEATURE_SNAPSHOT_INDEX_FILE}:${lineNumber}: ${error.message}`,
              error,
            );
          }
          this.#assertFeatureSnapshotIndexEntry(
            entry,
            checkpoint.canonical_bytes,
          );
          this.#addFeatureSnapshotIndexEntry(index, entry);
          index.indexChainSha256 = extendExactIndexChain(
            index.indexChainSha256,
            `${line}\n`,
          );
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
    if (index.byExactRef.size !== checkpoint.exact_entry_count) {
      throw invalidRecordIndex(
        "Feature snapshot index entry count does not match its checkpoint",
      );
    }
    if (index.indexChainSha256 !== checkpoint.index_chain_sha256) {
      throw invalidRecordIndex(
        "Feature snapshot index content does not match its checkpoint",
      );
    }
    return index;
  }

  async #recoverFeatureSnapshotIndexTail(index, canonicalBytes, attempt = 0) {
    const start = index.checkpoint.canonical_bytes;
    if (canonicalBytes < start) return this.#rebuildFeatureSnapshotIndex();
    if (canonicalBytes === start) return index;
    const entries = [];
    const pending = new Map();
    for await (const item of this.#recordsWithOffsets(
      FEATURE_SNAPSHOT_RECORD_TYPE,
      { start, endExclusive: canonicalBytes },
    )) {
      const entry = this.#featureSnapshotIndexEntry(
        item.record,
        item.offset,
        item.length,
        item.serialized,
      );
      const key = exactRecordKey(entry);
      const existing = pending.get(key) ?? index.byExactRef.get(key);
      if (existing) {
        if (existing.sha256 !== entry.sha256) {
          throw invalidRecordIndex(
            `Conflicting immutable indexed revision ${key}`,
          );
        }
        continue;
      }
      pending.set(key, entry);
      entries.push(entry);
    }
    const actualCanonicalBytes = await this.#recordFileSize(
      FEATURE_SNAPSHOT_RECORD_TYPE,
    );
    if (actualCanonicalBytes !== canonicalBytes) {
      if (attempt >= 2) {
        throw invalidRecordIndex(
          "Feature snapshot JSONL kept changing during index tail recovery",
        );
      }
      return this.#recoverFeatureSnapshotIndexTail(
        index,
        actualCanonicalBytes,
        attempt + 1,
      );
    }
    return this.#appendFeatureSnapshotIndexEntries(
      index,
      entries,
      canonicalBytes,
    );
  }

  async #ensureFeatureSnapshotIndex({ rebuild = false } = {}) {
    await fs.mkdir(this.indexesDir, { recursive: true });
    if (rebuild) return this.#rebuildFeatureSnapshotIndex();
    const canonicalBytes = await this.#recordFileSize(
      FEATURE_SNAPSHOT_RECORD_TYPE,
    );
    if (!this.#featureSnapshotIndex) {
      try {
        const checkpoint = JSON.parse(await fs.readFile(
          this.#featureSnapshotIndexCheckpointPath(),
          "utf8",
        ));
        this.#featureSnapshotIndex = await this.#loadFeatureSnapshotIndex(
          checkpoint,
          canonicalBytes,
        );
      } catch (error) {
        if (
          error.code !== "ENOENT" &&
          error.code !== "INVALID_RECORD_INDEX" &&
          !(error instanceof SyntaxError)
        ) {
          throw error;
        }
        return this.#rebuildFeatureSnapshotIndex();
      }
    }
    return this.#recoverFeatureSnapshotIndexTail(
      this.#featureSnapshotIndex,
      canonicalBytes,
    );
  }

  async #readFeatureSnapshotIndexEntry(entry, handle) {
    const buffer = Buffer.allocUnsafe(entry.length);
    let bytesRead = 0;
    while (bytesRead < entry.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        entry.length - bytesRead,
        entry.offset + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== entry.length || buffer.at(-1) !== 0x0a) {
      throw invalidRecordIndex(
        `Indexed feature snapshot ${exactRecordKey(entry)} is truncated`,
      );
    }
    const serialized = buffer.subarray(0, -1).toString("utf8");
    if (sha256(serialized) !== entry.sha256) {
      throw invalidRecordIndex(
        `Indexed feature snapshot ${exactRecordKey(entry)} hash mismatch`,
      );
    }
    let record;
    try {
      record = JSON.parse(serialized);
    } catch (error) {
      throw invalidRecordIndex(
        `Indexed feature snapshot ${exactRecordKey(entry)} is invalid JSON`,
        error,
      );
    }
    if (
      record.record_type !== FEATURE_SNAPSHOT_RECORD_TYPE ||
      exactRecordKey(record) !== exactRecordKey(entry)
    ) {
      throw invalidRecordIndex(
        `Indexed feature snapshot ${exactRecordKey(entry)} points to another record`,
      );
    }
    return record;
  }

  async #readIndexedFeatureSnapshots(entries) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const index = await this.#ensureFeatureSnapshotIndex({
        rebuild: attempt > 0,
      });
      try {
        const records = new Map();
        const selected = [...entries(index)];
        if (selected.length === 0) return records;
        const handle = await fs.open(
          this.recordPath(FEATURE_SNAPSHOT_RECORD_TYPE),
          "r",
        );
        try {
          for (const [key, entry] of selected) {
            records.set(
              key,
              await this.#readFeatureSnapshotIndexEntry(entry, handle),
            );
          }
        } finally {
          await handle.close();
        }
        return records;
      } catch (error) {
        if (error.code !== "INVALID_RECORD_INDEX" || attempt > 0) throw error;
      }
    }
    throw invalidRecordIndex("Feature snapshot index could not be recovered");
  }

  async #appendOrReuseIndexedFeatureSnapshots(records) {
    const existingLatest = await this.#readIndexedFeatureSnapshots((index) =>
      records
        .map((record) => [
          record.record_id,
          index.latestById.get(record.record_id),
        ])
        .filter(([, entry]) => entry)
    );
    const additions = records.filter(
      (record) => !existingLatest.has(record.record_id),
    );
    if (additions.length > 0) {
      const index = await this.#ensureFeatureSnapshotIndex();
      const canonicalBytesBefore = index.checkpoint.canonical_bytes;
      let nextOffset = canonicalBytesBefore;
      const lines = [];
      const entries = [];
      for (const record of additions) {
        const serialized = JSON.stringify(record);
        const line = `${serialized}\n`;
        const length = Buffer.byteLength(line);
        lines.push(line);
        entries.push(this.#featureSnapshotIndexEntry(
          record,
          nextOffset,
          length,
          serialized,
        ));
        nextOffset += length;
      }

      await fs.appendFile(
        this.recordPath(FEATURE_SNAPSHOT_RECORD_TYPE),
        lines.join(""),
        "utf8",
      );
      const canonicalBytesAfter = await this.#recordFileSize(
        FEATURE_SNAPSHOT_RECORD_TYPE,
      );
      if (canonicalBytesAfter !== nextOffset) {
        throw new Error(
          "feature_snapshot.jsonl changed during indexed deterministic append",
        );
      }
      await this.#appendFeatureSnapshotIndexEntries(
        index,
        entries,
        canonicalBytesAfter,
      );

      const fullyLoaded = this.#recordsCache.get(
        FEATURE_SNAPSHOT_RECORD_TYPE,
      );
      if (fullyLoaded) fullyLoaded.push(...additions);
      for (const record of additions) {
        this.#cacheTargetedRecord(FEATURE_SNAPSHOT_RECORD_TYPE, record);
      }
    }

    const finalFileSize = await this.#recordFileSize(
      FEATURE_SNAPSHOT_RECORD_TYPE,
    );
    for (const record of records) {
      this.#cacheLatestTargetedRecord(
        FEATURE_SNAPSHOT_RECORD_TYPE,
        existingLatest.get(record.record_id) ?? record,
        finalFileSize,
      );
    }
    return records.map((record) => {
      const existing = existingLatest.get(record.record_id);
      return {
        inserted: !existing,
        record: existing ?? record,
      };
    });
  }

  #targetedCache(type) {
    let cache = this.#targetedRecordsCache.get(type);
    if (!cache) {
      cache = new Map();
      this.#targetedRecordsCache.set(type, cache);
    }
    return cache;
  }

  #negativeScanCache(type) {
    let cache = this.#negativeRefScanSizes.get(type);
    if (!cache) {
      cache = new Map();
      this.#negativeRefScanSizes.set(type, cache);
    }
    return cache;
  }

  #latestTargetedCache(type) {
    let cache = this.#latestTargetedRecordsCache.get(type);
    if (!cache) {
      cache = new Map();
      this.#latestTargetedRecordsCache.set(type, cache);
    }
    return cache;
  }

  #cacheLatestTargetedRecord(type, record, fileSize) {
    const cache = this.#latestTargetedCache(type);
    cache.delete(record.record_id);
    cache.set(record.record_id, { record, fileSize });
    while (cache.size > TARGETED_RECORD_CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
  }

  #cacheTargetedRecord(type, record) {
    const cache = this.#targetedCache(type);
    const key = exactRecordKey(record);
    cache.delete(key);
    cache.set(key, record);
    while (cache.size > TARGETED_RECORD_CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
    this.#negativeScanCache(type).delete(key);
  }

  #cacheScanTail(type, records) {
    for (const record of records) this.#cacheTargetedRecord(type, record);
  }

  async #recordFileSize(type) {
    try {
      return (await fs.stat(this.recordPath(type))).size;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  async #withTypeScan(type, operation) {
    const previous = this.#scanChains.get(type) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.#scanChains.set(type, current);
    try {
      return await current;
    } finally {
      if (this.#scanChains.get(type) === current) this.#scanChains.delete(type);
    }
  }

  async #scanFile(type, visit) {
    try {
      await fs.access(this.recordPath(type));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const input = createReadStream(this.recordPath(type), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    const tail = [];
    let tailIndex = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          throw new Error(`${type}.jsonl:${lineNumber}: ${error.message}`);
        }
        visit(record);
        if (tail.length < TARGETED_SCAN_TAIL_RECORDS) {
          tail.push(record);
        } else {
          tail[tailIndex] = record;
          tailIndex = (tailIndex + 1) % TARGETED_SCAN_TAIL_RECORDS;
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (tail.length === TARGETED_SCAN_TAIL_RECORDS && tailIndex > 0) {
      this.#cacheScanTail(type, [
        ...tail.slice(tailIndex),
        ...tail.slice(0, tailIndex),
      ]);
    } else {
      this.#cacheScanTail(type, tail);
    }
  }

  async #loadRecords(type) {
    let records = this.#recordsCache.get(type);
    if (records) return records;
    let loading = this.#recordLoadPromises.get(type);
    if (!loading) {
      loading = (async () => {
        try {
          await fs.access(this.recordPath(type));
        } catch (error) {
          if (error.code === "ENOENT") {
            const empty = [];
            this.#recordsCache.set(type, empty);
            return empty;
          }
          throw error;
        }

        const loaded = [];
        const input = createReadStream(this.recordPath(type), { encoding: "utf8" });
        const lines = createInterface({ input, crlfDelay: Infinity });
        let lineNumber = 0;
        try {
          for await (const line of lines) {
            lineNumber += 1;
            if (!line) continue;
            try {
              loaded.push(JSON.parse(line));
            } catch (error) {
              throw new Error(`${type}.jsonl:${lineNumber}: ${error.message}`);
            }
          }
        } finally {
          lines.close();
          input.destroy();
        }
        this.#recordsCache.set(type, loaded);
        return loaded;
      })();
      this.#recordLoadPromises.set(type, loading);
    }
    try {
      records = await loading;
      return records;
    } finally {
      if (this.#recordLoadPromises.get(type) === loading) {
        this.#recordLoadPromises.delete(type);
      }
    }
  }

  async all(type, { latestOnly = true } = {}) {
    const records = await this.#loadRecords(type);
    if (!latestOnly) return [...records];
    const latest = new Map();
    for (const record of records) {
      const previous = latest.get(record.record_id);
      if (!previous || record.revision > previous.revision) latest.set(record.record_id, record);
    }
    return [...latest.values()];
  }

  async allByRefs(type, refs) {
    this.recordPath(type);
    if (!Array.isArray(refs)) throw new TypeError("Record refs must be an array");
    const keys = refs.map((ref) => {
      if (
        typeof ref?.record_id !== "string" ||
        !Number.isInteger(ref?.revision) ||
        ref.revision < 1
      ) {
        throw new TypeError("Record refs require record_id and a positive revision");
      }
      return exactRecordKey(ref);
    });
    const fullyLoaded = this.#recordsCache.get(type);
    if (fullyLoaded) {
      const recordsByRef = new Map(
        fullyLoaded.map((record) => [exactRecordKey(record), record]),
      );
      return keys.map((key) => recordsByRef.get(key)).filter(Boolean);
    }
    return this.#withTypeScan(type, async () => {
      const cache = this.#targetedCache(type);
      if (type === FEATURE_SNAPSHOT_RECORD_TYPE) {
        const found = new Map(
          keys
            .filter((key) => cache.has(key))
            .map((key) => [key, cache.get(key)]),
        );
        const unresolved = [...new Set(
          keys.filter((key) => !found.has(key)),
        )];
        if (unresolved.length > 0) {
          const indexed = await this.#readIndexedFeatureSnapshots((index) =>
            unresolved
              .map((key) => [key, index.byExactRef.get(key)])
              .filter(([, entry]) => entry)
          );
          for (const [key, record] of indexed) {
            found.set(key, record);
            this.#cacheTargetedRecord(type, record);
          }
        }
        return keys.map((key) => found.get(key)).filter(Boolean);
      }
      const negativeScans = this.#negativeScanCache(type);
      const fileSizeBefore = await this.#recordFileSize(type);
      const unresolved = new Set(keys.filter((key) =>
        !cache.has(key) && negativeScans.get(key) !== fileSizeBefore
      ));
      const found = new Map(
        keys.filter((key) => cache.has(key)).map((key) => [key, cache.get(key)]),
      );
      if (unresolved.size > 0) {
        await this.#scanFile(type, (record) => {
          const key = exactRecordKey(record);
          if (unresolved.has(key)) found.set(key, record);
        });
        const fileSizeAfter = await this.#recordFileSize(type);
        for (const [key, record] of found) this.#cacheTargetedRecord(type, record);
        if (fileSizeAfter === fileSizeBefore) {
          for (const key of unresolved) {
            if (!found.has(key)) negativeScans.set(key, fileSizeAfter);
          }
          while (negativeScans.size > TARGETED_RECORD_CACHE_LIMIT) {
            negativeScans.delete(negativeScans.keys().next().value);
          }
        }
      }
      return keys.map((key) => found.get(key) ?? cache.get(key)).filter(Boolean);
    });
  }

  async appendOrReuseMany(records) {
    if (!Array.isArray(records)) throw new TypeError("Records must be an array");
    if (records.length === 0) return [];
    const type = records[0]?.record_type;
    if (records.some((record) => record?.record_type !== type)) {
      throw new TypeError("appendOrReuseMany requires one record type per batch");
    }
    const ids = new Set();
    for (const record of records) {
      assertCanonicalRecord(record);
      if (!RECORD_TYPES.includes(record.record_type)) {
        throw new TypeError(`Unsupported record type: ${record.record_type}`);
      }
      if (record.revision !== 1 || record.supersedes !== null) {
        throw new TypeError(
          "appendOrReuseMany only accepts deterministic first revisions",
        );
      }
      if (ids.has(record.record_id)) {
        throw new TypeError(`Duplicate record id in batch: ${record.record_id}`);
      }
      ids.add(record.record_id);
    }
    const operation = async () => this.#withTypeScan(type, async () => {
      if (type === FEATURE_SNAPSHOT_RECORD_TYPE) {
        return this.#appendOrReuseIndexedFeatureSnapshots(records);
      }
      const existingLatest = new Map();
      const fullyLoaded = this.#recordsCache.get(type);
      if (fullyLoaded) {
        for (const record of fullyLoaded) {
          if (!ids.has(record.record_id)) continue;
          const previous = existingLatest.get(record.record_id);
          if (!previous || record.revision > previous.revision) {
            existingLatest.set(record.record_id, record);
          }
        }
      } else {
        const fileSizeBefore = await this.#recordFileSize(type);
        const latestCache = this.#latestTargetedCache(type);
        for (const id of ids) {
          const cached = latestCache.get(id);
          if (cached?.fileSize === fileSizeBefore) {
            existingLatest.set(id, cached.record);
          }
        }
        if (existingLatest.size < ids.size) {
          existingLatest.clear();
          await this.#scanFile(type, (record) => {
            if (!ids.has(record.record_id)) return;
            const previous = existingLatest.get(record.record_id);
            if (!previous || record.revision > previous.revision) {
              existingLatest.set(record.record_id, record);
            }
          });
          if (await this.#recordFileSize(type) !== fileSizeBefore) {
            throw new Error(
              `${type}.jsonl changed during deterministic artifact scan`,
            );
          }
        }
      }
      const additions = records.filter((record) => !existingLatest.has(record.record_id));
      if (additions.length > 0) {
        await fs.appendFile(
          this.recordPath(type),
          additions.map((record) => `${JSON.stringify(record)}\n`).join(""),
          "utf8",
        );
        if (fullyLoaded) fullyLoaded.push(...additions);
        for (const record of additions) this.#cacheTargetedRecord(type, record);
      }
      if (!fullyLoaded) {
        const finalFileSize = await this.#recordFileSize(type);
        for (const record of records) {
          this.#cacheLatestTargetedRecord(
            type,
            existingLatest.get(record.record_id) ?? record,
            finalFileSize,
          );
        }
      }
      return records.map((record) => {
        const existing = existingLatest.get(record.record_id);
        return {
          inserted: !existing,
          record: existing ?? record,
        };
      });
    });
    this.#appendChain = this.#appendChain.then(operation, operation);
    return this.#appendChain;
  }

  async append(record) {
    const operation = async () => {
      assertCanonicalRecord(record);
      if (!RECORD_TYPES.includes(record.record_type)) {
        throw new TypeError(`Unsupported record type: ${record.record_type}`);
      }
      const existing = await this.#loadRecords(record.record_type);
      const exact = existing.find(
        (item) => item.record_id === record.record_id && item.revision === record.revision,
      );
      if (exact) {
        if (JSON.stringify(exact) !== JSON.stringify(record)) {
          throw new Error(`Conflicting immutable revision ${record.record_id}@${record.revision}`);
        }
        return { inserted: false, record: exact };
      }
      const revisions = existing
        .filter((item) => item.record_id === record.record_id)
        .sort((a, b) => a.revision - b.revision);
      if (record.revision === 1 && revisions.length > 0) {
        throw new Error(`Record ${record.record_id} already exists`);
      }
      if (record.revision > 1) {
        const previous = revisions.at(-1);
        if (!previous || previous.revision !== record.revision - 1) {
          throw new Error(`Revision ${record.record_id}@${record.revision} is not consecutive`);
        }
        const supersedes = record.supersedes;
        if (
          supersedes?.record_id !== previous.record_id ||
          supersedes?.revision !== previous.revision
        ) {
          throw new Error(`Revision ${record.record_id}@${record.revision} must supersede the exact prior revision`);
        }
      }
      await fs.appendFile(this.recordPath(record.record_type), `${JSON.stringify(record)}\n`, "utf8");
      existing.push(record);
      return { inserted: true, record };
    };
    this.#appendChain = this.#appendChain.then(operation, operation);
    return this.#appendChain;
  }

  async appendMany(records) {
    const results = [];
    for (const record of records) results.push(await this.append(record));
    return results;
  }

  async writeBlob(namespace, id, payload) {
    const safeNamespace = String(namespace).replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeId = sha256(String(id));
    const directory = path.join(this.blobsDir, safeNamespace);
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${safeId}.json`);
    const serialized = `${JSON.stringify(payload)}\n`;
    try {
      await fs.writeFile(filePath, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = await fs.readFile(filePath, "utf8");
      } catch (readError) {
        throw new Error(`Existing immutable blob cannot be verified: ${readError.message}`);
      }
      let existingPayload;
      try {
        existingPayload = JSON.parse(existing);
      } catch (parseError) {
        throw new Error(`Existing immutable blob cannot be parsed: ${parseError.message}`);
      }
      if (
        sha256(stableStringify(existingPayload)) !==
        sha256(stableStringify(payload))
      ) {
        throw new Error(
          `Immutable blob collision or corruption at blob://${safeNamespace}/${safeId}.json`,
        );
      }
    }
    return `blob://${safeNamespace}/${safeId}.json`;
  }

  auditPath(type) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(type))) {
      throw new TypeError(`Invalid audit type: ${type}`);
    }
    return path.join(this.auditDir, `${type}.jsonl`);
  }

  async allAudit(type) {
    try {
      return (await fs.readFile(this.auditPath(type), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line);
          } catch (error) {
            throw new Error(`${type}.jsonl:${index + 1}: ${error.message}`);
          }
        });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async appendAudit(type, event) {
    const operation = async () => {
      const events = await this.allAudit(type);
      const identity = event.assertion_id ?? event.event_id;
      if (!identity || !Number.isInteger(event.revision) || event.revision < 1) {
        throw new TypeError("Audit event requires an assertion_id/event_id and positive revision");
      }
      const exact = events.find((item) =>
        (item.assertion_id ?? item.event_id) === identity &&
        item.revision === event.revision
      );
      if (exact) {
        if (JSON.stringify(exact) !== JSON.stringify(event)) {
          throw new Error(`Conflicting immutable audit revision ${identity}@${event.revision}`);
        }
        return { inserted: false, event: exact };
      }
      const previous = events
        .filter((item) => (item.assertion_id ?? item.event_id) === identity)
        .sort((left, right) => left.revision - right.revision)
        .at(-1);
      if (event.revision === 1 && previous) {
        throw new Error(`Audit event ${identity} already exists`);
      }
      if (event.revision > 1) {
        if (!previous || previous.revision !== event.revision - 1) {
          throw new Error(`Audit revision ${identity}@${event.revision} is not consecutive`);
        }
        if (
          event.supersedes?.assertion_id !== identity ||
          event.supersedes?.revision !== previous.revision
        ) {
          throw new Error(`Audit revision ${identity}@${event.revision} must supersede the exact prior revision`);
        }
      }
      await fs.appendFile(this.auditPath(type), `${JSON.stringify(event)}\n`, "utf8");
      return { inserted: true, event };
    };
    this.#appendChain = this.#appendChain.then(operation, operation);
    return this.#appendChain;
  }

  async readBlob(reference) {
    const match = String(reference).match(/^blob:\/\/([a-zA-Z0-9_-]+)\/([a-f0-9]{64}\.json)$/);
    if (!match) throw new TypeError(`Invalid blob reference: ${reference}`);
    return JSON.parse(await fs.readFile(path.join(this.blobsDir, match[1], match[2]), "utf8"));
  }

  async readState(name, fallback = {}) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.stateDir, `${name}.json`), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async writeState(name, value) {
    const target = path.join(this.stateDir, `${name}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  }

  async readModel(name = "champion", { invalidAsNull = false } = {}) {
    try {
      return assertStoredModelArtifact(
        JSON.parse(await fs.readFile(path.join(this.modelsDir, `${name}.json`), "utf8")),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (invalidAsNull && error.code === "INVALID_MODEL_ARTIFACT") return null;
      throw error;
    }
  }

  async writeModel(name, model) {
    if (model?.artifact_hash) {
      if (!/^[a-f0-9]{64}$/.test(model.artifact_hash)) {
        throw new TypeError("Model artifact_hash must be a lowercase SHA-256 digest");
      }
      const immutableArtifact = structuredClone(model);
      delete immutableArtifact.promoted_at;
      delete immutableArtifact.promotion_evaluation;
      const artifactPayload = { ...immutableArtifact };
      delete artifactPayload.artifact_hash;
      if (sha256(stableStringify(artifactPayload)) !== immutableArtifact.artifact_hash) {
        throw new Error("Model artifact hash does not match the immutable fitted artifact");
      }
      const artifactPath = path.join(
        this.modelArtifactsDir,
        `${immutableArtifact.artifact_hash}.json`,
      );
      const serialized = `${JSON.stringify(immutableArtifact, null, 2)}\n`;
      try {
        await fs.writeFile(artifactPath, serialized, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await fs.readFile(artifactPath, "utf8") !== serialized) {
          throw new Error(`Conflicting immutable model artifact ${immutableArtifact.artifact_hash}`);
        }
      }
    }
    const target = path.join(this.modelsDir, `${name}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  }

  async readModelArtifact(artifactHash) {
    if (!/^[a-f0-9]{64}$/.test(String(artifactHash))) {
      throw new TypeError("Model artifact hash must be a lowercase SHA-256 digest");
    }
    try {
      const artifact = assertStoredModelArtifact(
        JSON.parse(
          await fs.readFile(path.join(this.modelArtifactsDir, `${artifactHash}.json`), "utf8"),
        ),
      );
      if (artifact.artifact_hash !== artifactHash) {
        throw new Error("Stored model artifact path does not match its artifact_hash");
      }
      return artifact;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
}
