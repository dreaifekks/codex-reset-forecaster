import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWebPushConfig,
  normalizeWebPushConfig,
} from "../src/web-push/config.mjs";
import { createWebPushService } from "../src/web-push/service.mjs";

const ORIGIN = "https://forecast.example";
const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)])
  .toString("base64url");
const AUTH = Buffer.alloc(16, 9).toString("base64url");

function config(overrides = {}) {
  return normalizeWebPushConfig({
    enabled: true,
    siteOrigin: ORIGIN,
    publicKey: "test-public-key",
    privateKey: "test-private-key",
    subject: "mailto:ops@example.com",
    allowedEndpointHosts: ["push.example"],
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
    ...overrides,
  });
}

function subscription(index = 1, topics = undefined, preferences = undefined) {
  return {
    endpoint: `https://push.example/subscription/${index}`,
    keys: { p256dh: P256DH, auth: AUTH },
    ...(topics ? { topics } : {}),
    ...(preferences !== undefined ? { preferences } : {}),
  };
}

function preferences(overrides = {}) {
  return {
    schema_version: "notification-preferences/1",
    horizon_hours: 4,
    probability_threshold: 0.5,
    ...overrides,
  };
}

function forecastGate(overrides = {}) {
  return {
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
    ...overrides,
  };
}

function memoryStateAdapter({ writeDelayMs = 0 } = {}) {
  let value = null;
  let writes = 0;
  return {
    async read() {
      return structuredClone(value);
    },
    async write(next) {
      if (writeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
      }
      value = structuredClone(next);
      writes += 1;
    },
    snapshot() {
      return structuredClone(value);
    },
    get writes() {
      return writes;
    },
  };
}

function ledger({ cursor = 0, events = [] } = {}) {
  return {
    current: cursor,
    events,
    async getCursor() {
      return this.current;
    },
    async listAfter(after, { limit, topics }) {
      const available = this.events
        .filter((event) => event.sequence > after && topics.includes(event.topic))
        .slice(0, limit);
      return {
        events: available,
        cursor: available.at(-1)?.sequence ?? this.current,
        has_more: false,
      };
    },
  };
}

function forecastInput(sequence, selectedProbability, {
  issuedAt = new Date(
    Date.parse("2026-08-10T03:40:00.000Z") + sequence * 60_000,
  ).toISOString(),
  emittedAt = new Date(Date.parse(issuedAt) + 30_000).toISOString(),
  expiresAt = "2026-08-10T04:05:00.000Z",
  outcomeGate = forecastGate(),
} = {}) {
  return {
    sequence,
    prediction_ref: { record_id: `prediction-${sequence}`, revision: 1 },
    issued_at: issuedAt,
    emitted_at: emittedAt,
    knowledge_cutoff: issuedAt,
    expires_at: expiresAt,
    probabilities: Array.from({ length: 168 }, () => selectedProbability),
    outcome_revision_gate: structuredClone(outcomeGate),
  };
}

function forecastStream({ inputs = [], outcomeGate = forecastGate() } = {}) {
  return {
    inputs,
    outcomeGate,
    resetNext: false,
    async tail() {
      const input = this.inputs.at(-1) ?? null;
      return {
        cursor: input?.sequence ?? 0,
        input: structuredClone(input),
        outcome_revision_gate: structuredClone(this.outcomeGate),
      };
    },
    async listAfter(after, { limit }) {
      if (this.resetNext) {
        this.resetNext = false;
        const error = new RangeError("forecast input cursor reset required");
        error.code = "forecast_input_cursor_reset_required";
        throw error;
      }
      const remaining = this.inputs.filter((input) => input.sequence > after);
      const page = remaining.slice(0, limit);
      return {
        inputs: structuredClone(page),
        cursor: page.at(-1)?.sequence ?? after,
        has_more: remaining.length > page.length,
        outcome_revision_gate: structuredClone(this.outcomeGate),
      };
    },
  };
}

function service({
  appConfig = config(),
  adapter = memoryStateAdapter(),
  publications = ledger(),
  forecasts = null,
  sendNotification = async () => {},
  clock = () => new Date("2026-08-10T04:00:00.000Z"),
  logger = { error() {} },
} = {}) {
  return {
    adapter,
    publications,
    webPush: createWebPushService({
      config: appConfig,
      stateAdapter: adapter,
      publicationLedger: publications,
      forecastInputStream: forecasts,
      sendNotification,
      clock,
      logger,
    }),
  };
}

