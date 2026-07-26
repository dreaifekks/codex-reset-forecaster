export const DEFAULT_X_SEARCH_GATEWAY_UPSTREAM = "grokbuild";

const EXACT_TEXT_UPSTREAMS = new Set(["socialdata"]);

export function normalizeXSearchGatewayUpstream(value) {
  const normalized = String(
    value ?? DEFAULT_X_SEARCH_GATEWAY_UPSTREAM,
  ).trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("X Search Gateway upstream provider cannot be empty");
  }
  return normalized;
}

export function isExactXSearchGatewayUpstream(value) {
  return EXACT_TEXT_UPSTREAMS.has(
    normalizeXSearchGatewayUpstream(value),
  );
}

export function isSummaryXSearchGatewayUpstream(value) {
  return !isExactXSearchGatewayUpstream(value);
}
