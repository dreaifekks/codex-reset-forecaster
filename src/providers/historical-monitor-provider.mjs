import { hashLabel } from "../core/hash.mjs";
import {
  addCoverageAssertion,
  COVERAGE_ADEQUACY,
  coverageAssertions,
} from "../pipeline/coverage.mjs";
import {
  historicalDailyLedgerContractHash,
  HISTORICAL_DAILY_LEDGER_EVIDENCE_VERSION,
  HISTORICAL_DAILY_LEDGER_OBSERVATION_VERSION,
} from "../core/coverage-contract.mjs";
import {
  coverageWaitingFromDailyCandidates,
} from "../core/coverage-waiting.mjs";
import {
  appendRawObservationRevision,
  rawObservationFromItem,
  xStatusIdentity,
} from "./raw.mjs";

const X_EPOCH_MS = 1_288_834_974_657n;
const DAY_MS = 86_400_000;

function decodeHtml(value) {
  let decoded = String(value);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, number) => String.fromCodePoint(Number.parseInt(number, 16)))
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&apos;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function plainText(value) {
  return decodeHtml(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function timestampFromXSnowflake(id) {
  if (!/^\d{16,22}$/.test(String(id))) throw new Error(`Invalid X snowflake: ${id}`);
  return new Date(Number((BigInt(id) >> 22n) + X_EPOCH_MS)).toISOString();
}

export function parseHistoricalMonitorHtml(html) {
  const items = [];
  const itemPattern = /<li class="log-item">[\s\S]*?data-datetime="([^"]+)"[\s\S]*?<p class="log-item-text">([\s\S]*?)<\/p>[\s\S]*?href="https:\/\/x\.com\/thsottiaux\/status\/(\d+)"[\s\S]*?<\/li>/g;
  for (const match of String(html).matchAll(itemPattern)) {
    const [, publishedAt, encodedText, id] = match;
    const pageTimestamp = new Date(publishedAt).toISOString();
    const snowflakeTimestamp = timestampFromXSnowflake(id);
    if (Math.abs(Date.parse(pageTimestamp) - Date.parse(snowflakeTimestamp)) > 1_000) {
      throw new Error(`Archive timestamp does not match X snowflake ${id}`);
    }
    items.push({
      id,
      url: `https://x.com/thsottiaux/status/${id}`,
      published_at: snowflakeTimestamp,
      archive_text: plainText(encodedText),
    });
  }
  const coverageByDate = new Map();
  const coveragePattern = /data-date="(\d{4}-\d{2}-\d{2})"\s+data-count="(\d+)"/g;
  for (const match of String(html).matchAll(coveragePattern)) {
    const count = Number(match[2]);
    if (coverageByDate.has(match[1]) && coverageByDate.get(match[1]) !== count) {
      throw new Error(`Conflicting archive coverage count for ${match[1]}`);
    }
    coverageByDate.set(match[1], count);
  }
  const coverageDates = [...coverageByDate.keys()].sort();
  if (items.length === 0 || coverageDates.length === 0) {
    throw new Error("Historical monitor page contains no parseable items or coverage dates");
  }
  for (let index = 1; index < coverageDates.length; index += 1) {
    const expected = new Date(Date.parse(`${coverageDates[index - 1]}T00:00:00Z`) + DAY_MS)
      .toISOString().slice(0, 10);
    if (coverageDates[index] !== expected) {
      throw new Error(`Historical monitor coverage gap after ${coverageDates[index - 1]}`);
    }
  }
  const parsedCountByDate = new Map();
  for (const item of items) {
    const date = item.published_at.slice(0, 10);
    parsedCountByDate.set(date, (parsedCountByDate.get(date) ?? 0) + 1);
  }
  for (const [date, expectedCount] of coverageByDate) {
    const parsedCount = parsedCountByDate.get(date) ?? 0;
    if (parsedCount !== expectedCount) {
      throw new Error(
        `Historical monitor item count mismatch for ${date}: ` +
        `grid=${expectedCount}, parsed=${parsedCount}`,
      );
    }
  }
  for (const [date, parsedCount] of parsedCountByDate) {
    if (date < coverageDates[0]) continue;
    if (!coverageByDate.has(date)) {
      throw new Error(
        `Historical monitor parsed ${parsedCount} item(s) outside coverage grid for ${date}`,
      );
    }
  }
  return { items, coverageDates, coverageByDate };
}

