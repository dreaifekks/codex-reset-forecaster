import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTelegramConfig } from "../src/telegram/config.mjs";
import { normalizeTelegramLocale } from "../src/telegram/locale.mjs";
import { TelegramStateStore } from "../src/telegram/state-store.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reset-tg-locale-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function tokenEnvironment(t, overrides = {}) {
  const directory = await temporaryDirectory(t);
  const tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "123456:abcdefghijklmnopqrstuvwxyz_ABCD\n", {
    mode: 0o600,
  });
  return {
    TELEGRAM_BOT_TOKEN_FILE: tokenFile,
    TELEGRAM_ADMIN_USER_IDS: "10",
    TELEGRAM_BOT_DATA_DIR: path.join(directory, "data"),
    ...overrides,
  };
}

test("Telegram bot locale defaults to canonical Simplified Chinese", async (t) => {
  const env = await tokenEnvironment(t);
  const config = await loadTelegramConfig({ env });
  assert.equal(config.botLocale, "zh-CN");
  const english = await loadTelegramConfig({
    env: { ...env, TELEGRAM_BOT_LOCALE: "en-US" },
  });
  assert.equal(english.botLocale, "en");
});

test("Telegram bot locale normalizes supported aliases", () => {
  for (const [input, expected] of [
    ["zh", "zh-CN"],
    ["ZH_cn", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["en", "en"],
    ["EN_us", "en"],
    ["en-GB", "en"],
  ]) {
    assert.equal(normalizeTelegramLocale(input), expected);
  }
  assert.throws(
    () => normalizeTelegramLocale("fr"),
    /TELEGRAM_BOT_LOCALE must be one of: zh-CN, en/,
  );
});

test("Telegram config rejects an unsupported bot locale", async (t) => {
  await assert.rejects(
    loadTelegramConfig({
      env: await tokenEnvironment(t, { TELEGRAM_BOT_LOCALE: "ja" }),
    }),
    /TELEGRAM_BOT_LOCALE must be one of: zh-CN, en/,
  );
});

test("Telegram state binds both bot identity and canonical locale", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new TelegramStateStore({ directory }).init();

  await store.bindBotIdentity("123", "EN_us");
  const state = await store.read();
  assert.equal(state.schema_version, "telegram-bot-state/5");
  assert.equal(state.bot_id, "123");
  assert.equal(state.bot_locale, "en");

  await store.bindBotIdentity(123, "en");
  await assert.rejects(
    store.bindBotIdentity(123, "zh-CN"),
    /state belongs to locale en, not zh-CN/,
  );
  await assert.rejects(
    store.bindBotIdentity(456, "en"),
    /state belongs to bot 123, not bot 456/,
  );
  assert.deepEqual(await store.read(), state);
});

test("Telegram state requires an explicit locale when binding a bot", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new TelegramStateStore({ directory }).init();
  assert.throws(
    () => store.bindBotIdentity(123),
    /Telegram bot locale is required/,
  );
  assert.equal((await store.read()).bot_id, null);
});

test("Telegram v4 state migrates with an unbound locale and binds once", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = await new TelegramStateStore({ directory }).init();
  await first.bindBotIdentity(123, "zh-CN");
  const previous = await first.read();
  previous.schema_version = "telegram-bot-state/4";
  delete previous.bot_locale;
  await fs.writeFile(
    path.join(directory, "state.json"),
    `${JSON.stringify(previous)}\n`,
    { mode: 0o600 },
  );

  const migrated = await new TelegramStateStore({ directory }).init();
  const state = await migrated.read();
  assert.equal(state.schema_version, "telegram-bot-state/5");
  assert.equal(state.bot_id, "123");
  assert.equal(state.bot_locale, null);

  await migrated.bindBotIdentity(123, "zh-Hans");
  assert.equal((await migrated.read()).bot_locale, "zh-CN");
});