test("runtime web push config reads the key file and lets the environment override its subject", async () => {
  const loaded = await loadWebPushConfig({
    runtime: {
      public_base_url: ORIGIN,
      web_push: {
        enabled: true,
        vapid_keys_file: "/run/secrets/web-push.json",
        vapid_subject: "mailto:config@example.com",
        dispatch_interval_seconds: 17,
        max_subscriptions: 42,
      },
    },
  }, {
    environment: { WEB_PUSH_VAPID_SUBJECT: "mailto:env@example.com" },
    async stat(path) {
      assert.equal(path, "/run/secrets/web-push.json");
      return { isFile: () => true, mode: 0o100600 };
    },
    async readFile(path) {
      assert.equal(path, "/run/secrets/web-push.json");
      return JSON.stringify({
        subject: "mailto:file@example.com",
        public_key: "public-from-file",
        private_key: "private-from-file",
      });
    },
  });
  assert.equal(loaded.siteOrigin, ORIGIN);
  assert.equal(loaded.subject, "mailto:env@example.com");
  assert.equal(loaded.publicKey, "public-from-file");
  assert.equal(loaded.privateKey, "private-from-file");
  assert.equal(loaded.dispatchIntervalMs, 17_000);
  assert.equal(loaded.maxSubscriptions, 42);
});

test("runtime web push config rejects inline or overly broad VAPID secrets", async () => {
  await assert.rejects(
    loadWebPushConfig({
      enabled: true,
      site_origin: ORIGIN,
      subject: "mailto:ops@example.com",
      public_key: "inline-public",
      private_key: "inline-private",
    }),
    /must load its VAPID private key from keys_file/,
  );
  await assert.rejects(
    loadWebPushConfig({
      enabled: true,
      site_origin: ORIGIN,
      keys_file: "/run/secrets/web-push.json",
      subject: "mailto:ops@example.com",
    }, {
      environment: {},
      async stat() {
        return { isFile: () => true, mode: 0o100644 };
      },
      async readFile() {
        return JSON.stringify({
          public_key: "public-from-file",
          private_key: "private-from-file",
        });
      },
    }),
    /mode must be 0400 or 0600/,
  );
});

test("subscriptions baseline the current cursor, default safe topics, and serialize concurrent mutations", async () => {
  const adapter = memoryStateAdapter({ writeDelayMs: 5 });
  const publications = ledger({ cursor: 12 });
  const { webPush } = service({ adapter, publications });
  const [first, second] = await Promise.all([
    webPush.subscribe(subscription(1), { origin: ORIGIN }),
    webPush.subscribe(
      subscription(2, ["authority", "experimental_probability"]),
      { origin: ORIGIN },
    ),
  ]);
  assert.deepEqual(first.topics, ["authority", "outcome"]);
  assert.deepEqual(second.topics, ["authority", "experimental_probability"]);
  assert.deepEqual(first.preferences, preferences());
  assert.deepEqual(second.preferences, preferences());
  assert.equal(first.cursor, 12);
  assert.equal(second.cursor, 12);
  assert.equal(Object.keys(adapter.snapshot().subscriptions).length, 2);
  assert.equal(adapter.writes, 2);
});

test("subscriptions strictly persist and return personalized notification preferences", async () => {
  const adapter = memoryStateAdapter();
  const { webPush } = service({ adapter });
  const selected = preferences({
    horizon_hours: 168,
    probability_threshold: 0.725,
  });
  const saved = await webPush.subscribe(
    subscription(1, ["experimental_probability"], selected),
    { origin: ORIGIN },
  );
  assert.deepEqual(saved.preferences, selected);
  assert.deepEqual(
    Object.values(adapter.snapshot().subscriptions)[0].preferences,
    selected,
  );

  for (const invalid of [
    null,
    { ...selected, schema_version: "notification-preferences/2" },
    { ...selected, horizon_hours: 0 },
    { ...selected, horizon_hours: 169 },
    { ...selected, horizon_hours: 2.5 },
    { ...selected, probability_threshold: 0 },
    { ...selected, probability_threshold: -0.01 },
    { ...selected, probability_threshold: 1 },
    { ...selected, probability_threshold: 1.01 },
    { ...selected, probability_threshold: "0.5" },
    { ...selected, unknown: true },
  ]) {
    await assert.rejects(
      webPush.subscribe(
        subscription(2, ["experimental_probability"], invalid),
        { origin: ORIGIN },
      ),
      /notification preferences/,
    );
  }
});

