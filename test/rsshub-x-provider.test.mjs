import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseRsshubXJsonFeed,
  RsshubXProvider,
  RSSHUB_X_QUARANTINE_MEDIA_TYPE,
  RSSHUB_X_REPLY_CONTEXT_MEDIA_TYPE,
  RSSHUB_X_REPLY_CONTEXT_PROVIDER_NAME,
  rsshubXFeedUrl,
} from "../src/providers/rsshub-x-provider.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { loadConfig } from "../src/core/config.mjs";
import { processRecords } from "../src/pipeline/run.mjs";
import { latestSignalsAsOf } from "../src/model/as-of.mjs";
import { selectCurrentSignals } from "../src/pipeline/signal-selection.mjs";

const TIBO = {
  username: "thsottiaux",
  identity_id: "person_tibo_sottiaux",
  source_role: "product_lead",
};

function feedFor(username, items, {
  title = `Twitter @${username}`,
  homePageUrl = `https://x.com/${username}`,
} = {}) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title,
    home_page_url: homePageUrl,
    items,
  };
}

function feed(items) {
  return feedFor("thsottiaux", items, { title: "Twitter @Tibo" });
}

function post({
  id,
  title,
  contentHtml,
  datePublished,
  extra,
}) {
  return {
    id: `https://twitter.com/thsottiaux/status/${id}`,
    url: `https://x.com/thsottiaux/status/${id}`,
    title,
    content_html: contentHtml,
    date_published: datePublished,
    authors: [{
      name: "Tibo",
      url: "https://x.com/thsottiaux",
    }],
    ...(extra ? { _extra: extra } : {}),
  };
}

function postBy({
  username,
  name = username,
  id,
  title,
  contentHtml,
  datePublished,
  extra,
}) {
  return {
    id: `https://twitter.com/${username}/status/${id}`,
    url: `https://x.com/${username}/status/${id}`,
    title,
    content_html: contentHtml,
    date_published: datePublished,
    authors: [{
      name,
      url: `https://x.com/${username}`,
    }],
    ...(extra !== undefined ? { _extra: extra } : {}),
  };
}

function response(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/feed+json; charset=UTF-8",
      "cache-control": "public, max-age=300",
      etag: "W/\"test-feed\"",
      "last-modified": "Tue, 28 Jul 2026 06:00:00 GMT",
      "rsshub-cache-status": "HIT",
      "x-rsshub-route": "/twitter/user/:id/:routeParams?",
      ...headers,
    },
  });
}

function conversationResponse(payload, headers = {}) {
  return response(payload, {
    "x-rsshub-route": "/twitter/tweet/:id/status/:status/:original?",
    ...headers,
  });
}

async function temporaryStore(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return await new JsonlStore(directory).init();
}

function providerConfig(overrides = {}) {
  return {
    base_url: "https://rss.example.test/",
    provider_name: "rsshub_x_timeline",
    include_replies: true,
    count: 100,
    minimum_items: 1,
    request_timeout_ms: 5_000,
    max_response_bytes: 100_000,
    confirmation_identities: [TIBO],
    context_identities: [],
    ...overrides,
  };
}

