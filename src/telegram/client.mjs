const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function notificationCursor(value, label) {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(text) ||
    !Number.isSafeInteger(Number(text))
  ) {
    throw new ForecasterApiError(`${label} is invalid`, {
      code: "INVALID_RESPONSE",
    });
  }
  return Number(text);
}

function forecastOutcomeRevisionGate(value) {
  const revisionToken = value?.revision_token ?? null;
  const latestKnownAt = value?.latest_known_at ?? null;
  const currentOutcomes = value?.current_outcomes ?? [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !(
      (revisionToken === null && latestKnownAt === null) ||
      (
        typeof revisionToken === "string" &&
        revisionToken.length > 0 &&
        typeof latestKnownAt === "string" &&
        latestKnownAt.endsWith("Z") &&
        Number.isFinite(Date.parse(latestKnownAt))
      )
    ) ||
    typeof value.closes_episode !== "boolean" ||
    !Array.isArray(currentOutcomes)
  ) {
    throw new ForecasterApiError(
      "Forecaster outcome revision gate is invalid",
      { code: "INVALID_RESPONSE" },
    );
  }
  const normalizedOutcomes = currentOutcomes.map((entry) => {
    const range = entry?.occurred_time_range ?? null;
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !entry.outcome_ref ||
      typeof entry.outcome_ref.record_id !== "string" ||
      entry.outcome_ref.record_id.length === 0 ||
      !Number.isInteger(entry.outcome_ref.revision) ||
      entry.outcome_ref.revision < 1 ||
      typeof entry.outcome_token !== "string" ||
      entry.outcome_token.length === 0 ||
      typeof entry.status !== "string" ||
      entry.status.length === 0 ||
      typeof entry.known_at !== "string" ||
      !entry.known_at.endsWith("Z") ||
      !Number.isFinite(Date.parse(entry.known_at)) ||
      !(
        range === null ||
        (
          typeof range === "object" &&
          !Array.isArray(range) &&
          typeof range.start === "string" &&
          range.start.endsWith("Z") &&
          Number.isFinite(Date.parse(range.start)) &&
          typeof range.end === "string" &&
          range.end.endsWith("Z") &&
          Number.isFinite(Date.parse(range.end)) &&
          Date.parse(range.end) > Date.parse(range.start)
        )
      )
    ) {
      throw new ForecasterApiError(
        "Forecaster outcome revision gate entry is invalid",
        { code: "INVALID_RESPONSE" },
      );
    }
    return {
      outcome_ref: {
        record_id: entry.outcome_ref.record_id,
        revision: entry.outcome_ref.revision,
      },
      outcome_token: entry.outcome_token,
      status: entry.status,
      known_at: entry.known_at,
      occurred_time_range: range === null ? null : {
        start: range.start,
        end: range.end,
      },
    };
  }).sort((left, right) =>
    left.outcome_ref.record_id.localeCompare(right.outcome_ref.record_id) ||
    left.outcome_ref.revision - right.outcome_ref.revision ||
    left.outcome_token.localeCompare(right.outcome_token)
  );
  return {
    revision_token: revisionToken,
    latest_known_at: latestKnownAt,
    closes_episode: value.closes_episode,
    current_outcomes: normalizedOutcomes,
  };
}

function requestedForecastHorizons(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new TypeError("Forecast input horizons must be an array");
  }
  const horizons = value.map((horizon) => {
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 168) {
      throw new TypeError(
        "Forecast input horizons must contain integers from 1 through 168",
      );
    }
    return horizon;
  }).sort((left, right) => left - right);
  if (new Set(horizons).size !== horizons.length) {
    throw new TypeError("Forecast input horizons must be unique");
  }
  return horizons;
}

function assertForecastHorizonProjection(payload, horizons) {
  if (horizons === null || horizons.length === 0) return;
  if (
    !Array.isArray(payload?.horizon_hours) ||
    payload.horizon_hours.length !== horizons.length ||
    payload.horizon_hours.some((value, index) => value !== horizons[index])
  ) {
    throw new ForecasterApiError(
      "Forecaster forecast input horizon projection is invalid",
      { code: "INVALID_RESPONSE" },
    );
  }
}

