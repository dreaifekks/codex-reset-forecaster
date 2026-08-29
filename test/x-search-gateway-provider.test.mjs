import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { confirmationIdentityIds } from "../src/core/sources.mjs";
import { featureVectorAt } from "../src/model/features.mjs";
import { processRecords } from "../src/pipeline/run.mjs";
import { selectCurrentSignals } from "../src/pipeline/signal-selection.mjs";
import { XSearchGatewayProvider } from "../src/providers/x-search-gateway-provider.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

function gatewayResponse(provider) {
  return new Response(JSON.stringify({
    ok: true,
    provider,
    events: [],
    all_events: [{
      id: "2075657265508647008",
      event_id: "https://x.com/thsottiaux/status/2075657265508647008",
      author: "Tibo Sottiaux",
      handle: "thsottiaux",
      text: "We have reset usage limits across Codex and ChatGPT Work for all paid users.",
      url: "https://x.com/thsottiaux/status/2075657265508647008",
      created_at: "2026-07-10T19:03:50.000Z",
      lang: "en",
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function exhaustedGrokbuildResponse() {
  return new Response(JSON.stringify({
    ok: false,
    provider: "grokbuild",
    error: "grokbuild_usage_balance_exhausted",
    detail: "Grok Build usage balance exhausted",
    events: [],
  }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function setup(t, upstreamProvider, queries = [{
  name: "tibo",
  query: "from:thsottiaux Codex reset",
  handles: ["thsottiaux"],
}]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `reset-gateway-${upstreamProvider}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x_search_gateway: {
      enabled: true,
      upstream_provider: upstreamProvider,
      queries,
    } },
  } });
  return { directory, config, store: await new JsonlStore(directory).init() };
}

for (const upstreamProvider of ["grokbuild", "hermes"]) {
  test(`${upstreamProvider} gateway summaries are context-only, idempotent, and never establish outcomes or coverage`, async (t) => {
    const { config, store } = await setup(t, upstreamProvider);
    const requests = [];
    const fetchFn = async (_url, options) => {
      requests.push({
        authorization: options.headers.authorization,
        body: JSON.parse(options.body),
      });
      return gatewayResponse(upstreamProvider);
    };
    const now = new Date("2026-07-22T20:00:00Z");
    const provider = new XSearchGatewayProvider({
      config: config.providers.x_search_gateway,
      token: "test-gateway-token",
      fetchFn,
      now: () => now,
    });
    const first = await provider.collect(store);
    assert.equal(first.collected, 1);
    assert.equal(requests[0].authorization, "Bearer test-gateway-token");
    assert.equal(requests[0].body.provider, upstreamProvider);
    assert.equal(requests[0].body.include_seen, true);
    const processing = await processRecords(store, config, { now });
    assert.equal(processing.normalized.normalized, 1);
    assert.equal(processing.normalized.records[0].data.provenance.source_role, "aggregator");
    assert.equal(processing.outcomes.adjudicated, 0);
    const vector = featureVectorAt({
      targetTime: new Date("2026-07-22T21:00:00Z"),
      knowledgeCutoff: now,
      signals: await store.all("normalized_signal"),
      outcomes: await store.all("reset_outcome"),
      observations: await store.all("raw_observation"),
      confirmationIdentityIds: confirmationIdentityIds(config),
    });
    assert.equal(
      vector.features.official_reset_activity_decay,
      0,
      "summary must not receive original-author authority",
    );
    assert.ok(vector.features.independent_support_decay > 0, "summary may remain a context feature");
    const raw = await store.all("raw_observation");
    const summary = raw.find((record) => record.data.provider_item_id.includes("2075657265508647008"));
    assert.equal(summary.data.content.media_type, "application/vnd.x-search-summary+text");
    assert.equal(summary.data.published_at, "2026-07-10T19:03:50.601Z");
    assert.deepEqual(await store.readState("coverage", { providers: {} }), { providers: {} });
    assert.equal((await provider.collect(store)).collected, 0);
    assert.equal((await store.all("raw_observation")).length, 2, "event plus idempotent health record");
  });
}

test("gateway starts configured queries concurrently and preserves payload order", async (t) => {
  const queries = [
    { name: "slow_first", query: "Codex first" },
    { name: "second", query: "Codex second" },
    { name: "fast_last", query: "Codex last" },
  ];
  const ids = [
    "2081450000000000101",
    "2081450000000000102",
    "2081450000000000103",
  ];
  const { config, store } = await setup(t, "grokbuild", queries);
  const gates = new Map(queries.map((query) => [query.name, deferred()]));
  const started = [];
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    now: () => new Date("2026-07-29T10:00:00.000Z"),
  });
  provider.search = async (query) => {
    started.push(query.name);
    if (started.length === 1) markFirstStarted();
    return gates.get(query.name).promise;
  };

  const collecting = provider.collect(store);
  await firstStarted;
  const startedBeforeAnyResponse = [...started];
  for (let index = queries.length - 1; index >= 0; index -= 1) {
    gates.get(queries[index].name).resolve({
      ok: true,
      provider: "grokbuild",
      events: [],
      all_events: [{
        id: ids[index],
        handle: "example",
        text: queries[index].name,
        url: `https://x.com/example/status/${ids[index]}`,
      }],
    });
  }

  const result = await collecting;
  assert.deepEqual(
    startedBeforeAnyResponse,
    queries.map((query) => query.name),
    "every query should start before the slowest query completes",
  );
  assert.equal(result.queries, queries.length);
  assert.deepEqual(result.query_errors, []);
  assert.deepEqual(
    (await store.all("raw_observation"))
      .filter((record) =>
        record.data.content.media_type !==
        "application/vnd.reset-provider-health+json"
      )
      .map((record) => record.data.provider_item_id),
    ids,
    "out-of-order query completion must not reorder configured results",
  );
});

test("gateway preserves configured error order while collecting partial successes", async (t) => {
  const queries = [
    { name: "first_failure", query: "Codex first failure" },
    { name: "success", query: "Codex success" },
    { name: "last_failure", query: "Codex last failure" },
  ];
  const { config, store } = await setup(t, "grokbuild", queries);
  const gates = new Map(queries.map((query) => [query.name, deferred()]));
  let collectedAt = new Date("2026-07-29T10:00:00.000Z");
  let started = 0;
  let markAllStarted;
  const allStarted = new Promise((resolve) => {
    markAllStarted = resolve;
  });
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    now: () => collectedAt,
  });
  provider.search = async (query) => {
    started += 1;
    if (started === queries.length) markAllStarted();
    return gates.get(query.name).promise;
  };

  const collecting = provider.collect(store);
  await allStarted;
  gates.get("last_failure").reject(new Error("last failed first"));
  gates.get("success").resolve({
    ok: true,
    provider: "grokbuild",
    events: [],
    all_events: [{
      id: "2081450000000000200",
      handle: "example",
      text: "A successful query result.",
      url: "https://x.com/example/status/2081450000000000200",
    }],
  });
  gates.get("first_failure").reject(new Error("first failed last"));

  const result = await collecting;
  assert.equal(result.collected, 1);
  assert.equal(result.queries, 1);
  assert.deepEqual(result.query_errors, [
    { query: "first_failure", error: "first failed last" },
    { query: "last_failure", error: "last failed first" },
  ]);
  assert.deepEqual(result.health, {
    ok: false,
    delay_seconds: 0,
    error: "2 gateway query(s) failed",
  });
  const partialState = await store.readState("x-search-gateway-provider", {});
  assert.deepEqual(partialState.query_errors, result.query_errors);
  assert.equal(
    partialState.last_success_at,
    null,
    "a partial query set must not advance the full-success refresh gate",
  );

  collectedAt = new Date("2026-07-29T10:10:00.000Z");
  let retryCount = 0;
  provider.search = async (query) => {
    retryCount += 1;
    return {
      ok: true,
      provider: "grokbuild",
      events: [],
      all_events: [{
        id: `20814500000000003${retryCount}`,
        handle: "example",
        text: `Recovered ${query.name}`,
        url: `https://x.com/example/status/20814500000000003${retryCount}`,
      }],
    };
  };
  const retry = await provider.collect(store);
  assert.equal(retryCount, queries.length);
  assert.equal(retry.health.ok, true);
  assert.equal(
    (await store.readState("x-search-gateway-provider", {})).last_success_at,
    collectedAt.toISOString(),
  );
});

test("exhausted Grokbuild quota opens a persistent optional-query cooldown", async (t) => {
  const queries = [
    { name: "tibo", query: "from:thsottiaux Codex reset" },
    { name: "community", query: "Codex broken" },
    { name: "competition", query: "Claude released" },
  ];
  const { config, store } = await setup(t, "grokbuild", queries);
  let collectedAt = new Date("2026-08-29T06:20:00.000Z");
  let requestCount = 0;
  let exhausted = true;
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => {
      requestCount += 1;
      return exhausted
        ? exhaustedGrokbuildResponse()
        : gatewayResponse("grokbuild");
    },
    now: () => collectedAt,
  });

  const first = await provider.collect(store);
  assert.equal(requestCount, queries.length);
  assert.equal(first.fetched, true);
  assert.equal(first.collected, 0);
  assert.equal(first.skipped, "upstream_quota_exhausted");
  assert.deepEqual(first.skipped_queries, queries.map((query) => query.name));
  assert.equal(first.next_fetch_at, "2026-08-29T12:20:00.000Z");
  assert.deepEqual(first.health, {
    ok: true,
    delay_seconds: 0,
    error: null,
    skipped: "upstream_quota_exhausted",
  });
  const exhaustedState = await store.readState("x-search-gateway-provider", {});
  assert.equal(exhaustedState.last_error, null);
  assert.equal(exhaustedState.last_success_at, null);
  assert.equal(exhaustedState.last_partial_at, null);
  assert.equal(exhaustedState.last_failure_at, null);
  assert.equal(exhaustedState.quota_retry_at, first.next_fetch_at);

  collectedAt = new Date("2026-08-29T06:30:00.000Z");
  const skipped = await provider.collect(store);
  assert.equal(requestCount, queries.length, "cooldown must make no gateway requests");
  assert.equal(skipped.fetched, false);
  assert.equal(skipped.skipped, "upstream_quota_exhausted");
  assert.equal(skipped.next_fetch_at, first.next_fetch_at);

  exhausted = false;
  collectedAt = new Date("2026-08-29T12:20:00.000Z");
  const recovered = await provider.collect(store);
  assert.equal(requestCount, queries.length * 2);
  assert.equal(recovered.skipped, undefined);
  assert.equal(recovered.health.ok, true);
  const recoveredState = await store.readState("x-search-gateway-provider", {});
  assert.equal(recoveredState.last_success_at, collectedAt.toISOString());
  assert.equal(recoveredState.quota_exhausted_at, null);
  assert.equal(recoveredState.quota_retry_at, null);
  assert.deepEqual(recoveredState.skipped_queries, []);
});

