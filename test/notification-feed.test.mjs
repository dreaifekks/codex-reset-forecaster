import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderPublicationAtom } from "../src/notifications/feed.mjs";
import {
  createPublicationLedger,
  PUBLICATION_EVENT_SCHEMA_VERSION,
} from "../src/notifications/ledger.mjs";

function publicationCandidate(eventId) {
  const id = `pub_${createHash("sha256").update(eventId).digest("hex")}`;
  return {
    schema_version: PUBLICATION_EVENT_SCHEMA_VERSION,
    event_id: id,
    event_type: "outcome.reset_confirmed.v1",
    entity_key: `reset_outcome:${eventId}`,
    topic: "outcome",
    emitted_at: "2026-08-10T01:00:00.000Z",
    expires_at: "2026-08-11T01:00:00.000Z",
    experimental: false,
    supersedes_event_id: null,
    policy: {
      version: "publication-policy/1",
      hash: `sha256:${"a".repeat(64)}`,
    },
    source: {
      outcome_ref: { record_id: eventId, revision: 1 },
      verification_ref: { record_id: `verification-${eventId}`, revision: 1 },
    },
    report: { default_delivery: true },
    title: `Outcome ${eventId}`,
    summary: `Confirmed outcome ${eventId}`,
    url: `https://codexreset.example/accuracy?event=${eventId}`,
    notification: {
      title: `Outcome ${eventId}`,
      body: `Confirmed outcome ${eventId}`,
      url: `https://codexreset.example/accuracy?event=${eventId}`,
      tag: `outcome-${eventId}`,
    },
  };
}

test("publication Atom feed escapes content and separates experimental alerts", () => {
  const events = [
    {
      sequence: 1,
      event_id: "authority<&>",
      topic: "authority",
      emitted_at: "2026-08-10T01:00:00.000Z",
      expires_at: "2026-08-10T04:00:00.000Z",
      title: "Tibo <window>",
      summary: "A & B",
      url: "/?event=1&kind=authority",
    },
    {
      sequence: 2,
      event_id: "experimental",
      topic: "experimental_probability",
      emitted_at: "2026-08-10T02:00:00.000Z",
      expires_at: "2026-08-10T04:00:00.000Z",
      title: "实验概率告警",
      summary: "4h >= 50%",
      url: "/",
    },
    {
      sequence: 3,
      event_id: "expired-authority",
      topic: "authority",
      emitted_at: "2026-08-10T00:00:00.000Z",
      expires_at: "2026-08-10T00:30:00.000Z",
      title: "过期权威窗口",
      summary: "不应再投递",
      url: "/",
    },
  ];
  const ordinary = renderPublicationAtom(events, {
    publicBaseUrl: "https://codexreset.example",
    now: "2026-08-10T03:00:00.000Z",
  });
  assert.equal(ordinary.event_count, 1);
  assert.match(ordinary.body, /Tibo &lt;window&gt;/);
  assert.match(ordinary.body, /A &amp; B/);
  assert.doesNotMatch(ordinary.body, /实验概率告警/);
  assert.doesNotMatch(ordinary.body, /过期权威窗口/);
  assert.match(ordinary.body, /event=1&amp;kind=authority/);
  assert.match(ordinary.body, /alerts:stable/);

  const experimental = renderPublicationAtom(events, {
    publicBaseUrl: "https://codexreset.example",
    includeExperimental: true,
    now: "2026-08-10T03:00:00.000Z",
  });
  assert.equal(experimental.event_count, 2);
  assert.match(experimental.body, /实验概率告警/);
  assert.match(
    experimental.body,
    /公共固定 4 小时概率观察（50% 开启、30% 解除）/,
  );
  assert.match(experimental.body, /alerts:experimental/);
  assert.notEqual(experimental.etag, ordinary.etag);

  const expired = renderPublicationAtom(events, {
    publicBaseUrl: "https://codexreset.example",
    now: "2026-08-10T05:00:00.000Z",
  });
  assert.equal(expired.event_count, 0);
  assert.match(expired.body, /<updated>2026-08-10T01:00:00.000Z<\/updated>/);
});

test("publication ledger serializes one writer and rejects a cursor ahead of history", async () => {
  const audit = [];
  const store = {
    async allAudit() {
      return structuredClone(audit);
    },
    async appendAudit(_type, event) {
      audit.push(structuredClone(event));
      return { inserted: true, event: structuredClone(event) };
    },
  };
  const ledger = createPublicationLedger(store);
  assert.equal(createPublicationLedger(store), ledger);
  const appended = await Promise.all([
    ledger.append(publicationCandidate("one")),
    ledger.append(publicationCandidate("two")),
  ]);
  assert.deepEqual(appended.map((item) => item.event.sequence), [1, 2]);
  assert.deepEqual((await ledger.all()).map((event) => event.sequence), [1, 2]);
  await assert.rejects(
    ledger.listAfter(3),
    /cursor is ahead of the ledger/,
  );
});

test("publication ledger deduplicates the same visible event across provenance revisions", async () => {
  const audit = [];
  const store = {
    async allAudit() {
      return structuredClone(audit);
    },
    async appendAudit(_type, event) {
      audit.push(structuredClone(event));
      return { inserted: true, event: structuredClone(event) };
    },
  };
  const ledger = createPublicationLedger(store);
  const first = publicationCandidate("semantic-outcome");
  const inserted = await ledger.append(first);
  const regenerated = {
    ...structuredClone(first),
    event_id: `pub_${createHash("sha256").update("regenerated").digest("hex")}`,
    emitted_at: "2026-08-10T01:05:00.000Z",
    source: {
      outcome_ref: { record_id: "semantic-outcome", revision: 2 },
      verification_ref: {
        record_id: "verification-semantic-outcome",
        revision: 2,
      },
    },
  };
  const duplicate = await ledger.append(regenerated);

  assert.equal(inserted.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.event.event_id, inserted.event.event_id);
  assert.equal(await ledger.getCursor(), 1);
});
