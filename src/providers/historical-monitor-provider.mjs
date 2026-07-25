import { hashLabel } from "../core/hash.mjs";
import {
  addCoverageAssertion,
  COVERAGE_ADEQUACY,
} from "../pipeline/coverage.mjs";
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
  constructor({ config, fetchFn = fetch, now = () => new Date() }) {
    this.config = config;
    this.fetch = fetchFn;
    this.now = now;
    this.providerName = config.provider_name ?? "historical_monitor";
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
    const refreshMs = (this.config.refresh_interval_hours ?? 24) * 3_600_000;
    if (!force && previousState.last_success_at &&
        startedAt.getTime() - Date.parse(previousState.last_success_at) < refreshMs) {
      return { collected: 0, skipped: "refresh_interval", health: { ok: true, delay_seconds: 0 } };
    }
    try {
      const requestedAdequacy = this.config.coverage_adequacy;
      const completenessAttestation = this.config.coverage_completeness_attestation;
      const attestationExhaustedAt = completenessAttestation?.exhausted_at;
      const attestationReplayAvailableAt =
        completenessAttestation?.replay_available_at ?? null;
      const validCompletenessAttestation =
        completenessAttestation &&
        typeof completenessAttestation === "object" &&
        typeof completenessAttestation.method === "string" &&
        completenessAttestation.method.length > 0 &&
        typeof attestationExhaustedAt === "string" &&
        !Number.isNaN(Date.parse(attestationExhaustedAt)) &&
        (
          attestationReplayAvailableAt === null ||
          (
            typeof attestationReplayAvailableAt === "string" &&
            !Number.isNaN(Date.parse(attestationReplayAvailableAt))
          )
        );
      if (
        requestedAdequacy === COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE &&
        !validCompletenessAttestation
      ) {
        throw new Error(
          "historical_monitor negative_label_eligible requires a structured coverage_completeness_attestation with method and exhausted_at",
        );
      }
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
          providerVersion: "0.2.0",
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
          providerVersion: "0.2.0",
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
        validCompletenessAttestation;
      const coverageAdequacy = negativeLabelEligible
        ? COVERAGE_ADEQUACY.NEGATIVE_LABEL_ELIGIBLE
        : COVERAGE_ADEQUACY.OUTCOME_ONLY;
      let completenessEvidence = [];
      if (negativeLabelEligible) {
        const completenessPayload = {
          provider: this.providerName,
          archive_snapshot_ref: archiveSnapshotRef,
          archive_html_sha256: htmlHash,
          interval: { start: coverageStart, end: coverageEnd },
          attestation: completenessAttestation,
        };
        const completenessHash = hashLabel(completenessPayload);
        const completenessRef = await store.writeBlob(
          `${this.providerName}-coverage-attestations`,
          `${coverageStart}:${coverageEnd}:${completenessHash}`,
          completenessPayload,
        );
        completenessEvidence = [{
          kind: "independent_completeness_attestation",
          ref: completenessRef,
          sha256: completenessHash,
          method: completenessAttestation.method,
          exhausted_at: new Date(attestationExhaustedAt).toISOString(),
          replay_available_at: attestationReplayAvailableAt === null
            ? null
            : new Date(attestationReplayAvailableAt).toISOString(),
        }];
      }
      const coverageAssertion = await addCoverageAssertion(store, {
        provider: this.providerName,
        start: coverageStart,
        end: coverageEnd,
        mode: "historical_archive_date_grid",
        adequacy: coverageAdequacy,
        evidenceRefs: [
          {
            kind: "archive_snapshot",
            ref: archiveSnapshotRef,
            html_sha256: htmlHash,
            coverage_grid_sha256: coverageGridHash,
          },
          ...completenessEvidence,
        ],
        rationale: negativeLabelEligible
          ? "Archive coverage has an explicit independent completeness attestation."
          : "A contiguous archive date grid proves outcome discovery only, not complete negative-label coverage.",
        assertedAt: fetchedAt,
        replayAvailableAt: negativeLabelEligible
          ? attestationReplayAvailableAt
          : null,
      });
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
        coverage_start: coverageStart,
        coverage_end: coverageEnd,
        coverage_mode: coverageAssertion.mode,
        coverage_adequacy: coverageAssertion.adequacy,
        coverage_assertion_id: coverageAssertion.assertion_id,
        coverage_assertion_revision: coverageAssertion.revision,
        archive_snapshot_ref: archiveSnapshotRef,
        archive_html_sha256: htmlHash,
        archive_coverage_grid_sha256: coverageGridHash,
        last_success_at: fetchedAt.toISOString(),
        last_error: null,
      });
      return {
        collected: inserted,
        verified_items: verified.length,
        verified_archive_items: baseItems.length,
        discovered_linked_items: linkedItems.length,
        linked_item_errors: linkedErrors,
        coverage: { start: coverageStart, end: coverageEnd },
        coverage_assertion: coverageAssertion,
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
