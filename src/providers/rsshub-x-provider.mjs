import { hashLabel } from "../core/hash.mjs";
import { isFirstPersonFutureResetReply } from "../core/authority-reply.mjs";
import {
  appendRawObservationRevision,
  canonicalXStatusUrl,
  rawObservationFromItem,
  rawObservationMaterialHash,
  timestampFromXSnowflake,
  xStatusIdentity,
} from "./raw.mjs";

const PROVIDER_NAME = "rsshub_x_timeline";
const PROVIDER_VERSION = "0.3.1";
const STATE_VERSION = "rsshub-x-provider-state/4";
const FORMAT_VERSION = "rsshub-x-json-feed/3";
const SELECTION_METHOD = "rsshub_x_user_timeline_with_replies/1";
const QUARANTINE_SELECTION_METHOD = "rsshub_x_relation_quarantine/1";
const QUARANTINE_MEDIA_TYPE = "application/vnd.reset-provider-quarantine+json";
const QUARANTINE_VERSION = "rsshub-x-relation-quarantine/1";
const REPLY_CONTEXT_PROVIDER_NAME = "rsshub_x_reply_context";
const REPLY_CONTEXT_MEDIA_TYPE =
  "application/vnd.reset-authority-reply-context+text";
const REPLY_CONTEXT_SELECTION_METHOD =
  "rsshub_x_authority_reply_parent_context/1";
const REPLY_CONTEXT_MAX_ATTEMPTS = 3;
const REPLY_CONTEXT_MAX_PER_COLLECTION = 4;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const JSON_FEED_VERSIONS = new Set([
  "https://jsonfeed.org/version/1",
  "https://jsonfeed.org/version/1.1",
]);

class AmbiguousRelationMetadataError extends TypeError {
  constructor(message, reasonCode) {
    super(message);
    this.name = "AmbiguousRelationMetadataError";
    this.reasonCode = reasonCode;
  }
}

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["bull", "•"],
  ["emsp", " "],
  ["ensp", " "],
  ["gt", ">"],
  ["hellip", "…"],
  ["ldquo", "\u201c"],
  ["lsquo", "\u2018"],
  ["lt", "<"],
  ["mdash", "—"],
  ["middot", "·"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["quot", "\""],
  ["rdquo", "\u201d"],
  ["rsquo", "\u2019"],
  ["thinsp", " "],
]);

function normalizedHandle(value, label = "RSSHub X identity") {
  const handle = String(value ?? "").trim().replace(/^@/, "");
  if (!X_HANDLE.test(handle)) {
    throw new TypeError(`${label} has an invalid X username`);
  }
  return handle;
}

function profileHandle(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, "");
  if (!["x.com", "twitter.com"].includes(hostname)) return null;
  const match = url.pathname.match(/^\/([^/]+)\/?$/);
  if (!match || !X_HANDLE.test(match[1])) return null;
  return match[1];
}

function statusParts(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, "");
  if (!["x.com", "twitter.com"].includes(hostname)) return null;
  const match = url.pathname.match(
    /^\/([^/]+)\/status(?:es)?\/(\d+)(?:\/.*)?$/i,
  );
  if (!match) return null;
  return { handle: match[1], statusId: match[2] };
}

function configuredIdentities(config) {
  const selected = new Map();
  for (const [kind, identities] of [
    ["confirmation", config.confirmation_identities ?? []],
    ["context", config.context_identities ?? []],
  ]) {
    for (const identity of identities) {
      const username = normalizedHandle(identity?.username);
      if (typeof identity?.identity_id !== "string" || !identity.identity_id) {
        throw new TypeError(`RSSHub X identity @${username} is missing identity_id`);
      }
      const key = username.toLowerCase();
      const normalized = {
        username,
        identity_id: identity.identity_id,
        source_role: identity.source_role ?? "unknown",
        kind,
      };
      const previous = selected.get(key);
      if (
        previous &&
        (
          previous.identity_id !== normalized.identity_id ||
          previous.source_role !== normalized.source_role
        )
      ) {
        throw new TypeError(
          `RSSHub X identity mappings disagree for @${username}`,
        );
      }
      if (!previous || kind === "confirmation") selected.set(key, normalized);
    }
  }
  if (selected.size === 0) {
    throw new TypeError("RSSHub X provider requires at least one configured identity");
  }
  return [...selected.values()].sort((left, right) =>
    left.username.localeCompare(right.username)
  );
}

