import { hashLabel, makeRecordId } from "./hash.mjs";
import { toUtcIso } from "./time.mjs";

const PREFIXES = {
  raw_observation: "obs",
  normalized_signal: "sig",
  event_candidate: "evt",
  reset_outcome: "out",
  feature_snapshot: "feat",
  prediction: "pred",
  prediction_settlement: "set",
};

export const SCHEMA_VERSION = "reset-intel/0.2";

export function recordRef(record) {
  return { record_id: record.record_id, revision: record.revision };
}

export function createRecord({
  recordType,
  naturalKey,
  createdAt = new Date(),
  producer,
  data,
  revision = 1,
  supersedes = null,
}) {
  const prefix = PREFIXES[recordType];
  if (!prefix) throw new TypeError(`Unsupported record type: ${recordType}`);
  if (!producer?.name || !producer?.version) {
    throw new TypeError("Record producer requires name and version");
  }
  return {
    schema_version: SCHEMA_VERSION,
    record_type: recordType,
    record_id: makeRecordId(prefix, naturalKey),
    revision,
    supersedes,
    created_at: toUtcIso(createdAt),
    producer: {
      name: producer.name,
      version: producer.version,
      config_hash: producer.config_hash ?? null,
    },
    data,
  };
}

export function producer(name, version, config = null) {
  return {
    name,
    version,
    config_hash: config === null ? null : hashLabel(config),
  };
}

export function targetScope(overrides = {}) {
  return {
    vendor: "openai",
    product: "codex",
    population: "platform",
    plans: ["paid"],
    regions: ["global"],
    quota_bucket: null,
    ...overrides,
  };
}
