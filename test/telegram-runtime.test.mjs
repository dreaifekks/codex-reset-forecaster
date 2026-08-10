import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTelegramConfig } from "../src/telegram/config.mjs";
import {
  ForecasterClient,
  TelegramApiError,
  TelegramClient,
} from "../src/telegram/client.mjs";
import { TelegramBotRuntime } from "../src/telegram/runtime.mjs";
import { TelegramStateStore } from "../src/telegram/state-store.mjs";
import {
  formatOperationsAlert,
  formatTraffic,
} from "../src/telegram/format.mjs";
import { checkTelegramHeartbeat } from "../src/telegram-healthcheck.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-tg-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function runtimeConfig(overrides = {}) {
  return {
    token: "123456:abcdefghijklmnopqrstuvwxyz_ABCD",
    operationsToken: null,
    adminUserIds: new Set(["10"]),
    blockedUserIds: new Set(["99"]),
    allowedGroupChatIds: new Set(),
    staticNotificationChatIds: new Set(),
    staticExperimentalChatIds: new Set(),
    operationsAlertsEnabled: false,
    displayTimeZone: "UTC",
    forecasterPublicBaseUrl: "https://forecast.example.test",
    longPollTimeoutSeconds: 1,
    eventPollIntervalMs: 1_000,
    forecastInputPollIntervalMs: 1_000,
    dispatchIntervalMs: 100,
    heartbeatIntervalMs: 1_000,
    operationsAlertPollIntervalMs: 5_000,
    commandRateLimit: 12,
    commandRateWindowSeconds: 60,
    maximumOutboxAttempts: 12,
    ...overrides,
  };
}

test("traffic growth ratios are always rendered as percentages", () => {
  const base = {
    traffic: {
      current: { requests: 1 },
      yesterday: { requests: 1 },
      seven_days: { requests: 1 },
      growth: { day_over_day: 2 },
    },
    capacity: { level: "normal" },
  };
  assert.match(formatTraffic(base), /日增长：\+200\.0%/);
  assert.match(formatTraffic({
    ...base,
    traffic: {
      ...base.traffic,
      growth: { day_over_day: -0.5 },
    },
  }), /日增长：-50\.0%/);
});

test("runtime-only operations alerts explain main-thread blocking without capacity wording", () => {
  const text = formatOperationsAlert({
    level: "critical",
    title: "源站容量进入严重压力",
    summary: "触发信号：event_loop_lag_p95_620ms、event_loop_utilization_0.94、cgroup_memory_0.81",
    reasons: [
      "event_loop_lag_p95_620ms",
      "event_loop_utilization_0.94",
      "cgroup_memory_0.81",
      "node_heap_0.83",
      "in_flight_14",
      "event_loop_lag_critical",
      "event_loop_utilization_critical",
      "cgroup_memory_critical",
    ],
    observed_at: "2026-08-10T04:01:00Z",
  });

  assert.match(text, /源站主线程持续阻塞 \[critical\]/);
  assert.match(text, /这不是请求量增长告警。/);
  assert.match(text, /事件循环滞后 p95：620 毫秒/);
  assert.match(text, /事件循环利用率：94\.0%/);
  assert.match(text, /容器内存使用率：81\.0%/);
  assert.match(text, /Node\.js 堆内存使用率：83\.0%/);
  assert.match(text, /同时处理中请求：14 个/);
  assert.doesNotMatch(text, /容量压力/);
  assert.doesNotMatch(text, /event_loop|cgroup_memory|node_heap|in_flight/);
});

test("user-impact capacity alerts retain their original wording", () => {
  const summary = [
    "interactive_p95_900ms",
    "true_errors_5",
    "aborted_2.0pct",
    "concurrency_critical",
    "event_loop_utilization_0.80",
  ].join("、");
  const text = formatOperationsAlert({
    level: "strained",
    title: "源站容量开始吃紧",
    summary: `触发信号：${summary}`,
    reasons: summary.split("、"),
  });

  assert.match(text, /容量运维提醒（仅管理员）/);
  assert.match(text, /源站容量开始吃紧 \[strained\]/);
  assert.ok(text.includes(`触发信号：${summary}`));
  assert.doesNotMatch(text, /源站主线程持续阻塞|这不是请求量增长告警/);
});

function predictionFixture() {
  const start = Date.parse("2026-08-10T04:00:00Z");
  const slots = Array.from({ length: 168 }, (_, index) => ({
    start: new Date(start + index * 3_600_000).toISOString(),
    end: new Date(start + (index + 1) * 3_600_000).toISOString(),
    hazard: 0.01,
    first_reset_probability: 0.01,
    reset_by_end_probability: 1 - (0.99 ** (index + 1)),
    rolling_4h_probability: index < 165 ? 1 - (0.99 ** 4) : null,
    epistemic_interval_80: [0.005, 0.02],
  }));
  return {
    record_id: "pred_test",
    revision: 1,
    data: {
      issued_at: "2026-08-10T03:59:00Z",
      knowledge_cutoff: "2026-08-10T03:58:00Z",
      slots,
      model: { validation_status: "provisional" },
      data_quality: { score: 0.8 },
      authority_conditioning: { applied: false },
      post_outcome_refractory: { applied: false },
    },
  };
}

function notificationForecastInput(sequence, probability, {
  issuedAt = new Date(
    Date.parse("2026-08-10T03:40:00.000Z") + sequence * 60_000,
  ).toISOString(),
  emittedAt = new Date(Date.parse(issuedAt) + 30_000).toISOString(),
  expiresAt = "2026-08-10T05:00:00.000Z",
  outcomeRevisionGate = forecastGate(),
} = {}) {
  return {
    schema_version: "notification-forecast-input/2",
    sequence,
    input_id: `forecast_input_${String(sequence).padStart(64, "0")}`,
    prediction_ref: { record_id: `prediction-${sequence}`, revision: 1 },
    prediction_hash: `sha256:${String(sequence).padStart(64, "0")}`,
    issued_at: issuedAt,
    emitted_at: emittedAt,
    knowledge_cutoff: issuedAt,
    expires_at: expiresAt,
    serving_stage: "validated",
    probabilities: Array.from({ length: 168 }, () => probability),
    outcome_revision_gate: outcomeRevisionGate,
  };
}

function projectForecastInput(input, horizons) {
  if (input.schema_version === "notification-forecast-input-view/1") {
    return input;
  }
  const { probabilities, schema_version: sourceSchemaVersion, ...metadata } = input;
  return {
    ...metadata,
    schema_version: "notification-forecast-input-view/1",
    source_schema_version: sourceSchemaVersion,
    horizon_probabilities: horizons.map((horizonHours) => ({
      horizon_hours: horizonHours,
      probability: probabilities[horizonHours - 1],
    })),
  };
}

function forecastGate({
  revisionToken = null,
  latestKnownAt = null,
  closesEpisode = false,
  currentOutcomes = [],
} = {}) {
  return {
    revision_token: revisionToken,
    latest_known_at: latestKnownAt,
    closes_episode: closesEpisode,
    current_outcomes: currentOutcomes,
  };
}

class FakeTelegram {
  constructor() {
    this.webhook = { url: "" };
    this.updateBatches = [];
    this.sent = [];
    this.sendErrors = [];
  }

  async getWebhookInfo() {
    return this.webhook;
  }

  async getMe() {
    return { id: 1, username: "reset_test_bot" };
  }

  async getUpdates() {
    return this.updateBatches.shift() ?? [];
  }

  async sendMessage(message) {
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sent.push(message);
    return { message_id: this.sent.length };
  }
}

class FakeForecaster {
  constructor() {
    this.prediction = predictionFixture();
    this.eventBatches = [];
    this.forecastInputBatches = [];
    this.forecastInputRequests = [];
    this.operationsAlertBatches = [];
    this.history = [];
    this.trafficRequests = 0;
  }

  async getHealth() {
    return {
      status: "degraded",
      serving_ready: true,
      serving_stage: "provisional",
      synthetic_only: false,
      current_prediction_ref: {
        record_id: this.prediction.record_id,
        revision: this.prediction.revision,
        snapshot_url: "/api/forecast/snapshots/pred_test/1",
      },
    };
  }

  async getExactSnapshot() {
    return this.prediction;
  }

  async getHistory() {
    return this.history;
  }

  async getNotificationEvents() {
    return this.eventBatches.shift() ?? {
      events: [],
      cursor: "0",
      hasMore: false,
    };
  }

  async getForecastInputs(after = null, { horizonHours = null } = {}) {
    this.forecastInputRequests.push({
      after,
      horizonHours: horizonHours === null ? null : [...horizonHours],
    });
    const result = this.forecastInputBatches.shift() ?? {
      inputs: [],
      cursor: "0",
      hasMore: false,
      outcomeRevisionGate: forecastGate(),
      resetRequired: false,
      resetReason: null,
    };
    return Array.isArray(horizonHours) && horizonHours.length > 0
      ? {
          ...result,
          inputs: result.inputs.map((input) =>
            projectForecastInput(input, horizonHours)
          ),
        }
      : result;
  }

  async getTraffic() {
    this.trafficRequests += 1;
    return {
      observed_at: "2026-08-10T04:00:00Z",
      current: { requests: 120 },
      yesterday: { requests: 100 },
      seven_days: { requests: 600 },
      growth: { day_over_day: 0.2 },
      capacity: { level: "comfortable", utilization: 0.12 },
    };
  }

  async getOperationsAlerts() {
    return this.operationsAlertBatches.shift() ?? {
      alerts: [],
      cursor: "0",
      hasMore: false,
    };
  }
}