function tweetTextFromOEmbed(payload) {
  const match = String(payload.html ?? "").match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return match ? plainText(match[1]) : "";
}

function shortLinksFromOEmbed(payload) {
  return [...String(payload.html ?? "").matchAll(/href="(https:\/\/t\.co\/[^"]+)"/g)]
    .map((match) => decodeHtml(match[1]));
}

export class HistoricalMonitorProvider {
  constructor({
    config,
    target = null,
    outcomeDefinition = null,
    fetchFn = fetch,
    now = () => new Date(),
  }) {
    this.config = config;
    this.target = target;
    this.outcomeDefinition = outcomeDefinition;
    this.fetch = fetchFn;
    this.now = now;
    this.providerName = config.provider_name ?? "historical_monitor";
  }

  async coverageWaiting(store, attestation, observedAt) {
    if (!attestation) return null;
    const candidateState = await store.readState(
      "historical-monitor-coverage-candidates",
      { schema_version: "historical-coverage-candidates/1", days: {} },
    );
    return coverageWaitingFromDailyCandidates({
      providerId: this.providerName,
      days: candidateState.days,
      dayCloseLagHours: attestation.day_close_lag_hours,
      minimumStabilityHours: attestation.minimum_stability_hours,
      observedAt: candidateState.updated_at ?? observedAt,
    });
  }

