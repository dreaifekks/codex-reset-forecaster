import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTelegramLocale } from "./locale.mjs";

const DEFAULT_BOT_API_BASE = "https://api.telegram.org";
const DEFAULT_FORECASTER_API_BASE = "http://reset-forecaster:8787";
const DEFAULT_STATE_DIR = "/bot-data";
const DEFAULT_DISPLAY_TIME_ZONE = "Asia/Tokyo";
const TELEGRAM_ID = /^-?[0-9]+$/;

function required(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function integer(value, name, { minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return parsed;
}

function boolean(value, name, fallback = false) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new TypeError(`${name} must be a boolean`);
}

function origin(value, name, fallback) {
  const parsed = new URL(String(value ?? fallback));
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new TypeError(
      `${name} must be an HTTP(S) origin without credentials, query, or fragment`,
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeTelegramId(value, name = "Telegram id") {
  const text = String(value ?? "").trim();
  if (!TELEGRAM_ID.test(text)) {
    throw new TypeError(`${name} must be a decimal integer string`);
  }
  const normalized = BigInt(text).toString();
  if (normalized === "0") {
    throw new RangeError(`${name} cannot be zero`);
  }
  return normalized;
}

export function parseTelegramIdSet(value, name, { required: isRequired = false } = {}) {
  const items = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeTelegramId(item, name));
  const result = new Set(items);
  if (isRequired && result.size === 0) {
    throw new TypeError(`${name} must contain at least one Telegram id`);
  }
  return result;
}

function subset(candidate, allowed, name) {
  for (const id of candidate) {
    if (!allowed.has(id)) {
      throw new TypeError(`${name} contains chat ${id}, which is not allowlisted`);
    }
  }
}

function positiveIds(value, name, options) {
  const ids = parseTelegramIdSet(value, name, options);
  for (const id of ids) {
    if (id.startsWith("-")) {
      throw new TypeError(`${name} must contain positive user/private-chat ids`);
    }
  }
  return ids;
}

function negativeIds(value, name, options) {
  const ids = parseTelegramIdSet(value, name, options);
  for (const id of ids) {
    if (!id.startsWith("-")) {
      throw new TypeError(`${name} must contain negative group-chat ids`);
    }
  }
  return ids;
}

function displayTimeZone(value) {
  const timeZone = String(value ?? DEFAULT_DISPLAY_TIME_ZONE).trim() ||
    DEFAULT_DISPLAY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new TypeError("TELEGRAM_DISPLAY_TIME_ZONE is invalid");
  }
  return timeZone;
}

async function readToken(tokenFile) {
  const metadata = await fs.stat(tokenFile);
  if (!metadata.isFile()) {
    throw new TypeError("TELEGRAM_BOT_TOKEN_FILE must name a regular file");
  }
  if (![0o400, 0o600].includes(metadata.mode & 0o777)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN_FILE mode must be 0400 or 0600",
    );
  }
  if (metadata.size < 1 || metadata.size > 1_024) {
    throw new RangeError("Telegram bot token file has an invalid size");
  }
  const raw = await fs.readFile(tokenFile, "utf8");
  const token = raw.trim();
  if (
    !/^[0-9]{5,20}:[A-Za-z0-9_-]{20,256}$/.test(token) ||
    /\s/.test(token)
  ) {
    throw new TypeError("Telegram bot token file has an invalid value");
  }
  return token;
}