async function setupRuntime(t, { config = runtimeConfig(), now } = {}) {
  const directory = await temporaryDirectory(t);
  const telegram = new FakeTelegram();
  const forecaster = new FakeForecaster();
  const stateStore = new TelegramStateStore({
    directory,
    now: now ?? (() => new Date("2026-08-10T04:00:00Z")),
  });
  const runtime = new TelegramBotRuntime({
    telegram,
    forecaster,
    stateStore,
    config,
    now: now ?? (() => new Date("2026-08-10T04:00:00Z")),
    random: () => 0,
    logger: { error() {} },
  });
  await runtime.initialize();
  return { runtime, telegram, forecaster, stateStore, directory };
}

test("Telegram config reads safe secrets and configures a public-private bot", async (t) => {
  const directory = await temporaryDirectory(t);
  const tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "123456:abcdefghijklmnopqrstuvwxyz_ABCD\n", {
    mode: 0o600,
  });
  const config = await loadTelegramConfig({
    env: {
      TELEGRAM_BOT_TOKEN_FILE: tokenFile,
      TELEGRAM_ADMIN_USER_IDS: "0010",
      TELEGRAM_BLOCKED_USER_IDS: "20",
      TELEGRAM_ALLOWED_GROUP_CHAT_IDS: "-100",
      TELEGRAM_NOTIFICATION_CHAT_IDS: "10",
      TELEGRAM_EXPERIMENTAL_CHAT_IDS: "-100",
      TELEGRAM_BOT_DATA_DIR: path.join(directory, "data"),
      FORECASTER_API_BASE: "http://forecaster:8787",
      FORECASTER_PUBLIC_BASE_URL: "https://forecast.example.test",
    },
  });
  assert.deepEqual([...config.adminUserIds], ["10"]);
  assert.deepEqual([...config.blockedUserIds], ["20"]);
  assert.deepEqual([...config.allowedGroupChatIds], ["-100"]);
  assert.equal(config.stateDir, path.join(directory, "data"));
  await fs.chmod(tokenFile, 0o644);
  await assert.rejects(
    loadTelegramConfig({
      env: {
        TELEGRAM_BOT_TOKEN_FILE: tokenFile,
        TELEGRAM_ADMIN_USER_IDS: "10",
      },
    }),
    /mode must be 0400 or 0600/,
  );
  await fs.chmod(tokenFile, 0o500);
  await assert.rejects(
    loadTelegramConfig({
      env: {
        TELEGRAM_BOT_TOKEN_FILE: tokenFile,
        TELEGRAM_ADMIN_USER_IDS: "10",
      },
    }),
    /mode must be 0400 or 0600/,
  );
});

test("Telegram operations secret and public-role boundaries fail closed", async (t) => {
  const directory = await temporaryDirectory(t);
  const tokenFile = path.join(directory, "token");
  const operationsTokenFile = path.join(directory, "operations-token");
  await fs.writeFile(tokenFile, "123456:abcdefghijklmnopqrstuvwxyz_ABCD\n", {
    mode: 0o600,
  });
  await fs.writeFile(operationsTokenFile, `${"s".repeat(40)}\n`, {
    mode: 0o600,
  });
  const config = await loadTelegramConfig({
    env: {
      TELEGRAM_BOT_TOKEN_FILE: tokenFile,
      TELEGRAM_ADMIN_USER_IDS: "10",
      FORECASTER_OPERATIONS_TOKEN_FILE: operationsTokenFile,
      TELEGRAM_OPERATIONS_ALERTS_ENABLED: "true",
    },
  });
  assert.equal(config.operationsToken, "s".repeat(40));
  assert.equal(config.operationsAlertsEnabled, true);

  await assert.rejects(
    loadTelegramConfig({
      env: {
        TELEGRAM_BOT_TOKEN_FILE: tokenFile,
        TELEGRAM_ADMIN_USER_IDS: "10",
        TELEGRAM_BLOCKED_USER_IDS: "10",
      },
    }),
    /contains administrator/,
  );
  await assert.rejects(
    loadTelegramConfig({
      env: {
        TELEGRAM_BOT_TOKEN_FILE: tokenFile,
        TELEGRAM_ADMIN_USER_IDS: "10",
        TELEGRAM_ALLOWED_GROUP_CHAT_IDS: "20",
      },
    }),
    /negative group-chat ids/,
  );
  await fs.chmod(operationsTokenFile, 0o644);
  await assert.rejects(
    loadTelegramConfig({
      env: {
        TELEGRAM_BOT_TOKEN_FILE: tokenFile,
        TELEGRAM_ADMIN_USER_IDS: "10",
        FORECASTER_OPERATIONS_TOKEN_FILE: operationsTokenFile,
      },
    }),
    /mode must be 0400 or 0600/,
  );
});

test("public private commands enqueue atomically without a per-user allowlist", async (t) => {
  const { runtime, telegram, stateStore } = await setupRuntime(t);
  telegram.updateBatches.push([
    {
      update_id: 1,
      message: {
        from: { id: 99 },
        chat: { id: 99, type: "private" },
        text: "/forecast",
      },
    },
    {
      update_id: 2,
      message: {
        from: { id: 20 },
        chat: { id: 999, type: "private" },
        text: "/report",
      },
    },
    {
      update_id: 3,
      message: {
        from: { id: 20 },
        chat: { id: 20, type: "private" },
        text: "/forecast",
      },
    },
  ]);
  assert.deepEqual(await runtime.pollUpdatesOnce(), { updates: 3, jobs: 1 });
  let state = await stateStore.read();
  assert.equal(state.next_update_id, 4);
  assert.equal(state.outbox.length, 1);
  assert.match(state.outbox[0].text, /未来 4 小时/);
  assert.match(state.outbox[0].text, /临时预测/);
  assert.equal(await runtime.dispatchOnce(), true);
  state = await stateStore.read();
  assert.equal(state.outbox[0].status, "delivered");
  assert.equal(telegram.sent.length, 1);
});

test("configured groups are explicit read-only surfaces while subscriptions stay private", async (t) => {
  const config = runtimeConfig({
    allowedGroupChatIds: new Set(["-100"]),
  });
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  telegram.updateBatches.push([
    {
      update_id: 1,
      message: {
        from: { id: 20 },
        chat: { id: 20, type: "private" },
        text: "/subscribe",
      },
    },
    {
      update_id: 2,
      message: {
        from: { id: 20 },
        chat: { id: -100, type: "supergroup" },
        text: "/forecast",
      },
    },
    {
      update_id: 3,
      message: {
        from: { id: 20 },
        chat: { id: -100, type: "supergroup" },
        text: "/forecast@reset_test_bot",
      },
    },
    {
      update_id: 4,
      message: {
        from: { id: 20 },
        chat: { id: -100, type: "supergroup" },
        text: "/subscribe@reset_test_bot experimental",
      },
    },
    {
      update_id: 5,
      message: {
        from: { id: 20 },
        chat: { id: -999, type: "group" },
        text: "/forecast@reset_test_bot",
      },
    },
  ]);
  assert.deepEqual(await runtime.pollUpdatesOnce(), { updates: 5, jobs: 3 });
  const state = await stateStore.read();
  assert.deepEqual(Object.keys(state.dynamic_subscriptions), ["20"]);
  assert.equal(
    state.dynamic_subscriptions["20"].probability_preferences,
    null,
  );
  assert.match(state.outbox.at(-1).text, /订阅只属于你的私聊/);
});

test("ordinary users are rate limited without limiting administrators", async (t) => {
  const config = runtimeConfig({
    commandRateLimit: 2,
    commandRateWindowSeconds: 60,
  });
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  telegram.updateBatches.push([
    ...Array.from({ length: 4 }, (_, index) => ({
      update_id: index + 1,
      message: {
        from: { id: 20 },
        chat: { id: 20, type: "private" },
        text: "/help",
      },
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      update_id: index + 5,
      message: {
        from: { id: 10 },
        chat: { id: 10, type: "private" },
        text: "/help",
      },
    })),
  ]);
  assert.deepEqual(await runtime.pollUpdatesOnce(), { updates: 8, jobs: 7 });
  const state = await stateStore.read();
  assert.equal(
    state.outbox.filter((job) => /请求过于频繁/.test(job.text)).length,
    1,
  );
  assert.equal(state.next_update_id, 9);
});

test("operations status is available only to an administrator in private", async (t) => {
  const config = runtimeConfig({ operationsToken: "o".repeat(40) });
  const { runtime, telegram, forecaster, stateStore } = await setupRuntime(t, {
    config,
  });
  telegram.updateBatches.push([
    {
      update_id: 1,
      message: {
        from: { id: 20 },
        chat: { id: 20, type: "private" },
        text: "/traffic",
      },
    },
    {
      update_id: 2,
      message: {
        from: { id: 10 },
        chat: { id: 10, type: "private" },
        text: "/traffic",
      },
    },
    {
      update_id: 3,
      message: {
        from: { id: 20 },
        chat: { id: 20, type: "private" },
        text: "/help",
      },
    },
    {
      update_id: 4,
      message: {
        from: { id: 10 },
        chat: { id: 10, type: "private" },
        text: "/help",
      },
    },
  ]);
  assert.deepEqual(await runtime.pollUpdatesOnce(), { updates: 4, jobs: 4 });
  const state = await stateStore.read();
  assert.equal(forecaster.trafficRequests, 1);
  assert.match(state.outbox[0].text, /只对管理员私聊开放/);
  assert.match(state.outbox[1].text, /请求量与容量状态/);
  assert.equal(state.outbox[1].kind, "admin_command");
  assert.doesNotMatch(state.outbox[2].text, /\/traffic/);
  assert.match(state.outbox[3].text, /\/traffic/);
});