test("public Web Push config advertises the versioned preference bounds", () => {
  const { webPush } = service();
  assert.deepEqual(webPush.getPublicConfig().notification_preferences, {
    schema_version: "notification-preferences/1",
    horizon_hours: { minimum: 1, maximum: 168, default: 4 },
    probability_threshold: { minimum: 0.01, maximum: 0.99, default: 0.5 },
  });
});

test("subscription limits are checked inside the mutation queue", async () => {
  const { webPush } = service({ appConfig: config({ maxSubscriptions: 1 }) });
  const results = await Promise.allSettled([
    webPush.subscribe(subscription(1), { origin: ORIGIN }),
    webPush.subscribe(subscription(2), { origin: ORIGIN }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "subscription_limit_reached");
});

test("dispatcher sends matching publications and advances the per-subscription cursor", async () => {
  const sends = [];
  const publications = ledger({ cursor: 4 });
  const { webPush, adapter } = service({
    publications,
    async sendNotification(target, payload, options) {
      sends.push({ target, payload: JSON.parse(payload), options });
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  publications.events = [{
    sequence: 5,
    topic: "authority",
    event_id: "authority-5",
    expires_at: "2026-08-10T04:05:00.000Z",
    notification: {
      title: "Tibo 发布了新的重置动态",
      body: "这是权威动态，不是已确认结果。",
      url: "/#signals",
    },
  }];
  publications.current = 5;
  const summary = await webPush.dispatchNow();
  assert.equal(summary.sent, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.event_id, "authority-5");
  assert.equal(sends[0].payload.url, "/#signals");
  assert.equal(sends[0].options.urgency, "normal");
  assert.equal(sends[0].options.TTL, 300);
  assert.equal(sends[0].options.timeout, 15_000);
  assert.equal(Object.values(adapter.snapshot().subscriptions)[0].cursor, 5);
});

test("dispatcher advances past expired publications without sending them", async () => {
  let sendCount = 0;
  const publications = ledger({ cursor: 3 });
  const { webPush, adapter } = service({
    publications,
    async sendNotification() {
      sendCount += 1;
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  publications.events = [{
    sequence: 4,
    topic: "authority",
    event_id: "expired-authority-4",
    expires_at: "2026-08-10T03:59:59.000Z",
    notification: { title: "已经失去时效的动态" },
  }];
  publications.current = 4;
  const summary = await webPush.dispatchNow();
  assert.equal(summary.expired, 1);
  assert.equal(summary.sent, 0);
  assert.equal(sendCount, 0);
  assert.equal(Object.values(adapter.snapshot().subscriptions)[0].cursor, 4);
});

test("expired subscriptions are deleted and transient failures are retried without throwing", async () => {
  const publications = ledger({ cursor: 0 });
  let mode = "gone";
  const { webPush, adapter } = service({
    publications,
    async sendNotification() {
      const error = new Error(mode);
      error.statusCode = mode === "gone" ? 410 : 503;
      throw error;
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认", body: "已由当前 outcome 合同确认。" },
  }];
  publications.current = 1;
  const removed = await webPush.dispatchNow();
  assert.equal(removed.removed, 1);
  assert.equal(Object.keys(adapter.snapshot().subscriptions).length, 0);

  mode = "unavailable";
  await webPush.subscribe(subscription(2), { origin: ORIGIN });
  publications.events = [{
    sequence: 2,
    topic: "outcome",
    event_id: "outcome-2",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 2;
  const retried = await webPush.dispatchNow();
  assert.equal(retried.retried, 1);
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.cursor, 1);
  assert.equal(saved.retry.event_sequence, 2);
  assert.equal(saved.retry.status_code, 503);
});

test("temporary authentication and timeout statuses retry instead of disabling subscriptions", async () => {
  let current = new Date("2026-08-10T04:00:00.000Z");
  let fail = true;
  const publications = ledger({ cursor: 0 });
  const { webPush, adapter } = service({
    publications,
    clock: () => new Date(current),
    async sendNotification() {
      if (!fail) return { statusCode: 201 };
      const error = new Error("temporary VAPID rejection");
      error.statusCode = 403;
      throw error;
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 1;
  const retried = await webPush.dispatchNow();
  assert.equal(retried.retried, 1);
  let record = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(record.disabled, null);
  assert.equal(record.retry.status_code, 403);

  fail = false;
  current = new Date("2026-08-10T04:00:02.000Z");
  const delivered = await webPush.dispatchNow();
  assert.equal(delivered.sent, 1);
  record = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(record.cursor, 1);
  assert.equal(record.retry, null);
});

test("saving an existing subscription preserves its delivery cursor and retry", async () => {
  const publications = ledger({ cursor: 0 });
  const { webPush, adapter } = service({
    publications,
    async sendNotification() {
      const error = new Error("temporary push failure");
      error.statusCode = 503;
      throw error;
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 1;
  await webPush.dispatchNow();
  publications.current = 6;
  const saved = await webPush.subscribe(
    subscription(
      1,
      ["outcome", "experimental_probability"],
      preferences({ horizon_hours: 24, probability_threshold: 0.65 }),
    ),
    { origin: ORIGIN },
  );
  assert.equal(saved.cursor, 0);
  assert.deepEqual(saved.preferences, preferences({
    horizon_hours: 24,
    probability_threshold: 0.65,
  }));
  const record = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(record.retry.event_sequence, 1);
  assert.deepEqual(record.topics, ["outcome", "experimental_probability"]);
  assert.deepEqual(record.preferences, preferences({
    horizon_hours: 24,
    probability_threshold: 0.65,
  }));
});

test("a stuck push endpoint times out without blocking other subscriptions", async () => {
  const publications = ledger({ cursor: 0 });
  const sends = [];
  const { webPush } = service({
    appConfig: config({ requestTimeoutMs: 10 }),
    publications,
    async sendNotification(target) {
      sends.push(target.endpoint);
      if (target.endpoint.endsWith("/1")) return new Promise(() => {});
      return { statusCode: 201 };
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  await webPush.subscribe(subscription(2), { origin: ORIGIN });
  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 1;
  const summary = await webPush.dispatchNow();
  assert.equal(summary.retried, 1);
  assert.equal(summary.sent, 1);
  assert.equal(sends.length, 2);
});

test("service rejects cross-origin and malformed subscriptions", async () => {
  const { webPush } = service();
  await assert.rejects(
    webPush.subscribe(subscription(1), { origin: "https://evil.example" }),
    (error) => error.code === "origin_not_allowed",
  );
  await assert.rejects(
    webPush.subscribe({ ...subscription(1), endpoint: "http://push.example/x" }, {
      origin: ORIGIN,
    }),
    (error) => error.code === "invalid_subscription",
  );
  await assert.rejects(
    webPush.subscribe({
      ...subscription(1),
      endpoint: "https://metadata.internal/subscription",
    }, { origin: ORIGIN }),
    (error) => error.code === "endpoint_not_allowed",
  );
});

test("dispatcher removes newly disallowed stored endpoints while unsubscribe can remove them", async () => {
  const adapter = memoryStateAdapter();
  const publications = ledger({ cursor: 0 });
  const oldConfig = config({ allowedEndpointHosts: ["metadata.internal"] });
  const oldService = service({
    appConfig: oldConfig,
    adapter,
    publications,
  }).webPush;
  const legacySubscription = {
    ...subscription(1),
    endpoint: "https://metadata.internal/subscription/1",
  };
  await oldService.subscribe(legacySubscription, { origin: ORIGIN });

  let sends = 0;
  const currentService = service({
    adapter,
    publications,
    async sendNotification() {
      sends += 1;
    },
  }).webPush;
  const summary = await currentService.dispatchNow();
  assert.equal(summary.removed, 1);
  assert.equal(sends, 0);
  assert.equal(Object.keys(adapter.snapshot().subscriptions).length, 0);

  await oldService.subscribe(legacySubscription, { origin: ORIGIN });
  const result = await currentService.unsubscribe(
    { endpoint: legacySubscription.endpoint },
    { origin: ORIGIN },
  );
  assert.deepEqual(result, { removed: true });
  assert.equal(Object.keys(adapter.snapshot().subscriptions).length, 0);
});

test("dispatcher rechecks deletion and topic changes before each stored subscription sends", async () => {
  const publications = ledger({ cursor: 0 });
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const sends = [];
  const { webPush } = service({
    publications,
    async sendNotification(target) {
      sends.push(target.endpoint);
      if (target.endpoint.endsWith("/1")) {
        markFirstStarted();
        await firstGate;
      }
    },
  });
  await webPush.subscribe(subscription(1), { origin: ORIGIN });
  await webPush.subscribe(subscription(2), { origin: ORIGIN });
  await webPush.subscribe(subscription(3), { origin: ORIGIN });
  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 1;

  const dispatch = webPush.dispatchNow();
  await firstStarted;
  await webPush.unsubscribe(
    { endpoint: subscription(2).endpoint },
    { origin: ORIGIN },
  );
  await webPush.subscribe(
    subscription(3, ["experimental_probability"]),
    { origin: ORIGIN },
  );
  releaseFirst();
  const summary = await dispatch;

  assert.deepEqual(sends, [subscription(1).endpoint]);
  assert.equal(summary.sent, 1);
});

test("an in-flight result cannot mutate a newer generation of the same subscription", async () => {
  for (const result of ["gone", "success"]) {
    const adapter = memoryStateAdapter();
    const publications = ledger({ cursor: 0 });
    let release;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const delivery = new Promise((resolve, reject) => {
      release = () => {
        if (result === "gone") {
          const error = new Error("old subscription is gone");
          error.statusCode = 410;
          reject(error);
        } else {
          resolve({ statusCode: 201 });
        }
      };
    });
    const { webPush } = service({
      adapter,
      publications,
      async sendNotification() {
        markStarted();
        return delivery;
      },
    });
    await webPush.subscribe(subscription(1), { origin: ORIGIN });
    publications.events = [{
      sequence: 1,
      topic: "outcome",
      event_id: "outcome-1",
      expires_at: "2026-08-10T05:00:00.000Z",
      notification: { title: "重置已确认" },
    }];
    publications.current = 1;

    const dispatch = webPush.dispatchNow();
    await started;
    await webPush.subscribe(
      subscription(1, ["experimental_probability"]),
      { origin: ORIGIN },
    );
    release();
    await dispatch;

    const saved = Object.values(adapter.snapshot().subscriptions);
    assert.equal(saved.length, 1, result);
    assert.equal(saved[0].generation, 2, result);
    assert.equal(saved[0].cursor, 0, result);
    assert.equal(saved[0].retry, null, result);
    assert.equal(saved[0].disabled, null, result);
    assert.deepEqual(saved[0].topics, ["experimental_probability"], result);
  }
});

test("personalized probability delivery silently baselines, rearms, and only sends an opening crossing", async () => {
  const sends = [];
  const forecasts = forecastStream({
    inputs: [forecastInput(1, 0.7)],
  });
  const selected = preferences({
    horizon_hours: 24,
    probability_threshold: 0.6,
  });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(target, payload, options) {
      sends.push({ target, payload: JSON.parse(payload), options });
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"], selected),
    { origin: ORIGIN },
  );

  forecasts.inputs.push(forecastInput(2, 0.72));
  let summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 0);
  assert.equal(sends.length, 0, "an initially-high watch must remain a silent baseline");

  forecasts.inputs.push(forecastInput(3, 0.5));
  summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 0, "closing below hysteresis is silent");
  assert.equal(sends.length, 0);

  forecasts.inputs.push(forecastInput(4, 0.65));
  summary = await webPush.dispatchNow();
  assert.equal(summary.sent, 1);
  assert.equal(summary.personalized_sent, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.topic, "experimental_probability");
  assert.match(sends[0].payload.title, /未来 24 小时/);
  assert.match(sends[0].payload.body, /65\.0%/);
  assert.match(sends[0].payload.body, /60\.0%/);
  assert.match(sends[0].payload.body, /不是已确认重置/);
  assert.equal(sends[0].options.urgency, "normal");
  assert.equal(sends[0].options.TTL, 300);
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 4);
  assert.equal(saved.probability_watch.active, true);
  assert.equal(saved.probability_watch.open_notification_emitted, true);
  assert.equal(saved.probability_retry, null);
});

test("Web Push applies current outcome ranges without closing on historical corrections", async () => {
  const sends = [];
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"]),
    { origin: ORIGIN },
  );
  forecasts.inputs.push(forecastInput(2, 0.7));
  await webPush.dispatchNow();
  assert.equal(sends.length, 1);
  let saved = Object.values(adapter.snapshot().subscriptions)[0];
  const episodeId = saved.probability_watch.episode_id;

  const historicalCorrectionGate = forecastGate({
    revision_token: "historical-correction",
    latest_known_at: "2026-08-10T03:43:00.000Z",
    closes_episode: true,
    current_outcomes: [{
      outcome_ref: { record_id: "old-outcome", revision: 2 },
      outcome_token: "old-outcome@2",
      status: "eligible_confirmed",
      known_at: "2026-08-10T03:43:00.000Z",
      occurred_time_range: {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-08-01T01:00:00.000Z",
      },
    }],
  });
  forecasts.outcomeGate = historicalCorrectionGate;
  forecasts.inputs.push(forecastInput(3, 0.8, {
    outcomeGate: historicalCorrectionGate,
  }));
  await webPush.dispatchNow();
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(sends.length, 1);
  assert.equal(saved.probability_watch.active, true);
  assert.equal(saved.probability_watch.episode_id, episodeId);

  const currentOutcomeGate = forecastGate({
    revision_token: "current-outcome",
    latest_known_at: "2026-08-10T03:44:00.000Z",
    closes_episode: true,
    current_outcomes: [{
      outcome_ref: { record_id: "current-outcome", revision: 1 },
      outcome_token: "current-outcome@1",
      status: "eligible_confirmed",
      known_at: "2026-08-10T03:44:00.000Z",
      occurred_time_range: {
        start: "2026-08-10T03:42:45.000Z",
        end: "2026-08-10T03:43:00.000Z",
      },
    }],
  });
  forecasts.outcomeGate = currentOutcomeGate;
  forecasts.inputs.push(forecastInput(4, 0.8, {
    outcomeGate: currentOutcomeGate,
  }));
  await webPush.dispatchNow();
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(sends.length, 1);
  assert.equal(saved.probability_watch.active, false);

  forecasts.inputs.push(forecastInput(5, 0.8, {
    outcomeGate: currentOutcomeGate,
  }));
  await webPush.dispatchNow();
  assert.equal(sends.length, 2);
});

test("Web Push replays per-input outcome gates and sends only the current-cycle reopen", async () => {
  const sends = [];
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"]),
    { origin: ORIGIN },
  );

  const confirmedGate = forecastGate({
    revision_token: "confirmed-current-cycle",
    latest_known_at: "2026-08-10T03:42:50.000Z",
    closes_episode: true,
    current_outcomes: [{
      outcome_ref: { record_id: "current-cycle", revision: 1 },
      outcome_token: "current-cycle@1",
      status: "eligible_confirmed",
      known_at: "2026-08-10T03:42:50.000Z",
      occurred_time_range: {
        start: "2026-08-10T03:42:30.000Z",
        end: "2026-08-10T03:42:45.000Z",
      },
    }],
  });
  const oldOpen = forecastInput(2, 0.7);
  const confirmedClose = forecastInput(3, 0.7, {
    outcomeGate: confirmedGate,
  });
  const currentReopen = forecastInput(4, 0.7, {
    outcomeGate: confirmedGate,
  });
  forecasts.inputs.push(oldOpen, confirmedClose, currentReopen);
  forecasts.outcomeGate = confirmedGate;

  const summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 1);
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0].emitted_at,
    currentReopen.emitted_at,
    "the historical opening must evolve the watch without reaching the sender",
  );
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, currentReopen.sequence);
  assert.equal(saved.probability_watch.active, true);
  assert.equal(saved.probability_watch.last_prediction_key, "prediction-4@1");
  assert.equal(saved.probability_retry, null);
});

test("Web Push suppresses an opening that has the current token but an older knowledge cutoff", async () => {
  const sends = [];
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"]),
    { origin: ORIGIN },
  );

  const inputGate = forecastGate({
    revision_token: "current-token",
    latest_known_at: "2026-08-10T03:41:30.000Z",
  });
  forecasts.inputs.push(forecastInput(2, 0.7, { outcomeGate: inputGate }));
  forecasts.outcomeGate = forecastGate({
    revision_token: "current-token",
    latest_known_at: "2026-08-10T03:43:00.000Z",
  });

  const summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 0);
  assert.equal(sends.length, 0);
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 2);
  assert.equal(saved.probability_watch.last_prediction_key, "prediction-2@1");
});

test("a stable publication retry does not block a personalized probability crossing", async () => {
  const sends = [];
  const publications = ledger({ cursor: 0 });
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  let failOutcome = true;
  const { webPush, adapter } = service({
    publications,
    forecasts,
    async sendNotification(_target, serialized) {
      const payload = JSON.parse(serialized);
      sends.push(payload.topic);
      if (payload.topic === "outcome" && failOutcome) {
        failOutcome = false;
        const error = new Error("outcome push temporarily unavailable");
        error.statusCode = 503;
        throw error;
      }
    },
  });
  await webPush.subscribe(
    subscription(1, ["outcome", "experimental_probability"]),
    { origin: ORIGIN },
  );
  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 1;
  forecasts.inputs.push(forecastInput(2, 0.6));

  const summary = await webPush.dispatchNow();
  assert.equal(summary.retried, 1);
  assert.equal(summary.personalized_retried, 0);
  assert.equal(summary.personalized_sent, 1);
  assert.deepEqual(sends, ["outcome", "experimental_probability"]);
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.cursor, 0);
  assert.equal(saved.retry.event_sequence, 1);
  assert.equal(saved.forecast_input_cursor, 2);
  assert.equal(saved.probability_retry, null);
});

test("the forecast stream replaces the legacy global probability publication for Web Push", async () => {
  const sends = [];
  const publications = ledger({ cursor: 0 });
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    publications,
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"]),
    { origin: ORIGIN },
  );
  publications.events = [{
    sequence: 1,
    topic: "experimental_probability",
    event_id: "legacy-global-watch",
    expires_at: "2026-08-10T04:05:00.000Z",
    notification: { title: "旧的全局 4h/50% 概率提醒" },
  }];
  publications.current = 1;
  forecasts.inputs.push(forecastInput(2, 0.6));

  const summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 1);
  assert.equal(sends.length, 1);
  assert.notEqual(sends[0].event_id, "legacy-global-watch");
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.cursor, 1);
  assert.equal(saved.forecast_input_cursor, 2);
});

test("a personalized retry does not block stable publications and resumes at the same input", async () => {
  let current = new Date("2026-08-10T04:00:00.000Z");
  const sends = [];
  const publications = ledger({ cursor: 0 });
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  let failProbability = true;
  const { webPush, adapter } = service({
    publications,
    forecasts,
    clock: () => new Date(current),
    async sendNotification(_target, serialized) {
      const payload = JSON.parse(serialized);
      sends.push(payload.topic);
      if (payload.topic === "experimental_probability" && failProbability) {
        const error = new Error("probability push temporarily unavailable");
        error.statusCode = 503;
        throw error;
      }
    },
  });
  await webPush.subscribe(
    subscription(1, ["outcome", "experimental_probability"]),
    { origin: ORIGIN },
  );
  forecasts.inputs.push(forecastInput(2, 0.6));
  let summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_retried, 1);
  let saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 1);
  assert.equal(saved.retry, null);
  assert.equal(saved.probability_retry.input_sequence, 2);

  await webPush.subscribe(
    subscription(1, ["outcome", "experimental_probability"]),
    { origin: ORIGIN },
  );
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(
    saved.forecast_input_cursor,
    1,
    "saving the same rule must not skip the pending crossing",
  );
  assert.equal(saved.probability_retry.input_sequence, 2);
  assert.equal(saved.probability_watch.last_prediction_key, "prediction-1@1");

  publications.events = [{
    sequence: 1,
    topic: "outcome",
    event_id: "outcome-1",
    expires_at: "2026-08-10T05:00:00.000Z",
    notification: { title: "重置已确认" },
  }];
  publications.current = 1;
  summary = await webPush.dispatchNow();
  assert.equal(summary.sent, 1, "the stable outcome still sends");
  assert.equal(summary.personalized_sent, 0);
  assert.equal(summary.personalized_deferred, 1);
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.cursor, 1);
  assert.equal(saved.forecast_input_cursor, 1);

  failProbability = false;
  current = new Date("2026-08-10T04:00:02.000Z");
  summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 1);
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 2);
  assert.equal(saved.probability_retry, null);
  assert.deepEqual(sends, [
    "experimental_probability",
    "outcome",
    "experimental_probability",
  ]);
});

