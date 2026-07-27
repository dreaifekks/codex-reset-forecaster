import { createRecord, producer, recordRef } from "../core/records.mjs";
import { hashLabel, stableStringify } from "../core/hash.mjs";
import { toUtcIso } from "../core/time.mjs";

const X_EPOCH_MS = 1_288_834_974_657n;

export function xStatusIdentity(value) {
  const text = String(value ?? "").trim();
  const urlMatch = text.match(
    /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[^/?#]+\/)?status(?:es)?\/(\d+)/i,
  );
  if (urlMatch) return urlMatch[1];
  return /^\d{6,24}$/.test(text) ? text : null;
}

export function timestampFromXSnowflake(id) {
  if (!/^\d{16,22}$/.test(String(id))) {
    throw new Error(`Invalid X snowflake: ${id}`);
  }
  return new Date(Number((BigInt(id) >> 22n) + X_EPOCH_MS)).toISOString();
}

export function canonicalXStatusUrl(value, fallbackHandle = "i") {
  const id = xStatusIdentity(value);
  if (!id) return null;
  const handle = String(value ?? "").match(
    /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)\/status(?:es)?\/\d+/i,
  )?.[1];
  const normalizedHandle = handle && handle.toLowerCase() !== "i"
    ? handle
    : String(fallbackHandle || "i").replace(/^@/, "");
  return `https://x.com/${normalizedHandle}/status/${id}`;
}

function normalizedAvailabilityAttestation(value) {
  if (!value) return null;
  return {
    available_at: toUtcIso(value.available_at),
    basis: value.basis,
    attestor_url: value.attestor_url,
    verified_at: toUtcIso(value.verified_at),
    verification: value.verification,
  };
}

function materialDataFromItem(item) {
  return {
    canonical_url: item.canonical_url ?? null,
    published_at: item.published_at ? toUtcIso(item.published_at) : null,
    availability_attestation: item.availability_attestation
      ? {
          ...normalizedAvailabilityAttestation(item.availability_attestation),
          verified_at: null,
        }
      : null,
    author: {
      provider_author_id: item.author?.provider_author_id ?? null,
      identity_id: item.author?.identity_id ?? null,
      display_handle: item.author?.display_handle ?? null,
    },
    native_relations: (item.native_relations ?? [])
      .map((relation) => ({
        type: relation.type ?? "unknown",
        provider_item_id: relation.provider_item_id ? String(relation.provider_item_id) : null,
        url: relation.url ?? null,
      }))
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    content: {
      media_type: item.content?.media_type ?? "text/plain",
      text: item.content?.text ?? "",
      language: item.content?.language ?? null,
    },
    selection_context: item.selection_context ?? null,
    source_timing: item.source_timing ?? null,
  };
}

function materialDataFromObservation(observation) {
  return materialDataFromItem({
    canonical_url: observation.data.canonical_url,
    published_at: observation.data.published_at,
    availability_attestation: observation.data.availability_attestation,
    author: observation.data.author,
    native_relations: observation.data.native_relations,
    content: observation.data.content,
    selection_context: observation.data.selection_context,
    source_timing: observation.data.source_timing,
  });
}

export function rawObservationMaterialHash(itemOrObservation) {
  const material = itemOrObservation?.record_type === "raw_observation"
    ? materialDataFromObservation(itemOrObservation)
    : materialDataFromItem(itemOrObservation);
  return hashLabel(stableStringify(material));
}

export function rawObservationFromItem(item, {
  providerName,
  providerVersion,
  config,
  firstSeenAt,
  fetchedAt = firstSeenAt,
  rawPayloadRef = null,
  rawPayloadHash = null,
  revision = 1,
  supersedes = null,
  createdAt = null,
}) {
  const publishedAt = item.published_at ? toUtcIso(item.published_at) : null;
  const seenAt = toUtcIso(firstSeenAt);
  const fetched = toUtcIso(fetchedAt);
  const materialHash = rawObservationMaterialHash(item);
  return createRecord({
    recordType: "raw_observation",
    naturalKey: `${providerName}:${item.provider_item_id}`,
    createdAt: createdAt ?? seenAt,
    revision,
    supersedes,
    producer: producer(`${providerName}-provider`, providerVersion, config),
    data: {
      ingest_provider: providerName,
      provider_item_id: String(item.provider_item_id),
      canonical_url: item.canonical_url ?? null,
      published_at: publishedAt,
      first_seen_at: seenAt,
      fetched_at: fetched,
      availability_attestation: normalizedAvailabilityAttestation(item.availability_attestation),
      author: {
        provider_author_id: item.author?.provider_author_id ?? null,
        identity_id: item.author?.identity_id ?? null,
        display_handle: item.author?.display_handle ?? null,
      },
      native_relations: (item.native_relations ?? []).map((relation) => ({
        type: relation.type ?? "unknown",
        provider_item_id: relation.provider_item_id ? String(relation.provider_item_id) : null,
        url: relation.url ?? null,
      })),
      content: {
        media_type: item.content?.media_type ?? "text/plain",
        text: item.content?.text ?? "",
        language: item.content?.language ?? null,
        content_hash: hashLabel(item.content?.text ?? ""),
        raw_payload_ref: rawPayloadRef,
        raw_payload_hash: rawPayloadHash,
      },
      material_hash: materialHash,
      selection_context: item.selection_context ?? null,
      source_timing: item.source_timing ?? null,
    },
  });
}

export async function appendRawObservationRevision(store, item, {
  providerName,
  providerVersion,
  config,
  firstSeenAt,
  fetchedAt,
  rawPayload = item.raw ?? item,
}) {
  const providerItemId = String(item.provider_item_id);
  const previous = (await store.all("raw_observation"))
    .find((record) =>
      record.data.ingest_provider === providerName &&
      record.data.provider_item_id === providerItemId
    ) ?? null;
  const materialHash = rawObservationMaterialHash(item);
  const previousMaterialHash = previous?.data.material_hash ??
    (previous ? rawObservationMaterialHash(previous) : null);
  if (previous && previousMaterialHash === materialHash) {
    return { inserted: false, record: previous, unchanged: true };
  }

  const rawPayloadHash = hashLabel(stableStringify(rawPayload));
  const rawPayloadRef = await store.writeBlob(
    providerName,
    `${providerItemId}:${rawPayloadHash}`,
    rawPayload,
  );
  const record = rawObservationFromItem(item, {
    providerName,
    providerVersion,
    config,
    firstSeenAt: previous?.data.first_seen_at ?? firstSeenAt,
    fetchedAt,
    rawPayloadRef,
    rawPayloadHash,
    revision: previous ? previous.revision + 1 : 1,
    supersedes: previous ? recordRef(previous) : null,
    createdAt: previous ? fetchedAt : firstSeenAt,
  });
  return store.append(record);
}
