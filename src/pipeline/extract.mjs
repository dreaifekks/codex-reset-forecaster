import { createRecord, producer, recordRef, targetScope } from "../core/records.mjs";
import { makeRecordId } from "../core/hash.mjs";
import { addHours, floorHour, halfOpenRange } from "../core/time.mjs";
import { confirmationIdentityIds, sourceRoleForIdentity } from "../core/sources.mjs";
import {
  AUTHORITY_SCOPE_POLICY,
  extractorContract,
} from "../core/extractor-contract.mjs";
import { canonicalXStatusUrl, xStatusIdentity } from "../providers/raw.mjs";
import {
  MULTI_PRODUCT,
  UNKNOWN_PRODUCT,
  scopeIncludesProduct,
} from "../core/product-scope.mjs";
import {
  authorityReplyCommitmentSegment,
  isFirstPersonFutureResetReply,
} from "../core/authority-reply.mjs";
import {
  assessTopicRelevance,
  TOPIC_RELEVANCE_POLICY_VERSION,
} from "./topic-relevance.mjs";
import {
  createConfiguredSemanticTimingAssessor,
} from "../semantic-assistance/openai-compatible-chat.mjs";
import {
  semanticTimingPhaseHasWrapperSupport,
} from "../semantic-assistance/phase-policy.mjs";

const RESET_TERMS = /\b(reset(?:s|ting|ing|ted)?|refill(?:s|ed|ing)?|refresh(?:ed|ing)?)\b/i;
const SEMANTIC_RESET_TERMS =
  /\b(?:reset(?:s|ting|ing|ted)?|refill(?:s|ed|ing)?)\b/i;
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
const NON_RELEASE_LAUNCH_CONTEXT = new RegExp([
  String.raw`\b(?:on|at|during|after|before)\s+(?:app\s+|client\s+)?launch\b`,
  String.raw`\b(?:fail(?:s|ed|ing)?|unable|can(?:not|['’]t))\s+to\s+launch\b`,
].join("|"), "i");
const OFFICIAL_INCIDENT_TERMS = /\b(incident|outage|degrad(?:ed|ation)|capacity|service disruption|partial(?:ly)? down|war\s*room|investigat(?:e|es|ed|ing|ion)|mitigat(?:e|es|ed|ing|ion)|fleet (?:is )?melting)\b/i;
const EXPERIENCE_ISSUE_TERMS = new RegExp([
  String.raw`\bbugs?\b`,
  String.raw`\bbroken\b`,
  String.raw`\bcrash(?:es|ed|ing)?\b`,
  String.raw`\bfail(?:s|ed|ing|ure)?\b`,
  String.raw`\berrors?\b`,
  String.raw`\bstuck\b`,
  String.raw`\bhang(?:s|ing)?\b`,
  String.raw`\bfreez(?:e|es|ing)\b`,
  String.raw`\bunusable\b`,
  String.raw`\b(?:not|isn['’]?t|aren['’]?t)\s+work(?:ing)?\b`,
  String.raw`\bregress(?:ed|ion)?\b`,
  String.raw`\btimeouts?\b`,
  String.raw`\b(?:slow|slower|latency|laggy)\b`,
  String.raw`\busage\b[^.!?\n]{0,16}\b(?:drain(?:s|ed|ing)?|consumption)\b`,
  String.raw`\b(?:mcp|tool(?:\s+call|\s+use|\s+execution)?|login|auth(?:entication)?|session)\b[^.!?\n]{0,48}\b(?:broken|fail(?:s|ed|ing)?|error|stuck|hang(?:s|ing)?|timeout|unavailable)\b`,
  String.raw`\b(?:lost|losing|corrupt(?:ed|ion)?)\b[^.!?\n]{0,36}\b(?:session|work|changes|context|state)\b`,
  String.raw`\b(?:security|privacy)\s+(?:incident|issue|bug|flaw|regression|vulnerabilit(?:y|ies))\b`,
  String.raw`\b(?:cve-\d{4}-\d+|exploit(?:ed|able)?|(?:authentication\s+)?credentials?|tokens?|secrets?|api\s+keys?|private\s+(?:customer\s+)?data)\b[^.!?\n]{0,48}\b(?:leak(?:s|ed|ing)?|expos(?:e|es|ed|ing|ure)|compromis(?:e|es|ed|ing))\b`,
  String.raw`\b(?:leak(?:s|ed|ing)?|expos(?:e|es|ed|ing|ure)|compromis(?:e|es|ed|ing))\b[^.!?\n]{0,48}\b(?:authentication\s+)?(?:credentials?|tokens?|secrets?|api\s+keys?|private\s+(?:customer\s+)?data)\b`,
  String.raw`\b(?:data|files?|changes?|work)\b[^.!?\n]{0,36}\b(?:loss|lost|corrupt(?:ed|ion)?|overwrit(?:e|ten)|truncat(?:ed|ion))\b`,
  String.raw`\b(?:lost|losing|corrupt(?:s|ed|ing|ion)?|overwrit(?:e|es|ten|ing)|truncat(?:e|es|ed|ing|ion))\b[^.!?\n]{0,48}\b(?:data|files?|changes?|work|workspace|repositor(?:y|ies)|repos?|projects?|sessions?|context|state)\b`,
  String.raw`\b(?:incompatib(?:le|ility)|compatibility\s+(?:issue|bug|regression)|version\s+mismatch)\b`,
  String.raw`\b(?:still|again)\b[^.!?\n]{0,36}\b(?:broken|failing|affected|unavailable|reproducible)\b`,
].join("|"), "i");
const EXPERIENCE_RESOLUTION_TERMS =
  /\b(?:fixed|patched|resolved|working\s+again|back\s+(?:online|to\s+normal|up)|recovered|restored)\b/i;
const EXPERIENCE_MITIGATION_TERMS =
  /\b(?:fixing|patching|recovering|restoring|roll(?:ed|ing)?\s+back|workaround\s+(?:is\s+)?available|mitigat(?:e|es|ed|ing|ion))\b/i;