test("changing personalized preferences baselines the current tail without a synthetic alert", async () => {
  const sends = [];
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"], preferences()),
    { origin: ORIGIN },
  );
  forecasts.inputs.push(forecastInput(2, 0.65));
  const updatedPreferences = preferences({
    horizon_hours: 24,
    probability_threshold: 0.6,
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"], updatedPreferences),
    { origin: ORIGIN },
  );

  forecasts.inputs.push(forecastInput(3, 0.7));
  let summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 0);
  assert.equal(sends.length, 0);
  forecasts.inputs.push(forecastInput(4, 0.5), forecastInput(5, 0.65));
  summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].title, /未来 24 小时/);
  const saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.generation, 2);
  assert.equal(saved.forecast_input_cursor, 5);
  assert.deepEqual(saved.preferences, updatedPreferences);
});

test("forecast input cursor reset silently rebaselines the retained tail", async () => {
  const sends = [];
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"]),
    { origin: ORIGIN },
  );
  forecasts.inputs = [forecastInput(10, 0.7)];
  forecasts.resetNext = true;
  let summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_rebased, 1);
  assert.equal(summary.personalized_sent, 0);
  assert.equal(sends.length, 0);
  let saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 10);
  assert.equal(saved.probability_watch.active, true);

  forecasts.inputs.push(forecastInput(11, 0.72));
  summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 0);
  forecasts.inputs.push(forecastInput(12, 0.4), forecastInput(13, 0.6));
  summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 1);
  assert.equal(sends.length, 1);
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 13);
});

