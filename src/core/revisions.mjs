import { timestampMillis } from "./time.mjs";

export function latestRevisionsAsOf(records, cutoff, availableAt = (record) => record.created_at) {
  const cutoffMs = timestampMillis(cutoff);
  const selected = new Map();
  for (const record of records) {
    const available = availableAt(record);
    if (
      !available ||
      timestampMillis(available) > cutoffMs ||
      timestampMillis(record.created_at) > cutoffMs
    ) continue;
    const previous = selected.get(record.record_id);
    if (!previous || record.revision > previous.revision) selected.set(record.record_id, record);
  }
  return [...selected.values()];
}