test("RSSHub JSON Feed collection keeps exact status lineage, strips quoted text, and is idempotent", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-");
  const announcement = post({
    id: "2081899343091843463",
    title: "We’re celebrating fast adoption. I’m feeling like a limit reset.",
    contentHtml:
      "We’re celebrating the fast adoption of ChatGPT Work.<br><br>" +
      "I’m feeling like a limit reset.<br>Hold on tight to your ultra and /fast " +
      "and see you in a few hours!",
    datePublished: "2026-07-28T00:27:37.000Z",
  });
  const completion = post({
    id: "2081940052154933696",
    title: "Back at the laptop. The usage limits have been reset.",
    contentHtml:
      "Back at the laptop. The usage limits have been reset for all paid users " +
      "of Codex and ChatGPT Work.<hr style=\"border:0\">" +
      "<div class=\"rsshub-quote\">Tibo: I’m feeling like a limit reset." +
      "<br>See you in a few hours.</div>",
    datePublished: "2026-07-28T03:09:23.000Z",
    extra: {
      links: [{
        url: "https://x.com/thsottiaux/status/2081899343091843463",
        type: "quote",
        content_html:
          "<div class=\"rsshub-quote\">Tibo: I’m feeling like a limit reset." +
          "<br>See you in a few hours.</div>",
      }],
    },
  });
  const payload = feed([completion, announcement, structuredClone(announcement)]);
  const calls = [];
  let collectedAt = new Date("2026-07-28T06:00:00.000Z");
  await store.writeState("rsshub-x-timeline-provider", {
    schema_version: "rsshub-x-provider-state/1",
    provider: "rsshub_x_timeline",
    feeds: {
      thsottiaux: {
        feed_url:
          "https://rss.example.test/twitter/user/thsottiaux/" +
          "includeReplies=0&includeRts=1&showSymbolForRetweetAndReply=1&count=100?format=json",
        etag: "W/\"old-posts-only-feed\"",
        last_modified: "Tue, 28 Jul 2026 05:50:00 GMT",
        valid_snapshot: true,
      },
    },
  });
  const provider = new RsshubXProvider({
    config: providerConfig(),
    fetchFn: async (url, options) => {
      calls.push({ url: url.toString(), headers: options.headers });
      return response(payload);
    },
    now: () => collectedAt,
  });

  const result = await provider.collect(store);
  assert.deepEqual(result, {
    provider: "rsshub_x_timeline",
    format_version: "rsshub-x-json-feed/3",
    collected: 2,
    unchanged: 0,
    records: 2,
    quarantined: 0,
    feeds: 1,
    coverage_created: false,
    health: { ok: true, delay_seconds: 0, error: null },
  });
  assert.equal(
    calls[0].url,
    "https://rss.example.test/twitter/user/thsottiaux/" +
      "includeReplies=true&includeRts=1&showSymbolForRetweetAndReply=1&count=100?format=json",
  );
  assert.match(calls[0].headers.accept, /application\/feed\+json/);
  assert.equal(
    calls[0].headers["if-none-match"],
    undefined,
    "a route change must force a full snapshot instead of reusing the old ETag",
  );
  assert.equal(calls[0].headers["if-modified-since"], undefined);

  const observations = await store.all("raw_observation");
  const raw = observations.filter((record) =>
    record.data.content.media_type === "text/plain"
  );
  assert.equal(raw.length, 2, "duplicate status ids collapse before append");
  const future = raw.find((record) =>
    record.data.provider_item_id === "2081899343091843463"
  );
  const done = raw.find((record) =>
    record.data.provider_item_id === "2081940052154933696"
  );
  assert.equal(
    future.data.canonical_url,
    "https://x.com/thsottiaux/status/2081899343091843463",
  );
  assert.equal(future.data.published_at, "2026-07-28T00:27:37.869Z");
  assert.equal(future.data.first_seen_at, "2026-07-28T06:00:00.000Z");
  assert.equal(future.data.fetched_at, "2026-07-28T06:00:00.000Z");
  assert.equal(future.data.availability_attestation, null);
  assert.equal(future.data.author.identity_id, "person_tibo_sottiaux");
  assert.deepEqual(future.data.selection_context, {
    feature_eligible: true,
    outcome_conditioned: false,
    selection_method: "rsshub_x_user_timeline_with_replies/1",
  });
  assert.deepEqual(future.data.source_timing, {
    source_published_at: "2026-07-28T00:27:37.869Z",
    provider_observed_at: null,
    availability_basis: "rsshub_json_feed_item+status_snowflake",
  });
  assert.match(done.data.content.text, /Back at the laptop/);
  assert.doesNotMatch(done.data.content.text, /I’m feeling like a limit reset/);
  assert.deepEqual(done.data.native_relations, [{
    type: "quotes",
    provider_item_id: "2081899343091843463",
    url: "https://x.com/thsottiaux/status/2081899343091843463",
  }]);
  assert.ok(done.data.content.raw_payload_ref);

  const state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.schema_version, "rsshub-x-provider-state/4");
  assert.equal(state.provider, "rsshub_x_timeline");
  assert.equal(state.last_success_at, "2026-07-28T06:00:00.000Z");
  assert.equal(state.last_error, null);
  assert.equal(state.context_status, "fresh");
  assert.equal(state.feeds.thsottiaux.item_count, 2);
  assert.equal(state.feeds.thsottiaux.quarantined_item_count, 0);
  assert.equal(state.feeds.thsottiaux.format_version, "rsshub-x-json-feed/3");
  assert.equal(
    state.feeds.thsottiaux.newest_status_id,
    "2081940052154933696",
  );
  assert.equal(state.feeds.thsottiaux.etag, "W/\"test-feed\"");

  collectedAt = new Date("2026-07-28T06:06:00.000Z");
  const repeated = await provider.collect(store);
  assert.equal(repeated.collected, 0);
  assert.equal(repeated.unchanged, 2);
  assert.equal(
    (await store.all("raw_observation", { latestOnly: false }))
      .filter((record) => record.data.content.media_type === "text/plain")
      .length,
    2,
  );
  const currentFuture = (await store.all("raw_observation"))
    .find((record) => record.data.provider_item_id === future.data.provider_item_id);
  assert.equal(currentFuture.revision, 1);
  assert.equal(currentFuture.data.first_seen_at, "2026-07-28T06:00:00.000Z");
  assert.equal(calls[1].headers["if-none-match"], "W/\"test-feed\"");
  assert.deepEqual(await store.readState("coverage", { providers: {} }), {
    providers: {},
  });
});