function decodeHtmlEntities(value) {
  return String(value).replace(
    /&(?:#(x[0-9a-f]+|\d+)|([a-z][a-z0-9]+));/gi,
    (entity, numeric, named) => {
      if (numeric) {
        const base = numeric[0].toLowerCase() === "x" ? 16 : 10;
        const digits = base === 16 ? numeric.slice(1) : numeric;
        const codePoint = Number.parseInt(digits, base);
        if (
          !Number.isInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) return entity;
        return String.fromCodePoint(codePoint);
      }
      return NAMED_ENTITIES.get(named.toLowerCase()) ?? entity;
    },
  );
}

function htmlToPlainText(value) {
  const withoutUnsafeBlocks = String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const text = withoutUnsafeBlocks
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|blockquote|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeHtmlEntities(text)
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function quoteBoundary(contentHtml) {
  const quote = /<div\b[^>]*class=(["'])[^"']*\brsshub-quote\b[^"']*\1[^>]*>/i
    .exec(contentHtml);
  if (!quote) return null;
  let boundary = quote.index;
  const before = contentHtml.slice(0, boundary);
  const separator = /<hr\b[^>]*>\s*$/i.exec(before);
  if (separator) boundary = separator.index;
  return boundary;
}

function relationFromLink(link, itemLabel) {
  if (!link || typeof link !== "object" || Array.isArray(link)) {
    throw new TypeError(`${itemLabel} has an invalid RSSHub relation`);
  }
  const rawType = String(link.type ?? "").toLowerCase();
  const type = rawType === "quote"
    ? "quotes"
    : rawType === "repost"
      ? "repost"
      : rawType === "reply"
        ? "reply"
        : "links";
  const parts = statusParts(link.url);
  if (!parts) {
    if (type === "links") return null;
    throw new TypeError(`${itemLabel} ${rawType} relation lacks an exact X status URL`);
  }
  return {
    relation: {
      type,
      provider_item_id: parts.statusId,
      url: canonicalXStatusUrl(link.url, parts.handle),
    },
    contentHtml: typeof link.content_html === "string"
      ? link.content_html
      : null,
  };
}

function nativeRelations(item, itemLabel) {
  if (
    item._extra !== undefined &&
    (
      !item._extra ||
      typeof item._extra !== "object" ||
      Array.isArray(item._extra)
    )
  ) {
    throw new TypeError(`${itemLabel} has invalid RSSHub _extra metadata`);
  }
  const links = item._extra?.links ?? [];
  if (!Array.isArray(links)) {
    throw new TypeError(`${itemLabel} has invalid RSSHub relation links`);
  }
  const selected = new Map();
  for (const link of links) {
    const parsed = relationFromLink(link, itemLabel);
    if (!parsed) continue;
    const key = `${parsed.relation.type}:${parsed.relation.provider_item_id}`;
    if (!selected.has(key)) selected.set(key, parsed);
  }
  return [...selected.values()];
}

function startsWithRetweetMarker(value) {
  return /^\s*(?:RT|🔁)(?::|[\s\u2000-\u200b\u202f\u205f\u3000])/u.test(
    String(value ?? ""),
  );
}

function startsWithReplyMarker(value) {
  return /^\s*(?:Re\b|↩️?)(?::|[\s\u2000-\u200b\u202f\u205f\u3000])/u.test(
    String(value ?? ""),
  );
}

function ownContentHtml(item, relations, itemLabel) {
  const contentHtml = typeof item.content_html === "string"
    ? item.content_html
    : null;
  if (contentHtml === null) {
    if (typeof item.content_text === "string") return item.content_text;
    throw new TypeError(`${itemLabel} has no content_html or content_text`);
  }
  const quoteRelations = relations.filter(({ relation }) =>
    relation.type === "quotes"
  );
  const boundary = quoteBoundary(contentHtml);
  if (boundary !== null) {
    if (quoteRelations.length === 0) {
      throw new TypeError(
        `${itemLabel} contains quoted content without an exact quote relation`,
      );
    }
    return contentHtml.slice(0, boundary);
  }
  if (quoteRelations.length === 0) return contentHtml;

  for (const relation of quoteRelations) {
    if (
      relation.contentHtml &&
      contentHtml.endsWith(relation.contentHtml)
    ) {
      return contentHtml
        .slice(0, -relation.contentHtml.length)
        .replace(/<hr\b[^>]*>\s*$/i, "");
    }
  }
  throw new TypeError(
    `${itemLabel} quote body cannot be separated from the wrapper statement`,
  );
}

function feedDateMatchesStatus(datePublished, statusId) {
  const feedMs = Date.parse(datePublished);
  if (!Number.isFinite(feedMs)) return false;
  return Math.abs(feedMs - Date.parse(timestampFromXSnowflake(statusId))) < 2_000;
}

function feedItemContext(item, { username, identityId }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError("RSSHub JSON Feed item must be an object");
  }
  const itemUrl = statusParts(item.url);
  const itemId = statusParts(item.id);
  if (!itemUrl || !itemId || itemUrl.statusId !== itemId.statusId) {
    throw new TypeError("RSSHub JSON Feed item lacks one exact, consistent X status id");
  }
  if (
    !["i", username.toLowerCase()].includes(itemUrl.handle.toLowerCase()) ||
    !["i", username.toLowerCase()].includes(itemId.handle.toLowerCase())
  ) {
    throw new TypeError(
      `RSSHub JSON Feed status ${itemUrl.statusId} is not authored by @${username}`,
    );
  }
  const authorHandle = profileHandle(item.authors?.[0]?.url);
  if (!authorHandle || authorHandle.toLowerCase() !== username.toLowerCase()) {
    throw new TypeError(
      `RSSHub JSON Feed status ${itemUrl.statusId} has an invalid author profile`,
    );
  }

  const itemLabel = `RSSHub JSON Feed status ${itemUrl.statusId}`;
  const relationEntries = nativeRelations(item, itemLabel);
  const relations = relationEntries.map(({ relation }) => relation);
  const reposts = relations.filter((relation) => relation.type === "repost");
  const replies = relations.filter((relation) => relation.type === "reply");
  if (reposts.length > 1) {
    throw new TypeError(`${itemLabel} has multiple repost origins`);
  }
  if (replies.length > 1) {
    throw new TypeError(`${itemLabel} has multiple reply parents`);
  }
  const plainContent = htmlToPlainText(
    item.content_html ?? item.content_text,
  );
  return {
    identityId,
    item,
    itemLabel,
    itemUrl,
    plainContent,
    relationEntries,
    relations,
    replies,
    reposts,
    username,
  };
}

function assertFeedItemPublicationTime(context) {
  const {
    item,
    itemLabel,
    itemUrl,
    reposts,
  } = context;
  if (
    typeof item.date_published !== "string" ||
    (
      !feedDateMatchesStatus(item.date_published, itemUrl.statusId) &&
      !(
        reposts.length === 1 &&
        feedDateMatchesStatus(
          item.date_published,
          reposts[0].provider_item_id,
        )
      )
    )
  ) {
    throw new TypeError(`${itemLabel} has a publication time inconsistent with its status ids`);
  }
}

function feedObservation(context, {
  content,
  selectionContext,
  availabilityBasis = "rsshub_json_feed_item+status_snowflake",
}) {
  const {
    identityId,
    item,
    itemUrl,
    relations,
    username,
  } = context;
  const publishedAt = timestampFromXSnowflake(itemUrl.statusId);
  return {
    provider_item_id: itemUrl.statusId,
    canonical_url: canonicalXStatusUrl(item.url, username),
    published_at: publishedAt,
    author: {
      provider_author_id: username,
      identity_id: identityId,
      display_handle: `@${username}`,
    },
    native_relations: relations,
    content,
    selection_context: selectionContext,
    source_timing: {
      source_published_at: publishedAt,
      provider_observed_at: null,
      availability_basis: availabilityBasis,
    },
    raw: item,
  };
}

function parseFeedItem(item, { username, identityId }) {
  const context = feedItemContext(item, { username, identityId });
  const {
    itemLabel,
    plainContent,
    relationEntries,
    replies,
    reposts,
  } = context;
  const retweetMarker =
    startsWithRetweetMarker(item.title) ||
    startsWithRetweetMarker(plainContent);
  if (retweetMarker !== (reposts.length === 1)) {
    throw new AmbiguousRelationMetadataError(
      `${itemLabel} has ambiguous RT metadata; refusing to infer a primary statement`,
      "ambiguous_rt_metadata",
    );
  }
  const replyMarker =
    startsWithReplyMarker(item.title) ||
    startsWithReplyMarker(plainContent);
  if (replyMarker !== (replies.length === 1)) {
    throw new AmbiguousRelationMetadataError(
      `${itemLabel} has ambiguous reply metadata; refusing to infer a primary statement`,
      "ambiguous_reply_metadata",
    );
  }
  assertFeedItemPublicationTime(context);
  const text = htmlToPlainText(ownContentHtml(item, relationEntries, itemLabel));
  return feedObservation(context, {
    content: {
      media_type: "text/plain",
      text,
      language: item.language ?? null,
    },
    selectionContext: {
      feature_eligible: true,
      outcome_conditioned: false,
      selection_method: SELECTION_METHOD,
    },
  });
}

function quarantinedFeedItem(item, options, error) {
  const context = feedItemContext(item, options);
  assertFeedItemPublicationTime(context);
  const sourceText = htmlToPlainText(
    ownContentHtml(item, context.relationEntries, context.itemLabel),
  );
  return feedObservation(context, {
    content: {
      media_type: QUARANTINE_MEDIA_TYPE,
      text: JSON.stringify({
        schema_version: QUARANTINE_VERSION,
        reason_code: error.reasonCode,
        reason: error.message,
        source_text: sourceText,
      }),
      language: item.language ?? null,
    },
    selectionContext: {
      feature_eligible: false,
      outcome_conditioned: false,
      selection_method: QUARANTINE_SELECTION_METHOD,
    },
    availabilityBasis:
      "rsshub_json_feed_item+status_snowflake+relation_quarantine",
  });
}

function assertFeedIdentity(payload, username) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("RSSHub response must be a JSON Feed object");
  }
  if (!JSON_FEED_VERSIONS.has(payload.version)) {
    throw new TypeError(`Unsupported RSSHub JSON Feed version: ${payload.version}`);
  }
  const homeHandle = profileHandle(payload.home_page_url);
  if (!homeHandle || homeHandle.toLowerCase() !== username.toLowerCase()) {
    throw new TypeError(`RSSHub JSON Feed does not belong to @${username}`);
  }
  if (!Array.isArray(payload.items)) {
    throw new TypeError("RSSHub JSON Feed is missing its items array");
  }
}

