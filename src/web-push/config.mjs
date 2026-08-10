import fs from "node:fs/promises";

const DEFAULT_TOPICS = Object.freeze(["authority", "outcome"]);
const OPTIONAL_TOPICS = Object.freeze(["experimental_probability"]);
const ALLOWED_TOPICS = new Set([...DEFAULT_TOPICS, ...OPTIONAL_TOPICS]);
const DEFAULT_ENDPOINT_HOSTS = Object.freeze([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
  ".wns.windows.com",
]);

const DEFAULTS = Object.freeze({
  enabled: false,
  stateKey: "web-push",
  dispatchIntervalMs: 30_000,
  batchSize: 50,
  maxSubscriptions: 5_000,
  ttlSeconds: 6 * 60 * 60,
  retryBaseMs: 30_000,
  retryMaxMs: 30 * 60_000,
  maxRequestBytes: 16 * 1024,
  maxPayloadBytes: 3_500,
  requestTimeoutMs: 15_000,
});

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`Expected a boolean value, received ${JSON.stringify(value)}`);
}

function positiveInteger(value, fallback, label) {
  const parsed = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizedOrigin(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError("web push siteOrigin is required when enabled");
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("web push siteOrigin must be an absolute URL");
  }
  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("web push siteOrigin must use HTTPS outside localhost");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("web push siteOrigin must be an origin without credentials or a path");
  }
  return url.origin;
}

function normalizedSubject(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError("web push VAPID subject is required when enabled");
    return null;
  }
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("web push VAPID subject must be mailto: or an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("web push VAPID subject must be mailto: or an HTTPS URL");
  }
  return url.href;
}