test("RSSHub reply items preserve the exact parent relation and wrapper text", () => {
  const reply = post({
    id: "2081978301703422280",
    title: "Re @Robertg761_ How much did we pay you",
    contentHtml: "Re @Robertg761_ How much did we pay you",
    datePublished: "2026-07-28T05:41:23.000Z",
    extra: {
      links: [{
        url: "https://x.com/Robertg761_/status/2081905602683375686",
        type: "reply",
      }],
    },
  });
  const [parsed] = parseRsshubXJsonFeed(feed([reply]), {
    username: "thsottiaux",
    identityId: "person_tibo_sottiaux",
  });
  assert.equal(parsed.provider_item_id, "2081978301703422280");
  assert.equal(
    parsed.content.text,
    "Re @Robertg761_ How much did we pay you",
  );
  assert.deepEqual(parsed.native_relations, [{
    type: "reply",
    provider_item_id: "2081905602683375686",
    url: "https://x.com/Robertg761_/status/2081905602683375686",
  }]);
  assert.equal(
    parsed.selection_context.selection_method,
    "rsshub_x_user_timeline_with_replies/1",
  );

  const withoutRelation = structuredClone(reply);
  delete withoutRelation._extra;
  assert.throws(
    () => parseRsshubXJsonFeed(feed([withoutRelation]), {
      username: "thsottiaux",
      identityId: "person_tibo_sottiaux",
    }),
    /ambiguous reply metadata/,
  );

  const withoutMarker = structuredClone(reply);
  withoutMarker.title = "How much did we pay you";
  withoutMarker.content_html = "How much did we pay you";
  assert.throws(
    () => parseRsshubXJsonFeed(feed([withoutMarker]), {
      username: "thsottiaux",
      identityId: "person_tibo_sottiaux",
    }),
    /ambiguous reply metadata/,
  );

  const multipleParents = structuredClone(reply);
  multipleParents._extra.links.push({
    url: "https://x.com/someone/status/2081905602683375687",
    type: "reply",
  });
  assert.throws(
    () => parseRsshubXJsonFeed(feed([multipleParents]), {
      username: "thsottiaux",
      identityId: "person_tibo_sottiaux",
    }),
    /multiple reply parents/,
  );
});

