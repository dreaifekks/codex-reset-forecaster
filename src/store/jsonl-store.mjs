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

  constructor(root) {
    this.root = path.resolve(root);
    this.recordsDir = path.join(this.root, "records");
    this.blobsDir = path.join(this.root, "blobs");
    this.auditDir = path.join(this.root, "audit");
    this.stateDir = path.join(this.root, "state");
    this.modelsDir = path.join(this.root, "models");
    this.modelArtifactsDir = path.join(this.modelsDir, "artifacts");
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.recordsDir, { recursive: true }),
      fs.mkdir(this.blobsDir, { recursive: true }),
      fs.mkdir(this.auditDir, { recursive: true }),
      fs.mkdir(this.stateDir, { recursive: true }),
      fs.mkdir(this.modelsDir, { recursive: true }),
      fs.mkdir(this.modelArtifactsDir, { recursive: true }),
    ]);
    return this;
  }

  recordPath(type) {
    if (!RECORD_TYPES.includes(type)) throw new TypeError(`Unsupported record type: ${type}`);
    return path.join(this.recordsDir, `${type}.jsonl`);
  }

  async #loadRecords(type) {
    let records = this.#recordsCache.get(type);
    if (!records) {
      try {
        await fs.access(this.recordPath(type));
      } catch (error) {
        if (error.code === "ENOENT") {
          records = [];
          this.#recordsCache.set(type, records);
          return records;
        }
        throw error;
      }

      records = [];
      const input = createReadStream(this.recordPath(type), { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let lineNumber = 0;
      try {
        for await (const line of lines) {
          lineNumber += 1;
          if (!line) continue;
          try {
            records.push(JSON.parse(line));
          } catch (error) {
            throw new Error(`${type}.jsonl:${lineNumber}: ${error.message}`);
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
      this.#recordsCache.set(type, records);
    }
    return records;
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
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