function parseFeedSnapshot(payload, {
  username,
  identityId,
  minimumItems = 1,
  quarantineAmbiguousRelations = false,
} = {}) {
  const handle = normalizedHandle(username, "RSSHub X feed");
  if (typeof identityId !== "string" || !identityId) {
    throw new TypeError(`RSSHub X feed @${handle} is missing identityId`);
  }
  assertFeedIdentity(payload, handle);
  if (
    !Number.isInteger(minimumItems) ||
    minimumItems < 0 ||
    payload.items.length < minimumItems
  ) {
    throw new TypeError(
      `RSSHub JSON Feed for @${handle} has too few items to establish route health`,
    );
  }
  const selected = new Map();
  const quarantinedIds = new Set();
  for (const item of payload.items) {
    let parsed;
    let quarantined = false;
    try {
      parsed = parseFeedItem(item, {
        username: handle,
        identityId,
      });
    } catch (error) {
      if (
        !quarantineAmbiguousRelations ||
        !(error instanceof AmbiguousRelationMetadataError)
      ) {
        throw error;
      }
      parsed = quarantinedFeedItem(item, {
        username: handle,
        identityId,
      }, error);
      quarantined = true;
    }
    const previous = selected.get(parsed.provider_item_id);
    const previousQuarantined = quarantinedIds.has(parsed.provider_item_id);
    if (previous && previousQuarantined !== quarantined) {
      if (!quarantined) {
        selected.set(parsed.provider_item_id, parsed);
        quarantinedIds.delete(parsed.provider_item_id);
      }
      continue;
    }
    if (
      previous &&
      rawObservationMaterialHash(previous) !==
        rawObservationMaterialHash(parsed)
    ) {
      throw new TypeError(
        `RSSHub JSON Feed has conflicting copies of status ${parsed.provider_item_id}`,
      );
    }
    if (!previous) {
      selected.set(parsed.provider_item_id, parsed);
      if (quarantined) quarantinedIds.add(parsed.provider_item_id);
    }
  }
  const validItemCount = selected.size - quarantinedIds.size;
  if (validItemCount < minimumItems) {
    throw new TypeError(
      `RSSHub JSON Feed for @${handle} has too few valid items after relation quarantine`,
    );
  }
  const items = [...selected.values()].sort((left, right) =>
    left.published_at.localeCompare(right.published_at) ||
    left.provider_item_id.localeCompare(right.provider_item_id)
  );
  return {
    items,
    feedItemCount: payload.items.length,
    validItemCount,
    quarantinedItemCount: quarantinedIds.size,
    quarantinedStatusIds: [...quarantinedIds].sort(),
  };
}