test("RSSHub resolves an exact authority reply parent from a noisy conversation feed as context-only raw evidence", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-reply-context-");
  const childStatusId = "2086189414292865249";
  const parentStatusId = "2086188425691140496";
  const child = post({
    id: childStatusId,
    title: "Re @rxmphai I'll do another performative reset on Monday",
    contentHtml: "Re @rxmphai I'll do another performative reset on Monday",
    datePublished: "2026-08-08T20:34:50.000Z",
    extra: {
      links: [{
        url: `https://x.com/rxmphai/status/${parentStatusId}`,
        type: "reply",
      }],
    },
  });
  const parent = postBy({
    username: "rxmphai",
    name: "Rumph",
    id: parentStatusId,
    title: "This is just performative at this point. The weekly reset was yesterday",
    contentHtml:
      "This is just performative at this point. The weekly reset was yesterday" +
      "<hr><div class=\"rsshub-quote\">Tibo: I have reset usage limits " +
      "for all paid users of ChatGPT Work and Codex.</div>",
    datePublished: "2026-08-08T20:30:54.000Z",
    extra: {
      links: [{
        url: "https://x.com/thsottiaux/status/2086188036493344823",
        type: "quote",
        content_html:
          "<div class=\"rsshub-quote\">Tibo: I have reset usage limits " +
          "for all paid users of ChatGPT Work and Codex.</div>",
      }],
    },
  });
  const unrelated = postBy({
    username: "Nalfur",
    id: "2086368644229984274",
    title: "Re @rxmphai This reset was more confusing than useful",
    contentHtml: "Re @rxmphai This reset was more confusing than useful",
    datePublished: "2026-08-09T08:27:02.000Z",
    extra: {
      links: [{
        url: `https://x.com/rxmphai/status/${parentStatusId}`,
        type: "reply",
      }],
    },
  });
  const wrongAuthorSameId = postBy({
    username: "not_rxmphai",
    id: parentStatusId,
    title: "Malicious same-id wrapper",
    contentHtml: "Malicious same-id wrapper",
    datePublished: "2026-08-08T20:30:54.000Z",
  });
  const conversation = feedFor("rxmphai", [
    unrelated,
    wrongAuthorSameId,
    parent,
  ], {
    homePageUrl: `https://x.com/rxmphai/status/${parentStatusId}`,
  });
  const calls = [];
  const times = [
    "2026-08-08T20:40:00.000Z",
    "2026-08-08T20:40:01.000Z",
    "2026-08-08T20:40:02.000Z",
    "2026-08-08T20:40:03.000Z",
    "2026-08-08T20:40:04.000Z",
  ];
  let timeIndex = 0;
  const provider = new RsshubXProvider({
    config: providerConfig(),
    fetchFn: async (url) => {
      calls.push(url.toString());
      return url.pathname.includes("/twitter/tweet/")
        ? conversationResponse(conversation)
        : response(feed([child]));
    },
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
  });

  const result = await provider.collect(store);
  assert.equal(result.health.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1],
    `https://rss.example.test/twitter/tweet/rxmphai/status/${parentStatusId}?format=json`,
  );

  const observations = await store.all("raw_observation");
  const context = observations.find((record) =>
    record.data.ingest_provider === RSSHUB_X_REPLY_CONTEXT_PROVIDER_NAME
  );
  assert.ok(context);
  assert.equal(context.data.provider_item_id, parentStatusId);
  assert.equal(context.data.author.provider_author_id, "rxmphai");
  assert.equal(context.data.author.identity_id, null);
  assert.equal(context.data.content.media_type, RSSHUB_X_REPLY_CONTEXT_MEDIA_TYPE);
  assert.match(context.data.content.text, /weekly reset was yesterday/);
  assert.match(context.data.content.text, /ChatGPT Work and Codex/);
  assert.doesNotMatch(context.data.content.text, /Malicious same-id wrapper/);
  assert.deepEqual(context.data.selection_context, {
    feature_eligible: false,
    outcome_conditioned: false,
    selection_method: "rsshub_x_authority_reply_parent_context/1",
  });
  assert.equal(context.data.first_seen_at, "2026-08-08T20:40:03.000Z");
  assert.equal(context.data.fetched_at, "2026-08-08T20:40:03.000Z");
  assert.equal(
    context.data.source_timing.provider_observed_at,
    "2026-08-08T20:40:03.000Z",
  );
  assert.deepEqual(context.data.native_relations, [{
    type: "quotes",
    provider_item_id: "2086188036493344823",
    url: "https://x.com/thsottiaux/status/2086188036493344823",
  }]);

  const state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.reply_contexts[childStatusId].status, "resolved");
  assert.equal(state.reply_contexts[childStatusId].attempts, 1);
  assert.equal(
    state.reply_contexts[childStatusId].context_observation_ref.record_id,
    context.record_id,
  );
  assert.equal(state.reply_context_resolution.max_per_collection, 4);

  const runConfig = await loadConfig({
    configPath: "config/tibo-authority-live.json",
  });
  await processRecords(store, runConfig, {
    now: new Date("2026-08-09T10:46:00.000Z"),
  });
  const childObservation = observations.find((record) =>
    record.data.provider_item_id === childStatusId
  );
  const signal = selectCurrentSignals(
    await store.all("normalized_signal", { latestOnly: false }),
  ).find((record) =>
    record.data.observation_refs[0].record_id === childObservation.record_id
  );
  assert.ok(signal);
  assert.equal(signal.data.claim.event_type, "quota_reset");
  assert.equal(signal.data.claim.phase, "scheduled");
  assert.equal(signal.data.claim.scope.product, "codex");
  assert.equal(signal.data.claim.scope.population, "platform");
  assert.deepEqual(signal.data.claim.asserted_time_range, {
    start: "2026-08-10T00:00:00.000Z",
    end: "2026-08-11T00:00:00.000Z",
    boundary: "[start,end)",
    precision: "day",
    timezone_basis: "UTC",
    original_text: "on Monday",
  });
  assert.equal(signal.data.provenance.derivation, "primary_statement");
  assert.equal(signal.data.provenance.feature_eligible, true);
  assert.equal(
    signal.data.extraction.relevance.reason_code,
    "authority_reply_reset_commitment",
  );
  assert.deepEqual(signal.data.extraction.relevance.context_refs, [{
    record_id: context.record_id,
    revision: context.revision,
  }]);
  assert.deepEqual(await store.all("reset_outcome"), []);
});