  async authoritativeDailyCoverage(store, {
    parsed,
    verifiedItems,
    archiveSnapshotRef,
    htmlHash,
    coverageGridHash,
    fetchedAt,
    attestation,
    coverageContractHash,
  }) {
    const closeLagMs = attestation.day_close_lag_hours * 3_600_000;
    const stabilityMs = attestation.minimum_stability_hours * 3_600_000;
    const candidateLeadMs = closeLagMs - stabilityMs;
    const policyHash = hashLabel(attestation);
    const mode = "authoritative_daily_tibo_ledger";
    const previousAssertions = await coverageAssertions(store, [this.providerName]);
    const candidateState = await store.readState(
      "historical-monitor-coverage-candidates",
      { schema_version: "historical-coverage-candidates/1", days: {} },
    );
    candidateState.schema_version = "historical-coverage-candidates/1";
    candidateState.days ??= {};
    const coveredDates = new Set(parsed.coverageDates);
    for (const date of Object.keys(candidateState.days)) {
      if (!coveredDates.has(date)) delete candidateState.days[date];
    }
    const ledgersByDate = new Map(parsed.coverageDates.map((date) => {
      const dayItems = verifiedItems
        .filter((item) => item.published_at.slice(0, 10) === date)
        .map((item) => ({
          provider_item_id: item.id,
          canonical_url: item.url,
          published_at: item.published_at,
          content_hash: hashLabel(item.text),
          verification: item.oembed
            ? "x_oembed+snowflake"
            : "archive_text+snowflake",
        }))
        .sort((left, right) =>
          left.published_at.localeCompare(right.published_at) ||
          left.provider_item_id.localeCompare(right.provider_item_id)
        );
      const ledger = {
        date,
        expected_count: parsed.coverageByDate.get(date),
        verified_items: dayItems,
      };
      return [date, { ledger, hash: hashLabel(ledger) }];
    }));
    const revokedAssertionIds = new Set();
    for (const previous of previousAssertions.filter((assertion) =>
      assertion.provider === this.providerName &&
      assertion.mode === mode &&
      assertion.adequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
      assertion.revoked !== true
    )) {
      const date = previous.start.slice(0, 10);
      const ledger = ledgersByDate.get(date);
      const stillMatches = ledger && previous.evidence_refs?.some((evidence) =>
        evidence.kind === "independent_completeness_attestation" &&
        evidence.coverage_contract_hash === coverageContractHash &&
        evidence.authority_policy_hash === policyHash &&
        evidence.day_ledger_hash === ledger.hash
      );
      if (stillMatches) continue;
      await addCoverageAssertion(store, {
        provider: this.providerName,
        start: previous.start,
        end: previous.end,
        mode,
        adequacy: COVERAGE_ADEQUACY.OUTCOME_ONLY,
        evidenceRefs: [{
          kind: "archive_snapshot",
          ref: archiveSnapshotRef,
          html_sha256: htmlHash,
          coverage_grid_sha256: coverageGridHash,
        }],
        rationale: ledger
          ? "The authority-ledger policy or day contents changed and are pending a new stability window."
          : "The previously attested UTC day is absent from the current authority ledger.",
        assertedAt: fetchedAt,
        replayAvailableAt: null,
        assertionId: previous.assertion_id,
      });
      revokedAssertionIds.add(previous.assertion_id);
    }
    for (const date of parsed.coverageDates) {
      const start = `${date}T00:00:00.000Z`;
      const end = new Date(Date.parse(start) + DAY_MS).toISOString();
      if (Date.parse(end) + candidateLeadMs > fetchedAt.getTime()) continue;
      const { ledger: dayLedger, hash: dayLedgerHash } =
        ledgersByDate.get(date);
      const previous = previousAssertions.find((assertion) =>
        assertion.provider === this.providerName &&
        assertion.mode === mode &&
        assertion.start === start &&
        assertion.end === end
      );
      const previousEvidence = previous?.evidence_refs?.find((evidence) =>
        evidence.kind === "independent_completeness_attestation" &&
        evidence.coverage_contract_hash === coverageContractHash &&
        evidence.authority_policy_hash === policyHash &&
        evidence.day_ledger_hash === dayLedgerHash
      );
      if (
        previous?.adequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
        previous.revoked !== true &&
        previousEvidence
      ) {
        delete candidateState.days[date];
        continue;
      }
      if (
        previous?.adequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
        previous.revoked !== true &&
        !revokedAssertionIds.has(previous.assertion_id)
      ) {
        await addCoverageAssertion(store, {
          provider: this.providerName,
          start,
          end,
          mode,
          adequacy: COVERAGE_ADEQUACY.OUTCOME_ONLY,
          evidenceRefs: [{
            kind: "archive_snapshot",
            ref: archiveSnapshotRef,
            html_sha256: htmlHash,
            coverage_grid_sha256: coverageGridHash,
          }],
          rationale:
            "The daily authority ledger changed and is pending a new stability window.",
          assertedAt: fetchedAt,
          replayAvailableAt: null,
          assertionId: previous.assertion_id,
        });
      }
      const candidate = candidateState.days[date];
      if (
        !candidate ||
        candidate.coverage_contract_hash !== coverageContractHash ||
        candidate.authority_policy_hash !== policyHash ||
        candidate.day_ledger_hash !== dayLedgerHash
      ) {
        const firstObservation = {
          observation_version:
            HISTORICAL_DAILY_LEDGER_OBSERVATION_VERSION,
          provider: this.providerName,
          source_url: this.config.base_url,
          observed_at: fetchedAt.toISOString(),
          coverage_contract_hash: coverageContractHash,
          authority_policy_hash: policyHash,
          day_ledger: dayLedger,
          day_ledger_hash: dayLedgerHash,
          archive_snapshot_ref: archiveSnapshotRef,
          archive_html_sha256: htmlHash,
          archive_coverage_grid_sha256: coverageGridHash,
        };
        const firstObservationHash = hashLabel(firstObservation);
        const firstObservationRef = await store.writeBlob(
          `${this.providerName}-coverage-observations`,
          `${date}:${policyHash}:${dayLedgerHash}:${fetchedAt.toISOString()}`,
          firstObservation,
        );
        candidateState.days[date] = {
          coverage_contract_hash: coverageContractHash,
          authority_policy_hash: policyHash,
          day_ledger_hash: dayLedgerHash,
          first_observed_at: fetchedAt.toISOString(),
          first_observation_ref: firstObservationRef,
          first_observation_hash: firstObservationHash,
          last_observed_at: fetchedAt.toISOString(),
          observation_count: 1,
        };
        continue;
      }
      candidate.last_observed_at = fetchedAt.toISOString();
      candidate.observation_count += 1;
      if (
        fetchedAt.getTime() < Date.parse(end) + closeLagMs ||
        fetchedAt.getTime() - Date.parse(candidate.first_observed_at) < stabilityMs
      ) {
        continue;
      }
      const replayAvailableAt = fetchedAt.toISOString();
      const completenessPayload = {
        evidence_version: HISTORICAL_DAILY_LEDGER_EVIDENCE_VERSION,
        provider: this.providerName,
        source_url: this.config.base_url,
        outcome_definition: this.outcomeDefinition,
        coverage_contract_hash: coverageContractHash,
        target_scope: this.target,
        confirmation_identity_ids: [...attestation.confirmation_identity_ids].sort(),
        interval: { start, end, boundary: "[start,end)" },
        asserted_at: fetchedAt.toISOString(),
        exhausted_at: replayAvailableAt,
        replay_available_at: replayAvailableAt,
        archive_snapshot_ref: archiveSnapshotRef,
        archive_html_sha256: htmlHash,
        archive_coverage_grid_sha256: coverageGridHash,
        authority_policy: attestation,
        authority_policy_hash: policyHash,
        day_ledger: dayLedger,
        day_ledger_hash: dayLedgerHash,
        stability_observation: {
          first_observed_at: candidate.first_observed_at,
          ref: candidate.first_observation_ref,
          sha256: candidate.first_observation_hash,
          stable_for_hours:
            (fetchedAt.getTime() -
              Date.parse(candidate.first_observed_at)) / 3_600_000,
        },
      };
      const completenessHash = hashLabel(completenessPayload);
      const completenessRef = await store.writeBlob(
        `${this.providerName}-coverage-attestations`,
        `${date}:${policyHash}:${dayLedgerHash}:${fetchedAt.toISOString()}`,
        completenessPayload,
      );
      await addCoverageAssertion(store, {
        provider: this.providerName,
        start,
        end,
        mode,
        adequacy: COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE,
        evidenceRefs: [{
          kind: "independent_completeness_attestation",
          ref: completenessRef,
          sha256: completenessHash,
          method: attestation.method,
          exhausted_at: replayAvailableAt,
          replay_available_at: replayAvailableAt,
          coverage_contract_hash: coverageContractHash,
          authority_policy_hash: policyHash,
          day_ledger_hash: dayLedgerHash,
        }],
        rationale:
          "A versioned independent daily authority ledger was count-reconciled and each listed source post was verified.",
        assertedAt: fetchedAt,
        replayAvailableAt,
        assertionId: previous?.assertion_id ?? null,
      });
      delete candidateState.days[date];
    }
    candidateState.updated_at = fetchedAt.toISOString();
    await store.writeState(
      "historical-monitor-coverage-candidates",
      candidateState,
    );
    return (await coverageAssertions(store, [this.providerName]))
      .filter((assertion) =>
        assertion.mode === mode &&
        assertion.adequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
        assertion.revoked !== true
      )
      .sort((left, right) => left.start.localeCompare(right.start));
  }

