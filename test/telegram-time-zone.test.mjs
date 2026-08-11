import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTelegramConfig } from "../src/telegram/config.mjs";
import { formatNotificationEvent } from "../src/telegram/format.mjs";

async function tokenEnvironment(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-tg-tz-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "123456:abcdefghijklmnopqrstuvwxyz_ABCD\n", {
    mode: 0o600,
  });
  return {
    TELEGRAM_BOT_TOKEN_FILE: tokenFile,
    TELEGRAM_ADMIN_USER_IDS: "10",
    TELEGRAM_BOT_DATA_DIR: path.join(directory, "data"),
  };
}

test("Telegram display time zone defaults to fixed UTC+9", async (t) => {
  const env = await tokenEnvironment(t);
  const config = await loadTelegramConfig({ env });
  assert.equal(config.displayTimeZone, "Asia/Tokyo");

  const message = formatNotificationEvent({
    title: "测试通知",
    emitted_at: "2026-08-11T00:32:00.000Z",
    report: {
      correction_kind: "confirmed",
      outcome: {
        occurred_time_range: {
          start: "2026-08-11T00:00:00.000Z",
          end: "2026-08-11T01:00:00.000Z",
        },
      },
    },
  }, { timeZone: config.displayTimeZone });
  assert.match(
    message,
    /发生时间为 2026\/08\/11 09:00 UTC\+9 至 2026\/08\/11 10:00 UTC\+9/,
  );
  assert.match(message, /时间：2026\/08\/11 09:32 UTC\+9/);
  assert.doesNotMatch(message, /09:32 UTC(?:\n|$)/);
});

test("Telegram display time zone accepts an explicit IANA override", async (t) => {
  const env = {
    ...await tokenEnvironment(t),
    TELEGRAM_DISPLAY_TIME_ZONE: "America/New_York",
  };
  const config = await loadTelegramConfig({ env });
  assert.equal(config.displayTimeZone, "America/New_York");

  const message = formatNotificationEvent({
    title: "测试通知",
    emitted_at: "2026-08-11T00:32:00.000Z",
  }, { timeZone: config.displayTimeZone });
  assert.match(message, /时间：2026\/08\/10 20:32 UTC-4/);
});

test("Telegram authority windows use the configured display time zone", () => {
  const message = formatNotificationEvent({
    title: "出现新的权威重置时间窗",
    emitted_at: "2026-08-11T00:32:00.000Z",
    report: {
      forecast: {
        probabilities: { next_4h: 0.61 },
        authority_conditioning: {
          asserted_time_range: {
            start: "2026-08-11T03:00:00.000Z",
            end: "2026-08-11T04:00:00.000Z",
          },
        },
      },
    },
  });

  assert.match(
    message,
    /2026\/08\/11 12:00 UTC\+9 至 2026\/08\/11 13:00 UTC\+9/,
  );
  assert.doesNotMatch(message, /2026-08-11T0[34]:00:00\.000Z/);
});

test("Telegram display time zone rejects an invalid override", async (t) => {
  const env = {
    ...await tokenEnvironment(t),
    TELEGRAM_DISPLAY_TIME_ZONE: "UTC+9",
  };
  await assert.rejects(
    loadTelegramConfig({ env }),
    /TELEGRAM_DISPLAY_TIME_ZONE is invalid/,
  );
});
