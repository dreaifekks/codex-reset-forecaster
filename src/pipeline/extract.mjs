import { createRecord, producer, recordRef, targetScope } from "../core/records.mjs";
import { makeRecordId } from "../core/hash.mjs";
import { addHours, floorHour, halfOpenRange } from "../core/time.mjs";
import { confirmationIdentityIds, sourceRoleForIdentity } from "../core/sources.mjs";
import {
  AUTHORITY_SCOPE_POLICY,
  extractorContract,
} from "../core/extractor-contract.mjs";
import { canonicalXStatusUrl, xStatusIdentity } from "../providers/raw.mjs";
import { MULTI_PRODUCT, UNKNOWN_PRODUCT } from "../core/product-scope.mjs";

const RESET_TERMS = /\b(reset(?:s|ting|ing|ted)?|refill(?:s|ed|ing)?|refresh(?:ed|ing)?)\b/i;
const QUOTA_TERMS = /\b(usage|rate|quota|limit|limits|allowance)\b/i;
const TARGET_RESET_TERMS = /\b(codex(?:er|ers)?|global|all paid|paid users|paid plans|chatgpt work)\b/i;
const PLATFORM_SCOPE_TERMS = /\b(all paid|paid users|paid plans|all plans|all accounts|all users|all codex users|all paid chatgpt subscriptions|everyone(?:'s)?|everybody|across all|codex and chatgpt work|chatgpt work and codex|all (?:our )?(?:chatgpt work and codex|codex and chatgpt work) users)\b/i;
const GLOBAL_RESET_SCOPE = /(?:\bglobal(?:\s+codex)?\s+reset\b|\breset(?:s|ting|ing|ted)?\b[^.!?\n]{0,48}\bglobally\b)/i;
const NARROW_SCOPE_TERMS = new RegExp([
  String.raw`\b(?:plus|pro|team|enterprise|business|edu|free)(?:\s*(?:&|and|\/)\s*(?:plus|pro|team|enterprise|business|edu|free))*\s+(?:plans?|subscriptions?|users?|accounts?)\b`,
  String.raw`\b(?:some|selected|specific|affected|eligible|individual|a subset of|less than\s+\d+(?:\.\d+)?%)\s+(?:users?|accounts?|subscriptions?|plans?)\b`,
  String.raw`\b(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*[km])\s+(?:of\s+)?(?:users?|accounts?|subscriptions?)\b`,
  String.raw`\b(?:your|this|that)\s+(?:codex\s+)?account\b`,
  String.raw`\b(?:users?|accounts?|subscriptions?)\s+in\s+(?:the\s+)?(?:us|usa|uk|eu|europe|canada|australia|india|japan|asia)\b`,
  String.raw`\b(?:us|usa|uk|eu|european|canadian|australian|indian|japanese|asian)\s+(?:users?|accounts?|subscriptions?)\b`,
].join("|"), "i");
const BANKED_RESET_TERMS =
  /\b(?:banked\s+(?:codex\s+)?resets?|codex\s+banked\s+resets?|reset\s+banks?|reset\s+vouchers?|vouchers?)\b/i;
const IMMEDIATE_RESET_COMPLETION_TERMS = new RegExp([
  String.raw`\b(?:have|has|had|we've|we have|i've|i have)\s+(?:now\s+)?(?:fully\s+)?reset\b[^.!?\n]{0,64}\b(?:usage|rate|quota|limits?|allowance|everyone(?:'s)?\s+codex)\b`,
  String.raw`\b(?:usage|rate|quota|limits?|allowance)\b[^.!?\n]{0,64}\b(?:have|has|had|were|was)\s+(?:been\s+)?(?:fully\s+)?reset\b`,
  String.raw`\breset\s+button\s+(?:has\s+been\s+)?pressed\b`,
  String.raw`\bwe\s+did\b[^.!?\n]{0,48}\b(?:double|full|hard)?\s*reset\b`,
  String.raw`\b(?:full|hard)\s+reset\s+on\s+us\b`,
].join("|"), "i");
const COMPETITOR_TERMS = /\b(anthropic|claude|google|gemini|xai|grok|deepseek|mistral)\b/i;
const RELEASE_TERMS = /\b(launch(?:ed|ing)?|release(?:d|s|ing)?|new model|announce(?:d|ment)?|rollout)\b/i;
const INCIDENT_TERMS = /\b(incident|outage|degrad(?:ed|ation)|capacity|unavailable|recovered|restore(?:d|ing)?|partial(?:ly)? down|system errors?|hanging|war\s*room|investigat(?:e|es|ed|ing|ion)|mitigat(?:e|es|ed|ing|ion)|usage (?:drain(?:s|ed|ing)?|consumption)|fleet (?:is )?melting)\b/i;
const CODEX_TERMS = /\bcodex(?:er|ers)?\b/i;
const CHATGPT_WORK_TERMS = /\bchatgpt\s+work\b/i;

function resetScopeSegments(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((segment) => RESET_TERMS.test(segment));
}

function immediateResetScopeSegments(text) {
  return resetScopeSegments(text).filter((segment) =>
    !BANKED_RESET_TERMS.test(segment) ||
    IMMEDIATE_RESET_COMPLETION_TERMS.test(segment)
  );
}

function hasExplicitPlatformScope(text) {
  return immediateResetScopeSegments(text).some((segment) =>
    PLATFORM_SCOPE_TERMS.test(segment) || GLOBAL_RESET_SCOPE.test(segment)
  );
}

function hasNarrowScopeQualifier(text) {
  return immediateResetScopeSegments(text).some((segment) =>
    NARROW_SCOPE_TERMS.test(segment)
  );
}

function isBankedResetOnly(text) {
  return BANKED_RESET_TERMS.test(text) && !IMMEDIATE_RESET_COMPLETION_TERMS.test(text);
}

function policyAllowsAuthorityGenericCompletedScope({
  observation,
  config,
  eventType,
  phase,
  productScope,
  root,
  role,
  narrowScope,
  bankedResetOnly,
}) {
  const outcomeDefinition = config.outcome_definition;
  if (
    outcomeDefinition?.event_semantics !== "qualifying_authority_completion_statement" ||
    outcomeDefinition?.scope_policy !== AUTHORITY_SCOPE_POLICY ||
    eventType !== "quota_reset" ||
    phase !== "completed" ||
    root.derivation !== "primary_statement" ||
    observation.data.content.media_type !== "text/plain" ||
    role === "aggregator" ||
    narrowScope ||
    bankedResetOnly
  ) {
    return false;
  }
  const identityId = observation.data.author.identity_id;
  if (
    !new Set(outcomeDefinition.authority_identity_ids ?? []).has(identityId) ||
    !confirmationIdentityIds(config).has(identityId)
  ) {
    return false;
  }
  return productScope.product === "codex" ||
    productScope.products?.includes("codex") === true;
}
function sourceRole(observation, config) {
  if (observation.data.content.media_type === "application/vnd.x-search-summary+text") {
    return "aggregator";
  }
  return sourceRoleForIdentity(config, observation.data.author.identity_id);
}

function classifyEvent(text) {
  if (RESET_TERMS.test(text) && (QUOTA_TERMS.test(text) || TARGET_RESET_TERMS.test(text))) {
    return /\brefill/i.test(text) ? "quota_refill" : "quota_reset";
  }
  if (COMPETITOR_TERMS.test(text) && QUOTA_TERMS.test(text)) return "competitor_limit_change";
  if (RELEASE_TERMS.test(text)) return "release";
  if (INCIDENT_TERMS.test(text)) return /\brestore/i.test(text) ? "capacity_restore" : "incident";
  if (/\b(commit|merge|deploy|ship(?:ped|ping)?|development|build)\b/i.test(text)) {
    return "development_activity";
  }
  return null;
}

function classifyProductScope(text, config) {
  const codex = CODEX_TERMS.test(text);
  const chatgptWork = CHATGPT_WORK_TERMS.test(text);
  const competitor = COMPETITOR_TERMS.test(text);
  if (competitor && (codex || chatgptWork)) {
    return {
      vendor: "multi_vendor",
      product: MULTI_PRODUCT,
      products: [
        ...(codex ? ["codex"] : []),
        ...(chatgptWork ? ["chatgpt_work"] : []),
        "competing_model",
      ].sort(),
    };
  }
  if (codex && chatgptWork) {
    return {
      vendor: config.target.vendor,
      product: MULTI_PRODUCT,
      products: ["chatgpt_work", "codex"].sort(),
    };
  }
  if (codex) {
    return { vendor: config.target.vendor, product: "codex" };
  }
  if (chatgptWork) {
    return { vendor: config.target.vendor, product: "chatgpt_work" };
  }
  if (competitor) {
    return { vendor: "other", product: "competing_model" };
  }
  return { vendor: config.target.vendor, product: UNKNOWN_PRODUCT };
}

function classifyPhase(text, eventType) {
  if (/\b(denied|not happening|won't reset|will not reset|no (?:codex )?reset)\b/i.test(text) ||
      /\b(?:is|was|should|would)?\s*not\b(?!\s+only\b)[^.!?\n]{0,64}\b(?:a\s+)?(?:new\s+)?(?:global\s+|codex\s+)?reset\b/i.test(text)) return "denied";
  if (/\b(cancelled|canceled|called off)\b/i.test(text)) return "cancelled";
  if (isBankedResetOnly(text)) {
    return /\b(?:apply|use|redeem)\b[^.!?\n]{0,64}\b(?:later|schedule|when|whenever)\b/i.test(text) ||
      /\b(?:later|schedule|own\s+leisure|own\s+time)\b/i.test(text)
      ? "scheduled"
      : "rumor";
  }
  if (/\b(?:have|has|had|we've|we have|i've|i have)\s+(?:now\s+)?(?:fully\s+)?(?:been\s+)?reset\b/i.test(text)) return "completed";
  if (/\b(?:usage|rate|weekly|five-hour|5-hour)?\s*(?:limits?|quota|allowance)\s+(?:(?:have|has|had)\s+been|were|was|just(?:\s+got)?)\s+(?:fully\s+)?reset\b/i.test(text)) return "completed";
  if (/\b(?:reset|refill)\s+(?:is\s+)?(?:complete|completed|done|live)\b/i.test(text)) return "completed";
  if (/\b(?:reset button (?:has been )?pressed|(?:allowed|let)\s+codex\s+to\s+reset)\b/i.test(text)) return "completed";
  if (/\bwe\s+did\b[^.!?\n]{0,48}\b(?:double|full|hard)?\s*reset\b/i.test(text) ||
      /\b(?:full|hard)\s+reset\s+on\s+us\b/i.test(text)) return "completed";
  if (/\b(?:reset|refill)[\s\S]{0,24}\b(?:rolling out|underway|in progress)\b/i.test(text) ||
      /\b(?:usage|limits?|quota)[\s\S]{0,36}\b(?:return|back)\s+to\s+100%\s+within\s+(?:a few\s+)?minutes\b/i.test(text)) return "started";
  if (/\b(reset(?:ting)?|reseting|refill(?:ing)?)\s+(?:the\s+)?(?:usage|rate\s+limits?|limits?|quota)\s+(?:now|currently)\b/i.test(text)) return "started";
  if (/\b(?:we(?:\s+are|'re|’re)|i(?:\s+am|'m|’m))\s+(?:now\s+)?(?:once again\s+)?reset(?:ting|ing)\b/i.test(text)) return "started";
  if (/\b(?:decision (?:to|of)|started)\s+reset(?:ting|ing)\b/i.test(text)) return "started";
  if (/\bwe(?:\s+are|'re)\s+(?:now\s+)?(?:giving|applying)\b[^.!?\n]{0,64}\b(?:usage\s+)?reset\b/i.test(text)) return "started";
  if (RESET_TERMS.test(text) && /\b(?:propagating|lands?|should\s+land|should\s+be\s+showing|should\s+have\b[^.!?\n]{0,48}\bback)\b/i.test(text)) return "started";
  if (/\benjoy\b[\s\S]{0,40}\breset(?:ted)?\b/i.test(text)) return "completed";
  if (/\b(lands?|coming|incoming|arriv(?:e|es|ing)|will|going to|later|tomorrow|this evening|next hour|tonight|soon|in a bit)\b/i.test(text)) {
    return "scheduled";
  }
  if (/\b(expect|likely|probably|should|might|may)\b/i.test(text)) return "expected";
  if (["release", "incident", "development_activity", "competitor_limit_change"].includes(eventType)) {
    return /\b(rumor|reportedly|unconfirmed)\b/i.test(text) ? "rumor" : "completed";
  }
  return "rumor";
}

function assertedRange(text, publishedAt, phase) {
  if (!publishedAt) return null;
  const published = new Date(publishedAt);
  if (["scheduled", "expected", "started"].includes(phase)) {
    const minutes = text.match(/\b(?:in|over|within)?\s*(?:the\s+)?next\s+(\d{1,3})\s+minutes?\b/i);
    if (minutes) {
      return halfOpenRange(
        published,
        new Date(published.getTime() + Number(minutes[1]) * 60_000),
        "minute",
        minutes[0],
      );
    }
    if (/\b(?:in|over|within)?\s*(?:the\s+)?next\s+hour\b/i.test(text)) {
      return halfOpenRange(published, addHours(published, 1), "hour", "next hour");
    }
    if (/\b(?:in|over|within)?\s*(?:the\s+)?next\s+(?:few|couple of)\s+hours?\b/i.test(text) ||
        /\bback\s+in\s+a\s+few\b/i.test(text)) {
      return halfOpenRange(published, addHours(published, 3), "hour", "next few hours");
    }
    if (/\btomorrow morning\b/i.test(text)) {
      return halfOpenRange(addHours(published, 4), addHours(published, 24), "part_of_day", "tomorrow morning");
    }
    if (/\btomorrow\b/i.test(text)) {
      return halfOpenRange(addHours(published, 1), addHours(published, 30), "day", "tomorrow");
    }
    if (/\b(?:this evening|tonight)\b/i.test(text)) {
      return halfOpenRange(published, addHours(published, 24), "part_of_day", "this evening");
    }
    if (/\blater (?:in the day|today)\b/i.test(text)) {
      const end = new Date(Date.UTC(
        published.getUTCFullYear(),
        published.getUTCMonth(),
        published.getUTCDate() + 1,
      ));
      return halfOpenRange(published, end, "part_of_day", "later today");
    }
    if (/\b(?:reset incoming|in a bit)\b/i.test(text)) {
      return halfOpenRange(published, addHours(published, 6), "hour", "near-term intent");
    }
  }
  if (["started", "completed"].includes(phase) &&
      /\b(now|currently|have been reset|has been reset|have reset|has reset)\b/i.test(text)) {
    const start = floorHour(published);
    return halfOpenRange(start, addHours(start, 1), "hour", "notification-hour inference");
  }
  return null;
}

function evidenceRoot(observation, role) {
  const summarySource = observation.data.native_relations.find((item) =>
    item.type === "links" && (xStatusIdentity(item.provider_item_id) || xStatusIdentity(item.url))
  );
  if (role === "aggregator" && summarySource) {
    const statusId = xStatusIdentity(summarySource.provider_item_id) ??
      xStatusIdentity(summarySource.url);
    return {
      rootId: `x_post:${statusId}`,
      derivation: "summarizes",
    };
  }
  const relation = observation.data.native_relations.find((item) => ["quotes", "repost"].includes(item.type));
  if (relation?.provider_item_id || relation?.url) {
    const statusId = xStatusIdentity(relation.provider_item_id) ?? xStatusIdentity(relation.url);
    return {
      rootId: statusId
        ? `x_post:${statusId}`
        : `relation:${relation.provider_item_id ?? relation.url}`,
      derivation: relation.type === "quotes" ? "quotes" : "repost",
    };
  }
  const linkedSource = ["community", "aggregator"].includes(role)
    ? observation.data.native_relations.find((item) => item.type === "links" && item.url)
    : null;
  if (linkedSource) {
    const statusId = xStatusIdentity(linkedSource.provider_item_id) ??
      xStatusIdentity(linkedSource.url);
    let normalizedUrl = linkedSource.url;
    try {
      normalizedUrl = new URL(linkedSource.url).toString();
    } catch {
      // Retain the provider value as an auditable fallback for malformed links.
    }
    return {
      rootId: statusId
        ? `x_post:${statusId}`
        : `url:${normalizedUrl}`,
      derivation: "summarizes",
    };
  }
  const canonicalStatusId = xStatusIdentity(observation.data.canonical_url) ??
    xStatusIdentity(observation.data.provider_item_id);
  if (canonicalStatusId) {
    return {
      rootId: `x_post:${canonicalStatusId}`,
      derivation: "primary_statement",
    };
  }
  return {
    rootId: `${observation.data.ingest_provider}:${observation.data.provider_item_id}`,
    derivation: "primary_statement",
  };
}

export function extractSignal(observation, config, {
  availableAt = observation.data.fetched_at,
  createdAt = observation.data.fetched_at,
  evidenceRootOverride = null,
} = {}) {
  const extractor = extractorContract(config);
  const text = observation.data.content.text.replace(/[*_`]/g, "");
  const eventType = classifyEvent(text);
  if (!eventType) return null;
  const phase = classifyPhase(text, eventType);
  const productScope = classifyProductScope(text, config);
  const role = sourceRole(observation, config);
  const root = evidenceRootOverride ?? evidenceRoot(observation, role);
  const narrowScope = hasNarrowScopeQualifier(text);
  const bankedResetOnly = isBankedResetOnly(text);
  const platform = !bankedResetOnly && !narrowScope && (
    hasExplicitPlatformScope(text) ||
    policyAllowsAuthorityGenericCompletedScope({
      observation,
      config,
      eventType,
      phase,
      productScope,
      root,
      role,
      narrowScope,
      bankedResetOnly,
    })
  );
  const explicit = phase !== "rumor" &&
    (platform || !["quota_reset", "quota_refill"].includes(eventType));
  const confidence = explicit ? 0.94 : eventType ? 0.72 : 0.5;
  return createRecord({
    recordType: "normalized_signal",
    naturalKey: [
      `${observation.record_id}@${observation.revision}`,
      config.taxonomy_version,
      extractor.model,
      extractor.model_version,
      extractor.prompt_version,
      extractor.semantic_policy_hash,
    ].join(":"),
    createdAt,
    producer: producer("rule-claim-extractor", extractor.model_version, {
      taxonomy_version: config.taxonomy_version,
      extractor_model: extractor.model,
      prompt_version: extractor.prompt_version,
      semantic_policy_hash: extractor.semantic_policy_hash,
    }),
    data: {
      observation_refs: [recordRef(observation)],
      available_at: new Date(availableAt).toISOString(),
      taxonomy_version: config.taxonomy_version,
      claim: {
        event_type: eventType,
        phase,
        stance: ["denied", "cancelled"].includes(phase) ? "contradicts" : "supports",
        scope: targetScope({
          ...productScope,
          population: platform ? "platform" : "unknown",
          plans: platform ? ["paid"] : ["unknown"],
          quota_bucket: platform ? config.target.quota_bucket : null,
        }),
        asserted_time_range: assertedRange(text, observation.data.published_at, phase),
        author_certainty: explicit ? "explicit" : phase === "expected" ? "probable" : "possible",
      },
      provenance: {
        source_identity_id: observation.data.author.identity_id,
        source_role: role,
        root_evidence_id: root.rootId,
        derivation: root.derivation,
        independence_group_id: makeRecordId("ind", root.rootId),
        feature_eligible: observation.data.selection_context?.feature_eligible !== false,
        selection_bias: observation.data.selection_context?.outcome_conditioned
          ? "outcome_conditioned_archive_link"
          : null,
        source_published_at: observation.data.published_at,
        first_seen_at: observation.data.first_seen_at,
        recency_basis: observation.data.published_at
          ? "source_publication"
          : "unknown",
        canonical_source_url: canonicalXStatusUrl(
          observation.data.canonical_url ??
          observation.data.native_relations.find((relation) => relation.type === "links")?.url,
        ),
      },
      extraction: {
        model: extractor.model,
        model_version: extractor.model_version,
        prompt_version: extractor.prompt_version,
        semantic_policy_hash: extractor.semantic_policy_hash,
        confidence,
      },
    },
  });
}

export async function normalizeNewObservations(store, config, { now = new Date() } = {}) {
  const extractor = extractorContract(config);
  const observations = (await store.all("raw_observation", { latestOnly: false }))
    .sort((left, right) =>
      left.data.first_seen_at.localeCompare(right.data.first_seen_at) ||
      left.record_id.localeCompare(right.record_id) ||
      left.revision - right.revision
    );
  const normalized = await store.all("normalized_signal", { latestOnly: false });
  const exactRef = (ref) => `${ref.record_id}@${ref.revision}`;
  const currentNormalizedRefs = new Set(
    normalized
      .filter((signal) => signal.producer.name === "rule-claim-extractor" &&
        signal.data.taxonomy_version === config.taxonomy_version &&
        signal.data.extraction.model === extractor.model &&
        signal.data.extraction.model_version === extractor.model_version &&
        signal.data.extraction.prompt_version === extractor.prompt_version &&
        signal.data.extraction.semantic_policy_hash === extractor.semantic_policy_hash)
      .flatMap((signal) => signal.data.observation_refs.map(exactRef)),
  );
  const previouslyNormalizedRefs = new Set(
    normalized.flatMap((signal) => signal.data.observation_refs.map(exactRef)),
  );
  const normalizationState = await store.readState("normalization", { versions: {} });
  normalizationState.versions ??= {};
  const previouslyProcessedRefs = new Set([
    ...previouslyNormalizedRefs,
    ...Object.values(normalizationState.versions).flatMap((state) =>
      Object.entries(state?.processed ?? {})
        .filter(([, complete]) => complete === true)
        .map(([reference]) => reference)
    ),
  ]);
  const versionKey = [
    config.taxonomy_version,
    extractor.model,
    extractor.model_version,
    extractor.prompt_version,
    extractor.semantic_policy_hash,
  ].join(":");
  const processed = normalizationState.versions[versionKey]?.processed ?? {};
  const contentRoots = new Map();
  const evidenceRoots = new Map();
  for (const observation of observations) {
    const role = sourceRole(observation, config);
    let root = evidenceRoot(observation, role);
    const contentHash = observation.data.content.content_hash;
    const hasText = observation.data.content.media_type === "text/plain" &&
      observation.data.content.text.trim().length > 0;
    const contentTime = Date.parse(observation.data.published_at ?? observation.data.first_seen_at);
    const priorContent = contentRoots.get(contentHash);
    const samePropagationWave = priorContent &&
      Math.abs(contentTime - priorContent.at) <= 72 * 3_600_000;
    const authoritativeDirectStatement =
      root.derivation === "primary_statement" &&
      xStatusIdentity(observation.data.canonical_url) &&
      ["official", "product_lead", "product_team_member"].includes(role);
    if (
      root.derivation === "primary_statement" &&
      hasText &&
      samePropagationWave &&
      !authoritativeDirectStatement
    ) {
      root = { rootId: priorContent.rootId, derivation: "summarizes" };
    } else if (
      hasText &&
      (!priorContent || !samePropagationWave || authoritativeDirectStatement)
    ) {
      contentRoots.set(contentHash, { rootId: root.rootId, at: contentTime });
    }
    evidenceRoots.set(exactRef(observation), root);
  }
  const pending = observations.filter((observation) => {
    const key = exactRef(observation);
    return !currentNormalizedRefs.has(key) && processed[key] !== true;
  });
  const records = pending
    .map((observation) => extractSignal(observation, config, {
      createdAt: now,
      availableAt: previouslyProcessedRefs.has(exactRef(observation))
        ? now
        : observation.revision === 1
          ? observation.data.availability_attestation?.available_at ?? observation.data.fetched_at
          : observation.data.fetched_at ?? observation.created_at,
      evidenceRootOverride: evidenceRoots.get(exactRef(observation)),
    }))
    .filter(Boolean);
  const results = await store.appendMany(records);
  normalizationState.versions[versionKey] = {
    processed: Object.fromEntries([
      ...Object.keys(processed).map((key) => [key, true]),
      ...pending.map((observation) => [exactRef(observation), true]),
    ]),
    updated_at: new Date(now).toISOString(),
  };
  await store.writeState("normalization", normalizationState);
  return { normalized: results.filter((result) => result.inserted).length, records };
}