test("gateway topic screening preserves raw false positives but excludes them from current signals", async (t) => {
  const { config, store } = await setup(t, "grokbuild");
  const now = new Date("2026-07-27T01:30:00.000Z");
  const events = [
    {
      id: "2081364048994521589",
      handle: "example",
      text: "__RATE_LIMIT__: Gemini monthly cap exceeded. HTTP 429: You exceeded your current quota.",
      url: "https://x.com/example/status/2081364048994521589",
    },
    {
      id: "2081364116149584155",
      handle: "example",
      text: "Grok isn’t so sure. The capacity to define objectives remains a locus of control and technology will force society to confront it.",
      url: "https://x.com/example/status/2081364116149584155",
    },
    {
      id: "2081446159361675631",
      handle: "thsottiaux",
      text: "Trying, but not sure this time (possible reset hint; does not explicitly state Codex usage-limit reset).",
      url: "https://x.com/thsottiaux/status/2081446159361675631",
    },
    {
      id: "2081450000000000000",
      handle: "thsottiaux",
      text: "We have reset Codex usage limits across all paid plans.",
      url: "https://x.com/thsottiaux/status/2081450000000000000",
    },
  ];
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => new Response(JSON.stringify({
      ok: true,
      provider: "grokbuild",
      events: [],
      all_events: events,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    now: () => now,
  });

  assert.equal((await provider.collect(store)).collected, events.length);
  const processing = await processRecords(store, config, { now });
  assert.equal(processing.normalized.records.length, events.length);
  const signals = await store.all("normalized_signal");
  const current = selectCurrentSignals(signals);
  assert.equal(current.length, 1);
  assert.match(
    current[0].data.provenance.canonical_source_url,
    /2081450000000000000$/,
  );
  const excluded = signals.filter((signal) =>
    signal.data.extraction.relevance.decision !== "relevant"
  );
  assert.equal(excluded.length, 3);
  assert.ok(excluded.every((signal) =>
    signal.data.provenance.feature_eligible === false
  ));
  const rawIds = new Set((await store.all("raw_observation"))
    .map((record) => record.data.provider_item_id));
  assert.ok(events.every((event) => rawIds.has(event.id)));
});

test("gateway summaries derive a stable publication timestamp from the X status id", async (t) => {
  const { config, store } = await setup(t, "grokbuild");
  let collectedAt = new Date("2026-07-22T20:00:00Z");
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => {
      const response = await gatewayResponse("grokbuild").json();
      delete response.all_events[0].created_at;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    now: () => collectedAt,
  });

  assert.equal((await provider.collect(store)).collected, 1);
  const first = (await store.all("raw_observation"))
    .find((record) => record.data.provider_item_id === "2075657265508647008");
  assert.equal(first.data.published_at, "2026-07-10T19:03:50.601Z");
  assert.equal(first.data.first_seen_at, "2026-07-22T20:00:00.000Z");

  collectedAt = new Date("2026-07-22T21:00:00Z");
  assert.equal((await provider.collect(store)).collected, 0);
  const current = (await store.all("raw_observation"))
    .find((record) => record.data.provider_item_id === "2075657265508647008");
  assert.equal(current.revision, 1);
  assert.equal(current.data.published_at, first.data.published_at);
});