function normalizeForecastInputView(input, horizons) {
  const points = input?.horizon_probabilities;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.schema_version !== "notification-forecast-input-view/1" ||
    input.source_schema_version !== "notification-forecast-input/2" ||
    Object.hasOwn(input, "probabilities") ||
    !Array.isArray(points) ||
    points.length !== horizons.length
  ) {
    throw new ForecasterApiError(
      "Forecaster forecast input view is invalid",
      { code: "INVALID_RESPONSE" },
    );
  }
  let previousProbability = -Infinity;
  const normalizedPoints = points.map((point, index) => {
    if (
      !point ||
      typeof point !== "object" ||
      Array.isArray(point) ||
      point.horizon_hours !== horizons[index] ||
      !Number.isFinite(point.probability) ||
      point.probability < 0 ||
      point.probability > 1 ||
      point.probability < previousProbability
    ) {
      throw new ForecasterApiError(
        "Forecaster forecast input probability projection is invalid",
        { code: "INVALID_RESPONSE" },
      );
    }
    previousProbability = point.probability;
    return {
      horizon_hours: point.horizon_hours,
      probability: point.probability,
    };
  });
  return {
    ...structuredClone(input),
    horizon_probabilities: normalizedPoints,
    outcome_revision_gate: forecastOutcomeRevisionGate(
      input.outcome_revision_gate,
    ),
  };
}

export function redactSecrets(value, secrets = []) {
  let result = String(value ?? "");
  for (const secret of secrets) {
    if (secret) result = result.split(String(secret)).join("[redacted]");
  }
  return result;
}

export class TelegramApiError extends Error {
  constructor(message, {
    status = null,
    retryAfter = null,
    retryable = false,
    code = "TELEGRAM_API_ERROR",
  } = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.retryable = retryable;
    this.code = code;
  }
}

export class ForecasterApiError extends Error {
  constructor(message, {
    status = null,
    retryable = false,
    code = "FORECASTER_API_ERROR",
  } = {}) {
    super(message);
    this.name = "ForecasterApiError";
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function requestSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("request timeout"));
  }, timeoutMs);
  const onAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abort(reason) {
      controller.abort(reason);
    },
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

async function responsePayload(response, maxBytes, request) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.abort(new Error("response exceeds size limit"));
    await response.body?.cancel?.().catch(() => {});
    throw new RangeError("HTTP response exceeds the configured size limit");
  }
  let text;
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.abort(new Error("response exceeds size limit"));
          await reader.cancel().catch(() => {});
          throw new RangeError("HTTP response exceeds the configured size limit");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks, bytes).toString("utf8");
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new RangeError("HTTP response exceeds the configured size limit");
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("HTTP response is not valid JSON");
  }
}

export class TelegramClient {
  constructor({
    token,
    apiBase = "https://api.telegram.org",
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 15_000,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("TelegramClient requires fetch");
    }
    this.token = token;
    this.apiBase = String(apiBase).replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async call(method, payload = {}, { signal = null, timeoutMs = null } = {}) {
    if (!/^[A-Za-z][A-Za-z0-9]+$/.test(method)) {
      throw new TypeError("Invalid Telegram API method");
    }
    const request = requestSignal(
      timeoutMs ?? this.requestTimeoutMs,
      signal,
    );
    try {
      let response;
      try {
        response = await this.fetch(
          `${this.apiBase}/bot${this.token}/${method}`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(payload),
            signal: request.signal,
          },
        );
      } catch (error) {
        if (signal?.aborted) {
          throw new TelegramApiError("Telegram request was aborted", {
            retryable: false,
            code: "ABORTED",
          });
        }
        throw new TelegramApiError(
          request.timedOut()
            ? "Telegram request timed out"
            : "Telegram network request failed",
          {
            retryable: true,
            code: request.timedOut() ? "TIMEOUT" : "NETWORK_ERROR",
          },
        );
      }

      let payloadResult;
      try {
        payloadResult = await responsePayload(
          response,
          this.maxResponseBytes,
          request,
        );
      } catch {
        if (signal?.aborted) {
          throw new TelegramApiError("Telegram request was aborted", {
            code: "ABORTED",
          });
        }
        if (request.timedOut()) {
          throw new TelegramApiError("Telegram request timed out", {
            retryable: true,
            code: "TIMEOUT",
          });
        }
        throw new TelegramApiError("Telegram returned an invalid response", {
          status: response.status,
          retryable: response.status >= 500,
          code: "INVALID_RESPONSE",
        });
      }
      if (!response.ok || payloadResult?.ok !== true) {
        const status = Number.isInteger(payloadResult?.error_code)
          ? payloadResult.error_code
          : response.status;
        const retryAfter = Number.isInteger(
          payloadResult?.parameters?.retry_after,
        )
          ? payloadResult.parameters.retry_after
          : null;
        const description = redactSecrets(
          payloadResult?.description ?? "Telegram API request failed",
          [this.token],
        ).slice(0, 500);
        throw new TelegramApiError(description, {
          status,
          retryAfter,
          retryable: status === 429 || status >= 500,
        });
      }
      return payloadResult.result;
    } finally {
      request.cleanup();
    }
  }