test("a queued operations response is dropped after administrator removal", async (t) => {
  const config = runtimeConfig();
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    jobs: [{
      id: "admin-command:traffic",
      kind: "admin_command",
      chatId: "10",
      text: "sensitive aggregate",
    }],
  });
  config.adminUserIds.delete("10");
  assert.equal(await runtime.dispatchOnce(), true);
  const state = await stateStore.read();
  assert.equal(state.outbox[0].last_error, "recipient_not_authorized");
  assert.equal(telegram.sent.length, 0);
});

test("ordinary forecast replies omit internal quality and degraded diagnostics", async (t) => {
  const { runtime, telegram, stateStore } = await setupRuntime(t);
  telegram.updateBatches.push(["/forecast", "/report"].map((text, index) => ({
    update_id: 10 + index,
    message: { from: { id: 20 }, chat: { id: 20, type: "private" }, text },
  })));

  assert.deepEqual(await runtime.pollUpdatesOnce(), { updates: 2, jobs: 2 });
  const state = await stateStore.read();
  assert.match(state.outbox[0].text, /Codex 重置预测/);
  assert.match(state.outbox[1].text, /可能到来的 Codex 重置报告/);
  for (const job of state.outbox) {
    assert.doesNotMatch(job.text, /输入数据质量/);
    assert.doesNotMatch(job.text, /当前服务处于降级状态/);
    assert.doesNotMatch(job.text, /概率与数据质量/);
  }
});

test("report, history, lastreset, subscription, about, and help commands produce durable replies", async (t) => {
  const { runtime, telegram, forecaster, stateStore } = await setupRuntime(t);
  forecaster.history = [{
    status: "confirmed",
    occurred_time_range: {
      start: "2026-08-09T10:00:00Z",
      end: "2026-08-09T11:00:00Z",
      precision: "hour",
    },
    source: {
      canonical_url: "https://x.com/example/status/1",
      published_at: "2026-08-09T10:05:00Z",
    },
  }];
  const commands = [
    "/report",
    "/history 1",
    "/lastreset",
    "/subscribe",
    "/unsubscribe",
    "/about",
    "/info",
    "/help",
  ];
  telegram.updateBatches.push(commands.map((text, index) => ({
    update_id: 20 + index,
    message: { from: { id: 10 }, chat: { id: 10, type: "private" }, text },
  })));
  assert.deepEqual(await runtime.pollUpdatesOnce(), { updates: 8, jobs: 8 });
  const state = await stateStore.read();
  assert.equal(state.next_update_id, 28);
  assert.equal(state.outbox.length, 8);
  assert.match(state.outbox[0].text, /可能到来的 Codex 重置报告/);
  assert.match(state.outbox[1].text, /最近 1 次确认重置/);
  assert.match(state.outbox[2].text, /最近一次确认重置/);
  assert.match(state.outbox[3].text, /已订阅稳定通知/);
  assert.match(state.outbox[4].text, /已取消动态订阅/);
  assert.match(state.outbox[5].text, /独立的实验性 Codex 重置预测与通知工具/);
  assert.match(state.outbox[5].text, /非 OpenAI 官方服务/);
  assert.match(state.outbox[5].text, /https:\/\/forecast\.example\.test\//);
  assert.equal(state.outbox[6].text, state.outbox[5].text);
  assert.match(state.outbox[7].text, /\/about/);
  assert.deepEqual(state.dynamic_subscriptions, {});
});

test("private users can configure and inspect a probability subscription", async (t) => {
  const { runtime, telegram, stateStore } = await setupRuntime(t);
  telegram.updateBatches.push([{
    update_id: 1,
    message: {
      from: { id: 20 },
      chat: { id: 20, type: "private" },
      text: "/subscribe probability 24h 60%",
    },
  }]);
  await runtime.pollUpdatesOnce();
  let state = await stateStore.read();
  assert.deepEqual(state.dynamic_subscriptions["20"].probability_preferences, {
    schema_version: "notification-preferences/1",
    horizon_hours: 24,
    probability_threshold: 0.6,
  });
  assert.equal(state.dynamic_subscriptions["20"].generation, 1);
  assert.match(state.outbox.at(-1).text, /未来 24 小时概率严格超过 60%/);

  telegram.updateBatches.push([{
    update_id: 2,
    message: {
      from: { id: 20 },
      chat: { id: 20, type: "private" },
      text: "/subscription",
    },
  }, {
    update_id: 3,
    message: {
      from: { id: 30 },
      chat: { id: 30, type: "private" },
      text: "/subscribe experimental",
    },
  }]);
  await runtime.pollUpdatesOnce();
  state = await stateStore.read();
  assert.match(state.outbox.at(-2).text, /当前订阅设置/);
  assert.match(state.outbox.at(-2).text, /未来 24 小时/);
  assert.deepEqual(state.dynamic_subscriptions["30"].probability_preferences, {
    schema_version: "notification-preferences/1",
    horizon_hours: 4,
    probability_threshold: 0.5,
  });
  assert.match(state.outbox.at(-1).text, /兼容别名/);
});

test("Telegram probability polling baselines silently and sends only upward crossings", async (t) => {
  const { runtime, forecaster, stateStore, telegram } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{
      chatId: "20",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 24,
          probability_threshold: 0.6,
        },
      },
    }],
  });
  forecaster.forecastInputBatches.push({
    inputs: [],
    cursor: "0",
    hasMore: false,
    outcomeRevisionGate: forecastGate(),
    resetRequired: false,
    resetReason: null,
  });
  assert.deepEqual(await runtime.pollForecastInputsOnce(), {
    baseline: true,
    reset: false,
    inputs: 0,
    jobs: 0,
  });
  assert.deepEqual(forecaster.forecastInputRequests.at(-1), {
    after: null,
    horizonHours: [24],
  });

  for (const [sequence, probability] of [
    [1, 0.4],
    [2, 0.65],
    [3, 0.62],
    [4, 0.54],
    [5, 0.7],
  ]) {
    forecaster.forecastInputBatches.push({
      inputs: [notificationForecastInput(sequence, probability)],
      cursor: String(sequence),
      hasMore: false,
      outcomeRevisionGate: forecastGate(),
      resetRequired: false,
      resetReason: null,
    });
    await runtime.pollForecastInputsOnce();
  }
  assert.ok(forecaster.forecastInputRequests.slice(1).every((request) =>
    request.horizonHours.length === 1 && request.horizonHours[0] === 24
  ));
  let state = await stateStore.read();
  const probabilityJobs = state.outbox.filter((job) =>
    job.kind === "probability"
  );
  assert.equal(probabilityJobs.length, 2);
  assert.ok(probabilityJobs.every((job) =>
    job.subscription_generation === 1 &&
    job.preferences_hash.startsWith("sha256:")
  ));
  assert.match(probabilityJobs[0].text, /65\.0%/);
  assert.match(probabilityJobs[0].text, /不是已确认重置/);
  assert.equal(state.forecast_input_cursor, "5");
  assert.equal(state.dynamic_subscriptions["20"].probability_watch.active, true);

  assert.equal(await runtime.dispatchOnce(), true);
  assert.equal(await runtime.dispatchOnce(), true);
  state = await stateStore.read();
  assert.equal(
    state.outbox.filter((job) =>
      job.kind === "probability" && job.status === "delivered"
    ).length,
    2,
  );
  assert.equal(telegram.sent.length, 2);
});

test("Telegram requests only the unique horizons used by current dynamic rules", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{
      chatId: "20",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 24,
          probability_threshold: 0.6,
        },
      },
    }, {
      chatId: "21",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 4,
          probability_threshold: 0.5,
        },
      },
    }, {
      chatId: "22",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 24,
          probability_threshold: 0.7,
        },
      },
    }],
  });
  forecaster.forecastInputBatches.push({
    inputs: [], cursor: "0", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: false, resetReason: null,
  }, {
    inputs: [notificationForecastInput(1, 0.4)], cursor: "1", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: false, resetReason: null,
  });
  await runtime.pollForecastInputsOnce();
  await runtime.pollForecastInputsOnce();
  assert.deepEqual(forecaster.forecastInputRequests, [{
    after: null,
    horizonHours: [4, 24],
  }, {
    after: "0",
    horizonHours: [4, 24],
  }]);
  const state = await stateStore.read();
  for (const chatId of ["20", "21", "22"]) {
    assert.equal(
      state.dynamic_subscriptions[chatId].probability_watch.last_probability,
      0.4,
    );
  }
  assert.equal(state.outbox.some((job) => job.kind === "probability"), false);
});

