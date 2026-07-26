import fs from "node:fs/promises";
import path from "node:path";
import {
  appendRawObservationRevision,
  canonicalXStatusUrl,
  xStatusIdentity,
} from "./raw.mjs";

const PROVIDER_NAME = "timeline_jsonl";
const PROVIDER_VERSION = "1.0.0";
const FORMAT_VERSION = "author-timeline-jsonl/1";
const SELECTION_METHOD = "recent_author_timeline_export";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

function normalizedHandle(value, lineNumber) {
  const handle = String(value ?? "").trim().replace(/^@/, "");
  if (!X_HANDLE.test(handle)) {
    throw new TypeError(`Timeline JSONL line ${lineNumber} has an invalid author handle`);
  }
  return handle;
}

function configuredIdentityMappings(config) {
  const mappings = [];
  for (const [providerName, provider] of Object.entries(config.providers ?? {})) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    for (const [kind, identities] of [
      ["confirmation", provider.confirmation_identities ?? []],
      ["context", provider.context_identities ?? []],
    ]) {
      for (const identity of identities) {
        if (!identity?.username || !identity?.identity_id) continue;
        mappings.push({
          provider: providerName,
          kind,
          username: identity.username.toLowerCase(),
          identity_id: identity.identity_id,
          source_role: identity.source_role ?? "unknown",
        });
      }
    }
  }
  return mappings.sort((left, right) =>
    left.username.localeCompare(right.username) ||
    left.identity_id.localeCompare(right.identity_id) ||
    left.kind.localeCompare(right.kind) ||
    left.provider.localeCompare(right.provider)
  );
}

function identityForHandle(mappings, handle) {
  const matches = mappings.filter((mapping) =>
    mapping.username === handle.toLowerCase()
  );
  const identityIds = new Set(matches.map((mapping) => mapping.identity_id));
  if (identityIds.size > 1) {
    throw new TypeError(
      `Configured identity mappings disagree for @${handle}: ${[...identityIds].sort().join(", ")}`,
    );
  }
  return matches[0]?.identity_id ?? `x_${handle.toLowerCase()}`;
}

function normalizedPublishedAt(value, lineNumber) {
  const timestamp = Date.parse(value);
  if (!value || Number.isNaN(timestamp)) {
    throw new TypeError(`Timeline JSONL line ${lineNumber} has an invalid createdAt`);
  }
  return new Date(timestamp).toISOString();
}

function normalizedStatusUrl(value, id, handle, lineNumber) {
  if (value !== null && value !== undefined && String(value).trim() !== "") {
    let url;
    try {
      url = new URL(String(value).trim());
    } catch {
      throw new TypeError(`Timeline JSONL line ${lineNumber} has an invalid X status URL`);
    }
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, "");
    const match = url.pathname.match(
      /^\/([^/]+)\/status(?:es)?\/(\d+)(?:\/.*)?$/i,
    );
    if (!["x.com", "twitter.com"].includes(hostname) || !match) {
      throw new TypeError(`Timeline JSONL line ${lineNumber} has an invalid X status URL`);
    }
    const [, urlHandle, urlId] = match;
    if (urlId !== id) {
      throw new TypeError(
        `Timeline JSONL line ${lineNumber} URL status ID does not match id`,
      );
    }
    if (
      urlHandle.toLowerCase() !== "i" &&
      urlHandle.toLowerCase() !== handle.toLowerCase()
    ) {
      throw new TypeError(
        `Timeline JSONL line ${lineNumber} URL author does not match author`,
      );
    }
  }
  return canonicalXStatusUrl(id, handle);
}

function parseLine(value, lineNumber, identityMappings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Timeline JSONL line ${lineNumber} must be a JSON object`);
  }
  const platform = String(value.platform ?? "").trim().toLowerCase();
  if (!["x", "twitter"].includes(platform)) {
    throw new TypeError(
      `Timeline JSONL line ${lineNumber} platform must be x or twitter`,
    );
  }
  const id = String(value.id ?? "").trim();
  if (xStatusIdentity(id) !== id) {
    throw new TypeError(`Timeline JSONL line ${lineNumber} has an invalid status id`);
  }
  if (typeof value.text !== "string") {
    throw new TypeError(`Timeline JSONL line ${lineNumber} text must be a string`);
  }
  const handle = normalizedHandle(value.author, lineNumber);
  const unresolvedRetweet = /^\s*RT\s+@[A-Za-z0-9_]{1,15}:/i.test(value.text);
  return {
    provider_item_id: id,
    canonical_url: normalizedStatusUrl(value.url, id, handle, lineNumber),
    published_at: normalizedPublishedAt(value.createdAt, lineNumber),
    author: {
      provider_author_id: handle,
      identity_id: identityForHandle(identityMappings, handle),
      display_handle: `@${handle}`,
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text: value.text,
      language: null,
    },
    selection_context: {
      feature_eligible: !unresolvedRetweet,
      outcome_conditioned: false,
      selection_method: SELECTION_METHOD,
    },
    raw: value,
  };
}

export function parseTimelineJsonl(text, config) {
  const identityMappings = configuredIdentityMappings(config);
  const items = [];
  const seenIds = new Set();
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const lineNumber = index + 1;
    let value;
    try {
      value = JSON.parse(rawLine);
    } catch {
      throw new TypeError(`Timeline JSONL line ${lineNumber} is not valid JSON`);
    }
    const item = parseLine(value, lineNumber, identityMappings);
    if (seenIds.has(item.provider_item_id)) {
      throw new TypeError(
        `Timeline JSONL line ${lineNumber} duplicates status id ${item.provider_item_id}`,
      );
    }
    seenIds.add(item.provider_item_id);
    items.push(item);
  }
  if (items.length === 0) throw new TypeError("Timeline JSONL contains no records");
  return items;
}

export class TimelineJsonlProvider {
  constructor({
    filePath,
    config,
    now = () => new Date(),
    readFileFn = fs.readFile,
    statFn = fs.stat,
  }) {
    if (!filePath) throw new TypeError("Timeline JSONL import requires a file path");
    this.filePath = path.resolve(filePath);
    this.config = config;
    this.now = now;
    this.readFile = readFileFn;
    this.stat = statFn;
    this.identityMappings = configuredIdentityMappings(config);
  }

  async poll() {
    const stats = await this.stat(this.filePath);
    if (!stats.isFile()) throw new TypeError("Timeline JSONL path must be a regular file");
    if (stats.size > MAX_FILE_BYTES) {
      throw new RangeError(`Timeline JSONL file exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const items = parseTimelineJsonl(await this.readFile(this.filePath, "utf8"), this.config);
    return { items, health: { ok: true, delay_seconds: 0 } };
  }

  async collect(store) {
    const { items, health } = await this.poll();
    const fetchedAt = this.now();
    const providerConfig = {
      format_version: FORMAT_VERSION,
      selection_method: SELECTION_METHOD,
      identity_mappings: this.identityMappings,
    };
    let inserted = 0;
    let unchanged = 0;
    for (const item of items) {
      const result = await appendRawObservationRevision(store, item, {
        providerName: PROVIDER_NAME,
        providerVersion: PROVIDER_VERSION,
        config: providerConfig,
        firstSeenAt: fetchedAt,
        fetchedAt,
        rawPayload: item.raw,
      });
      if (result.inserted) inserted += 1;
      else unchanged += 1;
    }
    return {
      provider: PROVIDER_NAME,
      format_version: FORMAT_VERSION,
      collected: inserted,
      unchanged,
      records: items.length,
      coverage_created: false,
      health,
    };
  }
}
