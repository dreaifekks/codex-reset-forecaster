export const TOPIC_RELEVANCE_POLICY_VERSION = "reset-topic-relevance/2";

const TARGET_PRODUCT_TERMS = /\b(?:codex(?:er|ers)?|chatgpt\s+work)\b/i;
const ECOSYSTEM_PRODUCT_TERMS =
  /\b(?:anthropic|claude(?:\s+code)?|gemini|google\s+ai|xai|grok)\b/i;
const NAMED_PRODUCT_PATTERN = String.raw`(?:codex(?:er|ers)?|chatgpt\s+work|anthropic|claude(?:\s+code)?|gemini|google\s+ai|xai|grok)`;
const QUOTA_TERMS = new RegExp([
  String.raw`\busage(?:\s+limits?)?\b`,
  String.raw`\brate[_\s-]?limits?\b`,
  String.raw`\bquotas?\b`,
  String.raw`\ballowances?\b`,
  String.raw`\b(?:monthly|weekly|hourly|daily|token|request)\s+(?:caps?|limits?)\b`,
  String.raw`\b(?:five|5)[-\s]?hour\s+limits?\b`,
].join("|"), "i");
const RESET_ACTION = /\b(?:reset(?:s|ting|ted)?|refill(?:s|ed|ing)?)\b/i;
const LIMIT_POLICY_ACTION = new RegExp([
  String.raw`\b(?:increase|raise|boost|expand|double|lift|suspend|remove|reduce|lower|cut|change)(?:s|d|ing)?\b`,
  String.raw`\b(?:roll(?:ed|ing)?\s+out|set)\b`,
].join("|"), "i");
const RELEASE_ACTION =
  /\b(?:officially\s+)?(?:launch(?:es|ed|ing)?|release(?:s|d|ing)?|announce(?:s|d|ment|ing)?|introduc(?:es|ed|ing)?|roll(?:ed|ing)?\s+out)\b/i;
const RELEASE_VERB_PATTERN =
  String.raw`(?:launch(?:es|ed|ing)|release(?:s|d|ing)|announce(?:s|d|ing)|introduc(?:es|ed|ing)|roll(?:ed|ing)?\s+out)`;
const NAMED_RELEASE_ACTION = new RegExp([
  String.raw`${NAMED_PRODUCT_PATTERN}[^.!?\n]{0,36}\b${RELEASE_VERB_PATTERN}\b`,
  String.raw`\b${RELEASE_VERB_PATTERN}\b[^.!?\n]{0,36}${NAMED_PRODUCT_PATTERN}`,
].join("|"), "i");
const CREATION_WORKFLOW_LAUNCH =
  /\b(?:idea|startup|business|website|app|product)\b[^.!?\n]{0,32}\bto\s+launch\b/i;
const DEVELOPMENT_ACTION =
  /\b(?:commit(?:ted)?|merg(?:e|ed|ing)|deploy(?:ed|ing)?|ship(?:ped|ping)?|development|build(?:ing|s|t)?)\b/i;
const STRONG_INCIDENT_TERMS = new RegExp([
  String.raw`\bincidents?\b`,
  String.raw`\boutages?\b`,
  String.raw`\bdegrad(?:ed|ation)\b`,
  String.raw`\bunavailable\b`,
  String.raw`\bservice\s+disruption\b`,
  String.raw`\b(?:service|system|api)\s+(?:is\s+|was\s+)?down\b`,
  String.raw`\b(?:investigat|mitigat)(?:e|es|ed|ing|ion)\b`,
  String.raw`\brecover(?:ed|ing|y)\b`,
  String.raw`\busage\s+drain(?:s|ed|ing)?\b`,
].join("|"), "i");
const CAPACITY_OPERATION = new RegExp([
  String.raw`\bcapacity\s+(?:incident|issue|problem|constraint|shortage|degradation)\b`,
  String.raw`\bcapacity\s+(?:is|was|has\s+been)?\s*(?:restored|recovered|expanded|increased|constrained)\b`,
  String.raw`\b(?:add|restore|recover|expand|increase|scale)(?:s|d|ing)?\s+(?:service\s+)?capacity\b`,
].join("|"), "i");
const ERROR_SIGNATURE = new RegExp([
  String.raw`\bhttp\s*429\b`,
  String.raw`\b429\b`,
  String.raw`\bresource[_\s-]?exhausted\b`,
  String.raw`\b__?rate[_\s-]?limit__?\b`,
  String.raw`\brate[_\s-]?limit\s+(?:error|exception|response)\b`,
  String.raw`\b(?:monthly\s+cap|current\s+quota|quota|allowance)\s+(?:was\s+|is\s+)?exceeded\b`,
  String.raw`\bexceeded\s+(?:my|your|the|current)\s+(?:quota|allowance|limit)\b`,
].join("|"), "i");
const PLATFORM_SCOPE_TERMS =
  /\b(?:all users|all paid users|all plans|platform[-\s]?wide|service[-\s]?wide|globally|widespread|across the (?:service|platform))\b/i;