test("RSSHub does not resolve future-reset replies from a context identity", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-non-authority-reply-");
  const contextIdentity = {
    username: "rxmphai",
    identity_id: "person_rumph",
    source_role: "community",
  };
  const parentStatusId = "2086188036493344823";
  const contextReply = postBy({
    username: contextIdentity.username,
    id: "2086188425691140496",
    title: "Re @thsottiaux I'll do another reset on Monday",
    contentHtml: "Re @thsottiaux I'll do another reset on Monday",
    datePublished: "2026-08-08T20:30:54.000Z",
    extra: {
      links: [{
        url: `https://x.com/thsottiaux/status/${parentStatusId}`,
        type: "reply",
      }],
    },
  });
  const tiboPost = post({
    id: "2086189414292865249",
    title: "A normal update",
    contentHtml: "A normal update",
    datePublished: "2026-08-08T20:34:50.000Z",
  });
  const calls = [];
  await new RsshubXProvider({
    config: providerConfig({ context_identities: [contextIdentity] }),
    fetchFn: async (url) => {
      calls.push(url.toString());
      if (url.pathname.includes("/twitter/tweet/")) {
        throw new Error("a context identity must not trigger parent fetch");
      }
      return url.pathname.includes("/twitter/user/rxmphai/")
        ? response(feedFor("rxmphai", [contextReply]))
        : response(feed([tiboPost]));
    },
    now: () => new Date("2026-08-08T20:40:00.000Z"),
  }).collect(store);

  assert.equal(calls.length, 2);
  assert.equal(calls.some((url) => url.includes("/twitter/tweet/")), false);
  assert.equal(
    (await store.all("raw_observation")).some((record) =>
      record.data.ingest_provider === RSSHUB_X_REPLY_CONTEXT_PROVIDER_NAME
    ),
    false,
  );
});

test("RSSHub reply-parent failures degrade independently, retry old children after 304, and stop after a finite limit", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-reply-retry-");
  const childStatusId = "2086189414292865249";
  const parentStatusId = "2086188425691140496";
  const child = post({
    id: childStatusId,
    title: "Re @rxmphai I’ll do another reset on Monday",
    contentHtml: "Re @rxmphai I’ll do another reset on Monday",
    datePublished: "2026-08-08T20:34:50.000Z",
    extra: {
      links: [{
        url: `https://x.com/rxmphai/status/${parentStatusId}`,
        type: "reply",
      }],
    },
  });
  let timelineRequests = 0;
  let parentRequests = 0;
  let nowOffsetSeconds = 0;
  const provider = new RsshubXProvider({
    config: providerConfig(),
    fetchFn: async (url) => {
      if (url.pathname.includes("/twitter/tweet/")) {
        parentRequests += 1;
        return new Response("temporary upstream failure", { status: 503 });
      }
      timelineRequests += 1;
      if (timelineRequests === 1) return response(feed([child]));
      return new Response(null, {
        status: 304,
        headers: { etag: "W/\"test-feed\"" },
      });
    },
    now: () => new Date(
      Date.parse("2026-08-08T20:40:00.000Z") + nowOffsetSeconds++ * 1_000,
    ),
  });

  const first = await provider.collect(store);
  assert.equal(first.health.ok, true, "parent failure must not fail the timeline");
  let state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.reply_contexts[childStatusId].status, "retryable");
  assert.equal(state.reply_contexts[childStatusId].attempts, 1);
  assert.equal(state.context_status, "degraded");
  assert.match(state.last_context_error, /503/);
  assert.match(state.last_warning, /failed without failing the timeline/);

  await provider.collect(store);
  state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.reply_contexts[childStatusId].status, "retryable");
  assert.equal(state.reply_contexts[childStatusId].attempts, 2);

  await provider.collect(store);
  state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.reply_contexts[childStatusId].status, "terminal");
  assert.equal(state.reply_contexts[childStatusId].attempts, 3);
  assert.equal(state.reply_context_resolution.terminal, 1);
  assert.equal(state.context_status, "degraded");

  await provider.collect(store);
  assert.equal(parentRequests, 3, "terminal parents must not be retried forever");
  assert.equal(timelineRequests, 4, "the primary feed remains healthy under 304s");
  assert.equal(
    (await store.all("raw_observation")).some((record) =>
      record.data.ingest_provider === RSSHUB_X_REPLY_CONTEXT_PROVIDER_NAME
    ),
    false,
  );
});

