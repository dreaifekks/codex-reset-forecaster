function compareVersion(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareSignalRank(left, right) {
  const leftRef = left.data.observation_refs[0];
  const rightRef = right.data.observation_refs[0];
  if (leftRef.revision !== rightRef.revision) return leftRef.revision - rightRef.revision;
  const created = left.created_at.localeCompare(right.created_at);
  if (created !== 0) return created;
  if (left.revision !== right.revision) return left.revision - right.revision;
  const model = compareVersion(left.data.extraction.model_version, right.data.extraction.model_version);
  if (model !== 0) return model;
  const prompt = compareVersion(left.data.extraction.prompt_version, right.data.extraction.prompt_version);
  if (prompt !== 0) return prompt;
  return String(left.record_id).localeCompare(String(right.record_id));
}

function isProviderDiagnostic(signal) {
  const provenance = signal.data.provenance ?? {};
  return provenance.source_identity_id == null &&
    provenance.source_published_at == null &&
    provenance.canonical_source_url == null &&
    String(provenance.root_evidence_id ?? "").includes(":health-");
}

export function selectCurrentSignals(signals) {
  const selected = new Map();
  for (const signal of signals) {
    const observationId = signal.data.observation_refs[0]?.record_id;
    if (!observationId) continue;
    const previous = selected.get(observationId);
    if (!previous || compareSignalRank(previous, signal) < 0) selected.set(observationId, signal);
  }
  return [...selected.values()].filter((signal) =>
    signal.data.provenance?.feature_eligible !== false &&
    !isProviderDiagnostic(signal)
  );
}
