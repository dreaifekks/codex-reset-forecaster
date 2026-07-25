import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { confirmationIdentityIds } from "../src/core/sources.mjs";
import { featureVectorAt } from "../src/model/features.mjs";
import { processRecords } from "../src/pipeline/run.mjs";
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

async function setup(t, upstreamProvider) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `reset-gateway-${upstreamProvider}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { x_search_gateway: {
      enabled: true,
      upstream_provider: upstreamProvider,
      queries: [{
        name: "tibo",
        query: "from:thsottiaux Codex reset",
        handles: ["thsottiaux"],
      }],
    } },
  } });
  return { directory, config, store: await new JsonlStore(directory).init() };
}

test("Hermes gateway summaries are context-only, idempotent, and never establish outcomes or coverage", async (t) => {
  const { config, store } = await setup(t, "hermes");
  const requests = [];
  const fetchFn = async (_url, options) => {
    requests.push({
      authorization: options.headers.authorization,
      body: JSON.parse(options.body),
    });
    return gatewayResponse("hermes");
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
  assert.equal(requests[0].body.provider, "hermes");
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
  assert.deepEqual(await store.readState("coverage", { providers: {} }), { providers: {} });
  assert.equal((await provider.collect(store)).collected, 0);
  assert.equal((await store.all("raw_observation")).length, 2, "event plus idempotent health record");
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
