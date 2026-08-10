const AUDIT_TYPE = "publication-event";
const EVENT_SCHEMA_VERSION = "publication-event/1";
const TOPICS = new Set(["authority", "outcome", "experimental_probability"]);
const LEDGERS_BY_STORE = new WeakMap();
const EVENT_CONTRACTS = new Map([
  ["forecast.authority_window.opened.v1", {
    topic: "authority",
    refs: ["prediction_ref", "signal_ref"],
    supersedes: false,
  }],
  ["forecast.reset_watch.opened.v1", {
    topic: "experimental_probability",
    refs: ["prediction_ref"],
    supersedes: false,
  }],
  ["forecast.reset_watch.closed.v1", {
    topic: "experimental_probability",
    refs: ["prediction_ref"],
    supersedes: true,
  }],
  ["outcome.reset_confirmed.v1", {
    topic: "outcome",
    refs: ["outcome_ref", "verification_ref"],
    supersedes: false,
  }],
  ["outcome.reset_corrected.v1", {
    topic: "outcome",
    refs: ["outcome_ref", "verification_ref"],
    supersedes: true,
  }],
  ["outcome.reset_retracted.v1", {
    topic: "outcome",
    refs: ["outcome_ref"],
    supersedes: true,
  }],
  ["outcome.verification_withdrawn.v1", {
    topic: "outcome",
    refs: ["outcome_ref"],
    supersedes: true,
  }],
]);

function sortedEvents(events) {
  return [...events].sort((left, right) =>
    left.sequence - right.sequence || left.event_id.localeCompare(right.event_id)
  );
}

function utcTimestamp(value) {
  return typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value));
}

function recordReference(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.record_id === "string" &&
    value.record_id.length > 0 &&
    Number.isInteger(value.revision) &&
    value.revision >= 1;
}

function absoluteUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function assertEvent(event, { allowMissingSequence = false } = {}) {
  const contract = EVENT_CONTRACTS.get(event?.event_type);
  const experimental = event?.topic === "experimental_probability";
  const hasSupersededEvent = /^pub_[a-f0-9]{64}$/.test(
    event?.supersedes_event_id ?? "",
  );
  const notification = event?.notification;
  const references = event?.source && typeof event.source === "object"
    ? Object.values(event.source).filter((reference) => reference !== null)
    : [];
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    event.schema_version !== EVENT_SCHEMA_VERSION ||
    !/^pub_[a-f0-9]{64}$/.test(event.event_id ?? "") ||
    !contract ||
    typeof event.entity_key !== "string" ||
    event.entity_key.length === 0 ||
    event.topic !== contract.topic ||
    !TOPICS.has(event.topic) ||
    !utcTimestamp(event.emitted_at) ||
    !utcTimestamp(event.expires_at) ||
    Date.parse(event.expires_at) <= Date.parse(event.emitted_at) ||
    event.experimental !== experimental ||
    event.report?.default_delivery !== !experimental ||
    event.policy?.version !== "publication-policy/1" ||
    !/^sha256:[a-f0-9]{64}$/.test(event.policy?.hash ?? "") ||
    references.length === 0 ||
    references.some((reference) => !recordReference(reference)) ||
    contract.refs.some((name) => !recordReference(event.source?.[name])) ||
    hasSupersededEvent !== contract.supersedes ||
    (!contract.supersedes && event.supersedes_event_id !== null) ||
    typeof notification?.title !== "string" ||
    notification.title.length === 0 ||
    typeof notification?.body !== "string" ||
    notification.body.length === 0 ||
    typeof notification?.tag !== "string" ||
    notification.tag.length === 0 ||
    !absoluteUrl(notification?.url) ||
    event.title !== notification.title ||
    event.summary !== notification.body ||
    event.url !== notification.url ||
    (
      !allowMissingSequence &&
      (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        event.revision !== 1 ||
        event.supersedes !== null
      )
    )
  ) {
    throw new TypeError("Invalid publication event");
  }
  return event;
}

export function createPublicationLedger(store) {
  if (
    typeof store?.allAudit !== "function" ||
    typeof store?.appendAudit !== "function"
  ) {
    throw new TypeError("Publication ledger requires an audit-capable store");
  }
  const existingLedger = LEDGERS_BY_STORE.get(store);
  if (existingLedger) return existingLedger;

  let operationTail = Promise.resolve();
  let cachedEvents = null;

  async function loadEvents() {
    if (cachedEvents) return cachedEvents;
    const events = sortedEvents(await store.allAudit(AUDIT_TYPE));
    let previous = 0;
    const identities = new Set();
    for (const event of events) {
      assertEvent(event);
      if (event.sequence !== previous + 1) {
        throw new Error("Publication event sequence is not contiguous");
      }
      if (identities.has(event.event_id)) {
        throw new Error(`Duplicate publication event id ${event.event_id}`);
      }
      identities.add(event.event_id);
      previous = event.sequence;
    }
    cachedEvents = events;
    return cachedEvents;
  }

  function enqueue(operation) {
    const result = operationTail.then(operation);
    operationTail = result.catch(() => {});
    return result;
  }

  function all() {
    return enqueue(async () => structuredClone(await loadEvents()));
  }

  function getCursor() {
    return enqueue(async () => (await loadEvents()).at(-1)?.sequence ?? 0);
  }

  async function listAfter(cursor = 0, { limit = 100, topics = null } = {}) {
    const numericCursor = Number(cursor);
    if (!Number.isSafeInteger(numericCursor) || numericCursor < 0) {
      throw new TypeError("Publication cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("Publication page limit must be from 1 through 500");
    }
    const selectedTopics = topics === null
      ? null
      : new Set(topics);
    if (selectedTopics && [...selectedTopics].some((topic) => !TOPICS.has(topic))) {
      throw new TypeError("Publication page requested an unsupported topic");
    }
    return enqueue(async () => {
      const events = await loadEvents();
      const latestCursor = events.at(-1)?.sequence ?? 0;
      if (numericCursor > latestCursor) {
        throw new RangeError("Publication cursor is ahead of the ledger");
      }
      const remaining = events.filter((event) => event.sequence > numericCursor);
      const scanned = remaining.slice(0, limit);
      const nextCursor = scanned.at(-1)?.sequence ?? numericCursor;
      return {
        events: structuredClone(selectedTopics
          ? scanned.filter((event) => selectedTopics.has(event.topic))
          : scanned),
        cursor: nextCursor,
        next_cursor: String(nextCursor),
        has_more: remaining.length > scanned.length,
      };
    });
  }

  function append(candidate) {
    return enqueue(async () => {
      assertEvent(candidate, { allowMissingSequence: true });
      const events = await loadEvents();
      const existing = events.find((event) => event.event_id === candidate.event_id);
      if (existing) {
        return { inserted: false, event: structuredClone(assertEvent(existing)) };
      }
      const event = assertEvent({
        ...structuredClone(candidate),
        sequence: (events.at(-1)?.sequence ?? 0) + 1,
        revision: 1,
        supersedes: null,
      });
      const result = await store.appendAudit(AUDIT_TYPE, event);
      const stored = assertEvent(result.event);
      cachedEvents = [...events, structuredClone(stored)];
      return { inserted: result.inserted, event: structuredClone(stored) };
    });
  }

  const ledger = { all, append, getCursor, listAfter };
  LEDGERS_BY_STORE.set(store, ledger);
  return ledger;
}

export {
  AUDIT_TYPE as PUBLICATION_AUDIT_TYPE,
  EVENT_SCHEMA_VERSION as PUBLICATION_EVENT_SCHEMA_VERSION,
  TOPICS as PUBLICATION_TOPICS,
};