  getMe(options) {
    return this.call("getMe", {}, options);
  }

  getWebhookInfo(options) {
    return this.call("getWebhookInfo", {}, options);
  }

  setMyCommands({ commands, scope, signal = null }) {
    if (
      !Array.isArray(commands) ||
      commands.length < 1 ||
      commands.length > 100 ||
      commands.some((entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.command !== "string" ||
        !/^[a-z0-9_]{1,32}$/.test(entry.command) ||
        typeof entry.description !== "string" ||
        entry.description.length < 1 ||
        entry.description.length > 256
      ) ||
      !scope ||
      !["all_private_chats", "all_group_chats"].includes(scope.type)
    ) {
      throw new TypeError("Invalid Telegram command menu");
    }
    return this.call("setMyCommands", {
      commands: commands.map(({ command, description }) => ({
        command,
        description,
      })),
      scope: { type: scope.type },
    }, { signal });
  }

  getUpdates({ offset = null, timeout = 50, signal = null } = {}) {
    const payload = {
      timeout,
      limit: 100,
      allowed_updates: ["message"],
    };
    if (offset !== null) payload.offset = offset;
    return this.call("getUpdates", payload, {
      signal,
      timeoutMs: (timeout + 10) * 1_000,
    });
  }

  sendMessage({ chatId, text, signal = null }) {
    if (typeof text !== "string" || text.length < 1 || text.length > 4_096) {
      throw new RangeError("Telegram message text must contain 1-4096 characters");
    }
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    }, { signal });
  }
}

export class ForecasterClient {
  constructor({
    apiBase,
    operationsToken = null,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 15_000,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("ForecasterClient requires fetch");
    }
    this.base = new URL(String(apiBase).replace(/\/$/, "") + "/");
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.operationsToken = operationsToken === null
      ? null
      : String(operationsToken);
    if (
      this.operationsToken !== null &&
      (this.operationsToken.length < 32 ||
        this.operationsToken.length > 512 ||
        /\s|[\u0000-\u001f\u007f]/.test(this.operationsToken))
    ) {
      throw new TypeError("Forecaster operations token is invalid");
    }
  }

