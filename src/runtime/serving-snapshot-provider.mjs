export function createServingSnapshotProvider(seedSnapshot = null) {
  if (
    seedSnapshot !== null &&
    (typeof seedSnapshot !== "object" || Array.isArray(seedSnapshot))
  ) {
    throw new TypeError("Serving snapshot seed must be an object or null");
  }

  let current = seedSnapshot;

  return Object.freeze({
    get() {
      return current;
    },
    publish(snapshot) {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new TypeError("Serving snapshot must be an object");
      }
      current = snapshot;
      return snapshot;
    },
  });
}