test("RSSHub collection quarantines one ambiguous relation without promoting it or failing the valid snapshot", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-quarantine-");
  const valid = post({
    id: "2081899343091843463",
    title: "I’m feeling like a limit reset.",
    contentHtml:
      "We’re celebrating the fast adoption of ChatGPT Work. " +
      "I’m feeling like a limit reset. See you in a few hours.",
    datePublished: "2026-07-28T00:27:37.000Z",
  });
  const ambiguous = post({
    id: "2083331664420192388",
    title:
      "Re @theo They shipped it one day early. Thanks Theo. Let's keep learning together.",
    contentHtml:
      "Re @theo They shipped it one day early. Thanks Theo. " +
      "Let's keep learning together.<hr>" +
      "<div class=\"rsshub-quote\">OpenAI Developers: See what needs you next.</div>",
    datePublished: "2026-07-31T23:19:09.000Z",
    extra: {
      links: [{
        url: "https://x.com/OpenAIDevs/status/2083288643310133716",
        type: "quote",
        content_html:
          "<div class=\"rsshub-quote\">OpenAI Developers: See what needs you next.</div>",
      }],
    },
  });
  let payload = feed([ambiguous, valid]);
  let collectedAt = new Date("2026-08-01T03:10:00.000Z");
  const provider = new RsshubXProvider({
    config: providerConfig(),
    fetchFn: async () => response(payload),
    now: () => collectedAt,
  });

  const result = await provider.collect(store);
  assert.deepEqual(result, {
    provider: "rsshub_x_timeline",
    format_version: "rsshub-x-json-feed/3",
    collected: 2,
    unchanged: 0,
    records: 2,
    quarantined: 1,
    feeds: 1,
    coverage_created: false,
    health: { ok: true, delay_seconds: 0, error: null },
  });

  const quarantined = (await store.all("raw_observation"))
    .find((record) =>
      record.data.provider_item_id === "2083331664420192388"
    );
  assert.equal(
    quarantined.data.content.media_type,
    RSSHUB_X_QUARANTINE_MEDIA_TYPE,
  );
  assert.deepEqual(quarantined.data.selection_context, {
    feature_eligible: false,
    outcome_conditioned: false,
    selection_method: "rsshub_x_relation_quarantine/1",
  });
  const quarantine = JSON.parse(quarantined.data.content.text);
  assert.equal(quarantine.schema_version, "rsshub-x-relation-quarantine/1");
  assert.equal(quarantine.reason_code, "ambiguous_reply_metadata");
  assert.match(quarantine.source_text, /^Re @theo They shipped it one day early/);
  assert.doesNotMatch(quarantine.source_text, /See what needs you next/);
  assert.ok(quarantined.data.content.raw_payload_ref);
  const healthObservation = (await store.all("raw_observation"))
    .find((record) =>
      record.data.content.media_type ===
        "application/vnd.reset-provider-health+json"
    );
  assert.equal(
    JSON.parse(healthObservation.data.content.text).quarantined_item_count,
    1,
  );

  const state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.last_error, null);
  assert.equal(state.context_status, "fresh");
  assert.equal(state.current_quarantined_item_count, 1);
  assert.deepEqual(state.current_quarantined_status_ids, [
    "2083331664420192388",
  ]);
  assert.match(state.last_warning, /1 RSSHub item/);

  const runConfig = await loadConfig();
  await processRecords(store, runConfig, { now: collectedAt });
  const signals = await store.all("normalized_signal", { latestOnly: false });
  assert.equal(
    signals.some((signal) =>
      signal.data.observation_refs.some((reference) =>
        reference.record_id === quarantined.record_id
      )
    ),
    false,
    "a quarantined relation must not enter extraction or outcome adjudication",
  );

  const corrected = structuredClone(ambiguous);
  corrected._extra.links.push({
    url: "https://x.com/theo/status/2083287127865885060",
    type: "reply",
  });
  payload = feed([corrected, valid]);
  collectedAt = new Date("2026-08-01T03:20:00.000Z");
  const correctedResult = await provider.collect(store);
  assert.equal(correctedResult.collected, 1);
  assert.equal(correctedResult.unchanged, 1);
  assert.equal(correctedResult.quarantined, 0);

  const correctedObservation = (await store.all("raw_observation"))
    .find((record) =>
      record.data.provider_item_id === "2083331664420192388"
    );
  assert.equal(correctedObservation.revision, 2);
  assert.equal(correctedObservation.supersedes.record_id, quarantined.record_id);
  assert.equal(correctedObservation.supersedes.revision, 1);
  assert.equal(correctedObservation.data.first_seen_at, "2026-08-01T03:10:00.000Z");
  assert.equal(correctedObservation.data.fetched_at, "2026-08-01T03:20:00.000Z");
  assert.equal(correctedObservation.data.content.media_type, "text/plain");
  assert.equal(correctedObservation.data.selection_context.feature_eligible, true);
  assert.deepEqual(
    correctedObservation.data.native_relations.map((relation) => relation.type).sort(),
    ["quotes", "reply"],
  );
  const correctedState = await store.readState("rsshub-x-timeline-provider");
  assert.equal(correctedState.current_quarantined_item_count, 0);
  assert.deepEqual(correctedState.current_quarantined_status_ids, []);
  assert.equal(correctedState.last_warning, null);
});

