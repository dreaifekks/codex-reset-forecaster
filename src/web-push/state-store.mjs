const STATE_SCHEMA_VERSION = "web-push-state/1";

function emptyState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    subscriptions: {},
  };
}

function normalizedState(value) {
  if (value === null || value === undefined) return emptyState();
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema_version !== STATE_SCHEMA_VERSION ||
    typeof value.subscriptions !== "object" ||
    value.subscriptions === null ||
    Array.isArray(value.subscriptions)
  ) {
    throw new TypeError("Stored web push state is invalid or unsupported");
  }
  return structuredClone(value);
}

export function createQueuedStateStore(store, stateKey = "web-push") {
  let mutationTail = Promise.resolve();

  async function read() {
    await mutationTail;
    return normalizedState(await store.readState(stateKey, null));
  }

  function mutate(mutator) {
    if (typeof mutator !== "function") {
      throw new TypeError("Web push state mutation requires a callback");
    }
    const operation = mutationTail.then(async () => {
      const draft = normalizedState(await store.readState(stateKey, null));
      const result = await mutator(draft);
      const next = normalizedState(draft);
      await store.writeState(stateKey, next);
      return result;
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  return { read, mutate };
}

export {
  STATE_SCHEMA_VERSION,
};