export function parseRsshubXJsonFeed(payload, options = {}) {
  return parseFeedSnapshot(payload, options).items;
}

export function rsshubXFeedUrl(baseUrl, username, {
  count = 100,
  includeReplies = true,
} = {}) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new TypeError(
      "RSSHub X base_url must be an HTTPS origin without credentials, query, or fragment",
    );
  }
  const handle = normalizedHandle(username, "RSSHub X feed");
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError("RSSHub X count must be an integer between 1 and 100");
  }
  if (includeReplies !== true) {
    throw new TypeError("RSSHub X exact timeline must include replies");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/twitter/user/${encodeURIComponent(handle)}/` +
    `includeReplies=true&includeRts=1&showSymbolForRetweetAndReply=1&count=${count}`;
  base.searchParams.set("format", "json");
  return base;
}

function rsshubXReplyContextUrl(baseUrl, parentHandle, parentStatusId) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new TypeError(
      "RSSHub X base_url must be an HTTPS origin without credentials, query, or fragment",
    );
  }
  const handle = normalizedHandle(parentHandle, "RSSHub X reply parent");
  const statusId = xStatusIdentity(parentStatusId);
  if (!statusId) {
    throw new TypeError("RSSHub X reply parent has an invalid status id");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/twitter/tweet/${encodeURIComponent(handle)}/status/${statusId}`;
  base.searchParams.set("format", "json");
  return base;
}

function exactReplyParentItem(payload, {
  parentHandle,
  parentStatusId,
  identityId = null,
}) {
  const handle = normalizedHandle(parentHandle, "RSSHub X reply parent");
  const statusId = xStatusIdentity(parentStatusId);
  if (!statusId) {
    throw new TypeError("RSSHub X reply parent has an invalid status id");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("RSSHub X reply parent response must be a JSON Feed object");
  }
  if (!JSON_FEED_VERSIONS.has(payload.version) || !Array.isArray(payload.items)) {
    throw new TypeError("RSSHub X reply parent response is not a supported JSON Feed");
  }
  const home = statusParts(payload.home_page_url);
  if (
    !home ||
    home.statusId !== statusId ||
    home.handle.toLowerCase() !== handle.toLowerCase()
  ) {
    throw new TypeError("RSSHub X reply parent feed does not match the requested status");
  }

  const matching = payload.items.filter((item) => {
    const itemUrl = statusParts(item?.url);
    const itemId = statusParts(item?.id);
    const authorHandle = profileHandle(item?.authors?.[0]?.url);
    return itemUrl?.statusId === statusId &&
      itemId?.statusId === statusId &&
      itemUrl.handle.toLowerCase() === handle.toLowerCase() &&
      itemId.handle.toLowerCase() === handle.toLowerCase() &&
      authorHandle?.toLowerCase() === handle.toLowerCase();
  });
  if (matching.length === 0) {
    throw new Error(
      `RSSHub X reply parent feed omitted exact status ${statusId} by @${handle}`,
    );
  }

  const parsed = matching.map((rawItem) => {
    const item = rawItem._extra === null
      ? Object.fromEntries(
          Object.entries(rawItem).filter(([key]) => key !== "_extra"),
        )
      : rawItem;
    const context = feedItemContext(item, {
      username: handle,
      identityId,
    });
    assertFeedItemPublicationTime(context);
    const text = htmlToPlainText(item.content_html ?? item.content_text);
    if (!text) {
      throw new TypeError(`RSSHub X reply parent ${statusId} has no rendered text`);
    }
    return feedObservation(context, {
      content: {
        media_type: REPLY_CONTEXT_MEDIA_TYPE,
        text,
        language: item.language ?? null,
      },
      selectionContext: {
        feature_eligible: false,
        outcome_conditioned: false,
        selection_method: REPLY_CONTEXT_SELECTION_METHOD,
      },
      availabilityBasis:
        "rsshub_json_feed_item+status_snowflake+authority_reply_parent_context",
    });
  });
  const first = parsed[0];
  const firstHash = rawObservationMaterialHash(first);
  if (parsed.some((item) => rawObservationMaterialHash(item) !== firstHash)) {
    throw new TypeError(
      `RSSHub X reply parent feed has conflicting copies of status ${statusId}`,
    );
  }
  first.raw = matching[0];
  return first;
}