test("Telegram replays each input outcome gate and queues only the current reopened cycle", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{
      chatId: "20",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 4,
          probability_threshold: 0.6,
        },
      },
    }],
  });
  await stateStore.baselineForecastInputs({
    cursor: "0",
    outcomeRevisionGate: forecastGate(),
  });
  const confirmedOutcome = {
    outcome_ref: { record_id: "reset-outcome-1", revision: 1 },
    outcome_token: "reset-outcome-1@1",
    status: "eligible_confirmed",
    known_at: "2026-08-10T03:44:00.000Z",
    occurred_time_range: {
      start: "2026-08-10T03:42:00.000Z",
      end: "2026-08-10T03:43:00.000Z",
    },
  };
  const confirmedGate = forecastGate({
    revisionToken: "outcome-gate-confirmed",
    latestKnownAt: confirmedOutcome.known_at,
    closesEpisode: true,
    currentOutcomes: [confirmedOutcome],
  });
  forecaster.forecastInputBatches.push({
    inputs: [
      notificationForecastInput(1, 0.4, {
        issuedAt: "2026-08-10T03:40:00.000Z",
      }),
      notificationForecastInput(2, 0.7, {
        issuedAt: "2026-08-10T03:41:00.000Z",
      }),
      notificationForecastInput(3, 0.7, {
        issuedAt: "2026-08-10T03:45:00.000Z",
        outcomeRevisionGate: confirmedGate,
      }),
      notificationForecastInput(4, 0.7, {
        issuedAt: "2026-08-10T03:46:00.000Z",
        outcomeRevisionGate: confirmedGate,
      }),
    ],
    cursor: "4",
    hasMore: false,
    outcomeRevisionGate: confirmedGate,
    resetRequired: false,
    resetReason: null,
  });
  assert.deepEqual(await runtime.pollForecastInputsOnce(), {
    baseline: false,
    reset: false,
    inputs: 4,
    jobs: 1,
    hasMore: false,
  });
  const state = await stateStore.read();
  const jobs = state.outbox.filter((job) => job.kind === "probability");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].outcome_revision_token, confirmedGate.revision_token);
  assert.match(jobs[0].text, /03:46/);
  const watch = state.dynamic_subscriptions["20"].probability_watch;
  assert.equal(watch.active, true);
  assert.equal(watch.last_prediction_key, "prediction-4@1");
  assert.equal(watch.outcome_revision_token, confirmedGate.revision_token);
});

test("Telegram advances a cursor-only baseline without fetching probabilities when no rule needs them", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  forecaster.forecastInputBatches.push({
    inputs: [], cursor: "12", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: false, resetReason: null,
  });
  assert.deepEqual(await runtime.pollForecastInputsOnce(), {
    baseline: true,
    reset: false,
    inputs: 0,
    jobs: 0,
  });
  assert.deepEqual(forecaster.forecastInputRequests, [{
    after: null,
    horizonHours: [],
  }]);
  assert.equal((await stateStore.read()).forecast_input_cursor, "12");
});

test("changing a probability rule invalidates pending jobs and rebaselines", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{
      chatId: "20",
      value: { experimental: true },
    }],
  });
  forecaster.forecastInputBatches.push({
    inputs: [],
    cursor: "0",
    hasMore: false,
    outcomeRevisionGate: forecastGate(),
    resetRequired: false,
    resetReason: null,
  }, {
    inputs: [notificationForecastInput(1, 0.4)],
    cursor: "1",
    hasMore: false,
    outcomeRevisionGate: forecastGate(),
    resetRequired: false,
    resetReason: null,
  }, {
    inputs: [notificationForecastInput(2, 0.7)],
    cursor: "2",
    hasMore: false,
    outcomeRevisionGate: forecastGate(),
    resetRequired: false,
    resetReason: null,
  });
  await runtime.pollForecastInputsOnce();
  await runtime.pollForecastInputsOnce();
  await runtime.pollForecastInputsOnce();
  assert.equal(
    (await stateStore.read()).outbox.find((job) => job.kind === "probability")
      .status,
    "pending",
  );

  await stateStore.commitUpdateBatch({
    nextUpdateId: 2,
    subscriptionChanges: [{
      chatId: "20",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 24,
          probability_threshold: 0.8,
        },
      },
    }],
  });
  const state = await stateStore.read();
  assert.equal(state.dynamic_subscriptions["20"].generation, 2);
  assert.equal(state.dynamic_subscriptions["20"].probability_watch, null);
  const oldJob = state.outbox.find((job) => job.kind === "probability");
  assert.equal(oldJob.status, "dead");
  assert.equal(oldJob.last_error, "subscription_changed");
});

test("a rule changed during a lazy horizon request waits for a fresh silent baseline", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{ chatId: "20", value: { experimental: true } }],
  });
  await stateStore.baselineForecastInputs({
    cursor: "0",
    outcomeRevisionGate: forecastGate(),
  });
  let releaseRequest;
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  forecaster.getForecastInputs = async (after, { horizonHours }) => {
    requestStarted({ after, horizonHours });
    await new Promise((resolve) => {
      releaseRequest = resolve;
    });
    return {
      inputs: [projectForecastInput(
        notificationForecastInput(1, 0.7),
        horizonHours,
      )],
      cursor: "1",
      hasMore: false,
      outcomeRevisionGate: forecastGate(),
      resetRequired: false,
      resetReason: null,
    };
  };
  const polling = runtime.pollForecastInputsOnce();
  assert.deepEqual(await started, { after: "0", horizonHours: [4] });
  await stateStore.commitUpdateBatch({
    nextUpdateId: 2,
    subscriptionChanges: [{
      chatId: "20",
      value: {
        probability_preferences: {
          schema_version: "notification-preferences/1",
          horizon_hours: 4,
          probability_threshold: 0.8,
        },
      },
    }],
  });
  releaseRequest();
  await polling;
  let state = await stateStore.read();
  assert.equal(state.forecast_input_cursor, "1");
  assert.equal(state.dynamic_subscriptions["20"].probability_watch, null);
  assert.equal(state.outbox.some((job) => job.kind === "probability"), false);

  forecaster.getForecastInputs = async (_after, { horizonHours }) => ({
    inputs: [projectForecastInput(
      notificationForecastInput(2, 0.9),
      horizonHours,
    )],
    cursor: "2",
    hasMore: false,
    outcomeRevisionGate: forecastGate(),
    resetRequired: false,
    resetReason: null,
  });
  await runtime.pollForecastInputsOnce();
  state = await stateStore.read();
  assert.equal(state.dynamic_subscriptions["20"].probability_watch.active, true);
  assert.equal(state.dynamic_subscriptions["20"].probability_watch.open_notification_emitted, false);
  assert.equal(state.outbox.some((job) => job.kind === "probability"), false);
});

test("forecast input cursor resets drop pending personalized delivery and watches", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{ chatId: "20", value: { experimental: true } }],
  });
  forecaster.forecastInputBatches.push({
    inputs: [], cursor: "0", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: false, resetReason: null,
  }, {
    inputs: [notificationForecastInput(1, 0.4)], cursor: "1", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: false, resetReason: null,
  }, {
    inputs: [notificationForecastInput(2, 0.7)], cursor: "2", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: false, resetReason: null,
  }, {
    inputs: [], cursor: "10", hasMore: false,
    outcomeRevisionGate: forecastGate(), resetRequired: true,
    resetReason: "retention_gap",
  });
  await runtime.pollForecastInputsOnce();
  await runtime.pollForecastInputsOnce();
  await runtime.pollForecastInputsOnce();
  assert.deepEqual(await runtime.pollForecastInputsOnce(), {
    baseline: true,
    reset: true,
    inputs: 0,
    jobs: 0,
  });
  const state = await stateStore.read();
  assert.equal(state.forecast_input_cursor, "10");
  assert.equal(state.forecast_input_cursor_reset_reason, "retention_gap");
  assert.equal(state.dynamic_subscriptions["20"].probability_watch, null);
  const oldJob = state.outbox.find((job) => job.kind === "probability");
  assert.equal(oldJob.status, "dead");
  assert.equal(oldJob.last_error, "forecast_input_cursor_reset");
});

test("long polling fails closed when a webhook is configured", async (t) => {
  const directory = await temporaryDirectory(t);
  const telegram = new FakeTelegram();
  telegram.webhook = { url: "https://example.test/telegram" };
  const runtime = new TelegramBotRuntime({
    telegram,
    forecaster: new FakeForecaster(),
    stateStore: new TelegramStateStore({ directory }),
    config: runtimeConfig(),
    logger: { error() {} },
  });
  await assert.rejects(runtime.initialize(), /webhook is configured/);
});

test("event polling establishes a no-replay baseline and gates experimental delivery", async (t) => {
  const config = runtimeConfig({
    allowedGroupChatIds: new Set(["-200"]),
    staticExperimentalChatIds: new Set(["-200"]),
  });
  const { runtime, telegram, forecaster, stateStore } = await setupRuntime(t, {
    config,
  });
  telegram.updateBatches.push([{
    update_id: 10,
    message: {
      from: { id: 10 },
      chat: { id: 10, type: "private" },
      text: "/subscribe experimental",
    },
  }]);
  await runtime.pollUpdatesOnce();
  forecaster.eventBatches.push({
    events: [{ event_id: "pub_old" }],
    cursor: "5",
    hasMore: false,
  });
  assert.deepEqual(await runtime.pollEventsOnce(), {
    baseline: true,
    events: 1,
    jobs: 0,
  });
  forecaster.eventBatches.push({
    events: [
      {
        event_id: "pub_stable",
        topic: "outcome",
        experimental: false,
        emitted_at: "2026-08-10T04:01:00Z",
        expires_at: "2026-08-10T05:00:00Z",
        report: {
          title: "确认重置",
          summary: "已确认新的平台重置。",
          public_url: "https://forecast.example.test/accuracy",
          default_delivery: true,
        },
      },
      {
        event_id: "pub_experimental",
        topic: "experimental_probability",
        experimental: true,
        emitted_at: "2026-08-10T04:02:00Z",
        expires_at: "2026-08-10T05:00:00Z",
        report: {
          title: "概率观察",
          summary: "未来窗口概率上升。",
          default_delivery: false,
        },
      },
      {
        event_id: "pub_expired",
        topic: "outcome",
        experimental: false,
        emitted_at: "2026-08-10T03:50:00Z",
        expires_at: "2026-08-10T03:59:00Z",
        report: { title: "过期事件", summary: "不应入队", default_delivery: true },
      },
    ],
    cursor: "8",
    hasMore: false,
  });
  const result = await runtime.pollEventsOnce();
  assert.deepEqual(result, { baseline: false, events: 3, jobs: 3 });
  const state = await stateStore.read();
  assert.equal(state.event_cursor, "8");
  const eventJobs = state.outbox.filter((job) => job.kind === "event");
  assert.deepEqual(
    eventJobs.map((job) => job.chat_id).sort(),
    ["-200", "-200", "10"],
  );
  assert.equal(eventJobs.filter((job) => /实验性通知/.test(job.text)).length, 1);
});

