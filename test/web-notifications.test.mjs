import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicationLedger, PUBLICATION_EVENT_SCHEMA_VERSION } from "../src/notifications/ledger.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { createRequestHandler } from "../src/web/app.mjs";

function publicationId(value) {
  return `pub_${createHash("sha256").update(value).digest("hex")}`;
}

const POLICY = {
  version: "publication-policy/1",
  hash: `sha256:${"a".repeat(64)}`,
};

test("notification API, Atom feeds, manifest, and Web Push routes share one ledger", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-notifications-web-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new JsonlStore(directory).init();
  const ledger = createPublicationLedger(store);
  await ledger.append({
    schema_version: PUBLICATION_EVENT_SCHEMA_VERSION,
    event_id: publicationId("event-authority-1"),
    event_type: "forecast.authority_window.opened.v1",
    entity_key: "authority_signal:signal-1@1",
    topic: "authority",
    emitted_at: "2026-08-10T00:00:00.000Z",
    expires_at: "2026-08-11T00:00:00.000Z",
    experimental: false,
    supersedes_event_id: null,
    policy: POLICY,
    source: {
      prediction_ref: { record_id: "prediction-1", revision: 1 },
      signal_ref: { record_id: "signal-1", revision: 1 },
    },
    title: "权威 <时间窗>",
    summary: "可能到来 & 尚未确认",
    url: "https://reset.example/",
    report: { default_delivery: true },
    notification: {
      title: "权威 <时间窗>",
      body: "可能到来 & 尚未确认",
      url: "https://reset.example/",
      tag: "authority-1",
    },
  });
  await ledger.append({
    schema_version: PUBLICATION_EVENT_SCHEMA_VERSION,
    event_id: publicationId("event-experimental-1"),
    event_type: "forecast.reset_watch.opened.v1",
    entity_key: "forecast_watch:one",
    topic: "experimental_probability",
    emitted_at: "2026-08-10T00:10:00.000Z",
    expires_at: "2026-08-10T00:55:00.000Z",
    experimental: true,
    supersedes_event_id: null,
    policy: POLICY,
    source: {
      prediction_ref: { record_id: "prediction-1", revision: 1 },
    },
    title: "实验概率",
    summary: "50%",
    url: "https://reset.example/",
    report: { default_delivery: false },
    notification: {
      title: "实验概率",
      body: "50%",
      url: "https://reset.example/",
      tag: "experimental-1",
    },
  });
  const calls = [];
  const probabilityInputs = [
    {
      schema_version: "notification-forecast-input/2",
      sequence: 1,
      input_id: `forecast_input_${"1".padStart(64, "0")}`,
      prediction_ref: { record_id: "prediction-1", revision: 1 },
      prediction_hash: `sha256:${"1".padStart(64, "0")}`,
      issued_at: "2026-08-10T00:00:00.000Z",
      emitted_at: "2026-08-10T00:01:00.000Z",
      knowledge_cutoff: "2026-08-10T00:00:00.000Z",
      expires_at: "2026-08-10T00:45:00.000Z",
      serving_stage: "validated",
      probabilities: Array.from({ length: 168 }, () => 0.4),
      outcome_revision_gate: {
        revision_token: null,
        latest_known_at: null,
        closes_episode: false,
        current_outcomes: [],
      },
    },
    {
      schema_version: "notification-forecast-input/2",
      sequence: 2,
      input_id: `forecast_input_${"2".padStart(64, "0")}`,
      prediction_ref: { record_id: "prediction-2", revision: 1 },
      prediction_hash: `sha256:${"2".padStart(64, "0")}`,
      issued_at: "2026-08-10T00:10:00.000Z",
      emitted_at: "2026-08-10T00:11:00.000Z",
      knowledge_cutoff: "2026-08-10T00:10:00.000Z",
      expires_at: "2026-08-10T00:55:00.000Z",
      serving_stage: "validated",
      probabilities: Array.from({ length: 168 }, () => 0.7),
      outcome_revision_gate: {
        revision_token: null,
        latest_known_at: null,
        closes_episode: false,
        current_outcomes: [],
      },
    },
  ];
  const webPushService = {
    getPublicConfig: () => ({
      enabled: true,
      application_server_key: "public-key",
      default_topics: ["authority", "outcome"],
      optional_topics: ["experimental_probability"],
    }),
    async subscribe(payload, context) {
      calls.push({ method: "subscribe", payload, context });
      return { subscription_id: "one" };
    },
    async unsubscribe(payload, context) {
      calls.push({ method: "unsubscribe", payload, context });
      return { removed: true };
    },
  };
  const outcomeRevisionGate = {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
  };
  const forecastInputStream = {
    all: async () => probabilityInputs,
    async tail() {
      return {
        cursor: 2,
        input: probabilityInputs.at(-1),
        outcome_revision_gate: outcomeRevisionGate,
      };
    },
    async currentOutcomeRevisionGate() {
      return outcomeRevisionGate;
    },
    async listAfter(after, { limit }) {
      if (after > 2) {
        const error = new RangeError("ahead");
        error.code = "forecast_input_cursor_reset_required";
        error.reason = "ahead_of_tail";
        error.cursor = 2;
        throw error;
      }
      const remaining = probabilityInputs.filter((input) => input.sequence > after);
      const inputs = remaining.slice(0, limit);
      const cursor = inputs.at(-1)?.sequence ?? after;
      return {
        inputs,
        cursor,
        next_cursor: String(cursor),
        has_more: remaining.length > inputs.length,
        outcome_revision_gate: outcomeRevisionGate,
      };
    },
  };
  const handler = createRequestHandler({
    store,
    config: {
      runtime: { public_base_url: "https://reset.example" },
    },
    publicationLedger: ledger,
    forecastInputStream,
    webPushService,
    now: () => new Date("2026-08-10T00:20:00.000Z"),
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const eventsResponse = await fetch(`${base}/api/notifications/events?after=0&limit=1`);
  const events = await eventsResponse.json();
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].event_id, publicationId("event-authority-1"));
  assert.equal(events.next_cursor, "1");
  assert.equal(events.has_more, true);

  const baseline = await (await fetch(`${base}/api/notifications/events`)).json();
  assert.deepEqual(baseline, {
    events: [],
    cursor: 2,
    next_cursor: "2",
    has_more: false,
  });
  assert.equal(
    (await fetch(`${base}/api/notifications/events?after=`)).status,
    400,
  );

  const forecastBaseline = await (
    await fetch(`${base}/api/notifications/forecast-inputs`)
  ).json();
  assert.deepEqual(forecastBaseline, {
    inputs: [],
    cursor: 2,
    next_cursor: "2",
    has_more: false,
    outcome_revision_gate: outcomeRevisionGate,
  });
  const forecastPage = await (
    await fetch(`${base}/api/notifications/forecast-inputs?after=0&limit=1`)
  ).json();
  assert.deepEqual(forecastPage.inputs.map((input) => input.sequence), [1]);
  assert.equal(forecastPage.cursor, 1);
  assert.equal(forecastPage.has_more, true);
  const projectedForecastPage = await (
    await fetch(
      `${base}/api/notifications/forecast-inputs?after=0&limit=1&horizon_hours=24&horizon_hours=4`,
    )
  ).json();
  assert.deepEqual(projectedForecastPage.horizon_hours, [4, 24]);
  assert.equal(
    projectedForecastPage.inputs[0].schema_version,
    "notification-forecast-input-view/1",
  );
  assert.equal(
    projectedForecastPage.inputs[0].source_schema_version,
    "notification-forecast-input/2",
  );
  assert.equal(
    Object.hasOwn(projectedForecastPage.inputs[0], "probabilities"),
    false,
  );
  assert.deepEqual(projectedForecastPage.inputs[0].horizon_probabilities, [
    { horizon_hours: 4, probability: 0.4 },
    { horizon_hours: 24, probability: 0.4 },
  ]);
  const projectedBaseline = await (
    await fetch(
      `${base}/api/notifications/forecast-inputs?horizon_hours=24&horizon_hours=4`,
    )
  ).json();
  assert.deepEqual(projectedBaseline.horizon_hours, [4, 24]);
  assert.deepEqual(projectedBaseline.inputs, []);
  assert.equal(
    (await fetch(
      `${base}/api/notifications/forecast-inputs?after=0&after=1`,
    )).status,
    400,
  );
  assert.equal(
    (await fetch(
      `${base}/api/notifications/forecast-inputs?after=0&limit=1e2`,
    )).status,
    400,
  );
  assert.equal(
    (await fetch(
      `${base}/api/notifications/forecast-inputs?after=0&horizon_hours=24&horizon_hours=24`,
    )).status,
    400,
  );
  assert.equal(
    (await fetch(
      `${base}/api/notifications/forecast-inputs?after=0&horizon_hours=169`,
    )).status,
    400,
  );
  const forecastReset = await fetch(
    `${base}/api/notifications/forecast-inputs?after=99`,
  );
  assert.equal(forecastReset.status, 409);
  assert.equal((await forecastReset.json()).reason, "ahead_of_tail");
  const feedBaseline = await (
    await fetch(`${base}/api/notification-preferences/baseline`)
  ).json();
  assert.deepEqual(feedBaseline, {
    schema_version: "notification-feed-baseline/1",
    cursor: 2,
    next_cursor: "2",
  });

  const feedResponse = await fetch(`${base}/feed.xml`);
  assert.match(feedResponse.headers.get("content-type"), /application\/atom\+xml/);
  const feed = await feedResponse.text();
  assert.match(feed, /权威 &lt;时间窗&gt;/);
  assert.doesNotMatch(feed, /实验概率/);
  const experimentalFeed = await (await fetch(`${base}/feeds/experimental.xml`)).text();
  assert.match(experimentalFeed, /实验概率/);
  const probabilityFeedResponse = await fetch(
    `${base}/feeds/probability.xml?horizon_hours=24&probability_threshold=0.6&after=0`,
  );
  assert.equal(probabilityFeedResponse.status, 200);
  const probabilityFeed = await probabilityFeedResponse.text();
  assert.match(
    probabilityFeed,
    /horizon_hours=24&amp;probability_threshold=0.6&amp;after=0/,
  );
  assert.match(probabilityFeed, /70.0%/);
  assert.equal(
    (await fetch(
      `${base}/feeds/probability.xml?horizon_hours=24&probability_threshold=0.6`,
    )).status,
    400,
  );
  assert.equal(
    (await fetch(
      `${base}/feeds/probability.xml?horizon_hours=24&probability_threshold=0.6&after=0&after=1`,
    )).status,
    400,
  );
  const resetFeed = await fetch(
    `${base}/feeds/probability.xml?horizon_hours=24&probability_threshold=0.6&after=99`,
  );
  assert.equal(resetFeed.status, 200);
  assert.match(await resetFeed.text(), /基线已超出保留范围/);
  assert.equal(
    (await fetch(
      `${base}/feeds/probability.xml?horizon_hours=24&probability_threshold=1e-1&after=0`,
    )).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/notification-preferences/calibration`)).status,
    400,
  );
  assert.equal(
    (await fetch(
      `${base}/api/notification-preferences/calibration?horizon_hours=4&horizon_hours=24`,
    )).status,
    400,
  );

  const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
  assert.match(manifestResponse.headers.get("content-type"), /application\/manifest\+json/);

  const publicConfig = await (await fetch(`${base}/api/web-push/config`)).json();
  assert.equal(publicConfig.application_server_key, "public-key");
  const subscription = { endpoint: "https://push.example/one", keys: {} };
  const subscribed = await fetch(`${base}/api/web-push/subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://reset.example",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(subscription),
  });
  assert.equal(subscribed.status, 201);
  assert.deepEqual(calls[0], {
    method: "subscribe",
    payload: subscription,
    context: { origin: "https://reset.example" },
  });
  const blocked = await fetch(`${base}/api/web-push/subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify(subscription),
  });
  assert.equal(blocked.status, 403);
});
