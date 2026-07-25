export function eventTypeFamily(eventType) {
  return ["quota_reset", "quota_refill"].includes(eventType)
    ? "platform_quota_reset"
    : eventType;
}

export function canonicalEventType(eventType) {
  return eventTypeFamily(eventType) === "platform_quota_reset"
    ? "quota_reset"
    : eventType;
}
