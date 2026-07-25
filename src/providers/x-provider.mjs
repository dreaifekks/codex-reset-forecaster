import fs from "node:fs/promises";
import { hashLabel } from "../core/hash.mjs";
import { appendRawObservationRevision, rawObservationFromItem } from "./raw.mjs";
import { addCoverageInterval } from "../pipeline/coverage.mjs";

const X_OUTCOME_EXHAUSTIVENESS_CONTRACT_VERSION = "x-outcome-exhaustiveness/1";
const X_OUTCOME_ATTESTATION_VERSION = "x-outcome-exhaustiveness-attestation/1";

function relationType(type) {
  if (type === "retweeted") return "repost";
  if (type === "quoted") return "quotes";
  if (type === "replied_to") return "reply";
  return "unknown";
}

function maxId(items) {
  return items.reduce((maximum, item) => {
    if (!maximum) return item.id;
    return BigInt(item.id) > BigInt(maximum) ? item.id : maximum;
  }, null);
}

export class XProvider {
  constructor({
    config,
    bearerToken = process.env.X_BEARER_TOKEN,
    tokenFile = process.env.X_BEARER_TOKEN_FILE ?? config.token_file,
    target = null,
    fetchFn = fetch,
    now = () => new Date(),
  }) {
    this.config = config;
    this.bearerToken = bearerToken;
    this.tokenFile = tokenFile;
    this.target = target;
    this.fetch = fetchFn;
    this.now = now;
    this.baseUrl = config.base_url.replace(/\/$/, "");
  }

  async outcomeCoverageAttestation(store, { start, end, assertedAt }) {
    const contract = this.config.outcome_exhaustiveness_contract;
    if (!contract) {
      return {
        eligible: false,
        status: "not_configured",
        reasons: ["outcome_exhaustiveness_contract_missing"],
        evidence: null,
      };
    }
    const reasons = [];
    if (contract.version !== X_OUTCOME_EXHAUSTIVENESS_CONTRACT_VERSION) {
      reasons.push("unsupported_contract_version");
    }
    if (
      typeof contract.attestation_file !== "string" ||
      contract.attestation_file.length === 0
    ) {
      reasons.push("attestation_file_missing");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(contract.attestation_sha256 ?? "")) {
      reasons.push("attestation_hash_invalid");
    }
    let attestation = null;
    if (reasons.length === 0) {
      try {
        attestation = JSON.parse(await fs.readFile(contract.attestation_file, "utf8"));
      } catch {
        reasons.push("attestation_unreadable");
      }
    }
    if (
      attestation &&
      hashLabel(attestation) !== contract.attestation_sha256
    ) {
      reasons.push("attestation_hash_mismatch");
    }
    const expectedIdentityIds = (this.config.confirmation_identities ?? [])
      .map((identity) => identity.identity_id)
      .filter(Boolean)
      .sort();
    const attestedIdentityIds = [...(attestation?.confirmation_identity_ids ?? [])].sort();
    const interval = attestation?.interval;
    const intervalStartMs = Date.parse(interval?.start);
    const intervalEndMs = Date.parse(interval?.end);
    const assertedAtMs = Date.parse(assertedAt);
    if (attestation) {
      if (attestation.attestation_version !== X_OUTCOME_ATTESTATION_VERSION) {
        reasons.push("unsupported_attestation_version");
      }
      if (attestation.contract_version !== contract.version) {
        reasons.push("attestation_contract_version_mismatch");
      }
      if (
        attestation.provider !== "x" ||
        attestation.exhaustive_for !== "completed_platform_reset_outcomes"
      ) {
        reasons.push("attestation_outcome_semantics_invalid");
      }
      if (
        attestation.independent !== true ||
        typeof attestation.attestor !== "string" ||
        attestation.attestor.length === 0 ||
        typeof attestation.method !== "string" ||
        attestation.method.length === 0
      ) {
        reasons.push("attestation_independence_invalid");
      }
      if (!this.target || hashLabel(attestation.target_scope) !== hashLabel(this.target)) {
        reasons.push("attestation_target_scope_mismatch");
      }
      if (
        expectedIdentityIds.length === 0 ||
        hashLabel(attestedIdentityIds) !== hashLabel(expectedIdentityIds)
      ) {
        reasons.push("attestation_confirmation_identities_mismatch");
      }
      if (
        interval?.boundary !== "[start,end)" ||
        !Number.isFinite(intervalStartMs) ||
        !Number.isFinite(intervalEndMs) ||
        intervalStartMs > Date.parse(start) ||
        intervalEndMs < Date.parse(end)
      ) {
        reasons.push("attestation_interval_invalid");
      }
      const issuedAtMs = Date.parse(attestation.issued_at);
      const expiresAtMs = Date.parse(attestation.expires_at);
      if (
        typeof attestation.issued_at !== "string" ||
        !attestation.issued_at.endsWith("Z") ||
        typeof attestation.expires_at !== "string" ||
        !attestation.expires_at.endsWith("Z") ||
        typeof interval?.start !== "string" ||
        !interval.start.endsWith("Z") ||
        typeof interval?.end !== "string" ||
        !interval.end.endsWith("Z") ||
        !Number.isFinite(issuedAtMs) ||
        !Number.isFinite(expiresAtMs) ||
        issuedAtMs > assertedAtMs ||
        expiresAtMs <= assertedAtMs
      ) {
        reasons.push("attestation_expired_or_not_yet_valid");
      }
    }
    if (reasons.length > 0) {
      return {
        eligible: false,
        status: "invalid",
        reasons: [...new Set(reasons)],
        evidence: null,
      };
    }
    const ref = await store.writeBlob(
      "x-outcome-exhaustiveness-attestations",
      `${contract.version}:${contract.attestation_sha256}`,
      attestation,
    );
    return {
      eligible: true,
      status: "valid",
      reasons: [],
      evidence: {
        kind: "independent_outcome_exhaustiveness_attestation",
        ref,
        sha256: contract.attestation_sha256,
        method: attestation.method,
        exhausted_at: new Date(assertedAt).toISOString(),
        attestation_version: attestation.attestation_version,
        contract_version: contract.version,
        expires_at: new Date(attestation.expires_at).toISOString(),
      },
    };
  }