  async #get(url, {
    signal = null,
    acceptedStatuses = [200],
    operations = false,
  } = {}) {
    if (operations && !this.operationsToken) {
      throw new ForecasterApiError(
        "Forecaster operations access is not configured",
        { code: "OPERATIONS_NOT_CONFIGURED" },
      );
    }
    const request = requestSignal(this.requestTimeoutMs, signal);
    try {
      let response;
      try {
        response = await this.fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(operations
              ? { authorization: `Bearer ${this.operationsToken}` }
              : {}),
          },
          redirect: "error",
          signal: request.signal,
        });
      } catch {
        if (signal?.aborted) {
          throw new ForecasterApiError("Forecaster request was aborted", {
            code: "ABORTED",
          });
        }
        throw new ForecasterApiError(
          request.timedOut()
            ? "Forecaster request timed out"
            : "Forecaster network request failed",
          {
            retryable: true,
            code: request.timedOut() ? "TIMEOUT" : "NETWORK_ERROR",
          },
        );
      }
      let payload;
      try {
        payload = await responsePayload(response, this.maxResponseBytes, request);
      } catch {
        if (signal?.aborted) {
          throw new ForecasterApiError("Forecaster request was aborted", {
            code: "ABORTED",
          });
        }
        if (request.timedOut()) {
          throw new ForecasterApiError("Forecaster request timed out", {
            retryable: true,
            code: "TIMEOUT",
          });
        }
        throw new ForecasterApiError("Forecaster returned an invalid response", {
          status: response.status,
          retryable: response.status >= 500,
          code: "INVALID_RESPONSE",
        });
      }
      if (!acceptedStatuses.includes(response.status)) {
        throw new ForecasterApiError(
          String(payload?.message ?? payload?.error ?? "Forecaster request failed")
            .slice(0, 500),
          {
            status: response.status,
            retryable: response.status >= 500 || response.status === 429,
          },
        );
      }
      return { payload, status: response.status };
    } finally {
      request.cleanup();
    }
  }

  async getHealth(options = {}) {
    const { payload, status } = await this.#get(
      new URL("/api/health", this.base),
      { ...options, acceptedStatuses: [200, 503] },
    );
    return { ...payload, http_status: status };
  }

  async getExactSnapshot(snapshotUrl, options = {}) {
    const target = new URL(snapshotUrl, this.base);
    if (
      target.origin !== this.base.origin ||
      !target.pathname.startsWith("/api/forecast/snapshots/") ||
      target.search ||
      target.hash
    ) {
      throw new TypeError("Forecaster supplied an unsafe snapshot URL");
    }
    return (await this.#get(target, options)).payload;
  }

  async getHistory(options = {}) {
    const payload = (
      await this.#get(new URL("/api/history/results", this.base), options)
    ).payload;
    if (!Array.isArray(payload?.results)) {
      throw new ForecasterApiError("Forecaster history response is invalid", {
        code: "INVALID_RESPONSE",
      });
    }
    return payload.results;
  }

  async getNotificationEvents(after = null, options = {}) {
    const target = new URL("/api/notifications/events", this.base);
    const afterCursor = after === null
      ? null
      : notificationCursor(after, "Forecaster request cursor");
    if (afterCursor !== null) {
      target.searchParams.set("after", String(afterCursor));
    }
    const payload = (await this.#get(target, options)).payload;
    if (!Array.isArray(payload?.events)) {
      throw new ForecasterApiError("Forecaster event response is invalid", {
        code: "INVALID_RESPONSE",
      });
    }
    let cursor;
    try {
      const numericCursor = notificationCursor(
        payload.cursor,
        "Forecaster event cursor",
      );
      if (
        typeof payload.cursor !== "number" ||
        typeof payload.next_cursor !== "string" ||
        payload.next_cursor !== String(numericCursor) ||
        typeof payload.has_more !== "boolean" ||
        (afterCursor === null && (payload.events.length > 0 || payload.has_more)) ||
        (afterCursor !== null && numericCursor < afterCursor) ||
        (payload.has_more && afterCursor !== null && numericCursor <= afterCursor)
      ) {
        throw new Error("inconsistent cursor response");
      }
      cursor = String(numericCursor);
    } catch (error) {
      if (error instanceof ForecasterApiError) throw error;
      throw new ForecasterApiError("Forecaster event cursor is invalid", {
        code: "INVALID_RESPONSE",
      });
    }
    return {
      events: payload.events,
      cursor,
      hasMore: payload.has_more,
    };
  }

  async getForecastInputs(after = null, {
    limit = 100,
    horizonHours = null,
    ...options
  } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("Forecast input page limit must be from 1 through 500");
    }
    const target = new URL("/api/notifications/forecast-inputs", this.base);
    const afterCursor = after === null
      ? null
      : notificationCursor(after, "Forecast input request cursor");
    const requestedHorizons = requestedForecastHorizons(horizonHours);
    if (afterCursor !== null && requestedHorizons?.length === 0) {
      throw new TypeError(
        "Forecast input pages require at least one requested horizon",
      );
    }
    if (afterCursor !== null) {
      target.searchParams.set("after", String(afterCursor));
      target.searchParams.set("limit", String(limit));
    }
    for (const horizon of requestedHorizons ?? []) {
      target.searchParams.append("horizon_hours", String(horizon));
    }
    const response = await this.#get(target, {
      ...options,
      acceptedStatuses: [200, 409],
    });
    const payload = response.payload;
    assertForecastHorizonProjection(payload, requestedHorizons);
    const gate = forecastOutcomeRevisionGate(payload?.outcome_revision_gate);
    if (response.status === 409) {
      const cursor = notificationCursor(
        payload?.cursor,
        "Forecast input reset cursor",
      );
      if (
        payload?.error !== "forecast_input_cursor_reset_required" ||
        !["ahead_of_tail", "retention_gap"].includes(payload?.reason) ||
        typeof payload.cursor !== "number" ||
        payload.next_cursor !== String(cursor) ||
        payload.has_more !== false
      ) {
        throw new ForecasterApiError(
          "Forecaster forecast input reset response is invalid",
          { code: "INVALID_RESPONSE" },
        );
      }
      return {
        inputs: [],
        cursor: String(cursor),
        hasMore: false,
        outcomeRevisionGate: gate,
        resetRequired: true,
        resetReason: payload.reason,
      };
    }
    if (!Array.isArray(payload?.inputs)) {
      throw new ForecasterApiError("Forecaster forecast input response is invalid", {
        code: "INVALID_RESPONSE",
      });
    }
    const inputs = requestedHorizons === null
      ? payload.inputs
      : payload.inputs.map((input) =>
          normalizeForecastInputView(input, requestedHorizons)
        );
    const cursor = notificationCursor(
      payload.cursor,
      "Forecast input cursor",
    );
    if (
      typeof payload.cursor !== "number" ||
      payload.next_cursor !== String(cursor) ||
      typeof payload.has_more !== "boolean" ||
      (afterCursor === null && (inputs.length > 0 || payload.has_more)) ||
      (afterCursor !== null && cursor < afterCursor) ||
      (payload.has_more && afterCursor !== null && cursor <= afterCursor)
    ) {
      throw new ForecasterApiError("Forecaster forecast input cursor is invalid", {
        code: "INVALID_RESPONSE",
      });
    }
    let previous = afterCursor;
    for (const input of inputs) {
      const sequence = notificationCursor(
        input?.sequence,
        "Forecast input sequence",
      );
      if (
        typeof input.sequence !== "number" ||
        previous === null ||
        sequence <= previous ||
        sequence > cursor
      ) {
        throw new ForecasterApiError(
          "Forecaster forecast input sequence is invalid",
          { code: "INVALID_RESPONSE" },
        );
      }
      previous = sequence;
    }
    if (inputs.length > 0 && previous !== cursor) {
      throw new ForecasterApiError(
        "Forecaster forecast input page cursor is inconsistent",
        { code: "INVALID_RESPONSE" },
      );
    }
    return {
      inputs,
      cursor: String(cursor),
      hasMore: payload.has_more,
      outcomeRevisionGate: gate,
      resetRequired: false,
      resetReason: null,
    };
  }


  async getTraffic(options = {}) {
    return (
      await this.#get(new URL("/api/operations/traffic", this.base), {
        ...options,
        operations: true,
      })
    ).payload;
  }

  async getOperationsAlerts(after = null, options = {}) {
    const target = new URL("/api/operations/traffic/alerts", this.base);
    const afterCursor = after === null
      ? null
      : notificationCursor(after, "Operations alert request cursor");
    if (afterCursor !== null) {
      target.searchParams.set("after", String(afterCursor));
    }
    const response = await this.#get(target, {
      ...options,
      operations: true,
      acceptedStatuses: [200, 409],
    });
    const payload = response.payload;
    if (response.status === 409) {
      try {
        const cursor = notificationCursor(
          payload?.cursor,
          "Operations alert reset cursor",
        );
        if (
          payload?.error !== "operations_alert_cursor_reset_required" ||
          !["ahead_of_tail", "retention_gap"].includes(payload?.reason) ||
          typeof payload.cursor !== "number" ||
          payload.next_cursor !== String(cursor) ||
          payload.has_more !== false
        ) throw new Error("invalid operations reset response");
        return {
          alerts: [],
          cursor: String(cursor),
          hasMore: false,
          resetRequired: true,
          resetReason: payload.reason,
        };
      } catch (error) {
        if (error instanceof ForecasterApiError) throw error;
        throw new ForecasterApiError(
          "Forecaster operations alert reset response is invalid",
          { code: "INVALID_RESPONSE" },
        );
      }
    }
    if (!Array.isArray(payload?.alerts)) {
      throw new ForecasterApiError(
        "Forecaster operations alert response is invalid",
        { code: "INVALID_RESPONSE" },
      );
    }
    let cursor;
    try {
      const numericCursor = notificationCursor(
        payload.cursor,
        "Operations alert cursor",
      );
      if (
        typeof payload.cursor !== "number" ||
        typeof payload.next_cursor !== "string" ||
        payload.next_cursor !== String(numericCursor) ||
        typeof payload.has_more !== "boolean" ||
        (afterCursor === null && (payload.alerts.length > 0 || payload.has_more)) ||
        (afterCursor !== null && numericCursor < afterCursor) ||
        (payload.has_more && afterCursor !== null && numericCursor <= afterCursor)
      ) {
        throw new Error("inconsistent operations alert cursor response");
      }
      cursor = String(numericCursor);
    } catch (error) {
      if (error instanceof ForecasterApiError) throw error;
      throw new ForecasterApiError(
        "Forecaster operations alert cursor is invalid",
        { code: "INVALID_RESPONSE" },
      );
    }
    return { alerts: payload.alerts, cursor, hasMore: payload.has_more };
  }
}