test("an event that expires in the outbox is marked dead before Telegram send", async (t) => {
  let current = new Date("2026-08-10T04:00:00Z");
  const now = () => new Date(current);
  const { runtime, telegram, stateStore } = await setupRuntime(t, {
    now,
    config: runtimeConfig({
      staticNotificationChatIds: new Set(["10"]),
    }),
  });
  await stateStore.commitEvents({
    cursor: "9",
    jobs: [{
      id: "event:pub_short:10",
      kind: "event",
      chatId: "10",
      eventTopic: "outcome",
      experimental: false,
      text: "short-lived event",
      expiresAt: "2026-08-10T04:00:05Z",
    }],
  });
  current = new Date("2026-08-10T04:00:06Z");
  assert.equal(await runtime.dispatchOnce(), true);
  const state = await stateStore.read();
  assert.equal(state.outbox[0].status, "dead");
  assert.equal(state.outbox[0].last_error, "event_expired");
  assert.equal(telegram.sent.length, 0);
});

test("outbox honors retry_after then marks a non-retryable Telegram failure dead", async (t) => {
  let current = new Date("2026-08-10T04:00:00Z");
  const now = () => new Date(current);
  const { runtime, telegram, stateStore } = await setupRuntime(t, { now });
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    jobs: [{ id: "command:0", kind: "command", chatId: "10", text: "test" }],
  });
  telegram.sendErrors.push(
    new TelegramApiError("Too Many Requests", {
      status: 429,
      retryAfter: 7,
      retryable: true,
    }),
    new TelegramApiError("Forbidden", {
      status: 403,
      retryable: false,
    }),
  );
  await runtime.dispatchOnce();
  let state = await stateStore.read();
  assert.equal(state.outbox[0].status, "retry");
  assert.equal(state.outbox[0].not_before, "2026-08-10T04:00:07.000Z");
  current = new Date("2026-08-10T04:00:08Z");
  await runtime.dispatchOnce();
  state = await stateStore.read();
  assert.equal(state.outbox[0].status, "dead");
  assert.equal(state.outbox[0].attempts, 2);
});

test("an operations alert is not retried beyond its expiry", async (t) => {
  const config = runtimeConfig({
    operationsAlertsEnabled: true,
    operationsToken: "o".repeat(40),
  });
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  await stateStore.commitOperationsAlerts({
    cursor: "1",
    jobs: [{
      id: "operations:g0:expiry:10",
      kind: "operations_alert",
      chatId: "10",
      text: "short operations alert",
      expiresAt: "2026-08-10T04:00:30Z",
    }],
  });
  telegram.sendErrors.push(new TelegramApiError("Too Many Requests", {
    status: 429,
    retryAfter: 60,
    retryable: true,
  }));
  await runtime.dispatchOnce();
  const state = await stateStore.read();
  assert.equal(state.outbox[0].status, "dead");
  assert.equal(state.outbox[0].last_error, "operations_alert_expired");
});

test("a sending job is recovered for at-least-once delivery after restart", async (t) => {
  const directory = await temporaryDirectory(t);
  const now = () => new Date("2026-08-10T04:00:00Z");
  const first = await new TelegramStateStore({ directory, now }).init();
  await first.commitUpdateBatch({
    nextUpdateId: 2,
    jobs: [{ id: "command:1", kind: "command", chatId: "10", text: "hello" }],
  });
  assert.equal((await first.claimDueJob()).status, "sending");
  const second = await new TelegramStateStore({ directory, now }).init();
  const state = await second.read();
  assert.equal(state.outbox[0].status, "retry");
  assert.equal(state.outbox[0].last_error, "recovered_after_restart");
});

test("heartbeat healthcheck accepts fresh state and rejects stale state", async (t) => {
  const directory = await temporaryDirectory(t);
  let current = new Date("2026-08-10T04:00:00Z");
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  const env = {
    TELEGRAM_BOT_DATA_DIR: directory,
    TELEGRAM_HEARTBEAT_MAX_AGE_SECONDS: "60",
    TELEGRAM_UPDATE_POLL_MAX_AGE_SECONDS: "60",
    TELEGRAM_EVENT_POLL_MAX_AGE_SECONDS: "90",
  };
  assert.equal(await checkTelegramHeartbeat({ env, now: () => current }), true);
  current = new Date("2026-08-10T04:02:00Z");
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /missing or stale/,
  );
});

test("healthcheck detects stalled update and event polling independently", async (t) => {
  const directory = await temporaryDirectory(t);
  let current = new Date("2026-08-10T04:00:00Z");
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  const env = {
    TELEGRAM_BOT_DATA_DIR: directory,
    TELEGRAM_HEARTBEAT_MAX_AGE_SECONDS: "60",
    TELEGRAM_UPDATE_POLL_MAX_AGE_SECONDS: "60",
    TELEGRAM_EVENT_POLL_MAX_AGE_SECONDS: "90",
  };

  current = new Date("2026-08-10T04:02:00Z");
  await store.heartbeat();
  await store.recordEventPoll();
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /update poll is missing or stale/,
  );
  await store.recordUpdatePoll();
  assert.equal(await checkTelegramHeartbeat({ env, now: () => current }), true);

  current = new Date("2026-08-10T04:04:00Z");
  await store.heartbeat();
  await store.recordUpdatePoll();
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /event poll is missing or stale/,
  );
});

test("healthcheck requires the operations alert poll only when enabled", async (t) => {
  const directory = await temporaryDirectory(t);
  const current = new Date("2026-08-10T04:00:00Z");
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  const env = {
    TELEGRAM_BOT_DATA_DIR: directory,
    TELEGRAM_OPERATIONS_ALERTS_ENABLED: "true",
  };
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /operations alert poll is missing or stale/,
  );
  await store.baselineOperationsAlerts("0");
  assert.equal(
    await checkTelegramHeartbeat({ env, now: () => current }),
    true,
  );
});

test("operations health age follows a configured slow poll interval", async (t) => {
  const directory = await temporaryDirectory(t);
  let current = new Date("2026-08-10T04:00:00Z");
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  await store.baselineOperationsAlerts("0");
  const env = {
    TELEGRAM_BOT_DATA_DIR: directory,
    TELEGRAM_OPERATIONS_ALERTS_ENABLED: "true",
    TELEGRAM_OPERATIONS_ALERT_POLL_INTERVAL_MS: "300000",
    TELEGRAM_REQUEST_TIMEOUT_MS: "120000",
    TELEGRAM_HEARTBEAT_MAX_AGE_SECONDS: "600",
    TELEGRAM_UPDATE_POLL_MAX_AGE_SECONDS: "600",
    TELEGRAM_EVENT_POLL_MAX_AGE_SECONDS: "600",
    TELEGRAM_FORECAST_INPUT_POLL_MAX_AGE_SECONDS: "600",
  };
  current = new Date("2026-08-10T04:07:20Z");
  assert.equal(await checkTelegramHeartbeat({ env, now: () => current }), true);
  current = new Date("2026-08-10T04:07:31Z");
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /operations alert poll is missing or stale/,
  );
});

test("healthcheck detects a stuck or failed administrator alert delivery", async (t) => {
  const directory = await temporaryDirectory(t);
  let current = new Date("2026-08-10T04:00:00Z");
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  await store.commitOperationsAlerts({
    cursor: "1",
    jobs: [{
      id: "operations:health:10",
      kind: "operations_alert",
      chatId: "10",
      text: "capacity alert",
      expiresAt: "2026-08-11T04:00:00Z",
    }],
  });
  const env = {
    TELEGRAM_BOT_DATA_DIR: directory,
    TELEGRAM_OPERATIONS_ALERTS_ENABLED: "true",
  };
  current = new Date("2026-08-10T04:01:01Z");
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /outbox dispatch is stale/,
  );
  await store.markDead("operations:health:10", "telegram forbidden");
  await assert.rejects(
    checkTelegramHeartbeat({ env, now: () => current }),
    /recent failed operations alert/,
  );
});

test("healthcheck rejects an operations retry that already missed expiry", async (t) => {
  const directory = await temporaryDirectory(t);
  let current = new Date("2026-08-10T04:00:00Z");
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  await store.commitOperationsAlerts({
    cursor: "1",
    jobs: [{
      id: "operations:g0:missed:10",
      kind: "operations_alert",
      chatId: "10",
      text: "missed operations alert",
      expiresAt: "2026-08-10T04:01:00Z",
    }],
  });
  await store.claimDueJob();
  await store.markRetry("operations:g0:missed:10", {
    notBefore: "2026-08-10T05:00:00Z",
    error: "provider unavailable",
  });
  current = new Date("2026-08-10T04:02:00Z");
  await store.heartbeat();
  await store.recordUpdatePoll();
  await store.recordEventPoll();
  await store.recordOperationsAlertPoll();
  await assert.rejects(
    checkTelegramHeartbeat({
      env: {
        TELEGRAM_BOT_DATA_DIR: directory,
        TELEGRAM_OPERATIONS_ALERTS_ENABLED: "true",
      },
      now: () => current,
    }),
    /missed an operations alert expiry/,
  );
});