  async resolveBearerToken() {
    if (this.bearerToken) return this.bearerToken;
    if (!this.tokenFile) {
      throw new Error("X bearer token or token file is required for the X provider");
    }
    const token = (await fs.readFile(this.tokenFile, "utf8")).trim();
    if (!token) throw new Error("X bearer token file is empty");
    this.bearerToken = token;
    return token;
  }

  async request(pathname, searchParams = {}) {
    const bearerToken = await this.resolveBearerToken();
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
    const maximumAttempts = 1 + Math.max(0, this.config.max_retries ?? 2);
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const response = await this.fetch(url, {
        headers: { authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
      const body = await response.text();
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryable = response.status === 429 || response.status >= 500;
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : 250 * 2 ** attempt;
      if (!retryable || attempt === maximumAttempts - 1 || delayMs > 5_000) {
        throw new Error(`X API ${response.status} ${url.pathname}: ${body.slice(0, 500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`X API request exhausted retries: ${url.pathname}`);
  }

  async paginate(pathname, searchParams) {
    const data = [];
    const users = new Map();
    const pageEvidence = [];
    let nextToken = null;
    let exhausted = false;
    const maxPages = Math.max(1, this.config.max_pages_per_poll ?? 10);
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.request(pathname, {
        ...searchParams,
        pagination_token: nextToken,
      });
      data.push(...(payload.data ?? []));
      for (const user of payload.includes?.users ?? []) users.set(user.id, user);
      pageEvidence.push({
        page: page + 1,
        request_pagination_token: nextToken,
        response_next_token: payload.meta?.next_token ?? null,
        result_count: payload.data?.length ?? 0,
        newest_id: payload.meta?.newest_id ?? null,
        oldest_id: payload.meta?.oldest_id ?? null,
      });
      nextToken = payload.meta?.next_token ?? null;
      if (!nextToken) {
        exhausted = true;
        break;
      }
    }
    return {
      data,
      includes: { users: [...users.values()] },
      exhausted,
      page_evidence: pageEvidence,
    };
  }

  identityConfig(username) {
    const identities = [
      ...(this.config.confirmation_identities ?? []),
      ...(this.config.context_identities ?? []),
    ];
    return identities.find((identity) => identity.username.toLowerCase() === username.toLowerCase());
  }

  async resolveUser(username, state) {
    const cached = state.users?.[username];
    if (cached) return cached;
    const payload = await this.request(`/users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": "id,username,name",
    });
    if (!payload.data?.id) throw new Error(`X user not found: ${username}`);
    return payload.data;
  }

  mapTweets(payload) {
    const users = new Map((payload.includes?.users ?? []).map((user) => [user.id, user]));
    return (payload.data ?? []).map((tweet) => {
      const user = users.get(tweet.author_id) ?? {};
      const identity = user.username ? this.identityConfig(user.username) : null;
      return {
        provider_item_id: tweet.id,
        canonical_url: user.username ? `https://x.com/${user.username}/status/${tweet.id}` : `https://x.com/i/status/${tweet.id}`,
        published_at: tweet.created_at,
        author: {
          provider_author_id: tweet.author_id,
          identity_id: identity?.identity_id ?? (user.username ? `x_${user.username.toLowerCase()}` : null),
          display_handle: user.username ? `@${user.username}` : null,
        },
        native_relations: (tweet.referenced_tweets ?? []).map((relation) => ({
          type: relationType(relation.type),
          provider_item_id: relation.id,
          url: `https://x.com/i/status/${relation.id}`,
        })).concat((tweet.entities?.urls ?? []).map((entity) => ({
          type: "links",
          provider_item_id: null,
          url: entity.expanded_url ?? entity.unwound_url ?? entity.url ?? null,
        }))),
        content: {
          media_type: "text/plain",
          text: tweet.text ?? "",
          language: tweet.lang ?? null,
        },
        raw: tweet,
      };
    });
  }

  async recheckRecentItems(store) {
    const limit = Math.max(0, Math.min(100, this.config.revision_recheck_limit ?? 25));
    if (limit === 0) return { attempted: false, items: [] };
    const existing = (await store.all("raw_observation"))
      .filter((record) =>
        record.data.ingest_provider === "x" &&
        record.data.content.media_type === "text/plain" &&
        /^\d+$/.test(record.data.provider_item_id)
      )
      .sort((left, right) =>
        String(right.data.published_at ?? "").localeCompare(left.data.published_at ?? "")
      )
      .slice(0, limit);
    const ids = existing.map((record) => record.data.provider_item_id);
    if (ids.length === 0) return { attempted: false, items: [] };
    const payload = await this.request("/tweets", {
      ids: ids.join(","),
      "tweet.fields": "id,text,author_id,created_at,lang,referenced_tweets,entities",
      expansions: "author_id",
      "user.fields": "id,username,name",
    });
    const previousById = new Map(
      existing.map((record) => [record.data.provider_item_id, record]),
    );
    const items = this.mapTweets({
      data: payload.data ?? [],
      includes: payload.includes ?? {},
    }).map((item) => {
      const previous = previousById.get(String(item.provider_item_id));
      if (!previous) return item;
      return {
        ...item,
        canonical_url: item.author.display_handle
          ? item.canonical_url
          : previous.data.canonical_url,
        author: {
          provider_author_id: item.author.provider_author_id ??
            previous.data.author.provider_author_id,
          identity_id: item.author.identity_id ?? previous.data.author.identity_id,
          display_handle: item.author.display_handle ?? previous.data.author.display_handle,
        },
      };
    });
    return { attempted: true, items };
  }

  async poll(state = {}) {
    const items = [];
    const nextState = structuredClone(state);
    nextState.users ??= {};
    nextState.timelines ??= {};
    nextState.queries ??= {};
    nextState.confirmation_backfill_by_timeline ??= {};
    const identities = [
      ...(this.config.confirmation_identities ?? []),
      ...(this.config.context_identities ?? []),
    ];
    const confirmationNames = new Set(
      (this.config.confirmation_identities ?? []).map((identity) => identity.username.toLowerCase()),
    );
    let confirmationPollComplete = true;
    const contextErrors = [];
    let contextAttempts = 0;
    let contextSuccesses = 0;
    const confirmationPollEvidence = [];

    for (const identity of identities) {
      const isConfirmationTimeline = confirmationNames.has(identity.username.toLowerCase());
      if (!isConfirmationTimeline) contextAttempts += 1;
      try {
        const user = await this.resolveUser(identity.username, nextState);
        nextState.users[identity.username] = user;
        const hadCursor = Boolean(nextState.timelines[identity.username]);
        const payload = await this.paginate(`/users/${user.id}/tweets`, {
          max_results: "100",
          since_id: nextState.timelines[identity.username],
          start_time: nextState.timelines[identity.username] ? null : this.config.backfill_start,
          exclude: this.config.exclude_replies ? "replies" : null,
          "tweet.fields": "id,text,author_id,created_at,lang,referenced_tweets,entities",
          expansions: "author_id",
          "user.fields": "id,username,name",
        });
        const mapped = this.mapTweets(payload);
        items.push(...mapped);
        if (isConfirmationTimeline) {
          confirmationPollEvidence.push({
            identity: identity.username,
            user_id: user.id,
            since_id: nextState.timelines[identity.username] ?? null,
            start_time: nextState.timelines[identity.username]
              ? null
              : this.config.backfill_start,
            exhausted: payload.exhausted,
            pages: payload.page_evidence,
          });
        }
        if (payload.exhausted) {
          nextState.timelines[identity.username] = maxId(mapped.map((item) => ({ id: item.provider_item_id })))
            ?? nextState.timelines[identity.username]
            ?? null;
        } else {
          nextState.timelines[identity.username] = state.timelines?.[identity.username] ?? null;
        }
        if (isConfirmationTimeline && !payload.exhausted) {
          confirmationPollComplete = false;
        }
        if (isConfirmationTimeline) {
          const previouslyComplete = state.confirmation_backfill_by_timeline?.[identity.username] === true ||
            (state.confirmation_backfill_complete === true && hadCursor);
          nextState.confirmation_backfill_by_timeline[identity.username] = Boolean(
            this.config.backfill_start && (previouslyComplete || (!hadCursor && payload.exhausted)),
          );
        } else {
          contextSuccesses += 1;
        }
      } catch (error) {
        if (isConfirmationTimeline) throw error;
        contextErrors.push({
          source: "timeline",
          identity: identity.username,
          error: error.message,
        });
      }
    }

    for (const query of this.config.context_queries ?? []) {
      contextAttempts += 1;
      try {
        const payload = await this.paginate(this.config.search_endpoint ?? "/tweets/search/recent", {
          query,
          max_results: "100",
          since_id: nextState.queries[query],
          start_time: nextState.queries[query] ? null : this.config.backfill_start,
          "tweet.fields": "id,text,author_id,created_at,lang,referenced_tweets,entities",
          expansions: "author_id",
          "user.fields": "id,username,name",
        });
        const mapped = this.mapTweets(payload);
        items.push(...mapped);
        nextState.queries[query] = payload.exhausted
          ? maxId(mapped.map((item) => ({ id: item.provider_item_id })))
            ?? nextState.queries[query]
            ?? null
          : state.queries?.[query] ?? null;
        contextSuccesses += 1;
      } catch (error) {
        contextErrors.push({
          source: "query",
          query,
          error: error.message,
        });
      }
    }

    const unique = [...new Map(items.map((item) => [item.provider_item_id, item])).values()];
    const confirmationBackfillComplete = Boolean(this.config.backfill_start) &&
      confirmationNames.size > 0 &&
      [...confirmationNames].every((username) => {
        const identity = identities.find((candidate) => candidate.username.toLowerCase() === username);
        return nextState.confirmation_backfill_by_timeline[identity.username] === true;
      });
    nextState.confirmation_backfill_complete = confirmationBackfillComplete;
    return {
      items: unique,
      state: nextState,
      confirmationPollComplete,
      confirmationCoverageStart:
        confirmationBackfillComplete && confirmationPollComplete ? this.config.backfill_start : null,
      contextErrors,
      contextAttempts,
      contextSuccesses,
      confirmationPollEvidence,
    };
  }

  healthObservation({ ok, at, delaySeconds, error = null }) {
    return rawObservationFromItem({
      provider_item_id: `health-${at.toISOString()}-${ok ? "ok" : "error"}`,
      canonical_url: null,
      published_at: null,
      author: {
        provider_author_id: null,
        identity_id: null,
        display_handle: null,
      },
      native_relations: [],
      content: {
        media_type: "application/vnd.reset-provider-health+json",
        text: JSON.stringify({ ok, delay_seconds: delaySeconds, error }),
        language: null,
      },
    }, {
      providerName: "x",
      providerVersion: "0.3.0",
      config: this.config,
      firstSeenAt: at,
      fetchedAt: at,
      rawPayloadRef: null,
    });
  }

  async collect(store) {
    const startedAt = this.now();
    const state = await store.readState("x-provider", {});
    try {
      const {
        items: polledItems,
        state: nextState,
        confirmationPollComplete,
        confirmationCoverageStart,
        contextErrors,
        contextAttempts: polledContextAttempts,
        contextSuccesses: polledContextSuccesses,
        confirmationPollEvidence,
      } = await this.poll(state);
      let recheckedItems = [];
      let contextAttempts = polledContextAttempts;
      let contextSuccesses = polledContextSuccesses;
      try {
        const recheck = await this.recheckRecentItems(store);
        recheckedItems = recheck.items;
        if (recheck.attempted) {
          contextAttempts += 1;
          contextSuccesses += 1;
        }
      } catch (error) {
        contextAttempts += 1;
        contextErrors.push({
          source: "revision_recheck",
          error: error.message,
        });
      }
      const items = [...new Map(
        [...polledItems, ...recheckedItems].map((item) => [item.provider_item_id, item]),
      ).values()];
      const fetchedAt = this.now();
      let inserted = 0;
      for (const item of items) {
        const result = await appendRawObservationRevision(store, item, {
          providerName: "x",
          providerVersion: "0.3.0",
          config: this.config,
          firstSeenAt: fetchedAt,
          fetchedAt,
          rawPayload: item.raw,
        });
        if (result.inserted) inserted += 1;
      }
      const delaySeconds = Math.max(0, Math.round((this.now() - startedAt) / 1000));
      const incompleteError = confirmationPollComplete
        ? null
        : "confirmation timeline pagination was not exhausted; coverage was not advanced";
      const contextStatus = contextAttempts === 0
        ? "disabled"
        : contextErrors.length > 0
          ? "degraded"
          : "fresh";
      const contextError = contextErrors.length > 0
        ? contextErrors.map((entry) => entry.error).join("; ")
        : null;
      const safetyLagSeconds = Math.max(
        0,
        Number(this.config.coverage_safety_lag_seconds ?? 0),
      );
      const candidateCoverageEnd = new Date(
        startedAt.getTime() - safetyLagSeconds * 1000,
      );
      const previousCoverageEnd = state.last_confirmation_coverage_end_at ??
        state.last_success_at ??
        null;
      const coverageEnd = previousCoverageEnd &&
        Date.parse(previousCoverageEnd) > candidateCoverageEnd.getTime()
        ? new Date(previousCoverageEnd)
        : candidateCoverageEnd;
      await store.append(this.healthObservation({
        ok: confirmationPollComplete,
        at: fetchedAt,
        delaySeconds,
        error: incompleteError,
      }));
      const nextProviderState = {
        ...nextState,
        last_success_at: confirmationPollComplete
          ? fetchedAt.toISOString()
          : state.last_success_at ?? null,
        last_partial_at: confirmationPollComplete
          ? state.last_partial_at ?? null
          : fetchedAt.toISOString(),
        last_failure_at: confirmationPollComplete ? null : fetchedAt.toISOString(),
        last_error: incompleteError,
        last_confirmation_coverage_end_at: confirmationPollComplete
          ? coverageEnd.toISOString()
          : state.last_confirmation_coverage_end_at ?? null,
        context_status: contextStatus,
        last_context_success_at: contextSuccesses > 0
          ? fetchedAt.toISOString()
          : state.last_context_success_at ?? null,
        last_context_failure_at: contextErrors.length > 0
          ? fetchedAt.toISOString()
          : state.last_context_failure_at ?? null,
        last_context_error: contextError,
        context_errors: contextErrors,
      };
      const pollManifest = {
        provider: "x",
        started_at: startedAt.toISOString(),
        fetched_at: fetchedAt.toISOString(),
        confirmation_poll_complete: confirmationPollComplete,
        confirmation_coverage_start: confirmationCoverageStart,
        previous_success_at: state.last_success_at ?? null,
        observed_provider_item_ids: items.map((item) => String(item.provider_item_id)).sort(),
        timeline_cursors: nextState.timelines,
        confirmation_backfill_by_timeline: nextState.confirmation_backfill_by_timeline,
        confirmation_poll_evidence: confirmationPollEvidence,
      };
      const pollManifestHash = hashLabel(pollManifest);
      const pollManifestRef = await store.writeBlob(
        "x-polls",
        `${fetchedAt.toISOString()}:${pollManifestHash}`,
        pollManifest,
      );
      const pollEvidence = {
          kind: "complete_api_poll",
          ref: pollManifestRef,
          sha256: pollManifestHash,
          method: "paginated_confirmation_timelines_exhausted",
          exhausted_at: fetchedAt.toISOString(),
      };
      const coverageStart = confirmationCoverageStart ??
        (confirmationPollComplete ? previousCoverageEnd : null);
      let coverageAdequacy = null;
      let attestation = {
        eligible: false,
        status: "not_evaluated",
        reasons: [],
        evidence: null,
      };
      if (coverageStart && Date.parse(coverageStart) < coverageEnd.getTime()) {
        attestation = await this.outcomeCoverageAttestation(store, {
          start: coverageStart,
          end: coverageEnd,
          assertedAt: fetchedAt,
        });
        coverageAdequacy = attestation.eligible
          ? "negative_label_eligible"
          : "outcome_only";
        await addCoverageInterval(
          store,
          "x",
          coverageStart,
          coverageEnd,
          {
            mode: confirmationCoverageStart
              ? attestation.eligible
                ? "attested_confirmation_backfill"
                : "confirmation_backfill_outcome_only"
              : attestation.eligible
                ? "attested_confirmation_poll_interval"
                : "confirmation_poll_interval_outcome_only",
            adequacy: coverageAdequacy,
            evidence_refs: [
              pollEvidence,
              ...(attestation.evidence ? [attestation.evidence] : []),
            ],
            rationale: attestation.eligible
              ? "Exhaustive pagination is paired with a pinned independent outcome-exhaustiveness attestation."
              : "Exhaustive account pagination alone can discover outcomes but cannot prove that no reset occurred.",
            asserted_at: fetchedAt,
          },
        );
      }
      await store.writeState("x-provider", {
        ...nextProviderState,
        coverage_adequacy: coverageAdequacy,
        outcome_exhaustiveness_attestation_status: attestation.status,
        outcome_exhaustiveness_attestation_reasons: attestation.reasons,
      });
      return {
        collected: inserted,
        health: {
          ok: confirmationPollComplete,
          delay_seconds: delaySeconds,
          error: incompleteError,
        },
        context_errors: contextErrors,
        coverage_adequacy: coverageAdequacy,
        outcome_exhaustiveness_attestation_status: attestation.status,
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
        // Preserve the original provider failure when health logging also fails.
      }
      await store.writeState("x-provider", {
        ...state,
        last_failure_at: failedAt.toISOString(),
        last_error: error.message,
      });
      throw error;
    }
  }
}