test("expired personalized inputs advance without delivery and do not suppress the next live crossing", async () => {
  const sends = [];
  const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
  const { webPush, adapter } = service({
    forecasts,
    async sendNotification(_target, serialized) {
      sends.push(JSON.parse(serialized));
    },
  });
  await webPush.subscribe(
    subscription(1, ["experimental_probability"]),
    { origin: ORIGIN },
  );
  forecasts.inputs.push(forecastInput(2, 0.7, {
    expiresAt: "2026-08-10T03:59:59.000Z",
  }));
  let summary = await webPush.dispatchNow();
  assert.equal(summary.expired, 1);
  assert.equal(summary.personalized_expired, 1);
  assert.equal(summary.personalized_sent, 0);
  assert.equal(sends.length, 0);
  let saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 2);

  forecasts.inputs.push(forecastInput(3, 0.7));
  summary = await webPush.dispatchNow();
  assert.equal(summary.personalized_sent, 1);
  saved = Object.values(adapter.snapshot().subscriptions)[0];
  assert.equal(saved.forecast_input_cursor, 3);
});

test("an in-flight personalized result cannot overwrite or delete newer preferences", async () => {
  for (const result of ["gone", "success"]) {
    const adapter = memoryStateAdapter();
    const forecasts = forecastStream({ inputs: [forecastInput(1, 0.2)] });
    let release;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const delivery = new Promise((resolve, reject) => {
      release = () => {
        if (result === "gone") {
          const error = new Error("old personalized subscription is gone");
          error.statusCode = 410;
          reject(error);
        } else {
          resolve({ statusCode: 201 });
        }
      };
    });
    const { webPush } = service({
      adapter,
      forecasts,
      async sendNotification(_target, serialized) {
        if (JSON.parse(serialized).topic === "experimental_probability") {
          markStarted();
          return delivery;
        }
      },
    });
    await webPush.subscribe(
      subscription(1, ["experimental_probability"], preferences()),
      { origin: ORIGIN },
    );
    forecasts.inputs.push(forecastInput(2, 0.7));
    const dispatch = webPush.dispatchNow();
    await started;
    const replacement = preferences({
      horizon_hours: 24,
      probability_threshold: 0.65,
    });
    await webPush.subscribe(
      subscription(1, ["experimental_probability"], replacement),
      { origin: ORIGIN },
    );
    release();
    await dispatch;

    const saved = Object.values(adapter.snapshot().subscriptions);
    assert.equal(saved.length, 1, result);
    assert.equal(saved[0].generation, 2, result);
    assert.equal(saved[0].forecast_input_cursor, 2, result);
    assert.equal(saved[0].probability_retry, null, result);
    assert.deepEqual(saved[0].preferences, replacement, result);
    assert.equal(saved[0].probability_watch.last_prediction_key, "prediction-2@1");
  }
});
