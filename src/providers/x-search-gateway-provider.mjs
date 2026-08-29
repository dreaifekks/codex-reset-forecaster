import fs from "node:fs/promises";
import { hashLabel } from "../core/hash.mjs";
import {
  appendRawObservationRevision,
  canonicalXStatusUrl,
  rawObservationFromItem,
  timestampFromXSnowflake,
  xStatusIdentity,
} from "./raw.mjs";
import {
  DEFAULT_X_SEARCH_GATEWAY_UPSTREAM,
  isSummaryXSearchGatewayUpstream,
  normalizeXSearchGatewayUpstream,
} from "./x-search-gateway-semantics.mjs";

const PROVIDER_VERSION = "0.3.2";
const MINUTE_MS = 60_000;
const GROKBUILD_QUOTA_ERROR = "grokbuild_usage_balance_exhausted";
const QUOTA_EXHAUSTED_ERROR_CODE = "X_SEARCH_GATEWAY_QUOTA_EXHAUSTED";

function validTimestamp(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function grokbuildQuotaExhausted(response, payload, upstreamProvider) {
  if (upstreamProvider !== "grokbuild") return false;
  if (response.status === 402 || payload?.error === GROKBUILD_QUOTA_ERROR) {
    return true;
  }
  const diagnostic = [
    payload?.error,
    payload?.message,
    payload?.detail,
    payload?.stderr,
    payload?.stdout_excerpt,
    payload?.structuredOutputError,
  ].filter((value) => typeof value === "string").join(" ").toLowerCase();
  return diagnostic.includes("grok build usage balance exhausted") ||
    diagnostic.includes("grokbuild usage balance exhausted") ||
    (
      diagnostic.includes("usage balance exhausted") &&
      (
        diagnostic.includes("status 402") ||
        diagnostic.includes("payment required")
      )
    );
}

function quotaCooldownUntil(at, config) {
  const minutes = Number(config.quota_exhaustion_cooldown_minutes ?? 360);
  return new Date(at.getTime() + minutes * MINUTE_MS).toISOString();
}

function sourcePublishedTimestamp(event, sourceStatusId) {
  if (sourceStatusId) {
    try {
      return timestampFromXSnowflake(sourceStatusId);
    } catch {
      // Fall through to the provider timestamp for non-snowflake identifiers.
    }
  }
  return validTimestamp(event.created_at);
}

function providerItemId(event) {
  const statusId = xStatusIdentity(event.url) ??
    xStatusIdentity(event.event_id) ??
    xStatusIdentity(event.id);
  return String(statusId || event.event_id || event.url || event.id || hashLabel({
    handle: event.handle ?? null,
    text: event.text ?? "",
    created_at: event.created_at ?? null,
  }));
}

export class XSearchGatewayProvider {
  constructor({
    config,
    token = process.env.X_SEARCH_GATEWAY_TOKEN,
    fetchFn = fetch,
    readFileFn = fs.readFile,
    now = () => new Date(),
  }) {
    this.config = config;
    this.token = token;
    this.fetch = fetchFn;
    this.readFile = readFileFn;
    this.now = now;
    this.baseUrl = config.base_url.replace(/\/$/, "");
    this.upstreamProvider = normalizeXSearchGatewayUpstream(
      config.upstream_provider ?? DEFAULT_X_SEARCH_GATEWAY_UPSTREAM,
    );
    this.providerName = `x_search_gateway_${this.upstreamProvider}`;
  }

  async bearerToken() {
    if (this.token) return this.token;
    const tokenFile = process.env.X_SEARCH_GATEWAY_TOKEN_FILE ?? this.config.token_file;
    if (!tokenFile) throw new Error("X_SEARCH_GATEWAY_TOKEN or X_SEARCH_GATEWAY_TOKEN_FILE is required");
    const token = (await this.readFile(tokenFile, "utf8")).trim();
    if (!token) throw new Error("X Search Gateway token file is empty");
    return token;
  }

  async search(query) {
    const token = await this.bearerToken();
    const response = await this.fetch(`${this.baseUrl}/x/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: this.upstreamProvider,
        query: query.query,
        limit: query.limit ?? this.config.limit ?? 20,
        state: `${this.config.state_prefix ?? "codex-reset-forecaster"}:${query.name}`,
        handles: query.handles ?? [],
        include_seen: true,
        ...(query.search_type ? { search_type: query.search_type } : {}),
      }),
      signal: AbortSignal.timeout(this.config.request_timeout_ms ?? 190_000),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`X Search Gateway returned non-JSON status ${response.status}`);
    }
    if (!response.ok || payload.ok !== true) {
      const error = new Error(
        `X Search Gateway ${response.status}: ${String(payload.error ?? payload.message ?? "search failed").slice(0, 300)}`,
      );
      if (grokbuildQuotaExhausted(response, payload, this.upstreamProvider)) {
        error.code = QUOTA_EXHAUSTED_ERROR_CODE;
      }
      throw error;
    }
    if (
      normalizeXSearchGatewayUpstream(payload.provider) !==
      this.upstreamProvider
    ) {
      throw new Error(
        `X Search Gateway provider mismatch: requested ${this.upstreamProvider}`,
      );
    }
    return payload;
  }

  identity(handle) {
    const normalized = String(handle ?? "").replace(/^@/, "").toLowerCase();
    const identities = [
      ...(this.config.confirmation_identities ?? []),
      ...(this.config.context_identities ?? []),
    ];
    return identities.find((identity) =>
      identity.username?.toLowerCase() === normalized,
    ) ?? null;
  }

  mapEvent(event) {
    const handle = String(event.handle ?? "").replace(/^@/, "");
    const identity = this.identity(handle);
    const sourceStatusId = xStatusIdentity(event.url) ??
      xStatusIdentity(event.event_id) ??
      xStatusIdentity(event.id);
    const canonicalSourceUrl =
      canonicalXStatusUrl(event.url, handle || "i") ??
      canonicalXStatusUrl(event.event_id, handle || "i") ??
      canonicalXStatusUrl(event.id, handle || "i");
    const isSummary =
      isSummaryXSearchGatewayUpstream(this.upstreamProvider);
    const sourcePublishedAt = sourcePublishedTimestamp(event, sourceStatusId);
    return {
      provider_item_id: providerItemId(event),
      canonical_url: canonicalSourceUrl ?? event.url ?? null,
      published_at: sourcePublishedAt,
      author: {
        provider_author_id: handle || null,
        identity_id: identity?.identity_id ?? (handle ? `x_${handle.toLowerCase()}` : null),
        display_handle: handle ? `@${handle}` : null,
      },
      native_relations: isSummary && sourceStatusId ? [{
        type: "links",
        provider_item_id: sourceStatusId,
        url: canonicalSourceUrl,
      }] : [],
      content: {
        media_type: isSummary
          ? "application/vnd.x-search-summary+text"
          : "text/plain",
        text: String(event.text ?? ""),
        language: event.lang ?? null,
      },
      source_timing: {
        source_published_at: sourcePublishedAt,
        provider_observed_at: validTimestamp(
          event.first_seen_at ?? event.observed_at,
        ),
        availability_basis: isSummary ? "gateway_first_seen" : "provider_first_seen",
      },
      raw: event,
    };
  }

  healthObservation({ ok, at, delaySeconds, error = null }) {
    return rawObservationFromItem({
      provider_item_id: `health-${at.toISOString()}-${ok ? "ok" : "error"}`,
      canonical_url: null,
      published_at: null,
      author: {},
      native_relations: [],
      content: {
        media_type: "application/vnd.reset-provider-health+json",
        text: JSON.stringify({ ok, delay_seconds: delaySeconds, error }),
        language: null,
      },
    }, {
      providerName: this.providerName,
      providerVersion: PROVIDER_VERSION,
      config: this.config,
      firstSeenAt: at,
      fetchedAt: at,
      rawPayloadRef: null,
    });
  }

  async collect(store) {
    const startedAt = this.now();
    const stateKey = "x-search-gateway-provider";
    const previousState = await store.readState(stateKey, {});
    const providerConfigHash = hashLabel(this.config);
    const bootstrapReplay =
      previousState.upstream_provider !== this.upstreamProvider ||
      previousState.provider_config_hash !== providerConfigHash ||
      !previousState.last_success_at;
    const refreshIntervalMs = Number(
      this.config.refresh_interval_minutes ?? 30,
    ) * 60_000;
    const lastSuccessMs = Date.parse(previousState.last_success_at);
    const quotaRetryAt = validTimestamp(previousState.quota_retry_at);
    const quotaRetryMs = Date.parse(quotaRetryAt);
    let currentQueryErrors = [];
    if (
      this.upstreamProvider === "grokbuild" &&
      Number.isFinite(quotaRetryMs) &&
      startedAt.getTime() < quotaRetryMs
    ) {
      if (
        previousState.last_error == null &&
        previousState.last_partial_at === previousState.quota_exhausted_at &&
        (previousState.query_errors?.length ?? 0) === 0
      ) {
        await store.writeState(stateKey, {
          ...previousState,
          last_partial_at: null,
          last_failure_at: null,
        });
      }
      return {
        fetched: false,
        collected: 0,
        skipped: "upstream_quota_exhausted",
        upstream_provider: this.upstreamProvider,
        bootstrap_replay: false,
        next_fetch_at: quotaRetryAt,
        health: {
          ok: true,
          delay_seconds: 0,
          error: null,
          skipped: "upstream_quota_exhausted",
        },
      };
    }
    if (
      !bootstrapReplay &&
      !previousState.last_error &&
      Number.isFinite(lastSuccessMs) &&
      Number.isFinite(refreshIntervalMs) &&
      refreshIntervalMs > 0 &&
      startedAt.getTime() - lastSuccessMs < refreshIntervalMs
    ) {
      return {
        fetched: false,
        collected: 0,
        skipped: "refresh_interval",
        upstream_provider: this.upstreamProvider,
        bootstrap_replay: false,
        next_fetch_at: new Date(lastSuccessMs + refreshIntervalMs).toISOString(),
        health: { ok: true, delay_seconds: 0, error: null },
      };
    }
    try {
      const queries = this.config.queries ?? [];
      const queryResults = await Promise.allSettled(
        queries.map((query) => this.search(query)),
      );
      const payloads = [];
      const queryErrors = [];
      const skippedQueries = [];
      for (const [index, result] of queryResults.entries()) {
        if (result.status === "fulfilled") {
          payloads.push(result.value);
        } else if (result.reason?.code === QUOTA_EXHAUSTED_ERROR_CODE) {
          skippedQueries.push(queries[index].name);
        } else {
          queryErrors.push({
            query: queries[index].name,
            error: result.reason?.message ?? String(result.reason),
          });
        }
      }
      currentQueryErrors = queryErrors;
      if (payloads.length === 0 && queryErrors.length > 0) {
        throw new Error(
          `All X Search Gateway queries failed: ${queryErrors.map((entry) =>
            `${entry.query}: ${entry.error}`
          ).join("; ")}`,
        );
      }
      const events = payloads.flatMap((payload) => {
        if (bootstrapReplay) {
          return payload.all_events ?? payload.events ?? [];
        }
        return payload.events ?? payload.all_events ?? [];
      });
      const items = [...new Map(events.map((event) => {
        const item = this.mapEvent(event);
        return [item.provider_item_id, item];
      })).values()];
      const fetchedAt = this.now();
      const exhaustedRetryAt = skippedQueries.length > 0
        ? quotaCooldownUntil(fetchedAt, this.config)
        : null;
      let inserted = 0;
      for (const item of items) {
        const result = await appendRawObservationRevision(store, item, {
          providerName: this.providerName,
          providerVersion: PROVIDER_VERSION,
          config: this.config,
          firstSeenAt: fetchedAt,
          fetchedAt,
          rawPayload: item.raw,
        });
        if (result.inserted) inserted += 1;
      }
      const delaySeconds = Math.max(0, Math.round((fetchedAt - startedAt) / 1000));
      const partialError = queryErrors.length > 0
        ? `${queryErrors.length} gateway query(s) failed`
        : null;
      await store.append(this.healthObservation({
        ok: queryErrors.length === 0,
        at: fetchedAt,
        delaySeconds,
        error: partialError,
      }));
      await store.writeState(stateKey, {
        ...previousState,
        upstream_provider: this.upstreamProvider,
        provider_config_hash: providerConfigHash,
        last_success_at:
          queryErrors.length === 0 && skippedQueries.length === 0
          ? fetchedAt.toISOString()
          : previousState.last_success_at ?? null,
        last_partial_at:
          payloads.length > 0 &&
            (queryErrors.length > 0 || skippedQueries.length > 0)
            ? fetchedAt.toISOString()
            : null,
        last_failure_at: queryErrors.length > 0 ? fetchedAt.toISOString() : null,
        last_error: partialError,
        query_errors: queryErrors,
        quota_exhausted_at:
          skippedQueries.length > 0 ? fetchedAt.toISOString() : null,
        quota_retry_at: exhaustedRetryAt,
        last_skip_reason:
          skippedQueries.length > 0 ? "upstream_quota_exhausted" : null,
        skipped_queries: skippedQueries,
      });
      return {
        fetched: true,
        collected: inserted,
        upstream_provider: this.upstreamProvider,
        bootstrap_replay: bootstrapReplay,
        queries: payloads.length,
        query_errors: queryErrors,
        skipped_queries: skippedQueries,
        ...(skippedQueries.length > 0
          ? {
              skipped: "upstream_quota_exhausted",
              next_fetch_at: exhaustedRetryAt,
            }
          : {}),
        health: {
          ok: queryErrors.length === 0,
          delay_seconds: delaySeconds,
          error: partialError,
          ...(skippedQueries.length > 0
            ? { skipped: "upstream_quota_exhausted" }
            : {}),
        },
      };
    } catch (error) {
      const failedAt = this.now();
      try {
        await store.append(this.healthObservation({
          ok: false,
          at: failedAt,
          delaySeconds: Math.max(0, Math.round((failedAt - startedAt) / 1000)),
          error: error.message,
        }));
      } catch {
        // Preserve the original provider error.
      }
      await store.writeState(stateKey, {
        ...previousState,
        upstream_provider: this.upstreamProvider,
        provider_config_hash: providerConfigHash,
        last_failure_at: failedAt.toISOString(),
        last_error: error.message,
        query_errors: currentQueryErrors,
        quota_exhausted_at: null,
        quota_retry_at: null,
        last_skip_reason: null,
        skipped_queries: [],
      });
      throw error;
    }
  }
}
