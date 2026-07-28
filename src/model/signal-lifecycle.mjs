import { eventTypeFamily } from "../core/event-types.mjs";
import { productsInScope } from "../core/product-scope.mjs";
import { timestampMillis } from "../core/time.mjs";

const RESET_TIMING_PHASES = new Set([
  "scheduled",
  "expected",
  "started",
]);

export const RESET_TIMING_SIGNAL_LIFECYCLE_VERSION =
  "reset-timing-signal-lifecycle/1";

export function isResetTimingSignal(signal) {
  const claim = signal?.data?.claim;
  return RESET_TIMING_PHASES.has(claim?.phase) &&
    eventTypeFamily(claim?.event_type) === "platform_quota_reset";
}

function sourceTime(signal) {
  return signal.data.provenance.source_published_at ??
    signal.data.available_at;
}

function safeTimestampMillis(value) {
  try {
    return timestampMillis(value);
  } catch {
    return NaN;
  }
}

function compatibleScope(signal, outcome) {
  const signalScope = signal.data.claim.scope;
  const outcomeScope = outcome.data.scope;
  if (
    !signalScope ||
    !outcomeScope ||
    signalScope.vendor !== outcomeScope.vendor ||
    signalScope.population !== outcomeScope.population
  ) {
    return false;
  }
  const outcomeProducts = new Set(productsInScope(outcomeScope));
  return productsInScope(signalScope).some((product) =>
    outcomeProducts.has(product)
  );
}

export function isResetTimingSignalConsumed(
  signal,
  outcomes = [],
  targetTime = null,
) {
  if (!isResetTimingSignal(signal)) return false;
  const asserted = signal.data.claim.asserted_time_range;
  const publishedAt = safeTimestampMillis(sourceTime(signal));
  const target = targetTime === null
    ? Infinity
    : safeTimestampMillis(targetTime);
  const assertedStart = asserted
    ? safeTimestampMillis(asserted.start)
    : null;
  const assertedEnd = asserted
    ? safeTimestampMillis(asserted.end)
    : null;
  if (
    !Number.isFinite(publishedAt) ||
    (targetTime !== null && !Number.isFinite(target))
  ) return false;
  if (
    asserted &&
    (
      !Number.isFinite(assertedStart) ||
      !Number.isFinite(assertedEnd)
    )
  ) return false;
  return outcomes.some((outcome) => {
    const occurred = outcome?.data?.occurred_time_range;
    if (
      outcome?.data?.status !== "confirmed" ||
      eventTypeFamily(outcome.data.event_type) !== "platform_quota_reset" ||
      !occurred ||
      !compatibleScope(signal, outcome)
    ) return false;
    const occurredStart = safeTimestampMillis(occurred.start);
    const occurredEnd = safeTimestampMillis(occurred.end);
    const happenedAfterSignal = Number.isFinite(occurredStart) &&
      Number.isFinite(occurredEnd) &&
      occurredEnd > publishedAt &&
      occurredEnd <= target;
    if (!happenedAfterSignal) return false;
    return asserted
      ? occurredStart < assertedEnd && occurredEnd > assertedStart
      : true;
  });
}

export function isResetTimingSignalActiveAt(signal, {
  outcomes = [],
  targetTime = null,
} = {}) {
  if (!isResetTimingSignal(signal)) return false;
  const asserted = signal.data.claim.asserted_time_range;
  if (asserted && targetTime !== null) {
    const assertedEnd = safeTimestampMillis(asserted.end);
    const target = safeTimestampMillis(targetTime);
    if (
      !Number.isFinite(assertedEnd) ||
      !Number.isFinite(target) ||
      assertedEnd <= target
    ) return false;
  }
  return !isResetTimingSignalConsumed(signal, outcomes, targetTime);
}