function exactAuthorityReplyCandidates(observations, identities) {
  const confirmationByIdentity = new Map(
    identities
      .filter((identity) => identity.kind === "confirmation")
      .map((identity) => [identity.identity_id, identity]),
  );
  return observations.flatMap((observation) => {
    if (
      observation.data.ingest_provider !== PROVIDER_NAME ||
      observation.data.content.media_type !== "text/plain"
    ) return [];
    const identity = confirmationByIdentity.get(
      observation.data.author.identity_id,
    );
    if (
      !identity ||
      observation.data.author.provider_author_id?.toLowerCase() !==
        identity.username.toLowerCase()
    ) return [];
    const child = statusParts(observation.data.canonical_url);
    if (
      !child ||
      child.statusId !== String(observation.data.provider_item_id) ||
      child.handle.toLowerCase() !== identity.username.toLowerCase() ||
      !isFirstPersonFutureResetReply({
        text: observation.data.content.text,
        nativeRelations: observation.data.native_relations,
      })
    ) return [];
    const relation = observation.data.native_relations.find((item) =>
      item.type === "reply"
    );
    const parent = statusParts(relation?.url);
    const relatedStatusId = xStatusIdentity(relation?.provider_item_id);
    if (
      !parent ||
      !relatedStatusId ||
      parent.statusId !== relatedStatusId
    ) return [];
    return [{
      childRecord: observation,
      childStatusId: child.statusId,
      parentHandle: parent.handle,
      parentStatusId: parent.statusId,
    }];
  }).sort((left, right) =>
    left.childRecord.data.first_seen_at.localeCompare(
      right.childRecord.data.first_seen_at,
    ) || left.childStatusId.localeCompare(right.childStatusId)
  );
}

function boundedDelaySeconds(startedAt, finishedAt) {
  return Math.max(
    0,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1_000),
  );
}