async function readOperationsToken(tokenFile) {
  if (!tokenFile) return null;
  const metadata = await fs.stat(tokenFile);
  if (!metadata.isFile()) {
    throw new TypeError(
      "FORECASTER_OPERATIONS_TOKEN_FILE must name a regular file",
    );
  }
  if (![0o400, 0o600].includes(metadata.mode & 0o777)) {
    throw new Error(
      "FORECASTER_OPERATIONS_TOKEN_FILE mode must be 0400 or 0600",
    );
  }
  if (metadata.size < 32 || metadata.size > 1_024) {
    throw new RangeError("Forecaster operations token file has an invalid size");
  }
  const token = (await fs.readFile(tokenFile, "utf8")).trim();
  if (
    token.length < 32 ||
    token.length > 512 ||
    /\s|[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new TypeError("Forecaster operations token file has an invalid value");
  }
  return token;
}

export function telegramStatePath(env = process.env) {
  const stateDir = path.resolve(
    String(env.TELEGRAM_BOT_DATA_DIR ?? DEFAULT_STATE_DIR),
  );
  return path.join(stateDir, "state.json");
}

export async function loadTelegramConfig({ env = process.env } = {}) {
  const tokenFile = path.resolve(
    required(env.TELEGRAM_BOT_TOKEN_FILE, "TELEGRAM_BOT_TOKEN_FILE"),
  );
  const adminUserIds = positiveIds(
    env.TELEGRAM_ADMIN_USER_IDS,
    "TELEGRAM_ADMIN_USER_IDS",
    { required: true },
  );
  const blockedUserIds = positiveIds(
    env.TELEGRAM_BLOCKED_USER_IDS,
    "TELEGRAM_BLOCKED_USER_IDS",
  );
  for (const id of adminUserIds) {
    if (blockedUserIds.has(id)) {
      throw new TypeError(`TELEGRAM_BLOCKED_USER_IDS contains administrator ${id}`);
    }
  }
  const allowedGroupChatIds = negativeIds(
    env.TELEGRAM_ALLOWED_GROUP_CHAT_IDS,
    "TELEGRAM_ALLOWED_GROUP_CHAT_IDS",
  );
  const staticNotificationChatIds = parseTelegramIdSet(
    env.TELEGRAM_NOTIFICATION_CHAT_IDS,
    "TELEGRAM_NOTIFICATION_CHAT_IDS",
  );
  const staticExperimentalChatIds = parseTelegramIdSet(
    env.TELEGRAM_EXPERIMENTAL_CHAT_IDS,
    "TELEGRAM_EXPERIMENTAL_CHAT_IDS",
  );
  const staticRecipientIds = new Set([
    ...adminUserIds,
    ...allowedGroupChatIds,
  ]);
  subset(staticNotificationChatIds, staticRecipientIds,
    "TELEGRAM_NOTIFICATION_CHAT_IDS");
  subset(staticExperimentalChatIds, staticRecipientIds,
    "TELEGRAM_EXPERIMENTAL_CHAT_IDS");

  const operationsTokenFile = String(
    env.FORECASTER_OPERATIONS_TOKEN_FILE ?? "",
  ).trim();
  const operationsAlertsEnabled = boolean(
    env.TELEGRAM_OPERATIONS_ALERTS_ENABLED,
    "TELEGRAM_OPERATIONS_ALERTS_ENABLED",
    false,
  );
  if (operationsAlertsEnabled && !operationsTokenFile) {
    throw new TypeError(
      "FORECASTER_OPERATIONS_TOKEN_FILE is required when operations alerts are enabled",
    );
  }

  const stateDir = path.dirname(telegramStatePath(env));
  return {
    token: await readToken(tokenFile),
    tokenFile,
    botApiBase: origin(
      env.TELEGRAM_BOT_API_BASE,
      "TELEGRAM_BOT_API_BASE",
      DEFAULT_BOT_API_BASE,
    ),
    forecasterApiBase: origin(
      env.FORECASTER_API_BASE,
      "FORECASTER_API_BASE",
      DEFAULT_FORECASTER_API_BASE,
    ),
    forecasterPublicBaseUrl: origin(
      env.FORECASTER_PUBLIC_BASE_URL,
      "FORECASTER_PUBLIC_BASE_URL",
      env.FORECASTER_API_BASE ?? DEFAULT_FORECASTER_API_BASE,
    ),
    stateDir,
    adminUserIds,
    blockedUserIds,
    allowedGroupChatIds,
    staticNotificationChatIds,
    staticExperimentalChatIds,
    operationsTokenFile: operationsTokenFile
      ? path.resolve(operationsTokenFile)
      : null,
    operationsToken: await readOperationsToken(
      operationsTokenFile ? path.resolve(operationsTokenFile) : null,
    ),
    operationsAlertsEnabled,
    botLocale: normalizeTelegramLocale(env.TELEGRAM_BOT_LOCALE),
    displayTimeZone: displayTimeZone(env.TELEGRAM_DISPLAY_TIME_ZONE),
    longPollTimeoutSeconds: integer(
      env.TELEGRAM_LONG_POLL_TIMEOUT_SECONDS ?? 50,
      "TELEGRAM_LONG_POLL_TIMEOUT_SECONDS",
      { minimum: 1, maximum: 50 },
    ),
    requestTimeoutMs: integer(
      env.TELEGRAM_REQUEST_TIMEOUT_MS ?? 15_000,
      "TELEGRAM_REQUEST_TIMEOUT_MS",
      { minimum: 1_000, maximum: 120_000 },
    ),
    eventPollIntervalMs: integer(
      env.TELEGRAM_EVENT_POLL_INTERVAL_MS ?? 30_000,
      "TELEGRAM_EVENT_POLL_INTERVAL_MS",
      { minimum: 1_000, maximum: 300_000 },
    ),
    forecastInputPollIntervalMs: integer(
      env.TELEGRAM_FORECAST_INPUT_POLL_INTERVAL_MS ?? 30_000,
      "TELEGRAM_FORECAST_INPUT_POLL_INTERVAL_MS",
      { minimum: 1_000, maximum: 300_000 },
    ),
    dispatchIntervalMs: integer(
      env.TELEGRAM_DISPATCH_INTERVAL_MS ?? 1_000,
      "TELEGRAM_DISPATCH_INTERVAL_MS",
      { minimum: 100, maximum: 60_000 },
    ),
    heartbeatIntervalMs: integer(
      env.TELEGRAM_HEARTBEAT_INTERVAL_MS ?? 30_000,
      "TELEGRAM_HEARTBEAT_INTERVAL_MS",
      { minimum: 1_000, maximum: 60_000 },
    ),
    operationsAlertPollIntervalMs: integer(
      env.TELEGRAM_OPERATIONS_ALERT_POLL_INTERVAL_MS ?? 60_000,
      "TELEGRAM_OPERATIONS_ALERT_POLL_INTERVAL_MS",
      { minimum: 5_000, maximum: 3_600_000 },
    ),
    commandRateLimit: integer(
      env.TELEGRAM_COMMAND_RATE_LIMIT ?? 12,
      "TELEGRAM_COMMAND_RATE_LIMIT",
      { minimum: 1, maximum: 1_000 },
    ),
    commandRateWindowSeconds: integer(
      env.TELEGRAM_COMMAND_RATE_WINDOW_SECONDS ?? 60,
      "TELEGRAM_COMMAND_RATE_WINDOW_SECONDS",
      { minimum: 1, maximum: 3_600 },
    ),
    maximumOutboxAttempts: integer(
      env.TELEGRAM_MAX_OUTBOX_ATTEMPTS ?? 12,
      "TELEGRAM_MAX_OUTBOX_ATTEMPTS",
      { minimum: 1, maximum: 100 },
    ),
  };
}