test("a recent operations delivery failure survives public terminal-job pruning", async (t) => {
  const directory = await temporaryDirectory(t);
  let current = new Date("2026-08-10T04:00:00Z");
  const first = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await first.commitOperationsAlerts({
    cursor: "1",
    jobs: [{
      id: "operations:g0:failure:10",
      kind: "operations_alert",
      chatId: "10",
      text: "failed operations alert",
      expiresAt: "2026-08-10T05:00:00Z",
    }],
  });
  await first.markDead("operations:g0:failure:10", "telegram forbidden");
  const fixture = await first.read();
  const template = fixture.outbox[0];
  for (let index = 0; index < 260; index += 1) {
    fixture.outbox.push({
      ...template,
      id: `command:prune:${index}`,
      dedupe_key: `command:prune:${index}`,
      kind: "command",
      event_topic: null,
      experimental: false,
      text: "ordinary reply",
      status: "delivered",
      last_error: null,
      expires_at: null,
      updated_at: `2026-08-10T04:01:${String(index % 60).padStart(2, "0")}Z`,
      telegram_message_id: index + 1,
    });
  }
  fixture.heartbeat_at = "2026-08-10T04:02:00Z";
  fixture.last_update_poll_at = "2026-08-10T04:02:00Z";
  fixture.last_event_poll_at = "2026-08-10T04:02:00Z";
  fixture.last_operations_alert_poll_at = "2026-08-10T04:02:00Z";
  await fs.writeFile(
    path.join(directory, "state.json"),
    `${JSON.stringify(fixture)}\n`,
    { mode: 0o600 },
  );
  current = new Date("2026-08-10T04:02:00Z");
  const second = await new TelegramStateStore({
    directory,
    now: () => new Date(current),
  }).init();
  await second.heartbeat();
  const pruned = await second.read();
  assert.equal(
    pruned.outbox.some((job) => job.id === "operations:g0:failure:10"),
    false,
  );
  assert.equal(
    pruned.last_operations_delivery_failure_error,
    "telegram forbidden",
  );
  await assert.rejects(
    checkTelegramHeartbeat({
      env: {
        TELEGRAM_BOT_DATA_DIR: directory,
        TELEGRAM_OPERATIONS_ALERTS_ENABLED: "true",
      },
      now: () => current,
    }),
    /recent failed operations alert/,
  );
});

test("event enqueue observes an unsubscribe committed while the HTTP poll is in flight", async (t) => {
  const { runtime, forecaster, stateStore } = await setupRuntime(t);
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{ chatId: "10", value: { experimental: false } }],
  });
  forecaster.eventBatches.push({ events: [], cursor: "0", hasMore: false });
  await runtime.pollEventsOnce();

  let resolveEvents;
  forecaster.getNotificationEvents = () => new Promise((resolve) => {
    resolveEvents = resolve;
  });
  const polling = runtime.pollEventsOnce();
  while (!resolveEvents) await Promise.resolve();
  await stateStore.commitUpdateBatch({
    nextUpdateId: 2,
    subscriptionChanges: [{
      chatId: "10",
      value: null,
      cancelPendingEvents: true,
    }],
  });
  resolveEvents({
    events: [{
      event_id: "pub_after_unsubscribe",
      topic: "outcome",
      experimental: false,
      emitted_at: "2026-08-10T04:01:00Z",
      expires_at: "2026-08-10T05:00:00Z",
      report: { default_delivery: true },
      notification: { title: "确认重置", body: "不应入队" },
    }],
    cursor: "1",
    hasMore: false,
  });
  assert.deepEqual(await polling, { baseline: false, events: 1, jobs: 0 });
  const state = await stateStore.read();
  assert.equal(state.event_cursor, "1");
  assert.equal(state.outbox.filter((job) => job.kind === "event").length, 0);
});

test("unsubscribe cancels queued event jobs but keeps its command reply", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new TelegramStateStore({
    directory,
    now: () => new Date("2026-08-10T04:00:00Z"),
  }).init();
  await store.commitEvents({
    cursor: "1",
    jobs: [{
      id: "event:one:10",
      kind: "event",
      chatId: "10",
      eventTopic: "outcome",
      experimental: false,
      text: "pending event",
    }],
  });
  await store.commitUpdateBatch({
    nextUpdateId: 2,
    jobs: [{
      id: "command:1",
      kind: "command",
      chatId: "10",
      text: "已取消动态订阅。",
    }],
    subscriptionChanges: [{
      chatId: "10",
      value: null,
      cancelPendingEvents: true,
    }],
  });
  const state = await store.read();
  assert.equal(state.outbox.find((job) => job.kind === "event").status, "dead");
  assert.equal(state.outbox.find((job) => job.kind === "command").status, "pending");
});

test("unsubscribe preserves queued notifications for a statically subscribed chat", async (t) => {
  const config = runtimeConfig({
    staticNotificationChatIds: new Set(["10"]),
  });
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  await stateStore.commitEvents({
    cursor: "1",
    jobs: [{
      id: "event:static:10",
      kind: "event",
      chatId: "10",
      eventTopic: "outcome",
      experimental: false,
      expiresAt: "2026-08-10T05:00:00Z",
      text: "static pending event",
    }],
  });
  telegram.updateBatches.push([{
    update_id: 1,
    message: {
      from: { id: 10 },
      chat: { id: 10, type: "private" },
      text: "/unsubscribe",
    },
  }]);
  await runtime.pollUpdatesOnce();
  let state = await stateStore.read();
  assert.equal(state.outbox.find((job) => job.kind === "event").status, "pending");
  assert.match(
    state.outbox.find((job) => job.kind === "command").text,
    /仍有静态配置的通知/,
  );
  await runtime.dispatchOnce();
  await runtime.dispatchOnce();
  state = await stateStore.read();
  assert.equal(state.outbox.find((job) => job.kind === "event").status, "delivered");
  assert.equal(telegram.sent.length, 2);
});

test("dispatch rechecks the current chat allowlist before sending a durable job", async (t) => {
  const config = runtimeConfig({
    staticNotificationChatIds: new Set(["10"]),
  });
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  await stateStore.commitEvents({
    cursor: "1",
    jobs: [{
      id: "event:one:10",
      kind: "event",
      chatId: "10",
      eventTopic: "outcome",
      experimental: false,
      text: "must not send",
    }],
  });
  config.adminUserIds.delete("10");
  assert.equal(await runtime.dispatchOnce(), true);
  const state = await stateStore.read();
  assert.equal(state.outbox[0].last_error, "recipient_not_authorized");
  assert.equal(telegram.sent.length, 0);
});

test("a bot data volume is bound to one Telegram bot identity", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = await new TelegramStateStore({ directory }).init();
  await first.bindBotIdentity(1);
  const telegram = new FakeTelegram();
  telegram.getMe = async () => ({ id: 2, username: "another_bot" });
  const runtime = new TelegramBotRuntime({
    telegram,
    forecaster: new FakeForecaster(),
    stateStore: new TelegramStateStore({ directory }),
    config: runtimeConfig(),
    logger: { error() {} },
  });
  await assert.rejects(runtime.initialize(), /state belongs to bot 1/);
});