test("RSSHub collection still fails closed when every feed item has ambiguous relation metadata", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-quarantine-only-");
  const ambiguous = post({
    id: "2083331664420192388",
    title: "Re @theo A relation without an exact reply parent",
    contentHtml: "Re @theo A relation without an exact reply parent",
    datePublished: "2026-07-31T23:19:09.000Z",
  });
  const provider = new RsshubXProvider({
    config: providerConfig(),
    fetchFn: async () => response(feed([ambiguous])),
    now: () => new Date("2026-08-01T03:10:00.000Z"),
  });

  await assert.rejects(
    provider.collect(store),
    /too few valid items after relation quarantine/,
  );
  const state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.context_status, "error");
  assert.match(state.last_error, /too few valid items/);
});

test("RSSHub reposts use the wrapper snowflake time and require an exact repost relation", () => {
  const retweet = {
    id: "https://twitter.com/inkks1996/status/2082070624604996043",
    url: "https://x.com/inkks1996/status/2082070624604996043",
    title: "RT FAVORITE: event announcement",
    content_html: "RT FAVORITE<br>event announcement",
    date_published: "2026-07-28T09:00:08.000Z",
    authors: [{
      name: "inkks",
      url: "https://x.com/inkks1996",
    }],
    _extra: {
      links: [{
        url: "https://x.com/favo_official/status/2082028321655906326",
        type: "repost",
      }],
    },
  };
  const [parsed] = parseRsshubXJsonFeed({
    version: "https://jsonfeed.org/version/1.1",
    home_page_url: "https://x.com/inkks1996",
    items: [retweet],
  }, {
    username: "inkks1996",
    identityId: "x_inkks1996",
  });
  assert.equal(parsed.provider_item_id, "2082070624604996043");
  assert.equal(parsed.published_at, "2026-07-28T11:48:14.564Z");
  assert.deepEqual(parsed.native_relations, [{
    type: "repost",
    provider_item_id: "2082028321655906326",
    url: "https://x.com/favo_official/status/2082028321655906326",
  }]);

  const unresolved = structuredClone(retweet);
  delete unresolved._extra;
  assert.throws(
    () => parseRsshubXJsonFeed({
      version: "https://jsonfeed.org/version/1.1",
      home_page_url: "https://x.com/inkks1996",
      items: [unresolved],
    }, {
      username: "inkks1996",
      identityId: "x_inkks1996",
    }),
    /ambiguous RT metadata/,
  );

  const unmarked = structuredClone(retweet);
  unmarked.title = "event announcement";
  unmarked.content_html = "event announcement";
  assert.throws(
    () => parseRsshubXJsonFeed({
      version: "https://jsonfeed.org/version/1.1",
      home_page_url: "https://x.com/inkks1996",
      items: [unmarked],
    }, {
      username: "inkks1996",
      identityId: "x_inkks1996",
    }),
    /ambiguous RT metadata/,
  );
});

test("RSSHub provider treats an HTTP 200 empty timeline as unhealthy and records failure state", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-empty-");
  const at = new Date("2026-07-28T06:00:00.000Z");
  const provider = new RsshubXProvider({
    config: providerConfig(),
    fetchFn: async () => response(feed([])),
    now: () => at,
  });

  await assert.rejects(
    provider.collect(store),
    /too few items to establish route health/,
  );
  const state = await store.readState("rsshub-x-timeline-provider");
  assert.equal(state.provider, "rsshub_x_timeline");
  assert.equal(state.last_success_at, undefined);
  assert.equal(state.last_failure_at, "2026-07-28T06:00:00.000Z");
  assert.equal(state.context_status, "error");
  assert.match(state.last_error, /too few items/);
  const [health] = await store.all("raw_observation");
  assert.equal(
    health.data.content.media_type,
    "application/vnd.reset-provider-health+json",
  );
  assert.equal(JSON.parse(health.data.content.text).ok, false);
});