test("gateway replays seen results only while bootstrapping local provider state", async (t) => {
  const { config, store } = await setup(t, "grokbuild");
  let collectedAt = new Date("2026-07-22T20:00:00Z");
  let summaryText = "Initial search summary about a Codex reset.";
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => {
      const payload = await gatewayResponse("grokbuild").json();
      payload.all_events[0].text = summaryText;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    now: () => collectedAt,
  });

  const bootstrap = await provider.collect(store);
  assert.equal(bootstrap.bootstrap_replay, true);
  assert.equal(bootstrap.collected, 1);

  summaryText = "The same seen status with a newly worded search summary.";
  collectedAt = new Date("2026-07-22T21:00:00Z");
  const incremental = await provider.collect(store);
  assert.equal(incremental.bootstrap_replay, false);
  assert.equal(incremental.collected, 0);
  const statusRecords = (await store.all("raw_observation", { latestOnly: false }))
    .filter((record) => record.data.provider_item_id === "2075657265508647008");
  assert.equal(statusRecords.length, 1);
  assert.equal(statusRecords[0].revision, 1);
  assert.equal(statusRecords[0].data.content.text, "Initial search summary about a Codex reset.");
});

test("an exact-text SocialData gateway result may confirm Tibo but still cannot assert coverage", async (t) => {
  const { config, store } = await setup(t, "socialdata");
  const now = new Date("2026-07-22T20:00:00Z");
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => gatewayResponse("socialdata"),
    now: () => now,
  });
  await provider.collect(store);
  const processing = await processRecords(store, config, { now });
  assert.equal(processing.outcomes.adjudicated, 1);
  const outcome = (await store.all("reset_outcome"))[0];
  assert.equal(outcome.data.label_grade, "gold");
  assert.deepEqual(await store.readState("coverage", { providers: {} }), { providers: {} });
});

