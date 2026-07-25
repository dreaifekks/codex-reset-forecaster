import { stableStringify } from "./hash.mjs";

function providerConfigurations(config) {
  return Object.values(config.providers ?? {}).filter((provider) =>
    provider && typeof provider === "object" && !Array.isArray(provider),
  );
}

export function configuredSourceIdentities(config) {
  const grouped = new Map();
  for (const provider of providerConfigurations(config)) {
    for (const [kind, values] of [
      ["confirmation", provider.confirmation_identities ?? []],
      ["context", provider.context_identities ?? []],
    ]) {
      for (const identity of values) {
        if (!identity?.identity_id) continue;
        const key = `${kind}:${identity.identity_id}`;
        const entries = grouped.get(key) ?? [];
        entries.push({ ...identity, kind });
        grouped.set(key, entries);
      }
    }
  }
  const identities = [];
  for (const [key, entries] of grouped) {
    const roles = new Set(entries.map((entry) => entry.source_role ?? "unknown"));
    if (roles.size > 1) {
      throw new TypeError(
        `Conflicting source roles for ${key}: ${[...roles].sort().join(", ")}`,
      );
    }
    identities.push(
      [...entries].sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right))
      )[0],
    );
  }
  return identities.sort((left, right) =>
    left.kind.localeCompare(right.kind) ||
    left.identity_id.localeCompare(right.identity_id) ||
    String(left.source_role).localeCompare(String(right.source_role))
  );
}

export function canonicalSourceIdentityPolicy(config) {
  return configuredSourceIdentities(config).map(
    ({ identity_id, source_role, kind }) => ({
      identity_id,
      source_role: source_role ?? "unknown",
      kind,
    }),
  );
}

export function confirmationIdentityIds(config) {
  return new Set(
    configuredSourceIdentities(config)
      .filter((identity) => identity.kind === "confirmation")
      .map((identity) => identity.identity_id),
  );
}

export function sourceRoleForIdentity(config, identityId) {
  return configuredSourceIdentities(config)
    .find((identity) => identity.identity_id === identityId)?.source_role ?? "community";
}