test("RSSHub exact authority text respects first-seen cutoffs and only completion can settle an outcome", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-outcome-");
  const runConfig = await loadConfig({ overrides: {
    outcome_definition: {
      version: "authority-announced-platform-reset/2",
      event_semantics: "qualifying_authority_completion_statement",
      authority_identity_ids: ["person_tibo_sottiaux"],
      scope_policy: "explicit-platform-or-authority-general-codex/1",
      negative_label_policy: "authoritative_daily_ledger_absence",
    },
  } });
  const announcement = post({
    id: "2081899343091843463",
    title: "I’m feeling like a limit reset.",
    contentHtml:
      "We’re celebrating the fast adoption of ChatGPT Work. " +
      "I’m feeling like a limit reset. See you in a few hours.",
    datePublished: "2026-07-28T00:27:37.000Z",
  });
  const completion = post({
    id: "2081940052154933696",
    title: "The usage limits have been reset.",
    contentHtml:
      "Back at the laptop. The usage limits have been reset for all paid users " +
      "of Codex and ChatGPT Work.<hr><div class=\"rsshub-quote\">" +
      "I’m feeling like a limit reset.</div>",
    datePublished: "2026-07-28T03:09:23.000Z",
    extra: {
      links: [{
        url: "https://x.com/thsottiaux/status/2081899343091843463",
        type: "quote",
        content_html:
          "<div class=\"rsshub-quote\">I’m feeling like a limit reset.</div>",
      }],
    },
  });
  const firstSeenAt = new Date("2026-07-28T03:15:00.000Z");
  await new RsshubXProvider({
    config: {
      ...runConfig.providers.rsshub_x_timeline,
      base_url: "https://rss.example.test",
    },
    fetchFn: async () => response(feed([announcement, completion])),
    now: () => firstSeenAt,
  }).collect(store);
  await processRecords(store, runConfig, {
    now: new Date("2026-07-28T03:16:00.000Z"),
  });

  const signals = await store.all("normalized_signal", { latestOnly: false });
  assert.deepEqual(
    selectCurrentSignals(latestSignalsAsOf(
      signals,
      "2026-07-28T03:14:59.999Z",
    )),
    [],
  );
  const visible = selectCurrentSignals(latestSignalsAsOf(
    signals,
    "2026-07-28T03:16:00.000Z",
  ));
  assert.equal(visible.length, 2);
  assert.equal(
    visible.find((signal) => signal.data.claim.phase === "scheduled")
      .data.claim.event_type,
    "quota_reset",
  );
  const outcomes = await store.all("reset_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].data.status, "confirmed");
  assert.equal(outcomes[0].data.known_at, "2026-07-28T03:16:00.000Z");
  assert.deepEqual(await store.readState("coverage", { providers: {} }), {
    providers: {},
  });
});

test("an authority timeline repost cannot become an authority reset outcome", async (t) => {
  const store = await temporaryStore(t, "reset-rsshub-x-repost-outcome-");
  const runConfig = await loadConfig({ overrides: {
    outcome_definition: {
      version: "authority-announced-platform-reset/2",
      event_semantics: "qualifying_authority_completion_statement",
      authority_identity_ids: ["person_tibo_sottiaux"],
      scope_policy: "explicit-platform-or-authority-general-codex/1",
      negative_label_policy: "authoritative_daily_ledger_absence",
    },
  } });
  const repost = post({
    id: "2082070624604996043",
    title: "RT @someone: Codex usage limits have been reset for all paid users.",
    contentHtml:
      "RT @someone: Codex usage limits have been reset for all paid users.",
    datePublished: "2026-07-28T03:09:23.000Z",
    extra: {
      links: [{
        url: "https://x.com/someone/status/2081940052154933696",
        type: "repost",
      }],
    },
  });
  await new RsshubXProvider({
    config: {
      ...runConfig.providers.rsshub_x_timeline,
      base_url: "https://rss.example.test",
    },
    fetchFn: async () => response(feed([repost])),
    now: () => new Date("2026-07-28T11:55:00.000Z"),
  }).collect(store);
  await processRecords(store, runConfig, {
    now: new Date("2026-07-28T11:56:00.000Z"),
  });

  const [signal] = selectCurrentSignals(
    await store.all("normalized_signal", { latestOnly: false }),
  );
  assert.equal(signal.data.claim.phase, "completed");
  assert.equal(signal.data.provenance.derivation, "repost");
  assert.equal(
    signal.data.provenance.root_evidence_id,
    "x_post:2081940052154933696",
  );
  assert.deepEqual(await store.all("reset_outcome"), []);
});

test("RSSHub feed URL rejects unsafe origins and unbounded counts", () => {
  assert.equal(
    rsshubXFeedUrl("https://rss.dreaife.tokyo/", "thsottiaux", { count: 100 })
      .toString(),
    "https://rss.dreaife.tokyo/twitter/user/thsottiaux/" +
      "includeReplies=true&includeRts=1&showSymbolForRetweetAndReply=1&count=100?format=json",
  );
  assert.throws(
    () => rsshubXFeedUrl("http://127.0.0.1:1200", "thsottiaux"),
    /HTTPS origin/,
  );
  assert.throws(
    () => rsshubXFeedUrl("https://user:secret@example.test", "thsottiaux"),
    /without credentials/,
  );
  assert.throws(
    () => rsshubXFeedUrl("https://rss.example.test", "thsottiaux", { count: 101 }),
    /between 1 and 100/,
  );
  assert.throws(
    () => rsshubXFeedUrl(
      "https://rss.example.test",
      "thsottiaux",
      { includeReplies: false },
    ),
    /must include replies/,
  );
  assert.throws(
    () => new RsshubXProvider({
      config: providerConfig({ provider_name: "x" }),
    }),
    /provider_name must be rsshub_x_timeline/,
  );
});