test("Telegram HTTP body reads stay bounded by timeout and byte limit", async () => {
  const slow = new TelegramClient({
    token: "123456:abcdefghijklmnopqrstuvwxyz_ABCD",
    requestTimeoutMs: 20,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        const abort = () => controller.error(new Error("aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
    }), { status: 200 }),
  });
  await assert.rejects(
    slow.getMe(),
    (error) => error.code === "TIMEOUT",
  );

  const oversized = new TelegramClient({
    token: "123456:abcdefghijklmnopqrstuvwxyz_ABCD",
    requestTimeoutMs: 1_000,
    maxResponseBytes: 64,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(128));
        controller.close();
      },
    }), { status: 200 }),
  });
  await assert.rejects(
    oversized.getMe(),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("Forecaster notification cursors are canonical, monotonic, and make paged progress", async () => {
  function client(payload) {
    return new ForecasterClient({
      apiBase: "http://forecaster.test",
      fetchImpl: async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
  }
  assert.deepEqual(
    await client({
      events: [],
      cursor: 11,
      next_cursor: "11",
      has_more: false,
    }).getNotificationEvents("10"),
    { events: [], cursor: "11", hasMore: false },
  );
  for (const payload of [
    { events: [], cursor: 5, next_cursor: "5", has_more: false },
    { events: [], cursor: 10, next_cursor: "10", has_more: true },
    { events: [], cursor: 11, next_cursor: "011", has_more: false },
    { events: [], cursor: "11", next_cursor: "11", has_more: false },
  ]) {
    await assert.rejects(
      client(payload).getNotificationEvents("10"),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
  await assert.rejects(
    client({
      events: [{ event_id: "unexpected" }],
      cursor: 11,
      next_cursor: "11",
      has_more: false,
    }).getNotificationEvents(),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("Forecaster forecast input cursor responses preserve the current outcome gate", async () => {
  const gate = forecastGate({
    revisionToken: "outcome_gate_test",
    latestKnownAt: "2026-08-10T03:30:00.000Z",
  });
  const input = notificationForecastInput(2, 0.6);
  const client = new ForecasterClient({
    apiBase: "http://forecaster.test",
    fetchImpl: async () => new Response(JSON.stringify({
      inputs: [input],
      cursor: 2,
      next_cursor: "2",
      has_more: false,
      outcome_revision_gate: gate,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.deepEqual(await client.getForecastInputs("1"), {
    inputs: [input],
    cursor: "2",
    hasMore: false,
    outcomeRevisionGate: gate,
    resetRequired: false,
    resetReason: null,
  });

  const resetClient = new ForecasterClient({
    apiBase: "http://forecaster.test",
    fetchImpl: async () => new Response(JSON.stringify({
      error: "forecast_input_cursor_reset_required",
      reason: "retention_gap",
      cursor: 8,
      next_cursor: "8",
      has_more: false,
      outcome_revision_gate: gate,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.deepEqual(await resetClient.getForecastInputs("1"), {
    inputs: [],
    cursor: "8",
    hasMore: false,
    outcomeRevisionGate: gate,
    resetRequired: true,
    resetReason: "retention_gap",
  });
});

test("Forecaster forecast input requests bind and validate a sparse horizon projection", async () => {
  const gate = forecastGate();
  const input = projectForecastInput(
    notificationForecastInput(2, 0.6),
    [4, 24],
  );
  let requestedUrl = null;
  const client = new ForecasterClient({
    apiBase: "http://forecaster.test",
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({
        inputs: [input],
        cursor: 2,
        next_cursor: "2",
        has_more: false,
        horizon_hours: [4, 24],
        outcome_revision_gate: gate,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.getForecastInputs("1", {
    horizonHours: [24, 4],
  });
  assert.deepEqual(requestedUrl.searchParams.getAll("horizon_hours"), ["4", "24"]);
  assert.equal(Object.hasOwn(result.inputs[0], "probabilities"), false);
  assert.deepEqual(result.inputs[0].horizon_probabilities, [
    { horizon_hours: 4, probability: 0.6 },
    { horizon_hours: 24, probability: 0.6 },
  ]);
  assert.deepEqual(result.inputs[0].outcome_revision_gate, gate);

  const invalidClient = new ForecasterClient({
    apiBase: "http://forecaster.test",
    fetchImpl: async () => new Response(JSON.stringify({
      inputs: [{
        ...input,
        horizon_probabilities: [input.horizon_probabilities[1]],
      }],
      cursor: 2,
      next_cursor: "2",
      has_more: false,
      horizon_hours: [4, 24],
      outcome_revision_gate: gate,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    invalidClient.getForecastInputs("1", { horizonHours: [4, 24] }),
    (error) => error.code === "INVALID_RESPONSE",
  );
  const invalidInputGateClient = new ForecasterClient({
    apiBase: "http://forecaster.test",
    fetchImpl: async () => new Response(JSON.stringify({
      inputs: [{
        ...input,
        outcome_revision_gate: {
          ...gate,
          current_outcomes: "not-an-array",
        },
      }],
      cursor: 2,
      next_cursor: "2",
      has_more: false,
      horizon_hours: [4, 24],
      outcome_revision_gate: gate,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    invalidInputGateClient.getForecastInputs("1", {
      horizonHours: [4, 24],
    }),
    (error) => error.code === "INVALID_RESPONSE",
  );
  await assert.rejects(
    client.getForecastInputs("1", { horizonHours: [] }),
    /require at least one requested horizon/,
  );
});

test("Forecaster operations requests alone receive the separate bearer token", async () => {
  const requests = [];
  const client = new ForecasterClient({
    apiBase: "http://forecaster.test",
    operationsToken: "s".repeat(40),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.authorization });
      const pathname = new URL(url).pathname;
      const payload = pathname.endsWith("/alerts")
        ? { alerts: [], cursor: 4, next_cursor: "4", has_more: false }
        : pathname.endsWith("/traffic")
        ? { observed_at: "2026-08-10T04:00:00Z", current: { requests: 1 } }
        : { status: "ok" };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.getHealth();
  await client.getTraffic();
  assert.deepEqual(await client.getOperationsAlerts(), {
    alerts: [],
    cursor: "4",
    hasMore: false,
  });
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[1].authorization, `Bearer ${"s".repeat(40)}`);
  assert.equal(requests[2].authorization, `Bearer ${"s".repeat(40)}`);
});

test("Forecaster operations cursor reset responses are explicit and bounded", async () => {
  const client = new ForecasterClient({
    apiBase: "http://forecaster.test",
    operationsToken: "s".repeat(40),
    fetchImpl: async () => new Response(JSON.stringify({
      error: "operations_alert_cursor_reset_required",
      reason: "ahead_of_tail",
      cursor: 3,
      next_cursor: "3",
      has_more: false,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.deepEqual(await client.getOperationsAlerts("9"), {
    alerts: [],
    cursor: "3",
    hasMore: false,
    resetRequired: true,
    resetReason: "ahead_of_tail",
  });
});

test("operations alerts establish their own baseline and preempt public delivery", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, telegram, forecaster, stateStore } = await setupRuntime(t, {
    config,
  });
  forecaster.operationsAlertBatches.push({
    alerts: [],
    cursor: "3",
    hasMore: false,
  });
  assert.deepEqual(await runtime.pollOperationsAlertsOnce(), {
    baseline: true,
    alerts: 0,
    jobs: 0,
  });
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    jobs: [{
      id: "command:public",
      kind: "command",
      chatId: "20",
      text: "ordinary reply",
    }],
  });
  forecaster.operationsAlertBatches.push({
    alerts: [{
      alert_id: "traffic-pressure-4",
      level: "warning",
      title: "容量压力升高",
      summary: "请求增长进入观察区间。",
      observed_at: "2026-08-10T04:01:00Z",
      expires_at: "2026-08-10T05:00:00Z",
    }],
    cursor: "4",
    hasMore: false,
  });
  assert.deepEqual(await runtime.pollOperationsAlertsOnce(), {
    baseline: false,
    alerts: 1,
    jobs: 1,
  });
  let state = await stateStore.read();
  assert.equal(state.operations_alert_cursor, "4");
  assert.equal(state.event_cursor, null);
  assert.equal(
    state.outbox.filter((job) => job.kind === "operations_alert").length,
    1,
  );
  assert.equal(await runtime.dispatchOnce(), true);
  assert.equal(telegram.sent[0].chatId, "10");
  assert.match(telegram.sent[0].text, /容量运维提醒/);
  state = await stateStore.read();
  assert.equal(
    state.outbox.find((job) => job.kind === "operations_alert").status,
    "delivered",
  );
});

test("operations cursor gaps are recorded and rebased without an infinite retry", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, forecaster, stateStore } = await setupRuntime(t, { config });
  forecaster.operationsAlertBatches.push({
    alerts: [],
    cursor: "9",
    hasMore: false,
  });
  await runtime.pollOperationsAlertsOnce();
  forecaster.operationsAlertBatches.push({
    alerts: [],
    cursor: "3",
    hasMore: false,
    resetRequired: true,
    resetReason: "ahead_of_tail",
  });
  assert.deepEqual(await runtime.pollOperationsAlertsOnce(), {
    baseline: true,
    reset: true,
    alerts: 0,
    jobs: 1,
  });
  const state = await stateStore.read();
  assert.equal(state.operations_alert_cursor, "3");
  assert.equal(state.operations_alert_generation, 1);
  assert.equal(state.operations_alert_cursor_reset_reason, "ahead_of_tail");
  assert.ok(state.operations_alert_cursor_reset_at);
  assert.equal(
    state.outbox.filter((job) => job.kind === "operations_alert").length,
    1,
  );
});

test("operations alert polling drains bounded continuation pages immediately", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, forecaster, stateStore } = await setupRuntime(t, { config });
  forecaster.operationsAlertBatches.push({ alerts: [], cursor: "0", hasMore: false });
  await runtime.pollOperationsAlertsOnce();
  forecaster.operationsAlertBatches.push(
    {
      alerts: [{
        alert_id: "traffic:1",
        level: "strained",
        title: "容量压力",
        summary: "first page",
        observed_at: "2026-08-10T04:00:00Z",
        expires_at: "2026-08-10T05:00:00Z",
      }],
      cursor: "1",
      hasMore: true,
    },
    {
      alerts: [{
        alert_id: "traffic:2",
        level: "critical",
        title: "容量严重压力",
        summary: "second page",
        observed_at: "2026-08-10T04:01:00Z",
        expires_at: "2026-08-10T05:00:00Z",
      }],
      cursor: "2",
      hasMore: false,
    },
  );
  assert.deepEqual(await runtime.pollOperationsAlertsOnce(), {
    baseline: false,
    alerts: 2,
    jobs: 2,
  });
  const state = await stateStore.read();
  assert.equal(state.operations_alert_cursor, "2");
  assert.equal(
    state.outbox.filter((job) => job.kind === "operations_alert").length,
    2,
  );
});

test("operations pagination persists five pages then resumes safely next poll", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, forecaster, stateStore } = await setupRuntime(t, { config });
  forecaster.operationsAlertBatches.push({ alerts: [], cursor: "0", hasMore: false });
  await runtime.pollOperationsAlertsOnce();
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    forecaster.operationsAlertBatches.push({
      alerts: [{
        alert_id: `traffic:${sequence}`,
        level: "strained",
        title: "容量压力",
        summary: `page ${sequence}`,
        observed_at: `2026-08-10T04:0${sequence}:00Z`,
        expires_at: "2026-08-10T05:00:00Z",
      }],
      cursor: String(sequence),
      hasMore: sequence < 6,
    });
  }
  await assert.rejects(
    runtime.pollOperationsAlertsOnce(),
    /pagination exceeded the safe page limit/,
  );
  let state = await stateStore.read();
  assert.equal(state.operations_alert_cursor, "5");
  assert.equal(
    state.outbox.filter((job) => job.kind === "operations_alert").length,
    5,
  );
  assert.deepEqual(await runtime.pollOperationsAlertsOnce(), {
    baseline: false,
    alerts: 1,
    jobs: 1,
  });
  state = await stateStore.read();
  assert.equal(state.operations_alert_cursor, "6");
  assert.equal(
    state.outbox.filter((job) => job.kind === "operations_alert").length,
    6,
  );
});

test("a retention gap warns then replays every still-retained operations page", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, forecaster, stateStore } = await setupRuntime(t, { config });
  forecaster.operationsAlertBatches.push({ alerts: [], cursor: "9", hasMore: false });
  await runtime.pollOperationsAlertsOnce();
  const alert = (sequence, level = "strained") => ({
    alert_id: `traffic:${sequence}`,
    level,
    title: level === "critical" ? "容量严重压力" : "容量压力",
    summary: `retained alert ${sequence}`,
    observed_at: `2026-08-10T04:0${sequence}:00Z`,
    expires_at: "2026-08-10T05:00:00Z",
  });
  forecaster.operationsAlertBatches.push(
    {
      alerts: [],
      cursor: "2",
      hasMore: false,
      resetRequired: true,
      resetReason: "retention_gap",
    },
    {
      alerts: [alert(3), alert(4)],
      cursor: "4",
      hasMore: true,
    },
    {
      alerts: [alert(5, "critical")],
      cursor: "5",
      hasMore: false,
    },
  );
  assert.deepEqual(await runtime.pollOperationsAlertsOnce(), {
    baseline: true,
    reset: true,
    alerts: 3,
    jobs: 4,
  });
  const state = await stateStore.read();
  assert.equal(state.operations_alert_cursor, "5");
  assert.equal(state.operations_alert_generation, 1);
  assert.equal(state.operations_alert_cursor_reset_reason, "retention_gap");
  for (const sequence of [3, 4, 5]) {
    assert.ok(state.outbox.some((job) =>
      job.id === `operations:g1:traffic:${sequence}:10`
    ));
  }
});

test("a reset generation can deliver an alert sequence reused after core rollback", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, forecaster, stateStore } = await setupRuntime(t, { config });
  forecaster.operationsAlertBatches.push({ alerts: [], cursor: "3", hasMore: false });
  await runtime.pollOperationsAlertsOnce();
  const alert = {
    alert_id: "traffic:4",
    level: "critical",
    title: "容量严重压力",
    summary: "test",
    observed_at: "2026-08-10T04:00:00Z",
    expires_at: "2026-08-10T05:00:00Z",
  };
  forecaster.operationsAlertBatches.push({
    alerts: [alert],
    cursor: "4",
    hasMore: false,
  });
  assert.equal((await runtime.pollOperationsAlertsOnce()).jobs, 1);
  await runtime.dispatchOnce();
  await stateStore.commitOperationsAlerts({ cursor: "9", jobs: [] });

  forecaster.operationsAlertBatches.push({
    alerts: [],
    cursor: "3",
    hasMore: false,
    resetRequired: true,
    resetReason: "ahead_of_tail",
  });
  await runtime.pollOperationsAlertsOnce();
  forecaster.operationsAlertBatches.push({
    alerts: [alert],
    cursor: "4",
    hasMore: false,
  });
  assert.equal((await runtime.pollOperationsAlertsOnce()).jobs, 1);
  const state = await stateStore.read();
  assert.equal(state.operations_alert_generation, 1);
  assert.ok(state.outbox.some((job) =>
    job.id === "operations:g0:traffic:4:10" && job.status === "delivered"
  ));
  assert.ok(state.outbox.some((job) =>
    job.id === "operations:g1:traffic:4:10" && job.status === "pending"
  ));
});

test("ordinary subscriptions cannot receive or authorize operations alerts", async (t) => {
  const config = runtimeConfig({
    operationsToken: "o".repeat(40),
    operationsAlertsEnabled: true,
  });
  const { runtime, telegram, stateStore } = await setupRuntime(t, { config });
  await stateStore.commitUpdateBatch({
    nextUpdateId: 1,
    subscriptionChanges: [{ chatId: "20", value: { experimental: true } }],
  });
  await stateStore.commitOperationsAlerts({
    cursor: "1",
    jobs: [{
      id: "operations:forged:20",
      kind: "operations_alert",
      chatId: "20",
      text: "must not send",
      expiresAt: "2026-08-10T05:00:00Z",
    }],
  });
  assert.equal(await runtime.dispatchOnce(), true);
  const state = await stateStore.read();
  assert.equal(state.outbox[0].status, "dead");
  assert.equal(state.outbox[0].last_error, "recipient_not_authorized");
  assert.equal(telegram.sent.length, 0);
});

test("Telegram state refuses malformed or backwards event cursors", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new TelegramStateStore({ directory }).init();
  await store.baselineEvents("10");
  await assert.rejects(
    store.commitEvents({ cursor: "abc", jobs: [] }),
    /canonical non-negative safe integer/,
  );
  await assert.rejects(
    store.commitEvents({ cursor: "9", jobs: [] }),
    /cannot move backwards/,
  );
  assert.equal((await store.read()).event_cursor, "10");
  await store.baselineOperationsAlerts("5");
  await assert.rejects(
    store.commitOperationsAlerts({ cursor: "4", jobs: [] }),
    /operations alert cursor cannot move backwards/,
  );
});

test("Telegram state upgrades the pre-operations state schema", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = await new TelegramStateStore({ directory }).init();
  const legacy = await first.read();
  legacy.schema_version = "telegram-bot-state/1";
  delete legacy.last_operations_alert_poll_at;
  delete legacy.operations_alert_cursor;
  delete legacy.operations_alert_baseline_initialized;
  await fs.writeFile(
    path.join(directory, "state.json"),
    `${JSON.stringify(legacy)}\n`,
    { mode: 0o600 },
  );
  const upgraded = await new TelegramStateStore({ directory }).init();
  const state = await upgraded.read();
  assert.equal(state.schema_version, "telegram-bot-state/3");
  assert.equal(state.operations_alert_cursor, null);
  assert.equal(state.operations_alert_baseline_initialized, false);
});

test("Telegram state upgrades an older v2 file without cursor reset audit fields", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = await new TelegramStateStore({ directory }).init();
  const olderV2 = await first.read();
  olderV2.schema_version = "telegram-bot-state/2";
  delete olderV2.forecast_input_cursor;
  delete olderV2.forecast_input_baseline_initialized;
  delete olderV2.forecast_input_outcome_revision_gate;
  delete olderV2.forecast_input_cursor_reset_at;
  delete olderV2.forecast_input_cursor_reset_reason;
  delete olderV2.last_forecast_input_poll_at;
  delete olderV2.operations_alert_cursor_reset_at;
  delete olderV2.operations_alert_cursor_reset_reason;
  delete olderV2.operations_alert_generation;
  delete olderV2.last_operations_delivery_failure_at;
  delete olderV2.last_operations_delivery_failure_error;
  olderV2.dynamic_subscriptions = {
    "20": {
      chat_id: "20",
      stable: true,
      experimental: true,
      updated_at: olderV2.updated_at,
    },
  };
  olderV2.outbox = [{
    id: "event:legacy-experimental:20",
    dedupe_key: "event:legacy-experimental:20",
    kind: "event",
    event_topic: "experimental_probability",
    experimental: true,
    chat_id: "20",
    text: "legacy fixed probability event",
    status: "pending",
    attempts: 0,
    not_before: olderV2.updated_at,
    expires_at: "2099-01-01T00:00:00.000Z",
    created_at: olderV2.updated_at,
    updated_at: olderV2.updated_at,
    last_error: null,
    telegram_message_id: null,
  }];
  for (const job of olderV2.outbox) {
    delete job.subscription_generation;
    delete job.preferences_hash;
    delete job.outcome_revision_token;
  }
  await fs.writeFile(
    path.join(directory, "state.json"),
    `${JSON.stringify(olderV2)}\n`,
    { mode: 0o600 },
  );
  const upgraded = await new TelegramStateStore({ directory }).init();
  const state = await upgraded.read();
  assert.equal(state.operations_alert_cursor_reset_at, null);
  assert.equal(state.operations_alert_cursor_reset_reason, null);
  assert.equal(state.operations_alert_generation, 0);
  assert.equal(state.last_operations_delivery_failure_at, null);
  assert.equal(state.last_operations_delivery_failure_error, null);
  assert.equal(state.schema_version, "telegram-bot-state/3");
  assert.deepEqual(state.dynamic_subscriptions["20"].probability_preferences, {
    schema_version: "notification-preferences/1",
    horizon_hours: 4,
    probability_threshold: 0.5,
  });
  assert.equal(state.dynamic_subscriptions["20"].probability_watch, null);
  assert.equal(state.dynamic_subscriptions["20"].generation, 1);
  assert.equal(state.forecast_input_baseline_initialized, false);
  assert.equal(state.outbox[0].subscription_generation, null);
  assert.equal(state.outbox[0].preferences_hash, null);
  assert.equal(state.outbox[0].outcome_revision_token, null);

  const telegram = new FakeTelegram();
  const runtime = new TelegramBotRuntime({
    telegram,
    forecaster: new FakeForecaster(),
    stateStore: upgraded,
    config: runtimeConfig(),
    now: () => new Date(olderV2.updated_at),
    random: () => 0,
    logger: { error() {} },
  });
  await runtime.initialize();
  assert.equal(await runtime.dispatchOnce(), true);
  const rejected = (await upgraded.read()).outbox[0];
  assert.equal(rejected.status, "dead");
  assert.equal(rejected.last_error, "recipient_not_authorized");
  assert.equal(telegram.sent.length, 0);
});