function keyValue(value, label, { required = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (required && !normalized) throw new TypeError(`${label} is required when enabled`);
  return normalized || null;
}

function endpointHosts(value) {
  const rules = value ?? DEFAULT_ENDPOINT_HOSTS;
  if (
    !Array.isArray(rules) ||
    rules.length < 1 ||
    rules.length > 32 ||
    rules.some((rule) =>
      typeof rule !== "string" ||
      !/^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
        .test(rule)
    )
  ) {
    throw new TypeError("web push allowedEndpointHosts must contain DNS host rules");
  }
  return [...new Set(rules.map((rule) => rule.toLowerCase()))];
}

export function normalizeTopics(value, { useDefaults = true } = {}) {
  if (value === undefined || value === null) {
    return useDefaults ? [...DEFAULT_TOPICS] : [];
  }
  if (!Array.isArray(value)) throw new TypeError("web push topics must be an array");
  const topics = [...new Set(value)];
  if (
    topics.length === 0 ||
    topics.some((topic) => typeof topic !== "string" || !ALLOWED_TOPICS.has(topic))
  ) {
    throw new TypeError("web push topics contain an unsupported value");
  }
  return topics;
}

export function normalizeWebPushConfig(input = {}) {
  const enabled = booleanValue(input.enabled, DEFAULTS.enabled);
  const siteOrigin = normalizedOrigin(
    input.siteOrigin ?? input.site_origin,
    { required: enabled },
  );
  const publicKey = keyValue(
    input.publicKey ?? input.public_key,
    "web push VAPID public key",
    { required: enabled },
  );
  const privateKey = keyValue(
    input.privateKey ?? input.private_key,
    "web push VAPID private key",
    { required: enabled },
  );
  const subject = normalizedSubject(
    input.subject,
    { required: enabled },
  );
  return Object.freeze({
    enabled,
    siteOrigin,
    publicKey,
    privateKey,
    subject,
    stateKey: String(input.stateKey ?? input.state_key ?? DEFAULTS.stateKey),
    dispatchIntervalMs: input.dispatchIntervalMs !== undefined ||
        input.dispatch_interval_ms !== undefined
      ? positiveInteger(
          input.dispatchIntervalMs ?? input.dispatch_interval_ms,
          DEFAULTS.dispatchIntervalMs,
          "web push dispatchIntervalMs",
        )
      : positiveInteger(
          input.dispatch_interval_seconds,
          DEFAULTS.dispatchIntervalMs / 1_000,
          "web push dispatch_interval_seconds",
        ) * 1_000,
    batchSize: positiveInteger(
      input.batchSize ?? input.batch_size,
      DEFAULTS.batchSize,
      "web push batchSize",
    ),
    maxSubscriptions: positiveInteger(
      input.maxSubscriptions ?? input.max_subscriptions,
      DEFAULTS.maxSubscriptions,
      "web push maxSubscriptions",
    ),
    ttlSeconds: positiveInteger(
      input.ttlSeconds ?? input.ttl_seconds,
      DEFAULTS.ttlSeconds,
      "web push ttlSeconds",
    ),
    retryBaseMs: positiveInteger(
      input.retryBaseMs ?? input.retry_base_ms,
      DEFAULTS.retryBaseMs,
      "web push retryBaseMs",
    ),
    retryMaxMs: positiveInteger(
      input.retryMaxMs ?? input.retry_max_ms,
      DEFAULTS.retryMaxMs,
      "web push retryMaxMs",
    ),
    maxRequestBytes: positiveInteger(
      input.maxRequestBytes ?? input.max_request_bytes,
      DEFAULTS.maxRequestBytes,
      "web push maxRequestBytes",
    ),
    maxPayloadBytes: positiveInteger(
      input.maxPayloadBytes ?? input.max_payload_bytes,
      DEFAULTS.maxPayloadBytes,
      "web push maxPayloadBytes",
    ),
    requestTimeoutMs: positiveInteger(
      input.requestTimeoutMs ?? input.request_timeout_ms,
      DEFAULTS.requestTimeoutMs,
      "web push requestTimeoutMs",
    ),
    allowedEndpointHosts: endpointHosts(
      input.allowedEndpointHosts ?? input.allowed_endpoint_hosts,
    ),
  });
}

export async function loadWebPushConfig(appConfig = {}, {
  readFile = fs.readFile,
  stat = fs.stat,
  environment = process.env,
} = {}) {
  const runtime = appConfig.runtime ?? {};
  const runtimeConfig = runtime.web_push ?? appConfig;
  const enabled = booleanValue(runtimeConfig.enabled, false);
  let keyConfig = {};
  const keyFile = runtimeConfig.vapid_keys_file ??
    runtimeConfig.keys_file ??
    runtimeConfig.keysFile ??
    null;
  if (enabled) {
    if (
      typeof runtimeConfig.privateKey === "string" ||
      typeof runtimeConfig.private_key === "string"
    ) {
      throw new TypeError(
        "Enabled web push must load its VAPID private key from keys_file",
      );
    }
    if (typeof keyFile !== "string" || keyFile.trim().length === 0) {
      throw new TypeError("Enabled web push requires a VAPID keys_file");
    }
    let metadata;
    try {
      metadata = await stat(keyFile);
    } catch (error) {
      throw new TypeError(`Unable to stat web push keys_file: ${error.message}`);
    }
    if (typeof metadata?.isFile !== "function" || !metadata.isFile()) {
      throw new TypeError("Web push keys_file must be a regular file");
    }
    const permissions = Number.isInteger(metadata.mode)
      ? metadata.mode & 0o777
      : null;
    if (![0o400, 0o600].includes(permissions)) {
      throw new TypeError(
        "Web push keys_file mode must be 0400 or 0600",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(keyFile, "utf8"));
    } catch (error) {
      throw new TypeError(`Unable to read web push keys_file: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Web push keys_file must contain a JSON object");
    }
    if (
      parsed.schema_version !== undefined &&
      parsed.schema_version !== "web-push-vapid-keys/1"
    ) {
      throw new TypeError("Web push keys_file uses an unsupported schema_version");
    }
    keyConfig = {
      subject: parsed.subject,
      public_key: parsed.public_key,
      private_key: parsed.private_key,
    };
  }
  const subjectOverride = [
    environment.WEB_PUSH_VAPID_SUBJECT,
    environment.RESET_WEB_PUSH_VAPID_SUBJECT,
    runtimeConfig.vapid_subject,
    runtimeConfig.subject,
    keyConfig.subject,
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  return normalizeWebPushConfig({
    ...runtimeConfig,
    ...keyConfig,
    siteOrigin: runtimeConfig.siteOrigin ??
      runtimeConfig.site_origin ??
      runtime.public_base_url,
    subject: subjectOverride,
    dispatchIntervalMs: runtimeConfig.dispatch_interval_seconds
      ? runtimeConfig.dispatch_interval_seconds * 1_000
      : runtimeConfig.dispatchIntervalMs ?? runtimeConfig.dispatch_interval_ms,
  });
}

export {
  ALLOWED_TOPICS,
  DEFAULT_ENDPOINT_HOSTS,
  DEFAULT_TOPICS,
  OPTIONAL_TOPICS,
};