const EXPERIENCE_RECOVERY_TERMS = new RegExp(
  `${EXPERIENCE_RESOLUTION_TERMS.source}|${EXPERIENCE_MITIGATION_TERMS.source}`,
  "i",
);
const CONTINUING_EXPERIENCE_ISSUE_TERMS = new RegExp([
  String.raw`\b(?:still|again|remains?|continues?|continuing)\b[^.!?\n]{0,48}\b(?:broken|failing|affected|unavailable|unusable|reproducible|crash(?:es|ing)?|hang(?:s|ing)?|corrupt(?:ed|ing)?|leak(?:s|ing)?)\b`,
  String.raw`\b(?:broken|failing|affected|unavailable|unusable|reproducible|crash(?:es|ing)?|hang(?:s|ing)?|corrupt(?:ed|ing)?|leak(?:s|ing)?)\b[^.!?\n]{0,32}\b(?:still|again|remains?|continues?|continuing)\b`,
].join("|"), "i");
const QUOTA_ANOMALY_TERMS = new RegExp([
  String.raw`\b(?:reset|refill)(?:s|ting|ted)?\b[^.!?\n]{0,72}\b(?:still|yet|immediately|instantly)\b[^.!?\n]{0,72}\b(?:429|quota|limit|exhausted)\b`,
  String.raw`\b(?:429|quota|limit|exhausted)\b[^.!?\n]{0,72}\b(?:after|despite)\b[^.!?\n]{0,36}\b(?:reset|refill)\b`,
  String.raw`\b(?:usage|quota|allowance)\b[^.!?\n]{0,48}\b(?:vanish(?:es|ed|ing)?|wrong|incorrect|miscount(?:ed|ing)?)\b`,
  String.raw`\b(?:vanish(?:es|ed|ing)?|wrong|incorrect|miscount(?:ed|ing)?)\b[^.!?\n]{0,48}\b(?:usage|quota|allowance)\b`,
].join("|"), "i");
const CODEX_TERMS = /\bcodex(?:er|ers)?\b/i;
const CODEX_MODE_ALIAS_TERMS = /(?:\/fast\b|\bultra\b)/i;
const CHATGPT_WORK_TERMS = /\bchatgpt\s+work\b/i;
const SIGNAL_MEDIA_TYPES = new Set([
  "text/plain",
  "application/vnd.x-search-summary+text",
]);

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

