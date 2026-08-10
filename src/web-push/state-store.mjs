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

export function createCoreStateAdapter(store, stateKey = "web-push") {
  if (
    typeof store?.readState !== "function" ||
    typeof store?.writeState !== "function"
  ) {
    throw new TypeError("A core store with readState/writeState is required");
  }
  return {
    read: () => store.readState(stateKey, null),
    write: (value) => store.writeState(stateKey, value),
  };
}

export function createQueuedStateStore(stateAdapter) {
  if (
    typeof stateAdapter?.read !== "function" ||
    typeof stateAdapter?.write !== "function"
  ) {
    throw new TypeError("A web push stateAdapter with read/write is required");
  }
  let mutationTail = Promise.resolve();

  async function read() {
    await mutationTail;
    return normalizedState(await stateAdapter.read());
  }

  function mutate(mutator) {
    if (typeof mutator !== "function") {
      throw new TypeError("Web push state mutation requires a callback");
    }
    const operation = mutationTail.then(async () => {
      const draft = normalizedState(await stateAdapter.read());
      const result = await mutator(draft);
      const next = normalizedState(draft);
      await stateAdapter.write(next);
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