  async invalidateIncompatibleAuthorityCoverage(store, {
    coverageContractHash,
    assertedAt,
  }) {
    const mode = "authoritative_daily_tibo_ledger";
    const assertions = await coverageAssertions(store, [this.providerName]);
    let invalidated = 0;
    for (const assertion of assertions.filter((entry) =>
      entry.mode === mode &&
      entry.adequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
      entry.revoked !== true
    )) {
      const evidence = assertion.evidence_refs?.find((entry) =>
        entry.kind === "independent_completeness_attestation"
      );
      if (
        coverageContractHash !== null &&
        evidence?.coverage_contract_hash === coverageContractHash
      ) {
        continue;
      }
      await addCoverageAssertion(store, {
        provider: this.providerName,
        start: assertion.start,
        end: assertion.end,
        mode,
        adequacy: COVERAGE_ADEQUACY.OUTCOME_ONLY,
        evidenceRefs: [{
          kind: "coverage_contract_transition",
          previous_coverage_contract_hash:
            evidence?.coverage_contract_hash ?? null,
          current_coverage_contract_hash: coverageContractHash,
        }],
        rationale:
          "The current outcome and coverage contract no longer matches this attestation.",
        assertedAt,
        replayAvailableAt: null,
        assertionId: assertion.assertion_id,
      });
      invalidated += 1;
    }
    const candidateState = await store.readState(
      "historical-monitor-coverage-candidates",
      { schema_version: "historical-coverage-candidates/1", days: {} },
    );
    let candidatesChanged = false;
    for (const [date, candidate] of Object.entries(candidateState.days ?? {})) {
      if (
        coverageContractHash === null ||
        candidate.coverage_contract_hash !== coverageContractHash
      ) {
        delete candidateState.days[date];
        candidatesChanged = true;
      }
    }
    if (candidatesChanged) {
      candidateState.updated_at = new Date(assertedAt).toISOString();
      await store.writeState(
        "historical-monitor-coverage-candidates",
        candidateState,
      );
    }
    return invalidated;
  }