const EXPLICIT_NON_CLAIM = new RegExp([
  String.raw`\bdoes\s+not\s+explicitly\s+state\b[^.!?]{0,100}\b(?:reset|limits?|quota)\b`,
  String.raw`\bnot\s+an?\s+(?:actual|explicit|confirmed)\b[^.!?]{0,80}\b(?:reset|limit|incident|release)\b`,
  String.raw`\bpossible\s+(?:reset|limit)\s+hint\b[^.!?]{0,80}\b(?:not\s+sure|does\s+not)\b`,
  String.raw`\btrying\b[^.!?]{0,80}\bnot\s+sure\b[^.!?]{0,80}\b(?:reset|limits?|quota)\b`,
].join("|"), "i");
const RELATED_REPLY_CUE = new RegExp([
  String.raw`\bsame\s+here\b`,
  String.raw`\bme\s+too\b`,
  String.raw`\b(?:can\s+)?confirm(?:ed)?\b`,
  String.raw`\b(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+(?:also\s+)?seeing\b`,
  String.raw`\b(?:still|also)\s+(?:seeing|happening|affected|broken|down|unavailable)\b`,
  String.raw`\b(?:not\s+)?fixed\s+(?:now|yet|for\s+me)\b`,
  String.raw`\b(?:works?|back|resolved|recovered)\s+(?:now|for\s+me)\b`,
].join("|"), "i");

