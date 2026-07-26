import fs from "node:fs/promises";
import { hashLabel } from "../core/hash.mjs";
import {
  appendRawObservationRevision,
  canonicalXStatusUrl,
  rawObservationFromItem,
  xStatusIdentity,
} from "./raw.mjs";
import {
  DEFAULT_X_SEARCH_GATEWAY_UPSTREAM,
  isSummaryXSearchGatewayUpstream,
  normalizeXSearchGatewayUpstream,
} from "./x-search-gateway-semantics.mjs";

const PROVIDER_VERSION = "0.3.0";

function validTimestamp(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
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
      throw new Error(
        `X Search Gateway ${response.status}: ${String(payload.error ?? payload.message ?? "search failed").slice(0, 300)}`,
      );
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
    const sourcePublishedAt = validTimestamp(event.created_at);
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
    try {
      const payloads = [];
      const queryErrors = [];
      for (const query of this.config.queries ?? []) {
        try {
          payloads.push(await this.search(query));
        } catch (error) {
          queryErrors.push({ query: query.name, error: error.message });
        }
      }
      if (payloads.length === 0 && queryErrors.length > 0) {
        throw new Error(
          `All X Search Gateway queries failed: ${queryErrors.map((entry) =>
            `${entry.query}: ${entry.error}`
          ).join("; ")}`,
        );
      }
      const events = payloads.flatMap((payload) => payload.all_events ?? payload.events ?? []);
      const items = [...new Map(events.map((event) => {
        const item = this.mapEvent(event);
        return [item.provider_item_id, item];
      })).values()];
      const fetchedAt = this.now();
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
      await store.writeState("x-search-gateway-provider", {
        upstream_provider: this.upstreamProvider,
        last_success_at: fetchedAt.toISOString(),
        last_partial_at: queryErrors.length > 0 ? fetchedAt.toISOString() : null,
        last_failure_at: queryErrors.length > 0 ? fetchedAt.toISOString() : null,
        last_error: partialError,
        query_errors: queryErrors,
      });
      return {
        collected: inserted,
        upstream_provider: this.upstreamProvider,
        queries: payloads.length,
        query_errors: queryErrors,
        health: {
          ok: queryErrors.length === 0,
          delay_seconds: delaySeconds,
          error: partialError,
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
      await store.writeState("x-search-gateway-provider", {
        upstream_provider: this.upstreamProvider,
        last_failure_at: failedAt.toISOString(),
        last_error: error.message,
      });
      throw error;
    }
  }
}
