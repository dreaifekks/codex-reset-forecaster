export function latestRevisionsAsOf(records, cutoff, availableAt = (record) => record.created_at) {
  const cutoffMs = Date.parse(cutoff);
  const selected = new Map();
  for (const record of records) {
    const available = availableAt(record);
    if (!available || Date.parse(available) > cutoffMs || Date.parse(record.created_at) > cutoffMs) continue;
    const previous = selected.get(record.record_id);
    if (!previous || record.revision > previous.revision) selected.set(record.record_id, record);
  }
  return [...selected.values()];
}