function splitSegments(value) {
  return String(value ?? "")
    .split(/\n+|(?<=[.!?。！？])\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function hasOperationalAction(segment) {
  return RESET_ACTION.test(segment) ||
    LIMIT_POLICY_ACTION.test(segment) ||
    RELEASE_ACTION.test(segment) ||
    DEVELOPMENT_ACTION.test(segment) ||
    STRONG_INCIDENT_TERMS.test(segment) ||
    CAPACITY_OPERATION.test(segment);
}

function requestOrHypothetical(segment) {
  if (!hasOperationalAction(segment)) return false;
  return [
    /\bplease\b[^.!?]{0,100}\b(?:reset|refill|increase|raise|lift|release|launch)\b/i,
    /\b(?:reset|refill|increase|raise|lift|release|launch)\b[^.!?]{0,60}\bplease\b/i,
    /\b(?:can|could|would|will)\s+(?:you|we|they|openai|anthropic|google|xai)\b[^.!?]{0,100}\b(?:reset|refill|increase|raise|lift|release|launch)\b/i,
    /\bwhen\s+(?:will|can|could|would)\b[^.!?]{0,100}\b(?:reset|refill|increase|raise|lift|release|launch)\b/i,
    /\b(?:i|we)\s+(?:wish|hope)\b[^.!?]{0,100}\b(?:reset|refill|increase|raise|lift|release|launch)\b/i,
    /\b(?:i|we)\s+need\b[^.!?]{0,80}\b(?:reset|refill)\b/i,
    /\b(?:openai|anthropic|google|xai)\s+should\b[^.!?]{0,80}\b(?:reset|refill|increase|raise|lift|release|launch)\b/i,
    /\bwould\s+be\s+nice\s+if\b[^.!?]{0,100}\b(?:reset|refill|increase|raise|lift|release|launch)\b/i,
    /\b(?:reset|refill)\b[^.!?]{0,60}\bfor\s+(?:me|us)\b/i,
  ].some((pattern) => pattern.test(segment));
}

function explicitPlatformOperation(segment) {
  if (!PLATFORM_SCOPE_TERMS.test(segment)) return false;
  return STRONG_INCIDENT_TERMS.test(segment) ||
    CAPACITY_OPERATION.test(segment) ||
    (QUOTA_TERMS.test(segment) && LIMIT_POLICY_ACTION.test(segment));
}

function individualQuotaError(segment) {
  return ERROR_SIGNATURE.test(segment) && !explicitPlatformOperation(segment);
}

function operationalMatch(segment) {
  const targetProduct = TARGET_PRODUCT_TERMS.test(segment);
  const ecosystemProduct = ECOSYSTEM_PRODUCT_TERMS.test(segment);
  if (!targetProduct && !ecosystemProduct) return null;

  const quotaReset = RESET_ACTION.test(segment) &&
    (QUOTA_TERMS.test(segment) || targetProduct);
  const limitPolicy = QUOTA_TERMS.test(segment) && LIMIT_POLICY_ACTION.test(segment);
  const targetIncident = targetProduct &&
    (STRONG_INCIDENT_TERMS.test(segment) || CAPACITY_OPERATION.test(segment));
  const release = NAMED_RELEASE_ACTION.test(segment) &&
    !CREATION_WORKFLOW_LAUNCH.test(segment);
  const targetDevelopment = targetProduct && DEVELOPMENT_ACTION.test(segment);
  if (
    !quotaReset &&
    !limitPolicy &&
    !targetIncident &&
    !release &&
    !targetDevelopment
  ) return null;

  return {
    segment,
    reasonCode: targetProduct
      ? "target_operational_claim"
      : "ecosystem_operational_claim",
  };
}

function terminalReason(segments) {
  if (segments.some((segment) => EXPLICIT_NON_CLAIM.test(segment))) {
    return "explicit_non_claim";
  }
  if (segments.some(requestOrHypothetical)) {
    return "request_or_hypothetical";
  }
  if (segments.some(individualQuotaError)) {
    return "individual_quota_error";
  }
  return null;
}

function operationalMatches(segments) {
  return segments
    .filter((segment) =>
      !requestOrHypothetical(segment) &&
      !individualQuotaError(segment) &&
      !EXPLICIT_NON_CLAIM.test(segment)
    )
    .map(operationalMatch)
    .filter(Boolean);
}

function contextRelation(context) {
  const value = String(
    context?.relation_type ?? context?.relation ?? context?.type ?? "",
  ).toLowerCase();
  if (["quote", "quotes", "quoted"].includes(value)) return "quote";
  if (["reply", "parent", "replied_to"].includes(value)) return "reply_parent";
  return null;
}

function contextText(context) {
  return context?.text ??
    context?.content?.text ??
    context?.observation?.data?.content?.text ??
    "";
}

function contextReference(context) {
  if (context?.context_ref !== undefined) return context.context_ref;
  if (context?.observation_ref !== undefined) return context.observation_ref;
  if (context?.ref !== undefined) return context.ref;
  const observation = context?.observation;
  if (observation?.record_id && Number.isInteger(observation.revision)) {
    return {
      record_id: observation.record_id,
      revision: observation.revision,
    };
  }
  return null;
}

function uniqueReferences(references) {
  const selected = new Map();
  for (const reference of references.filter((value) => value !== null)) {
    const key = typeof reference === "string"
      ? `string:${reference}`
      : `object:${JSON.stringify(reference)}`;
    if (!selected.has(key)) selected.set(key, reference);
  }
  return [...selected.values()];
}

function result(decision, reasonCode, basis, matchedSegments = [], contextRefs = []) {
  return {
    decision,
    reason_code: reasonCode,
    basis,
    matched_segments: matchedSegments,
    context_refs: uniqueReferences(contextRefs),
  };
}

export function assessTopicRelevance({
  text = "",
  sourceRole = "unknown",
  contexts = [],
  hasUnresolvedContext = false,
} = {}) {
  const segments = splitSegments(text);
  const selfTerminalReason = terminalReason(segments);
  if (selfTerminalReason) {
    return result("irrelevant", selfTerminalReason, "self");
  }

  const selfMatches = operationalMatches(segments);
  if (selfMatches.length > 0) {
    return result(
      "relevant",
      selfMatches[0].reasonCode,
      "self",
      selfMatches.map((match) => match.segment),
    );
  }

  if (
    ["official", "product_lead", "product_team_member"].includes(sourceRole) &&
    (
      TARGET_PRODUCT_TERMS.test(text) ||
      PLATFORM_SCOPE_TERMS.test(text)
    ) &&
    (
      segments.some((segment) =>
        QUOTA_TERMS.test(segment) &&
        RESET_ACTION.test(segment) &&
        !ECOSYSTEM_PRODUCT_TERMS.test(segment)
      ) ||
      (
        TARGET_PRODUCT_TERMS.test(text) &&
        RESET_ACTION.test(text) &&
        !ECOSYSTEM_PRODUCT_TERMS.test(text)
      )
    )
  ) {
    return result(
      "relevant",
      "target_authority_operational_claim",
      "self",
      segments.filter((segment) =>
        RESET_ACTION.test(segment) || TARGET_PRODUCT_TERMS.test(segment)
      ),
    );
  }

  for (const context of Array.isArray(contexts) ? contexts : []) {
    const basis = contextRelation(context);
    if (!basis) continue;
    const matches = operationalMatches(splitSegments(contextText(context)));
    if (matches.length === 0) continue;
    if (basis === "reply_parent" && !RELATED_REPLY_CUE.test(String(text ?? ""))) {
      continue;
    }
    const ownSegments = splitSegments(text);
    return result(
      "relevant",
      "contextual_operational_claim",
      basis,
      [
        ...(ownSegments.length > 0 ? ownSegments : []),
        ...matches.map((match) => match.segment),
      ],
      [contextReference(context)],
    );
  }

  if (hasUnresolvedContext) {
    return result(
      "pending_context",
      "missing_relation_context",
      "unresolved_context",
    );
  }

  // A normalized source role is accepted as input for future policy revisions,
  // but role alone is deliberately never positive relevance evidence.
  String(sourceRole ?? "unknown");
  return result("irrelevant", "generic_discussion", "self");
}