export class RsshubXProvider {
  constructor({
    config,
    fetchFn = fetch,
    now = () => new Date(),
  }) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("RSSHub X provider config is required");
    }
    if (
      config.provider_name !== undefined &&
      config.provider_name !== PROVIDER_NAME
    ) {
      throw new TypeError(
        `RSSHub X provider_name must be ${PROVIDER_NAME}`,
      );
    }
    this.config = config;
    this.fetch = fetchFn;
    this.now = now;
    this.providerName = PROVIDER_NAME;
    this.stateKey = `${this.providerName.replaceAll("_", "-")}-provider`;
    this.identities = configuredIdentities(config);
    this.includeReplies = config.include_replies ?? true;
    this.count = Number(config.count ?? 100);
    this.minimumItems = Number(config.minimum_items ?? 1);
    this.maximumResponseBytes = Number(
      config.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.requestTimeoutMs = Number(
      config.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    rsshubXFeedUrl(config.base_url, this.identities[0].username, {
      count: this.count,
      includeReplies: this.includeReplies,
    });
    if (
      !Number.isInteger(this.minimumItems) ||
      this.minimumItems < 1 ||
      !Number.isInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1 ||
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new TypeError("RSSHub X provider limits are invalid");
    }
  }

  healthObservation({
    ok,
    at,
    delaySeconds,
    error = null,
    feedCount = 0,
    itemCount = 0,
    quarantinedItemCount = 0,
  }) {
    return rawObservationFromItem({
      provider_item_id: `health-${at.toISOString()}-${ok ? "ok" : "error"}`,
      canonical_url: null,
      published_at: null,
      author: {},
      native_relations: [],
      content: {
        media_type: "application/vnd.reset-provider-health+json",
        text: JSON.stringify({
          ok,
          delay_seconds: delaySeconds,
          error,
          feed_count: feedCount,
          item_count: itemCount,
          quarantined_item_count: quarantinedItemCount,
          coverage_created: false,
        }),
        language: null,
      },
    }, {
      providerName: this.providerName,
      providerVersion: PROVIDER_VERSION,
      config: this.config,
      firstSeenAt: at,
      fetchedAt: at,
      rawPayloadRef: null,
    });
  }

  async fetchFeed(identity, previous = {}) {
    const url = rsshubXFeedUrl(this.config.base_url, identity.username, {
      count: this.count,
      includeReplies: this.includeReplies,
    });
    const currentFeedUrl = url.toString();
    const reusablePrevious = (
      previous.feed_url === currentFeedUrl &&
      previous.format_version === FORMAT_VERSION
    )
      ? previous
      : {};
    const headers = {
      accept: "application/feed+json, application/json;q=0.9",
    };
    if (reusablePrevious.etag) {
      headers["if-none-match"] = reusablePrevious.etag;
    }
    if (reusablePrevious.last_modified) {
      headers["if-modified-since"] = reusablePrevious.last_modified;
    }
    const response = await this.fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (response.status === 304) {
      if (reusablePrevious.valid_snapshot !== true) {
        throw new Error(`RSSHub returned 304 before @${identity.username} had a valid snapshot`);
      }
      return {
        identity,
        url: currentFeedUrl,
        notModified: true,
        items: [],
        feedItemCount: reusablePrevious.feed_item_count ?? 0,
        validItemCount: reusablePrevious.item_count ?? 0,
        quarantinedItemCount:
          reusablePrevious.quarantined_item_count ?? 0,
        quarantinedStatusIds:
          reusablePrevious.quarantined_status_ids ?? [],
        cursor: {
          ...reusablePrevious,
          etag:
            response.headers.get("etag") ??
            reusablePrevious.etag ??
            null,
          last_modified:
            response.headers.get("last-modified") ??
            reusablePrevious.last_modified ??
            null,
        },
      };
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `RSSHub X feed @${identity.username} returned ${response.status}: ` +
        body.slice(0, 300),
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.toLowerCase().includes("application/feed+json") &&
      !contentType.toLowerCase().includes("application/json")
    ) {
      throw new Error(
        `RSSHub X feed @${identity.username} returned non-JSON content`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maximumResponseBytes
    ) {
      throw new RangeError(`RSSHub X feed @${identity.username} exceeds the response limit`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.maximumResponseBytes) {
      throw new RangeError(`RSSHub X feed @${identity.username} exceeds the response limit`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`RSSHub X feed @${identity.username} returned invalid JSON`);
    }
    const snapshot = parseFeedSnapshot(payload, {
      username: identity.username,
      identityId: identity.identity_id,
      minimumItems: this.minimumItems,
      quarantineAmbiguousRelations: true,
    });
    const { items } = snapshot;
    const route = response.headers.get("x-rsshub-route");
    if (route && route !== "/twitter/user/:id/:routeParams?") {
      throw new Error(`RSSHub X feed @${identity.username} matched an unexpected route`);
    }
    const normalizedSignature = items.map((item) => ({
      provider_item_id: item.provider_item_id,
      material_hash: rawObservationMaterialHash(item),
    }));
    return {
      identity,
      url: currentFeedUrl,
      notModified: false,
      items,
      ...snapshot,
      cursor: {
        feed_url: currentFeedUrl,
        format_version: FORMAT_VERSION,
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        cache_control: response.headers.get("cache-control"),
        rsshub_cache_status: response.headers.get("rsshub-cache-status"),
        feed_fingerprint: hashLabel(normalizedSignature),
        feed_item_count: snapshot.feedItemCount,
        item_count: snapshot.validItemCount,
        quarantined_item_count: snapshot.quarantinedItemCount,
        quarantined_status_ids: snapshot.quarantinedStatusIds,
        newest_status_id: [...items]
          .filter((item) => item.content.media_type !== QUARANTINE_MEDIA_TYPE)
          .sort((left, right) =>
          right.published_at.localeCompare(left.published_at)
        )[0]?.provider_item_id ?? null,
        valid_snapshot: true,
      },
    };
  }

  async fetchReplyParent(candidate) {
    const url = rsshubXReplyContextUrl(
      this.config.base_url,
      candidate.parentHandle,
      candidate.parentStatusId,
    );
    const response = await this.fetch(url, {
      headers: {
        accept: "application/feed+json, application/json;q=0.9",
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `RSSHub X reply parent ${candidate.parentStatusId} returned ` +
          `${response.status}: ${body.slice(0, 300)}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.toLowerCase().includes("application/feed+json") &&
      !contentType.toLowerCase().includes("application/json")
    ) {
      throw new Error(
        `RSSHub X reply parent ${candidate.parentStatusId} returned non-JSON content`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maximumResponseBytes
    ) {
      throw new RangeError(
        `RSSHub X reply parent ${candidate.parentStatusId} exceeds the response limit`,
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.maximumResponseBytes) {
      throw new RangeError(
        `RSSHub X reply parent ${candidate.parentStatusId} exceeds the response limit`,
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        `RSSHub X reply parent ${candidate.parentStatusId} returned invalid JSON`,
      );
    }
    const route = response.headers.get("x-rsshub-route");
    if (route && route !== "/twitter/tweet/:id/status/:status/:original?") {
      throw new Error(
        `RSSHub X reply parent ${candidate.parentStatusId} matched an unexpected route`,
      );
    }
    const parentIdentity = this.identities.find((identity) =>
      identity.username.toLowerCase() === candidate.parentHandle.toLowerCase()
    );
    return exactReplyParentItem(payload, {
      parentHandle: candidate.parentHandle,
      parentStatusId: candidate.parentStatusId,
      identityId: parentIdentity?.identity_id ?? null,
    });
  }

  async resolveReplyContexts(store, priorReplyContexts = {}) {
    const observations = await store.all("raw_observation");
    const candidates = exactAuthorityReplyCandidates(
      observations,
      this.identities,
    );
    const existingContexts = new Map(
      observations
        .filter((observation) =>
          observation.data.ingest_provider === REPLY_CONTEXT_PROVIDER_NAME &&
          observation.data.content.media_type === REPLY_CONTEXT_MEDIA_TYPE
        )
        .map((observation) => {
          const status = statusParts(observation.data.canonical_url);
          return [
            status?.statusId === String(observation.data.provider_item_id)
              ? `${status.handle.toLowerCase()}:${status.statusId}`
              : null,
            observation,
          ];
        })
        .filter(([key]) => key !== null),
    );
    const previous = priorReplyContexts &&
        typeof priorReplyContexts === "object" &&
        !Array.isArray(priorReplyContexts)
      ? priorReplyContexts
      : {};
    const next = { ...previous };
    const stateFor = (candidate) => {
      const prior = previous[candidate.childStatusId];
      if (
        !prior ||
        prior.parent_status_id !== candidate.parentStatusId ||
        prior.parent_handle?.toLowerCase() !==
          candidate.parentHandle.toLowerCase()
      ) {
        return { attempts: 0, status: "retryable" };
      }
      return prior;
    };
    const contextKey = (candidate) =>
      `${candidate.parentHandle.toLowerCase()}:${candidate.parentStatusId}`;
    const resolvedEntry = (candidate, context, current, resolvedAt) => ({
      child_observation_ref: {
        record_id: candidate.childRecord.record_id,
        revision: candidate.childRecord.revision,
      },
      parent_handle: candidate.parentHandle,
      parent_status_id: candidate.parentStatusId,
      status: "resolved",
      attempts: current.attempts ?? 0,
      last_attempt_at: current.last_attempt_at ?? null,
      resolved_at: resolvedAt,
      terminal_at: null,
      last_error: null,
      context_observation_ref: {
        record_id: context.record_id,
        revision: context.revision,
      },
    });

    for (const candidate of candidates) {
      const current = stateFor(candidate);
      next[candidate.childStatusId] = {
        child_observation_ref: {
          record_id: candidate.childRecord.record_id,
          revision: candidate.childRecord.revision,
        },
        parent_handle: candidate.parentHandle,
        parent_status_id: candidate.parentStatusId,
        status: current.status ?? "retryable",
        attempts: Number(current.attempts ?? 0),
        last_attempt_at: current.last_attempt_at ?? null,
        resolved_at: current.resolved_at ?? null,
        terminal_at: current.terminal_at ?? null,
        last_error: current.last_error ?? null,
        context_observation_ref: current.context_observation_ref ?? null,
      };
      const context = existingContexts.get(contextKey(candidate));
      if (!context) continue;
      next[candidate.childStatusId] = resolvedEntry(
        candidate,
        context,
        current,
        current.resolved_at ?? context.data.first_seen_at,
      );
    }

    const pending = candidates
      .filter((candidate) => {
        const status = next[candidate.childStatusId] ?? stateFor(candidate);
        return status.status !== "resolved" &&
          status.status !== "terminal" &&
          Number(status.attempts ?? 0) < REPLY_CONTEXT_MAX_ATTEMPTS;
      })
      .sort((left, right) => {
        const leftAttempts = Number(
          (next[left.childStatusId] ?? stateFor(left)).attempts ?? 0,
        );
        const rightAttempts = Number(
          (next[right.childStatusId] ?? stateFor(right)).attempts ?? 0,
        );
        return leftAttempts - rightAttempts ||
          left.childRecord.data.first_seen_at.localeCompare(
            right.childRecord.data.first_seen_at,
          ) || left.childStatusId.localeCompare(right.childStatusId);
      })
      .slice(0, REPLY_CONTEXT_MAX_PER_COLLECTION);

    let attempted = 0;
    let resolved = 0;
    const errors = [];
    for (const candidate of pending) {
      const current = next[candidate.childStatusId] ?? stateFor(candidate);
      const existing = existingContexts.get(contextKey(candidate));
      if (existing) {
        next[candidate.childStatusId] = resolvedEntry(
          candidate,
          existing,
          current,
          current.resolved_at ?? existing.data.first_seen_at,
        );
        continue;
      }
      attempted += 1;
      const attemptAt = new Date(this.now());
      const attempts = Number(current.attempts ?? 0) + 1;
      try {
        const fetchedParent = await this.fetchReplyParent(candidate);
        const fetchedAt = new Date(this.now());
        const parent = {
          ...fetchedParent,
          source_timing: {
            ...fetchedParent.source_timing,
            provider_observed_at: fetchedAt.toISOString(),
          },
        };
        const append = await appendRawObservationRevision(store, parent, {
          providerName: REPLY_CONTEXT_PROVIDER_NAME,
          providerVersion: PROVIDER_VERSION,
          config: {
            format_version: FORMAT_VERSION,
            selection_method: REPLY_CONTEXT_SELECTION_METHOD,
            source: this.config,
          },
          firstSeenAt: fetchedAt,
          fetchedAt,
          rawPayload: parent.raw,
        });
        existingContexts.set(contextKey(candidate), append.record);
        next[candidate.childStatusId] = resolvedEntry(
          candidate,
          append.record,
          {
            ...current,
            attempts,
            last_attempt_at: attemptAt.toISOString(),
          },
          fetchedAt.toISOString(),
        );
        resolved += 1;
      } catch (error) {
        const failedAt = new Date(this.now());
        const errorMessage = String(error?.message ?? error).slice(0, 500);
        const terminal = attempts >= REPLY_CONTEXT_MAX_ATTEMPTS;
        next[candidate.childStatusId] = {
          child_observation_ref: {
            record_id: candidate.childRecord.record_id,
            revision: candidate.childRecord.revision,
          },
          parent_handle: candidate.parentHandle,
          parent_status_id: candidate.parentStatusId,
          status: terminal ? "terminal" : "retryable",
          attempts,
          last_attempt_at: attemptAt.toISOString(),
          resolved_at: null,
          terminal_at: terminal ? failedAt.toISOString() : null,
          last_error: errorMessage,
          context_observation_ref: null,
        };
        errors.push(`${candidate.parentStatusId}: ${errorMessage}`);
      }
    }

    const statuses = candidates.map((candidate) =>
      next[candidate.childStatusId] ?? stateFor(candidate)
    );
    return {
      entries: next,
      attempted,
      resolved,
      retryable: statuses.filter((state) => state.status === "retryable").length,
      terminal: statuses.filter((state) => state.status === "terminal").length,
      errors,
    };
  }

  async collect(store) {
    const startedAt = new Date(this.now());
    const priorState = await store.readState(this.stateKey, {
      schema_version: STATE_VERSION,
      provider: this.providerName,
      feeds: {},
    });
    try {
      const feeds = [];
      for (const identity of this.identities) {
        feeds.push(await this.fetchFeed(
          identity,
          priorState.feeds?.[identity.username.toLowerCase()] ?? {},
        ));
      }
      const fetchedAt = new Date(this.now());
      let inserted = 0;
      let unchanged = 0;
      let records = 0;
      let quarantined = 0;
      for (const feed of feeds) {
        quarantined += feed.quarantinedItemCount;
        for (const item of feed.items) {
          records += 1;
          const result = await appendRawObservationRevision(store, item, {
            providerName: this.providerName,
            providerVersion: PROVIDER_VERSION,
            config: {
              format_version: FORMAT_VERSION,
              source: this.config,
            },
            firstSeenAt: fetchedAt,
            fetchedAt,
            rawPayload: item.raw,
          });
          if (result.inserted) inserted += 1;
          else unchanged += 1;
        }
      }
      const replyContexts = await this.resolveReplyContexts(
        store,
        priorState.reply_contexts ?? {},
      );
      const completedAt = new Date(this.now());
      const health = {
        ok: true,
        delay_seconds: boundedDelaySeconds(startedAt, completedAt),
        error: null,
      };
      await store.append(this.healthObservation({
        ...health,
        at: completedAt,
        feedCount: feeds.length,
        itemCount: records,
        quarantinedItemCount: quarantined,
      }));
      const nextFeeds = { ...(priorState.feeds ?? {}) };
      for (const feed of feeds) {
        const key = feed.identity.username.toLowerCase();
        nextFeeds[key] = {
          ...(nextFeeds[key] ?? {}),
          ...feed.cursor,
          last_success_at: completedAt.toISOString(),
          last_not_modified_at: feed.notModified
            ? completedAt.toISOString()
            : nextFeeds[key]?.last_not_modified_at ?? null,
        };
      }
      const warnings = [];
      if (quarantined > 0) {
        warnings.push(
          `${quarantined} RSSHub item(s) quarantined because exact relation metadata was ambiguous`,
        );
      }
      if (replyContexts.errors.length > 0) {
        warnings.push(
          `${replyContexts.errors.length} authority reply parent context request(s) failed without failing the timeline`,
        );
      }
      if (
        replyContexts.terminal > 0 &&
        replyContexts.errors.length === 0
      ) {
        warnings.push(
          `${replyContexts.terminal} authority reply parent context request(s) remain terminal`,
        );
      }
      const unresolvedReplyContextErrors = Object.values(
        replyContexts.entries,
      )
        .filter((entry) => entry.status !== "resolved" && entry.last_error)
        .map((entry) => entry.last_error);
      const contextDegraded =
        replyContexts.retryable > 0 || replyContexts.terminal > 0;
      await store.writeState(this.stateKey, {
        ...priorState,
        schema_version: STATE_VERSION,
        provider: this.providerName,
        format_version: FORMAT_VERSION,
        feeds: nextFeeds,
        reply_contexts: replyContexts.entries,
        reply_context_resolution: {
          max_attempts: REPLY_CONTEXT_MAX_ATTEMPTS,
          max_per_collection: REPLY_CONTEXT_MAX_PER_COLLECTION,
          attempted: replyContexts.attempted,
          resolved: replyContexts.resolved,
          retryable: replyContexts.retryable,
          terminal: replyContexts.terminal,
          last_run_at: completedAt.toISOString(),
        },
        last_success_at: completedAt.toISOString(),
        last_failure_at: null,
        last_error: null,
        last_warning: warnings.length > 0 ? warnings.join("; ") : null,
        last_quarantine_at: quarantined > 0
          ? completedAt.toISOString()
          : priorState.last_quarantine_at ?? null,
        current_quarantined_item_count: quarantined,
        current_quarantined_status_ids: feeds
          .flatMap((feed) => feed.quarantinedStatusIds)
          .filter((statusId, index, all) => all.indexOf(statusId) === index)
          .sort(),
        context_status: contextDegraded ? "degraded" : "fresh",
        last_context_success_at: completedAt.toISOString(),
        last_context_failure_at: replyContexts.errors.length > 0
          ? completedAt.toISOString()
          : priorState.last_context_failure_at ?? null,
        last_context_error: unresolvedReplyContextErrors.length > 0
          ? [...new Set(unresolvedReplyContextErrors)].join("; ")
          : null,
      });
      return {
        provider: this.providerName,
        format_version: FORMAT_VERSION,
        collected: inserted,
        unchanged,
        records,
        quarantined,
        feeds: feeds.length,
        coverage_created: false,
        health,
      };
    } catch (error) {
      const failedAt = new Date(this.now());
      const errorMessage = String(error?.message ?? error);
      try {
        await store.append(this.healthObservation({
          ok: false,
          at: failedAt,
          delaySeconds: boundedDelaySeconds(startedAt, failedAt),
          error: errorMessage,
        }));
      } catch {
        // Preserve the original provider error.
      }
      await store.writeState(this.stateKey, {
        ...priorState,
        schema_version: STATE_VERSION,
        provider: this.providerName,
        format_version: FORMAT_VERSION,
        last_failure_at: failedAt.toISOString(),
        last_error: errorMessage,
        context_status: "error",
        last_context_failure_at: failedAt.toISOString(),
        last_context_error: errorMessage,
      });
      throw error;
    }
  }
}

export {
  FORMAT_VERSION as RSSHUB_X_FORMAT_VERSION,
  PROVIDER_NAME as RSSHUB_X_PROVIDER_NAME,
  PROVIDER_VERSION as RSSHUB_X_PROVIDER_VERSION,
  QUARANTINE_MEDIA_TYPE as RSSHUB_X_QUARANTINE_MEDIA_TYPE,
  QUARANTINE_SELECTION_METHOD as RSSHUB_X_QUARANTINE_SELECTION_METHOD,
  REPLY_CONTEXT_MEDIA_TYPE as RSSHUB_X_REPLY_CONTEXT_MEDIA_TYPE,
  REPLY_CONTEXT_PROVIDER_NAME as RSSHUB_X_REPLY_CONTEXT_PROVIDER_NAME,
};