test("gateway failure diagnostics never become reset signals", async (t) => {
  const { config, store } = await setup(t, "grokbuild");
  const now = new Date("2026-07-26T08:07:30.000Z");
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => new Response(JSON.stringify({
      ok: false,
      error: "usage limit reset search is temporarily unavailable",
    }), {
      status: 502,
      headers: { "content-type": "application/json" },
    }),
    now: () => now,
  });

  await assert.rejects(
    provider.collect(store),
    /All X Search Gateway queries failed/,
  );
  const observations = await store.all("raw_observation");
  assert.equal(observations.length, 1);
  assert.equal(
    observations[0].data.content.media_type,
    "application/vnd.reset-provider-health+json",
  );
  assert.deepEqual(
    (await store.readState("x-search-gateway-provider", {})).query_errors,
    [{
      query: "tibo",
      error: "X Search Gateway 502: usage limit reset search is temporarily unavailable",
    }],
  );
  const processing = await processRecords(store, config, { now });
  assert.equal(processing.normalized.normalized, 0);
  assert.deepEqual(await store.all("normalized_signal"), []);
  assert.deepEqual(await store.all("reset_outcome"), []);
});

test("gateway responses fail closed when the returned provider differs", async (t) => {
  const { config } = await setup(t, "grokbuild");
  const provider = new XSearchGatewayProvider({
    config: config.providers.x_search_gateway,
    token: "test-gateway-token",
    fetchFn: async () => gatewayResponse("hermes"),
  });

  await assert.rejects(
    provider.search({
      name: "tibo",
      query: "from:thsottiaux Codex reset",
      handles: ["thsottiaux"],
    }),
    /provider mismatch: requested grokbuild/,
  );
});