  async request(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      signal: AbortSignal.timeout(this.config.request_timeout_ms ?? 20_000),
    });
    if (!response.ok) throw new Error(`Historical monitor request failed with HTTP ${response.status}`);
    return response;
  }

  async verifyWithOEmbed(item) {
    if (this.config.verify_x_oembed === false) {
      return { ...item, text: item.archive_text, oembed: null };
    }
    const endpoint = new URL(this.config.x_oembed_url ?? "https://publish.twitter.com/oembed");
    endpoint.searchParams.set("url", item.url);
    endpoint.searchParams.set("omit_script", "true");
    endpoint.searchParams.set("dnt", "true");
    const payload = await (await this.request(endpoint)).json();
    const responseId = String(payload.url ?? "").match(/status\/(\d+)/)?.[1];
    const author = new URL(payload.author_url).pathname.replace(/^\//, "").toLowerCase();
    const text = tweetTextFromOEmbed(payload);
    if (responseId !== item.id || author !== "thsottiaux" || !text) {
      throw new Error(`X oEmbed verification failed for ${item.id}`);
    }
    return { ...item, text, oembed: payload, short_links: shortLinksFromOEmbed(payload) };
  }

  async verifiedItems(items) {
    const concurrency = Math.max(1, Math.min(8, this.config.verification_concurrency ?? 6));
    const verified = [];
    for (let index = 0; index < items.length; index += concurrency) {
      verified.push(...await Promise.all(
        items.slice(index, index + concurrency).map((item) => this.verifyWithOEmbed(item)),
      ));
    }
    return verified;
  }

  async discoverLinkedItems(baseItems) {
    if (this.config.discover_linked_posts === false) {
      return { linkedItems: [], linksBySource: new Map(), linkedErrors: [] };
    }
    const links = [];
    for (const item of baseItems) {
      for (const url of item.short_links ?? []) links.push({ sourceId: item.id, url });
    }
    const resolved = [];
    const concurrency = Math.max(1, Math.min(8, this.config.verification_concurrency ?? 6));
    for (let index = 0; index < links.length; index += concurrency) {
      resolved.push(...await Promise.all(links.slice(index, index + concurrency).map(async (link) => {
        try {
          const response = await this.fetch(link.url, {
            redirect: "follow",
            signal: AbortSignal.timeout(this.config.request_timeout_ms ?? 20_000),
          });
          const id = xStatusIdentity(response.url);
          return id ? { sourceId: link.sourceId, id } : null;
        } catch (error) {
          return {
            sourceId: link.sourceId,
            error: `short-link resolution failed: ${error.message}`,
          };
        }
      })));
    }
    const linksBySource = new Map();
    const linkedById = new Map();
    const linkedErrors = resolved
      .filter((entry) => entry?.error)
      .map((entry) => ({ source_id: entry.sourceId, error: entry.error }));
    const baseIds = new Set(baseItems.map((item) => item.id));
    for (const link of resolved.filter((entry) => entry?.id)) {
      if (link.id === link.sourceId) continue;
      if (!linksBySource.has(link.sourceId)) linksBySource.set(link.sourceId, new Set());
      linksBySource.get(link.sourceId).add(link.id);
      if (!baseIds.has(link.id)) linkedById.set(link.id, {
        id: link.id,
        url: `https://x.com/thsottiaux/status/${link.id}`,
        published_at: timestampFromXSnowflake(link.id),
        archive_text: "",
        linked_from: [],
        selection_context: {
          feature_eligible: false,
          outcome_conditioned: true,
          selection_method: "linked_from_known_reset_archive_item",
        },
      });
      linkedById.get(link.id)?.linked_from.push(link.sourceId);
    }
    const linkedItems = [];
    const verificationConcurrency = Math.max(
      1,
      Math.min(8, this.config.verification_concurrency ?? 6),
    );
    const candidates = [...linkedById.values()];
    for (let index = 0; index < candidates.length; index += verificationConcurrency) {
      const chunk = candidates.slice(index, index + verificationConcurrency);
      const settled = await Promise.allSettled(chunk.map((item) => this.verifyWithOEmbed(item)));
      for (let offset = 0; offset < settled.length; offset += 1) {
        const result = settled[offset];
        if (result.status === "fulfilled") {
          linkedItems.push(result.value);
        } else {
          linkedErrors.push({
            source_id: chunk[offset].linked_from?.[0] ?? null,
            provider_item_id: chunk[offset].id,
            error: `linked-post verification failed: ${result.reason.message}`,
          });
        }
      }
    }
    return { linkedItems, linksBySource, linkedErrors };
  }

  healthObservation({ ok, at, delaySeconds, error = null }) {
    return rawObservationFromItem({
      provider_item_id: `health-${at.toISOString()}-${ok ? "ok" : "error"}`,
      canonical_url: this.config.base_url,
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
      providerVersion: "0.1.0",
      config: this.config,
      firstSeenAt: at,
      fetchedAt: at,
    });
  }

  async collect(store, { force = false } = {}) {
    const startedAt = this.now();
    const previousState = await store.readState("historical-monitor-provider", {});
    const requestedAdequacy = this.config.coverage_adequacy;
    const completenessAttestation =
      this.config.coverage_completeness_attestation;
    const coverageContractHash =
      requestedAdequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE
        ? historicalDailyLedgerContractHash({
            attestation: completenessAttestation,
            outcomeDefinition: this.outcomeDefinition,
            providerName: this.providerName,
            sourceUrl: this.config.base_url,
            target: this.target,
            confirmationIdentityIds: (
              this.config.confirmation_identities ?? []
            )
              .map((identity) => identity.identity_id)
              .filter(Boolean),
          })
        : null;
    const invalidatedCoverageAssertions =
      await this.invalidateIncompatibleAuthorityCoverage(store, {
        coverageContractHash,
        assertedAt: startedAt,
      });
    const refreshMs = (this.config.refresh_interval_hours ?? 24) * 3_600_000;
    const currentContractAlreadyObserved =
      Object.hasOwn(previousState, "coverage_contract_hash") &&
      previousState.coverage_contract_hash === coverageContractHash;
    if (!force && previousState.last_success_at &&
        startedAt.getTime() - Date.parse(previousState.last_success_at) < refreshMs &&
        currentContractAlreadyObserved) {
      const coverageWaiting = await this.coverageWaiting(
        store,
        completenessAttestation,
        startedAt,
      );
      await store.writeState("historical-monitor-provider", {
        ...previousState,
        coverage_waiting: coverageWaiting,
      });
      return {
        collected: 0,
        skipped: "refresh_interval",
        coverage_waiting: coverageWaiting,
        invalidated_coverage_assertions: invalidatedCoverageAssertions,
        health: { ok: true, delay_seconds: 0 },
      };
    }
    try {
      const response = await this.request(this.config.base_url);
      const html = await response.text();
      const parsed = parseHistoricalMonitorHtml(html);
      const baseItems = await this.verifiedItems(parsed.items);
      const {
        linkedItems,
        linksBySource,
        linkedErrors,
      } = await this.discoverLinkedItems(baseItems);
      const verified = [
        ...baseItems.map((item) => ({
          ...item,
          linked_ids: [...(linksBySource.get(item.id) ?? [])],
        })),
        ...linkedItems.map((item) => ({
          ...item,
          selection_context: {
            ...item.selection_context,
            linked_from: [...new Set(item.linked_from ?? [])],
          },
        })),
      ];
      const fetchedAt = this.now();
      const baseItemIds = new Set(baseItems.map((item) => item.id));
      const verifiedItemIds = new Set(verified.map((item) => item.id));
      const coverageGrid = parsed.coverageDates.map((date) => ({
        date,
        count: parsed.coverageByDate.get(date),
      }));
      const htmlHash = hashLabel(html);
      const coverageGridHash = hashLabel(coverageGrid);
      const archiveSnapshotRef = await store.writeBlob(
        `${this.providerName}-archive-snapshots`,
        `${fetchedAt.toISOString()}:${htmlHash}`,
        {
          source_url: this.config.base_url,
          fetched_at: fetchedAt.toISOString(),
          format: this.config.format,
          html_sha256: htmlHash,
          coverage_grid_sha256: coverageGridHash,
          coverage_grid: coverageGrid,
          html,
        },
      );
      let inserted = 0;
      for (const item of verified) {
        const result = await appendRawObservationRevision(store, {
          provider_item_id: item.id,
          canonical_url: item.url,
          published_at: item.published_at,
          availability_attestation: {
            available_at: item.published_at,
            basis: "direct_source_publication",
            attestor_url: item.url,
            verified_at: fetchedAt.toISOString(),
            verification: item.oembed ? "x_oembed+snowflake" : "archive_text+snowflake",
          },
          author: {
            provider_author_id: "thsottiaux",
            identity_id: "person_tibo_sottiaux",
            display_handle: "@thsottiaux",
          },
          native_relations: (item.linked_ids ?? []).map((id) => ({
            type: "links",
            provider_item_id: id,
            url: `https://x.com/thsottiaux/status/${id}`,
          })),
          content: { media_type: "text/plain", text: item.text, language: "en" },
          selection_context: item.selection_context ?? null,
        }, {
          providerName: this.providerName,
          providerVersion: "0.3.0",
          config: this.config,
          firstSeenAt: fetchedAt,
          fetchedAt,
          rawPayload: {
            archive_text: item.archive_text,
            archive_url: this.config.base_url,
            archive_snapshot_ref: archiveSnapshotRef,
            x_oembed: item.oembed,
            selection_context: item.selection_context ?? null,
          },
        });
        if (result.inserted) inserted += 1;
      }
      const legacyOutcomeConditioned = (await store.all("raw_observation"))
        .filter((record) =>
          record.data.ingest_provider === this.providerName &&
          record.data.content.media_type === "text/plain" &&
          !baseItemIds.has(record.data.provider_item_id) &&
          !verifiedItemIds.has(record.data.provider_item_id) &&
          record.data.selection_context?.outcome_conditioned !== true
        );
      for (const observation of legacyOutcomeConditioned) {
        const result = await appendRawObservationRevision(store, {
          provider_item_id: observation.data.provider_item_id,
          canonical_url: observation.data.canonical_url,
          published_at: observation.data.published_at,
          availability_attestation: observation.data.availability_attestation,
          author: observation.data.author,
          native_relations: observation.data.native_relations,
          content: observation.data.content,
          source_timing: observation.data.source_timing,
          selection_context: {
            feature_eligible: false,
            outcome_conditioned: true,
            selection_method: "legacy_non_archive_item_from_outcome_archive_provider",
          },
        }, {
          providerName: this.providerName,
          providerVersion: "0.3.0",
          config: this.config,
          firstSeenAt: observation.data.first_seen_at,
          fetchedAt,
          rawPayload: {
            migration: "mark_legacy_outcome_conditioned_archive_link",
            superseded_observation_ref: {
              record_id: observation.record_id,
              revision: observation.revision,
            },
            superseded_raw_payload_ref: observation.data.content.raw_payload_ref,
          },
        });
        if (result.inserted) inserted += 1;
      }
      const coverageStart = `${parsed.coverageDates[0]}T00:00:00.000Z`;
      const dayAfterLast = new Date(
        Date.parse(`${parsed.coverageDates.at(-1)}T00:00:00Z`) + DAY_MS,
      );
      const coverageEnd = new Date(Math.min(dayAfterLast.getTime(), fetchedAt.getTime())).toISOString();
      if (Date.parse(coverageEnd) <= Date.parse(coverageStart)) {
        throw new Error("Historical monitor coverage interval is empty");
      }
      const negativeLabelEligible =
        requestedAdequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
        completenessAttestation;
      const coverageAdequacy = negativeLabelEligible
        ? COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE
        : COVERAGE_ADEQUACY.OUTCOME_ONLY;
      let runCoverageAssertions;
      if (negativeLabelEligible) {
        runCoverageAssertions = await this.authoritativeDailyCoverage(store, {
          parsed,
          verifiedItems: baseItems,
          archiveSnapshotRef,
          htmlHash,
          coverageGridHash,
          fetchedAt,
          attestation: completenessAttestation,
          coverageContractHash,
        });
      } else {
        runCoverageAssertions = [await addCoverageAssertion(store, {
          provider: this.providerName,
          start: coverageStart,
          end: coverageEnd,
          mode: "historical_archive_date_grid",
          adequacy: coverageAdequacy,
          evidenceRefs: [{
            kind: "archive_snapshot",
            ref: archiveSnapshotRef,
            html_sha256: htmlHash,
            coverage_grid_sha256: coverageGridHash,
          }],
          rationale:
            "A contiguous archive date grid proves outcome discovery only, not complete negative-label coverage.",
          assertedAt: fetchedAt,
          replayAvailableAt: null,
        })];
      }
      const coverageAssertion = runCoverageAssertions.at(-1) ?? null;
      const effectiveCoverageStart = runCoverageAssertions[0]?.start ?? null;
      const effectiveCoverageEnd = coverageAssertion?.end ?? null;
      const coverageWaiting = await this.coverageWaiting(
        store,
        negativeLabelEligible ? completenessAttestation : null,
        fetchedAt,
      );
      const delaySeconds = Math.max(0, Math.round((fetchedAt - startedAt) / 1000));
      await store.append(this.healthObservation({ ok: true, at: fetchedAt, delaySeconds }));
      await store.writeState("historical-monitor-provider", {
        provider: this.providerName,
        source_url: this.config.base_url,
        parser: this.config.format,
        verified_items: verified.length,
        verified_archive_items: baseItems.length,
        discovered_linked_items: linkedItems.length,
        linked_item_errors: linkedErrors,
        coverage_start: effectiveCoverageStart,
        coverage_end: effectiveCoverageEnd,
        coverage_mode: coverageAssertion?.mode ?? null,
        coverage_adequacy: coverageAssertion?.adequacy ?? null,
        coverage_assertion_id: coverageAssertion?.assertion_id ?? null,
        coverage_assertion_revision: coverageAssertion?.revision ?? null,
        coverage_assertion_count: runCoverageAssertions.length,
        archive_snapshot_ref: archiveSnapshotRef,
        archive_html_sha256: htmlHash,
        archive_coverage_grid_sha256: coverageGridHash,
        coverage_contract_hash: coverageContractHash,
        coverage_waiting: coverageWaiting,
        last_success_at: fetchedAt.toISOString(),
        last_error: null,
      });
      return {
        collected: inserted,
        verified_items: verified.length,
        verified_archive_items: baseItems.length,
        discovered_linked_items: linkedItems.length,
        linked_item_errors: linkedErrors,
        coverage: { start: effectiveCoverageStart, end: effectiveCoverageEnd },
        coverage_assertion: coverageAssertion,
        coverage_assertions: runCoverageAssertions,
        coverage_pending: negativeLabelEligible && runCoverageAssertions.length === 0,
        coverage_waiting: coverageWaiting,
        invalidated_coverage_assertions: invalidatedCoverageAssertions,
        archive_snapshot_ref: archiveSnapshotRef,
        health: { ok: true, delay_seconds: delaySeconds },
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
      await store.writeState("historical-monitor-provider", {
        ...previousState,
        provider: this.providerName,
        source_url: this.config.base_url,
        last_failure_at: failedAt.toISOString(),
        last_error: error.message,
      });
      throw error;
    }
  }
}