function policyAllowsAuthorityGenericScope({
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
    !["quota_reset", "quota_refill"].includes(eventType) ||
    ![
      "completed",
      "scheduled",
      "expected",
      "started",
      "denied",
      "cancelled",
    ].includes(phase) ||
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

function configuredAuthorityReplyCommitment({
  observation,
  config,
  text,
  role,
}) {
  const outcomeDefinition = config.outcome_definition;
  const identityId = observation.data.author.identity_id;
  const replyIdentityIds = new Set(
    config.extractor?.authority_reply_identity_ids ?? [],
  );
  const reply = observation.data.native_relations.filter((relation) =>
    relation.type === "reply"
  )[0];
  if (
    observation.data.content.media_type !== "text/plain" ||
    outcomeDefinition?.event_semantics !==
      "qualifying_authority_completion_statement" ||
    outcomeDefinition?.scope_policy !== AUTHORITY_SCOPE_POLICY ||
    !replyIdentityIds.has(identityId) ||
    !new Set(outcomeDefinition.authority_identity_ids ?? []).has(identityId) ||
    !confirmationIdentityIds(config).has(identityId) ||
    !["official", "product_lead", "product_team_member"].includes(role) ||
    observation.data.selection_context?.feature_eligible === false ||
    !isFirstPersonFutureResetReply({
      text,
      nativeRelations: observation.data.native_relations,
    }) ||
    !(xStatusIdentity(reply?.provider_item_id) ?? xStatusIdentity(reply?.url))
  ) {
    return null;
  }
  return authorityReplyCommitmentSegment(text);
}

function sourceRole(observation, config) {
  if (observation.data.content.media_type === "application/vnd.x-search-summary+text") {
    return "aggregator";
  }
  return sourceRoleForIdentity(config, observation.data.author.identity_id);
}

function classifyEvent(text) {
  const releaseClaim =
    RELEASE_TERMS.test(text) && !NON_RELEASE_LAUNCH_CONTEXT.test(text);
  const codexExperienceIssue =
    CODEX_TERMS.test(text) && EXPERIENCE_ISSUE_TERMS.test(text);
  if (CODEX_TERMS.test(text) && QUOTA_ANOMALY_TERMS.test(text)) {
    return "experience_issue";
  }
  if (
    RESET_TERMS.test(text) &&
    (
      QUOTA_TERMS.test(text) ||
      TARGET_RESET_TERMS.test(text) ||
      CODEX_MODE_ALIAS_TERMS.test(text)
    )
  ) {
    return /\brefill/i.test(text) ? "quota_refill" : "quota_reset";
  }
  if (COMPETITOR_TERMS.test(text) && QUOTA_TERMS.test(text)) return "competitor_limit_change";
  if (COMPETITOR_TERMS.test(text) && releaseClaim) {
    return "competitor_model_release";
  }
  if (
    codexExperienceIssue &&
    (
      CONTINUING_EXPERIENCE_ISSUE_TERMS.test(text) ||
      (
        EXPERIENCE_MITIGATION_TERMS.test(text) &&
        !EXPERIENCE_RESOLUTION_TERMS.test(text)
      )
    )
  ) {
    return "experience_issue";
  }
  if (OFFICIAL_INCIDENT_TERMS.test(text)) {
    return EXPERIENCE_RESOLUTION_TERMS.test(text)
      ? "capacity_restore"
      : "incident";
  }
  if (CODEX_TERMS.test(text) && EXPERIENCE_RECOVERY_TERMS.test(text)) {
    return "experience_recovery";
  }
  if (codexExperienceIssue) {
    return "experience_issue";
  }
  if (releaseClaim) return "release";
  if (/\b(commit|merge|deploy|ship(?:ped|ping)?|development|build)\b/i.test(text)) {
    return "development_activity";
  }
  return null;
}

function impactKind(text) {
  if (
    /\b(?:security|privacy)\s+(?:incident|issue|bug|flaw|regression|vulnerabilit(?:y|ies))\b/i
      .test(text) ||
    /\b(?:cve-\d{4}-\d+|exploit(?:ed|able)?|(?:authentication\s+)?credentials?|tokens?|secrets?|api\s+keys?|private\s+(?:customer\s+)?data)\b[^.!?\n]{0,48}\b(?:leak(?:s|ed|ing)?|expos(?:e|es|ed|ing|ure)|compromis(?:e|es|ed|ing))\b/i
      .test(text) ||
    /\b(?:leak(?:s|ed|ing)?|expos(?:e|es|ed|ing|ure)|compromis(?:e|es|ed|ing))\b[^.!?\n]{0,48}\b(?:authentication\s+)?(?:credentials?|tokens?|secrets?|api\s+keys?|private\s+(?:customer\s+)?data)\b/i
      .test(text)
  ) return "security_privacy";
  if (
    /\b(?:data|files?|changes?|work)\b[^.!?\n]{0,36}\b(?:loss|lost|corrupt(?:ed|ion)?|overwrit(?:e|ten)|truncat(?:ed|ion))\b/i
      .test(text) ||
    /\b(?:lost|losing|corrupt(?:s|ed|ing|ion)?|overwrit(?:e|es|ten|ing)|truncat(?:e|es|ed|ing|ion))\b[^.!?\n]{0,48}\b(?:data|files?|changes?|work|workspace|repositor(?:y|ies)|repos?|projects?|sessions?|context|state)\b/i
      .test(text)
  ) return "data_integrity";
  if (
    /\b(?:incompatib(?:le|ility)|compatibility\s+(?:issue|bug|regression)|version\s+mismatch)\b/i
      .test(text)
  ) return "compatibility";
  if (/\b(?:outage|down|unavailable|service disruption)\b/i.test(text)) return "availability";
  if (/\b(?:slow|slower|latency|laggy|timeout)\b/i.test(text)) return "performance";
  if (/\b(?:mcp|tool(?:\s+call|\s+use|\s+execution)?)\b/i.test(text)) return "tool_execution";
  if (/\b(?:session|context|state|lost|corrupt)\b/i.test(text)) return "session_state";
  if (/\b(?:usage|quota|allowance|429|rate limit)\b/i.test(text)) return "quota_accounting";
  if (/\b(?:login|auth|authentication)\b/i.test(text)) return "auth";
  if (/\b(?:cli|ide|extension|desktop|web|ui|ux)\b/i.test(text)) return "client_ux";
  if (/\b(?:wrong|incorrect|hallucinat|regress)\b/i.test(text)) return "correctness";
  return "other";
}

function affectedSurfaces(text) {
  const surfaces = [
    [/\bcli\b/i, "cli"],
    [/\b(?:ide|extension|vscode|jetbrains)\b/i, "ide"],
    [/\bapi\b/i, "api"],
    [/\bweb\b/i, "web"],
    [/\b(?:agent loop|agent run|run)\b/i, "agent_loop"],
    [/\btool(?:\s+call|\s+use|\s+execution)?\b/i, "tool_use"],
    [/\bmcp\b/i, "mcp"],
    [/\b(?:login|auth|authentication)\b/i, "auth"],
    [/\b(?:\/fast|fast mode)\b/i, "fast_mode"],
  ].filter(([pattern]) => pattern.test(text)).map(([, surface]) => surface);
  return surfaces.length > 0 ? [...new Set(surfaces)] : ["unknown"];
}

function impactScope(text) {
  if (
    PLATFORM_SCOPE_TERMS.test(text) ||
    /\b(?:platform[-\s]?wide|service[-\s]?wide|across\s+the\s+platform|globally|widespread|almost global)\b/i.test(text)
  ) return "platform";
  if (/\b(?:many|multiple|several|some)\s+users\b|\bothers?\s+(?:are\s+)?seeing\b/i.test(text)) {
    return "multiple_users";
  }
  if (/\b(?:i|my|me|for me)\b/i.test(text)) return "individual";
  return "unknown";
}

function impactLifecycle(text, eventType) {
  if (eventType === "capacity_restore") return "resolved";
  if (CONTINUING_EXPERIENCE_ISSUE_TERMS.test(text)) {
    return EXPERIENCE_MITIGATION_TERMS.test(text) ? "mitigating" : "active";
  }
  if (EXPERIENCE_RESOLUTION_TERMS.test(text)) return "resolved";
  if (EXPERIENCE_MITIGATION_TERMS.test(text)) return "mitigating";
  if (/\binvestigat(?:e|es|ed|ing|ion)\b/i.test(text)) return "investigating";
  if (eventType === "experience_recovery") return "resolved";
  if (["incident", "experience_issue"].includes(eventType)) return "active";
  return "unknown";
}

function impactSeverity(text, scope, lifecycle) {
  if (lifecycle === "resolved") return "unknown";
  const hardBlock = /\b(?:outage|down|unavailable|unusable|cannot|can['’]?t|crash|stuck|hang(?:s|ing)?|login|auth)\b/i.test(text);
  const destructive =
    /\b(?:lost|losing|corrupt(?:s|ed|ing|ion)?|data\s+loss|overwrit(?:e|es|ten|ing)|truncat(?:e|es|ed|ing|ion))\b/i
      .test(text);
  const securityExposure =
    /\b(?:security|privacy)\s+(?:incident|issue|bug|flaw|regression|vulnerabilit(?:y|ies))\b/i
      .test(text) ||
    /\b(?:cve-\d{4}-\d+|exploit(?:ed|able)?|(?:authentication\s+)?credentials?|tokens?|secrets?|api\s+keys?|private\s+(?:customer\s+)?data)\b[^.!?\n]{0,48}\b(?:leak(?:s|ed|ing)?|expos(?:e|es|ed|ing|ure)|compromis(?:e|es|ed|ing))\b/i
      .test(text) ||
    /\b(?:leak(?:s|ed|ing)?|expos(?:e|es|ed|ing|ure)|compromis(?:e|es|ed|ing))\b[^.!?\n]{0,48}\b(?:authentication\s+)?(?:credentials?|tokens?|secrets?|api\s+keys?|private\s+(?:customer\s+)?data)\b/i
      .test(text);
  const degraded = /\b(?:degrad(?:ed|ation)|fail(?:s|ed|ing|ure)?|errors?|broken|usage drain)\b/i.test(text);
  const performanceOnly = /\b(?:slow|slower|latency|laggy)\b/i.test(text) &&
    !hardBlock && !destructive && !degraded;
  if (scope === "platform" && (hardBlock || destructive)) return "critical";
  if (
    ["platform", "multiple_users"].includes(scope) &&
    (hardBlock || destructive || securityExposure || degraded)
  ) return "high";
  if (hardBlock || destructive || securityExposure || degraded) return "medium";
  if (performanceOnly || /\b(?:minor|cosmetic|annoying|friction)\b/i.test(text)) return "low";
  return "unknown";
}

function classifyImpact(text, eventType, sourceRole) {
  if (![
    "incident",
    "capacity_restore",
    "experience_issue",
    "experience_recovery",
  ].includes(eventType)) return null;
  const affectedScope = impactScope(text);
  const lifecycle = impactLifecycle(text, eventType);
  return {
    category: impactKind(text),
    severity: impactSeverity(text, affectedScope, lifecycle),
    lifecycle,
    affected_scope: affectedScope,
    affected_surfaces: affectedSurfaces(text),
    workaround: /\b(?:workaround|can still|use .+ instead|switch(?:ed)? to)\b/i.test(text)
      ? "available"
      : /\b(?:partial(?:ly)?|intermittent)\b/i.test(text)
        ? "partial"
        : "unknown",
    evidence_basis: ["official", "product_lead", "product_team_member"].includes(sourceRole)
      ? "official_incident"
      : /\b(?:repro|reproduce|steps to reproduce)\b/i.test(text)
        ? "reproduction"
        : "first_party_report",
  };
}

function competitiveStage(text) {
  if (/\b(?:rumor|reportedly|unconfirmed)\b/i.test(text)) return "rumor";
  if (/\b(?:general availability|generally available|\bga\b|available to (?:all|everyone))\b/i.test(text)) {
    return "general_availability";
  }
  if (/\b(?:roll(?:ed|ing)? out|available now|launched|released)\b/i.test(text)) {
    return "rolled_out";
  }
  if (/\b(?:preview|beta|early access)\b/i.test(text)) return "preview";
  return "announced";
}

function classifyCompetitiveContext(text, eventType) {
  if (!["competitor_model_release", "competitor_limit_change"].includes(eventType)) {
    return null;
  }
  const coding = /\b(?:claude code|coding|code agent|developer agent|coding agent)\b/i.test(text);
  return {
    kind: eventType === "competitor_limit_change"
      ? "limit_change"
      : coding
        ? "coding_agent_release"
        : /\b(?:model|opus|sonnet|haiku|flash|pro|grok|deepseek|mistral)\b/i.test(text)
          ? "model_release"
          : "capability_release",
    relevance: coding ? "direct" : "adjacent",
    stage: competitiveStage(text),
  };
}

function classifyProductScope(text, config) {
  const codex = CODEX_TERMS.test(text) || CODEX_MODE_ALIAS_TERMS.test(text);
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
      /\bbut\s+no\b/i.test(text) ||
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
  if (RESET_TERMS.test(text) && /\b(?:propagating|land(?:s|ing)?|should\s+land|should\s+be\s+showing|should\s+have\b[^.!?\n]{0,48}\bback)\b/i.test(text)) return "started";
  if (/\benjoy\b[\s\S]{0,40}\breset(?:ted)?\b/i.test(text)) return "completed";
  if (
    /\bfeeling\s+like\s+(?:a\s+)?(?:(?:usage|rate|limit)\s+)?reset\b/i.test(text) &&
    /\bsee\s+you\s+in\s+(?:a\s+)?few\s+hours?\b/i.test(text)
  ) return "scheduled";
  if (/\b(land(?:s|ing)?|coming|incoming|arriv(?:e|es|ing)|will|going to|later|tomorrow|this evening|next hour|tonight|soon|in a bit)\b/i.test(text) ||
      /\bgive\s+us\s+\d{1,3}\s+hours?\b/i.test(text)) {
    return "scheduled";
  }
  if (/\b(expect|likely|probably|should|might|may)\b/i.test(text)) return "expected";
  if (eventType === "experience_recovery") {
    return EXPERIENCE_RESOLUTION_TERMS.test(text) ? "completed" : "started";
  }
  if (eventType === "experience_issue") {
    if (/\b(?:investigat|mitigat)(?:e|es|ed|ing|ion)\b/i.test(text)) return "started";
    return /\b(?:rumor|reportedly|unconfirmed)\b/i.test(text) ? "rumor" : "started";
  }
  if (eventType === "competitor_model_release") {
    if (/\b(?:rumor|reportedly|unconfirmed)\b/i.test(text)) return "rumor";
    if (/\b(?:preview|beta|early access|announc(?:e|es|ed|ing|ement)|coming|soon)\b/i.test(text) &&
        !/\b(?:available now|general availability|generally available|launched|released|rolled out)\b/i.test(text)) {
      return "expected";
    }
    return "completed";
  }
  if (["release", "incident", "capacity_restore", "development_activity", "competitor_limit_change"].includes(eventType)) {
    return /\b(rumor|reportedly|unconfirmed)\b/i.test(text) ? "rumor" : "completed";
  }
  return "rumor";
}

function resetTimingText(text) {
  const timingTerms =
    /\b(?:next|within|over|in|later|tomorrow|tonight|evening|morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday|minutes?|hours?|soon|incoming|in a bit)\b/i;
  const timingActions =
    /\b(?:land(?:s|ing)?|arriv(?:e|es|ing)|coming|showing|back|return(?:s|ed|ing)?|give us)\b/i;
  const segments = text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(Boolean);
  const relevant = segments.filter((segment) =>
    RESET_TERMS.test(segment) ||
    (
      timingTerms.test(segment) &&
      (QUOTA_TERMS.test(segment) || timingActions.test(segment))
    )
  );
  return relevant.length > 0 ? relevant.join("\n") : text;
}

function assertedRange(text, publishedAt, phase, {
  allowNamedWeekday = false,
} = {}) {
  if (!publishedAt) return null;
  const published = new Date(publishedAt);
  const timingText = resetTimingText(text);
  if (["scheduled", "expected", "started"].includes(phase)) {
    const minutes = timingText.match(/\b(?:in|over|within)?\s*(?:the\s+)?next\s+(\d{1,3})\s+minutes?\b/i);
    if (minutes) {
      return halfOpenRange(
        published,
        new Date(published.getTime() + Number(minutes[1]) * 60_000),
        "minute",
        minutes[0],
      );
    }
    const fewMinutes = timingText.match(
      /\b(?:back\s+in|within|in|over)\s+(?:the\s+next\s+)?(?:a\s+)?few\s+minutes?\b/i,
    );
    if (fewMinutes) {
      return halfOpenRange(
        published,
        new Date(published.getTime() + 30 * 60_000),
        "minute",
        fewMinutes[0],
      );
    }
    const hourRange = timingText.match(
      /\b(?:(?:in|over|within)\s+(?:the\s+)?next|next)\s+(\d{1,3})\s*(?:[-\u2010-\u2015\u2212]|\bto\b)\s*(\d{1,3})\s+hours?\b/i,
    );
    if (hourRange) {
      const minimumHours = Number(hourRange[1]);
      const maximumHours = Number(hourRange[2]);
      if (minimumHours > 0 && maximumHours >= minimumHours) {
        return halfOpenRange(
          published,
          addHours(published, maximumHours),
          "hour",
          hourRange[0],
        );
      }
    }
    const numericHours = timingText.match(
      /\b(?:(?:(?:in|over|within)\s+(?:the\s+)?next|next)\s+|(?:in|within)\s+|give\s+us\s+)(\d{1,3})\s+hours?\b/i,
    );
    if (numericHours && Number(numericHours[1]) > 0) {
      return halfOpenRange(
        published,
        addHours(published, Number(numericHours[1])),
        "hour",
        numericHours[0],
      );
    }
    if (/\b(?:in|over|within)?\s*(?:the\s+)?next\s+hour\b/i.test(timingText)) {
      return halfOpenRange(published, addHours(published, 1), "hour", "next hour");
    }
    if (/\b(?:in|over|within)?\s*(?:the\s+)?next\s+(?:few|couple of)\s+hours?\b/i.test(timingText) ||
        /\b(?:back|see\s+you)\s+in\s+(?:a\s+)?few\s+hours?\b/i.test(timingText)) {
      return halfOpenRange(published, addHours(published, 3), "hour", "next few hours");
    }
    if (/\btomorrow morning\b/i.test(timingText)) {
      return halfOpenRange(addHours(published, 4), addHours(published, 24), "part_of_day", "tomorrow morning");
    }
    if (/\btomorrow\b/i.test(timingText)) {
      return halfOpenRange(addHours(published, 1), addHours(published, 30), "day", "tomorrow");
    }
    if (/\b(?:this evening|tonight)\b/i.test(timingText)) {
      return halfOpenRange(published, addHours(published, 24), "part_of_day", "this evening");
    }
    if (/\blater (?:in the day|today)\b/i.test(timingText)) {
      const end = new Date(Date.UTC(
        published.getUTCFullYear(),
        published.getUTCMonth(),
        published.getUTCDate() + 1,
      ));
      return halfOpenRange(published, end, "part_of_day", "later today");
    }
    const namedWeekday = timingText.match(
      /\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    );
    if (allowNamedWeekday && namedWeekday) {
      const weekdayByName = new Map([
        ["sunday", 0],
        ["monday", 1],
        ["tuesday", 2],
        ["wednesday", 3],
        ["thursday", 4],
        ["friday", 5],
        ["saturday", 6],
      ]);
      const targetDay = weekdayByName.get(namedWeekday[1].toLowerCase());
      const daysAhead = (targetDay - published.getUTCDay() + 7) % 7;
      const dayStart = new Date(Date.UTC(
        published.getUTCFullYear(),
        published.getUTCMonth(),
        published.getUTCDate() + daysAhead,
      ));
      const start = daysAhead === 0 ? published : dayStart;
      const end = new Date(dayStart.getTime() + 24 * 60 * 60 * 1_000);
      return halfOpenRange(start, end, "day", namedWeekday[0]);
    }
    if (/\b(?:reset incoming|in a bit)\b/i.test(timingText)) {
      return halfOpenRange(published, addHours(published, 6), "hour", "near-term intent");
    }
  }
  if (["started", "completed"].includes(phase) &&
      /\b(now|currently|have been reset|has been reset|have reset|has reset)\b/i.test(timingText)) {
    const start = floorHour(published);
    return halfOpenRange(start, addHours(start, 1), "hour", "notification-hour inference");
  }
  return null;
}

function primaryStatementEvidenceRoot(observation) {
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
  return primaryStatementEvidenceRoot(observation);
}

function replyParentEvidenceRoot(observation) {
  const relation = observation.data.native_relations.find((item) =>
    item.type === "reply"
  );
  if (!relation?.provider_item_id && !relation?.url) return null;
  const statusId = xStatusIdentity(relation.provider_item_id) ??
    xStatusIdentity(relation.url);
  return {
    rootId: statusId
      ? `x_post:${statusId}`
      : `relation:${relation.provider_item_id ?? relation.url}`,
    derivation: "reply",
  };
}

function observationContextAvailableAt(observation) {
  if (observation.revision === 1) {
    return observation.data.availability_attestation?.available_at ??
      observation.data.first_seen_at;
  }
  return observation.data.fetched_at ?? observation.created_at;
}

function contextIdentityKeys(observation) {
  return [...new Set([
    observation.data.provider_item_id,
    xStatusIdentity(observation.data.provider_item_id),
    xStatusIdentity(observation.data.canonical_url),
  ].filter(Boolean).map(String))];
}

function contextObservationPreference(observation) {
  return [
    observation.data.content.media_type === "text/plain" ? 1 : 0,
    observation.revision,
    observationContextAvailableAt(observation),
    observation.record_id,
  ];
}

function compareContextObservation(left, right) {
  const leftRank = contextObservationPreference(left);
  const rightRank = contextObservationPreference(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] > rightRank[index]) return 1;
    if (leftRank[index] < rightRank[index]) return -1;
  }
  return 0;
}

function contextIndex(observations) {
  const latestByRecordId = new Map();
  for (const observation of observations) {
    const previous = latestByRecordId.get(observation.record_id);
    if (!previous || observation.revision > previous.revision) {
      latestByRecordId.set(observation.record_id, observation);
    }
  }
  const index = new Map();
  for (const observation of latestByRecordId.values()) {
    for (const key of contextIdentityKeys(observation)) {
      const previous = index.get(key);
      if (!previous || compareContextObservation(observation, previous) > 0) {
        index.set(key, observation);
      }
    }
  }
  return index;
}

function relationContexts(observation, observationsByRelationId) {
  const relations = observation.data.native_relations.filter((relation) =>
    ["reply", "quotes"].includes(relation.type)
  );
  const contexts = [];
  let unresolved = 0;
  for (const relation of relations) {
    const keys = [
      relation.provider_item_id,
      xStatusIdentity(relation.provider_item_id),
      xStatusIdentity(relation.url),
    ].filter(Boolean).map(String);
    const related = keys
      .map((key) => observationsByRelationId.get(key))
      .find((candidate) => candidate?.record_id !== observation.record_id);
    if (!related) {
      unresolved += 1;
      continue;
    }
    contexts.push({
      relation_type: relation.type,
      text: related.data.content.text,
      observation_ref: recordRef(related),
      available_at: observationContextAvailableAt(related),
    });
  }
  return {
    contexts,
    hasUnresolvedContext: unresolved > 0,
  };
}

function exactReferenceKey(reference) {
  return reference &&
    typeof reference.record_id === "string" &&
    Number.isInteger(reference.revision)
    ? `${reference.record_id}@${reference.revision}`
    : null;
}

function configuredSemanticAuthority({ observation, config, role }) {
  const identityId = observation.data.author.identity_id;
  return config.outcome_definition?.event_semantics ===
      "qualifying_authority_completion_statement" &&
    config.outcome_definition?.scope_policy === AUTHORITY_SCOPE_POLICY &&
    new Set(config.outcome_definition.authority_identity_ids ?? [])
      .has(identityId) &&
    confirmationIdentityIds(config).has(identityId) &&
    ["official", "product_lead", "product_team_member"].includes(role);
}

function semanticQuoteContext(contexts, contextRef) {
  const expectedKey = exactReferenceKey(contextRef);
  const quotes = contexts.filter((context) =>
    context.relation_type === "quotes" &&
    exactReferenceKey(context.observation_ref) !== null &&
    typeof context.available_at === "string" &&
    Number.isFinite(Date.parse(context.available_at))
  );
  if (quotes.length !== 1) return null;
  return exactReferenceKey(quotes[0].observation_ref) === expectedKey
    ? quotes[0]
    : null;
}

function targetScopeFromSemanticQuote(context, config) {
  const contextScope = classifyProductScope(context.text, config);
  if (
    contextScope.vendor !== config.target.vendor ||
    !scopeIncludesProduct(contextScope, config.target.product)
  ) {
    return null;
  }
  return {
    vendor: config.target.vendor,
    product: config.target.product,
  };
}

function semanticAssistanceCandidate({
  observation,
  config,
  signal,
  contexts,
  hasUnresolvedContext,
  now,
}) {
  const policy = config.extractor?.semantic_assistance;
  const text = observation.data.content.text.replace(/[*_`]/g, "");
  const relevance = signal?.data?.extraction?.relevance;
  const role = signal?.data?.provenance?.source_role;
  const firstSeenMs = Date.parse(observation.data.first_seen_at);
  const nowMs = Date.parse(now);
  const maximumAgeMs = policy?.maximum_observation_age_hours * 3_600_000;
  const hasDeterministicTimingRange = ["scheduled", "expected", "started"]
    .some((phase) => assertedRange(
      text,
      observation.data.published_at,
      phase,
    ) !== null);
  if (
    policy?.enabled !== true ||
    observation.data.content.media_type !== "text/plain" ||
    observation.data.selection_context?.feature_eligible === false ||
    observation.data.selection_context?.outcome_conditioned === true ||
    !configuredSemanticAuthority({ observation, config, role }) ||
    relevance?.decision !== "relevant" ||
    relevance.basis !== "quote" ||
    hasUnresolvedContext ||
    signal.data.provenance.derivation !== "quotes" ||
    !SEMANTIC_RESET_TERMS.test(text) ||
    !hasDeterministicTimingRange ||
    isBankedResetOnly(text) ||
    hasNarrowScopeQualifier(text) ||
    !Number.isFinite(firstSeenMs) ||
    !Number.isFinite(nowMs) ||
    nowMs < firstSeenMs ||
    nowMs - firstSeenMs > maximumAgeMs ||
    relevance.context_refs.length !== 1
  ) {
    return null;
  }
  const quote = semanticQuoteContext(contexts, relevance.context_refs[0]);
  if (!quote || !targetScopeFromSemanticQuote(quote, config)) return null;
  return {
    wrapper_text: text,
    quote_text: quote.text,
    target_product: config.target.product,
    context_ref: quote.observation_ref,
  };
}

// Re-check every deterministic gate at the application boundary. The remote
// model can select only a non-terminal timing phase; it cannot supply identity,
// product, scope, event type, evidence lineage, or a completion label.
function validatedSemanticTimingAssistance({
  observation,
  config,
  text,
  role,
  relevance,
  contexts,
  hasUnresolvedContext,
  semanticAssistance,
}) {
  const policy = config.extractor?.semantic_assistance;
  const completedAtMs = Date.parse(semanticAssistance?.completed_at);
  const firstSeenMs = Date.parse(observation.data.first_seen_at);
  const maximumAgeMs = policy?.maximum_observation_age_hours * 3_600_000;
  const contextRef = semanticAssistance?.context_ref;
  const quote = semanticQuoteContext(contexts, contextRef);
  const quoteAvailableAtMs = Date.parse(quote?.available_at);
  const targetScope = quote
    ? targetScopeFromSemanticQuote(quote, config)
    : null;
  const semanticTimingRange = assertedRange(
    text,
    observation.data.published_at,
    semanticAssistance?.phase,
  );
  if (
    policy?.enabled !== true ||
    observation.data.content.media_type !== "text/plain" ||
    observation.data.selection_context?.feature_eligible === false ||
    observation.data.selection_context?.outcome_conditioned === true ||
    !configuredSemanticAuthority({ observation, config, role }) ||
    relevance.decision !== "relevant" ||
    relevance.basis !== "quote" ||
    hasUnresolvedContext ||
    relevance.context_refs.length !== 1 ||
    exactReferenceKey(relevance.context_refs[0]) !==
      exactReferenceKey(contextRef) ||
    semanticAssistance?.policy_version !== policy.policy_version ||
    semanticAssistance?.protocol !== policy.protocol ||
    semanticAssistance?.model !== policy.model ||
    semanticAssistance?.prompt_version !== policy.prompt_version ||
    semanticAssistance?.decision !== "applied" ||
    !["scheduled", "expected", "started"].includes(
      semanticAssistance?.phase,
    ) ||
    !Number.isFinite(semanticAssistance?.confidence) ||
    semanticAssistance.confidence < policy.minimum_confidence ||
    semanticAssistance.confidence > 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(
      semanticAssistance?.response_hash ?? "",
    ) ||
    !Number.isFinite(completedAtMs) ||
    !Number.isFinite(firstSeenMs) ||
    !Number.isFinite(quoteAvailableAtMs) ||
    completedAtMs < Math.max(firstSeenMs, quoteAvailableAtMs) ||
    completedAtMs - firstSeenMs > maximumAgeMs ||
    !quote ||
    !targetScope ||
    !SEMANTIC_RESET_TERMS.test(text) ||
    !semanticTimingPhaseHasWrapperSupport(text, semanticAssistance?.phase) ||
    semanticTimingRange === null ||
    isBankedResetOnly(text) ||
    hasNarrowScopeQualifier(text)
  ) {
    return null;
  }
  return {
    ...semanticAssistance,
    context_ref: {
      record_id: contextRef.record_id,
      revision: contextRef.revision,
    },
    target_scope: targetScope,
  };
}

export function extractSignal(observation, config, {
  availableAt = observation.data.fetched_at,
  createdAt = observation.data.fetched_at,
  evidenceRootOverride = null,
  contexts = [],
  hasUnresolvedContext = false,
  semanticAssistance = null,
} = {}) {
  if (!SIGNAL_MEDIA_TYPES.has(observation.data.content.media_type)) {
    return null;
  }
  const extractor = extractorContract(config);
  const text = observation.data.content.text.replace(/[*_`]/g, "");
  if (
    extractor.topic_relevance_policy_version !==
    TOPIC_RELEVANCE_POLICY_VERSION
  ) {
    throw new Error(
      `Unsupported topic relevance policy: ${extractor.topic_relevance_policy_version}`,
    );
  }
  const role = sourceRole(observation, config);
  const authorityReplyCommitment = configuredAuthorityReplyCommitment({
    observation,
    config,
    text,
    role,
  });
  const deterministicRelevance = assessTopicRelevance({
    text,
    sourceRole: role,
    contexts,
    hasUnresolvedContext,
    authorityReplyCommitment,
    authorityReplyTargetProduct: config.target.product,
  });
  const appliedSemanticAssistance = validatedSemanticTimingAssistance({
    observation,
    config,
    text,
    role,
    relevance: deterministicRelevance,
    contexts,
    hasUnresolvedContext,
    semanticAssistance,
  });
  const relevance = appliedSemanticAssistance
    ? {
        decision: "relevant",
        reason_code: "semantic_authority_quote_timing",
        basis: "self",
        matched_segments: [text],
        context_refs: [appliedSemanticAssistance.context_ref],
      }
    : deterministicRelevance;
  const authorityReplyClaim =
    relevance.reason_code === "authority_reply_reset_commitment";
  const claimText = authorityReplyClaim
    ? relevance.matched_segments.join("\n")
    : relevance.basis === "self"
      ? text
      : relevance.matched_segments.join("\n");
  const eventType = appliedSemanticAssistance
    ? (/\brefill/i.test(claimText) ? "quota_refill" : "quota_reset")
    : classifyEvent(claimText) ?? (
      authorityReplyClaim
      ? (/\brefill/i.test(claimText) ? "quota_refill" : "quota_reset")
      : null
    );
  if (!eventType) return null;
  const phase = appliedSemanticAssistance
    ? appliedSemanticAssistance.phase
    : authorityReplyClaim
    ? "scheduled"
    : classifyPhase(claimText, eventType);
  const productScope = appliedSemanticAssistance
    ? appliedSemanticAssistance.target_scope
    : authorityReplyClaim
    ? { vendor: config.target.vendor, product: config.target.product }
    : classifyProductScope(claimText, config);
  const impact = classifyImpact(claimText, eventType, role);
  const competitiveContext = classifyCompetitiveContext(claimText, eventType);
  let root = evidenceRootOverride ?? evidenceRoot(observation, role);
  if (relevance.basis === "reply_parent") {
    root = replyParentEvidenceRoot(observation) ?? {
      rootId: root.rootId,
      derivation: "reply",
    };
  }
  if (
    relevance.basis === "self" &&
    root.derivation === "quotes"
  ) {
    root = primaryStatementEvidenceRoot(observation);
  }
  const narrowScope = hasNarrowScopeQualifier(claimText);
  const bankedResetOnly = isBankedResetOnly(claimText);
  const platform = impact?.affected_scope === "platform" ||
    (!bankedResetOnly && !narrowScope && (
      hasExplicitPlatformScope(claimText) ||
      policyAllowsAuthorityGenericScope({
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
    ));
  const explicit = phase !== "rumor" &&
    (platform || !["quota_reset", "quota_refill"].includes(eventType));
  const confidence = explicit ? 0.94 : eventType ? 0.72 : 0.5;
  const contextRefs = relevance.context_refs.filter((reference) =>
    reference &&
    typeof reference.record_id === "string" &&
    Number.isInteger(reference.revision)
  );
  const observationRefs = [
    recordRef(observation),
    ...contextRefs,
  ].filter((reference, index, all) =>
    all.findIndex((candidate) =>
      candidate.record_id === reference.record_id &&
      candidate.revision === reference.revision
    ) === index
  );
  const usedContextKeys = new Set(contextRefs.map((reference) =>
    `${reference.record_id}@${reference.revision}`
  ));
  const contextAvailableAtMs = contexts
    .filter((context) => {
      const reference = context.observation_ref ?? context.context_ref ?? context.ref;
      return reference && usedContextKeys.has(
        `${reference.record_id}@${reference.revision}`,
      );
    })
    .reduce((maximum, context) => {
      const value = Date.parse(context.available_at);
      return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
    }, Date.parse(availableAt));
  const effectiveAvailableAtMs = appliedSemanticAssistance
    ? Math.max(
        contextAvailableAtMs,
        Date.parse(appliedSemanticAssistance.completed_at),
      )
    : contextAvailableAtMs;
  const effectiveAvailableAt = new Date(effectiveAvailableAtMs).toISOString();
  const effectiveCreatedAt = appliedSemanticAssistance
    ? new Date(Math.max(
        Date.parse(createdAt),
        Date.parse(appliedSemanticAssistance.completed_at),
      )).toISOString()
    : createdAt;
  return createRecord({
    recordType: "normalized_signal",
    naturalKey: [
      observationRefs.map((reference) =>
        `${reference.record_id}@${reference.revision}`
      ).join("+"),
      config.taxonomy_version,
      extractor.model,
      extractor.model_version,
      extractor.prompt_version,
      extractor.semantic_policy_hash,
    ].join(":"),
    createdAt: effectiveCreatedAt,
    producer: producer("rule-claim-extractor", extractor.model_version, {
      taxonomy_version: config.taxonomy_version,
      extractor_model: extractor.model,
      prompt_version: extractor.prompt_version,
      semantic_policy_hash: extractor.semantic_policy_hash,
    }),
    data: {
      observation_refs: observationRefs,
      available_at: effectiveAvailableAt,
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
        asserted_time_range: assertedRange(
          claimText,
          observation.data.published_at,
          phase,
          { allowNamedWeekday: authorityReplyClaim },
        ),
        author_certainty: explicit ? "explicit" : phase === "expected" ? "probable" : "possible",
        impact,
        competitive_context: competitiveContext,
      },
      provenance: {
        source_identity_id: observation.data.author.identity_id,
        source_role: role,
        root_evidence_id: root.rootId,
        derivation: root.derivation,
        independence_group_id: makeRecordId("ind", root.rootId),
        feature_eligible:
          relevance.decision === "relevant" &&
          observation.data.selection_context?.feature_eligible !== false &&
          !(
            relevance.basis === "reply_parent" &&
            ["quota_reset", "quota_refill"].includes(eventType)
          ) &&
          !["experience_issue", "experience_recovery"].includes(eventType) &&
          competitiveContext?.stage !== "rumor",
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
        ...(appliedSemanticAssistance
          ? {
              semantic_assistance: {
                policy_version: appliedSemanticAssistance.policy_version,
                protocol: appliedSemanticAssistance.protocol,
                model: appliedSemanticAssistance.model,
                prompt_version: appliedSemanticAssistance.prompt_version,
                decision: appliedSemanticAssistance.decision,
                phase: appliedSemanticAssistance.phase,
                confidence: appliedSemanticAssistance.confidence,
                response_hash: appliedSemanticAssistance.response_hash,
                completed_at: appliedSemanticAssistance.completed_at,
                context_ref: appliedSemanticAssistance.context_ref,
              },
            }
          : {}),
        relevance: {
          policy_version: TOPIC_RELEVANCE_POLICY_VERSION,
          decision: relevance.decision,
          reason_code: relevance.reason_code,
          basis: relevance.basis,
          matched_segments: relevance.matched_segments,
          context_refs: contextRefs,
        },
      },
    },
  });
}

export async function normalizeNewObservations(store, config, {
  now = new Date(),
  semanticAssessor = createConfiguredSemanticTimingAssessor(config),
} = {}) {
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
      .map((signal) => signal.data.observation_refs[0])
      .filter(Boolean)
      .map(exactRef),
  );
  const previouslyNormalizedRefs = new Set(
    normalized
      .map((signal) => signal.data.observation_refs[0])
      .filter(Boolean)
      .map(exactRef),
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
  const observationsByRelationId = contextIndex(observations);
  const relationContextByRef = new Map(observations.map((observation) => [
    exactRef(observation),
    relationContexts(observation, observationsByRelationId),
  ]));
  const contextSignature = (relationContext) => [
    relationContext.hasUnresolvedContext ? "unresolved" : "resolved",
    ...relationContext.contexts.map((context) => {
      const reference = context.observation_ref;
      return [
        context.relation_type,
        reference.record_id,
        reference.revision,
      ].join(":");
    }).sort(),
  ].join("|");
  const priorContextSignatures =
    normalizationState.versions[versionKey]?.context_signatures ?? {};
  const nextContextSignatures = Object.fromEntries(
    [...relationContextByRef].map(([reference, relationContext]) => [
      reference,
      contextSignature(relationContext),
    ]),
  );
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
    return (
      !currentNormalizedRefs.has(key) &&
      processed[key] !== true
    ) || (
      processed[key] === true &&
      priorContextSignatures[key] !== nextContextSignatures[key]
    );
  });
  const semanticSummary = {
    enabled: semanticAssessor !== null,
    attempted: 0,
    applied: 0,
    rejected: 0,
    failed: 0,
  };
  const records = [];
  for (const observation of pending) {
    const relationContext = relationContextByRef.get(exactRef(observation));
    const extractionOptions = {
      createdAt: now,
      availableAt: previouslyProcessedRefs.has(exactRef(observation))
        ? now
        : observation.revision === 1
          ? observation.data.availability_attestation?.available_at ??
            observation.data.fetched_at
          : observation.data.fetched_at ?? observation.created_at,
      evidenceRootOverride: evidenceRoots.get(exactRef(observation)),
      ...relationContext,
    };
    const deterministic = extractSignal(observation, config, extractionOptions);
    let record = deterministic;
    if (semanticAssessor && deterministic) {
      const candidate = semanticAssistanceCandidate({
        observation,
        config,
        signal: deterministic,
        contexts: relationContext.contexts,
        hasUnresolvedContext: relationContext.hasUnresolvedContext,
        now,
      });
      if (candidate) {
        semanticSummary.attempted += 1;
        try {
          const assessment = await semanticAssessor.assess(candidate);
          if (assessment) {
            const assisted = extractSignal(observation, config, {
              ...extractionOptions,
              semanticAssistance: {
                ...assessment,
                context_ref: candidate.context_ref,
              },
            });
            if (assisted?.data?.extraction?.semantic_assistance) {
              record = assisted;
              semanticSummary.applied += 1;
            } else {
              semanticSummary.rejected += 1;
            }
          } else {
            semanticSummary.rejected += 1;
          }
        } catch {
          semanticSummary.failed += 1;
        }
      }
    }
    if (record) records.push(record);
  }
  const results = await store.appendMany(records);
  normalizationState.versions[versionKey] = {
    processed: Object.fromEntries([
      ...Object.keys(processed).map((key) => [key, true]),
      ...pending.map((observation) => [exactRef(observation), true]),
    ]),
    context_signatures: {
      ...priorContextSignatures,
      ...nextContextSignatures,
    },
    updated_at: new Date(now).toISOString(),
  };
  await store.writeState("normalization", normalizationState);
  return {
    normalized: results.filter((result) => result.inserted).length,
    records,
    semantic_assistance: semanticSummary,
  };
}
