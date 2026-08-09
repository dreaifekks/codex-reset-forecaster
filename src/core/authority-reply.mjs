const DIRECT_RESET_MODIFIER =
  String.raw`(?:another|a|the|one\s+more|performative|full|hard|global|codex|usage|rate|limit|quota|weekly|five[-\s]?hour)`;
const FIRST_PERSON_FUTURE_RESET = new RegExp([
  String.raw`\b(?:i(?:['’]ll|\s+will)|we(?:['’]ll|\s+will))\b\s+`,
  String.raw`(?:`,
  String.raw`(?:do|perform|trigger|run|apply|give)\s+`,
  String.raw`(?:${DIRECT_RESET_MODIFIER}\s+){0,6}`,
  String.raw`(?:reset|refill)`,
  String.raw`|(?:reset|refill))\b`,
].join(""), "i");

const NON_COMMITMENT_QUALIFIER = new RegExp([
  String.raw`\bnot\b`,
  String.raw`\bnever\b`,
  String.raw`\bmaybe\b`,
  String.raw`\bmight\b`,
  String.raw`\bmay\b`,
  String.raw`\bperhaps\b`,
  String.raw`\bpossibly\b`,
  String.raw`\bprobably\b`,
  String.raw`\bif\b`,
  String.raw`\bhope\b`,
  String.raw`\bwish\b`,
  String.raw`\bconsider(?:ing)?\b`,
  String.raw`\bthinking\s+about\b`,
  String.raw`\bcancel(?:s|led|ed|ling|ing)?\b`,
  String.raw`\bcalled\s+off\b`,
  String.raw`\bscratch\s+that\b`,
  String.raw`\bchang(?:e|ed|ing)\s+(?:my|our)\s+mind\b`,
  String.raw`\babort(?:s|ed|ing)?\b`,
  String.raw`\bprevent(?:s|ed|ing)?\b`,
  String.raw`\bstop(?:s|ped|ping)?\b`,
  String.raw`\bdelay(?:s|ed|ing)?\b`,
  String.raw`\bavoid(?:s|ed|ing)?\b`,
  String.raw`\bwait(?:s|ed|ing)?\b`,
  String.raw`\bask(?:s|ed|ing)?\b`,
  String.raw`\brequest(?:s|ed|ing)?\b`,
  String.raw`\btell(?:s|ing|told)?\b`,
  String.raw`\bwon['’]?t\b`,
  String.raw`\bwill\s+not\b`,
  String.raw`\bnever\s+mind\b`,
  String.raw`\bpostpone(?:s|d|ing)?\b`,
  String.raw`\bthink\b`,
  String.raw`\bguess\b`,
  String.raw`\bsuppose\b`,
  String.raw`\b(?:looks?|seems?)\s+like\b`,
].join("|"), "i");

const NARROW_RESET_SCOPE = new RegExp([
  String.raw`\b(?:my|your|his|her|their|one\s+user['’]s|a\s+user['’]s|an?\s+individual['’]s)\s+(?:codex\s+)?(?:account|quota|usage|limits?|allowance)\b`,
  String.raw`\b(?:plus|pro|team|enterprise|business|edu|free)(?:\s*(?:&|and|\/)\s*(?:plus|pro|team|enterprise|business|edu|free))*\s+(?:plans?|tiers?|subscriptions?|users?|accounts?|quota|usage|limits?|allowance)\b`,
  String.raw`\b(?:users?|accounts?|subscriptions?)\s+(?:on|under|using)\s+(?:the\s+)?(?:plus|pro|team|enterprise|business|edu|free)(?:\s+(?:plan|tier|subscription))?\b`,
  String.raw`\b(?:some|selected|specific|affected|eligible|individual|a\s+subset\s+of)\s+(?:users?|accounts?|subscriptions?|plans?)\b`,
  String.raw`\b(?:users?|accounts?|subscriptions?)\s+in\s+(?:the\s+)?(?:us|usa|uk|eu|europe|canada|australia|india|japan|asia)\b`,
  String.raw`\b(?:us|usa|uk|eu|european|canadian|australian|indian|japanese|asian)\s+(?:users?|accounts?|subscriptions?)\b`,
].join("|"), "i");

const RESET_ACTION = /\b(?:reset(?:s|ting|ted)?|refill(?:s|ed|ing)?)\b/i;
const RESET_ACTION_GLOBAL =
  /\b(?:reset(?:s|ting|ted)?|refill(?:s|ed|ing)?)\b/gi;
const TIMING_OR_END_AFTER_RESET = new RegExp(
  String.raw`^\s*(?:$|[,;:\u2010-\u2015-]?\s*(?:on|in|within|over|later|tomorrow|tonight|this\s+(?:evening|morning)|next|soon)\b)`,
  "i",
);

function segments(value) {
  return String(value ?? "")
    .split(/\n+|(?<=[.!?。！？])\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function authorityReplyCommitmentSegment(text) {
  const sourceText = String(text ?? "");
  if (
    NON_COMMITMENT_QUALIFIER.test(sourceText) ||
    NARROW_RESET_SCOPE.test(sourceText)
  ) return null;
  const textSegments = segments(sourceText);
  const resetMentions = textSegments.reduce(
    (count, segment) => count + [...segment.matchAll(RESET_ACTION_GLOBAL)].length,
    0,
  );
  if (resetMentions !== 1) return null;
  for (const segment of textSegments) {
    const match = FIRST_PERSON_FUTURE_RESET.exec(segment);
    if (!match || /[?？]/u.test(segment)) continue;
    if (NON_COMMITMENT_QUALIFIER.test(segment)) continue;
    const reset = RESET_ACTION.exec(match[0]);
    const resetEnd = reset
      ? match.index + reset.index + reset[0].length
      : segment.length;
    const suffix = segment.slice(resetEnd);
    if (!TIMING_OR_END_AFTER_RESET.test(suffix)) continue;
    return segment;
  }
  return null;
}

export function hasNarrowAuthorityResetScope(text) {
  return NARROW_RESET_SCOPE.test(String(text ?? ""));
}

export function hasSingleNativeReply(relations = []) {
  if (!Array.isArray(relations)) return false;
  const replies = relations.filter((relation) => relation?.type === "reply");
  const providerStatusId = String(
    replies[0]?.provider_item_id ?? "",
  ).match(/^\d{6,24}$/)?.[0] ?? null;
  const urlStatusId = String(replies[0]?.url ?? "").match(
    /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[^/?#]+\/)?status(?:es)?\/(\d{6,24})/i,
  )?.[1] ?? null;
  const exactStatusId = providerStatusId ?? urlStatusId;
  return replies.length === 1 &&
    !relations.some((relation) => relation?.type === "repost") &&
    exactStatusId !== null &&
    !(providerStatusId && urlStatusId && providerStatusId !== urlStatusId);
}

export function isFirstPersonFutureResetReply({ text, nativeRelations } = {}) {
  return hasSingleNativeReply(nativeRelations) &&
    authorityReplyCommitmentSegment(text) !== null;
}
