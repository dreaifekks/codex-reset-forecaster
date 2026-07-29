import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "./outcome-contract.mjs";
import {
  predictionRequiresPostOutcomeRefractory,
} from "./prediction-contract.mjs";

const RECORD_TYPES = new Set([
  "raw_observation",
  "normalized_signal",
  "event_candidate",
  "reset_outcome",
  "feature_snapshot",
  "prediction",
  "prediction_settlement",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`Canonical record validation failed: ${message}`);
}

function isUtc(value) {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function probability(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be in [0,1]`);
}

function range(value, label, nullable = false) {
  if (nullable && value === null) return;
  invariant(value && isUtc(value.start) && isUtc(value.end), `${label} timestamps must be RFC 3339 UTC`);
  invariant(Date.parse(value.start) < Date.parse(value.end), `${label} must be non-empty`);
  invariant(value.boundary === "[start,end)", `${label} must be half-open`);
}

function recordReference(value, label) {
  invariant(value && typeof value.record_id === "string" && Number.isInteger(value.revision) && value.revision >= 1, `${label} is invalid`);
}

function coverageAssertionReference(value, label) {
  invariant(
    value &&
    typeof value.assertion_id === "string" &&
    value.assertion_id.length > 0 &&
    Number.isInteger(value.revision) &&
    value.revision >= 1,
    `${label} is invalid`,
  );
}

function scope(value, label) {
  invariant(value && value.vendor && value.product && value.population, `${label} is incomplete`);
  if (value.product === "multi_product") {
    invariant(
      Array.isArray(value.products) &&
      value.products.length >= 2 &&
      new Set(value.products).size === value.products.length,
      `${label} multi-product membership is invalid`,
    );
  }
}

function validatePrediction(record) {
  const data = record.data;
  invariant(isUtc(data.issued_at) && isUtc(data.knowledge_cutoff), "prediction timestamps must be UTC");
  range(data.horizon, "prediction horizon");
  invariant(
    Date.parse(data.knowledge_cutoff) <= Date.parse(data.issued_at),
    "prediction cannot be issued before its knowledge cutoff",
  );
  invariant(
    Date.parse(data.issued_at) <= Date.parse(data.horizon.start),
    "prediction horizon cannot start before publication",
  );
  scope(data.scope, "prediction scope");
  invariant(data.base_slot === "PT1H" && data.display_horizon === "PT4H", "prediction resolution mismatch");
  invariant(Array.isArray(data.slots) && data.slots.length >= 1 && data.slots.length <= 168, "prediction must have 1..168 slots");
  invariant(
    data.slots[0].start === data.horizon.start &&
    data.slots.at(-1).end === data.horizon.end,
    "prediction slots must exactly cover the declared horizon",
  );
  let survival = 1;
  for (const [index, slot] of data.slots.entries()) {
    range({ start: slot.start, end: slot.end, boundary: "[start,end)" }, `prediction slot ${index}`);
    invariant(Date.parse(slot.end) - Date.parse(slot.start) === 3_600_000, `prediction slot ${index} is not one hour`);
    if (index > 0) invariant(slot.start === data.slots[index - 1].end, "prediction slots are not contiguous");
    probability(slot.hazard, `slot ${index} hazard`);
    probability(slot.first_reset_probability, `slot ${index} first reset probability`);
    probability(slot.reset_by_end_probability, `slot ${index} cumulative probability`);
    if (slot.rolling_4h_probability !== null) {
      probability(slot.rolling_4h_probability, `slot ${index} rolling probability`);
    }
    invariant(Math.abs(slot.first_reset_probability - survival * slot.hazard) <= 1e-8, `slot ${index} first reset identity mismatch`);
    survival *= 1 - slot.hazard;
    invariant(Math.abs(slot.reset_by_end_probability - (1 - survival)) <= 1e-8, `slot ${index} cumulative identity mismatch`);
    if (slot.epistemic_interval_80) {
      invariant(slot.epistemic_interval_80.length === 2, `slot ${index} uncertainty interval length`);
      probability(slot.epistemic_interval_80[0], `slot ${index} uncertainty lower`);
      probability(slot.epistemic_interval_80[1], `slot ${index} uncertainty upper`);
      invariant(slot.epistemic_interval_80[0] <= slot.epistemic_interval_80[1], `slot ${index} uncertainty order`);
    }
  }
  for (let index = 0; index < data.slots.length; index += 1) {
    if (index + 4 > data.slots.length) {
      invariant(
        data.slots[index].rolling_4h_probability === null,
        `slot ${index} rolling probability must be null without four saved hazards`,
      );
      continue;
    }
    let rollingSurvival = 1;
    for (let offset = 0; offset < 4; offset += 1) {
      rollingSurvival *= 1 - data.slots[index + offset].hazard;
    }
    invariant(Math.abs(data.slots[index].rolling_4h_probability - (1 - rollingSurvival)) <= 1e-8, `slot ${index} rolling identity mismatch`);
  }
  probability(data.no_reset_probability, "prediction no-reset probability");
  invariant(Math.abs(data.no_reset_probability - survival) <= 1e-8, "prediction no-reset identity mismatch");
  const refractory = data.post_outcome_refractory;
  invariant(
    !predictionRequiresPostOutcomeRefractory(record) ||
      refractory !== undefined,
    "current reset-forecaster prediction requires post-outcome refractory metadata",
  );
  if (refractory !== undefined) {
    invariant(
      refractory?.policy_version ===
        "post-outcome-refractory-piecewise-hazard-multiplier/1" &&
      refractory.outcome_selection_basis ===
        "latest_eligible_confirmed_outcome_available_at_cutoff" &&
      refractory.time_basis === "occurred_time_range_end" &&
      refractory.prior_basis ===
        "versioned_non_learned_minimum_inter_event_prior" &&
      ["live", "archive_replay", "synthetic_replay"].includes(
        refractory.as_of_mode,
      ) &&
      typeof refractory.applied === "boolean",
      "prediction post-outcome refractory policy mismatch",
    );
    probability(
      refractory.base_horizon_probability,
      "prediction refractory base horizon probability",
    );
    probability(
      refractory.conditioned_horizon_probability,
      "prediction refractory conditioned horizon probability",
    );
    if (refractory.status === "active") {
      invariant(
        refractory.applied === true,
        "active prediction refractory must be applied",
      );
      recordReference(
        refractory.outcome_ref,
        "prediction refractory outcome ref",
      );
      invariant(
        isUtc(refractory.outcome_known_at) &&
        isUtc(refractory.outcome_available_at) &&
        isUtc(refractory.recovery_end_at),
        "prediction refractory timestamps invalid",
      );
      range(
        refractory.outcome_occurred_time_range,
        "prediction refractory outcome range",
      );
      probability(
        refractory.first_slot_multiplier,
        "prediction refractory first-slot multiplier",
      );
      invariant(
        refractory.first_slot_multiplier < 1 &&
        refractory.conditioned_horizon_probability <=
          refractory.base_horizon_probability + 1e-8,
        "active prediction refractory must suppress hazard",
      );
    } else if (refractory.status === "recovered") {
      invariant(
        refractory.applied === false,
        "recovered prediction refractory cannot be applied",
      );
      recordReference(
        refractory.outcome_ref,
        "prediction recovered refractory outcome ref",
      );
      invariant(
        isUtc(refractory.outcome_known_at) &&
        isUtc(refractory.outcome_available_at) &&
        isUtc(refractory.recovery_end_at),
        "prediction recovered refractory timestamps invalid",
      );
      range(
        refractory.outcome_occurred_time_range,
        "prediction recovered refractory outcome range",
      );
      invariant(
        refractory.first_slot_multiplier === 1,
        "prediction recovered refractory multiplier must be one",
      );
    } else {
      invariant(
        ["disabled", "no_eligible_outcome"].includes(refractory.status) &&
        refractory.applied === false &&
        refractory.outcome_ref === null &&
        refractory.outcome_known_at === null &&
        refractory.outcome_available_at === null &&
        refractory.outcome_occurred_time_range === null &&
        refractory.recovery_end_at === null &&
        refractory.first_slot_multiplier === null,
        "inactive prediction refractory metadata invalid",
      );
    }
    if (!refractory.applied) {
      invariant(
        Math.abs(
          refractory.base_horizon_probability -
          refractory.conditioned_horizon_probability
        ) <= 1e-8,
        "inactive prediction refractory changed probability",
      );
    }
  }
  if (data.authority_conditioning !== undefined) {
    const conditioning = data.authority_conditioning;
    invariant(
      conditioning?.policy_version ===
        "authority-timing-first-event-mixture/1",
      "prediction authority timing policy mismatch",
    );
    invariant(
      conditioning.reliability_basis ===
        "versioned_prior_non_exhaustive_statement_history",
      "prediction authority timing reliability basis mismatch",
    );
    invariant(
      typeof conditioning.applied === "boolean",
      "prediction authority timing applied flag missing",
    );
    probability(
      conditioning.base_horizon_probability,
      "prediction base horizon probability",
    );
    probability(
      conditioning.conditioned_horizon_probability,
      "prediction conditioned horizon probability",
    );
    if (refractory !== undefined) {
      invariant(
        Math.abs(
          conditioning.base_horizon_probability -
          refractory.conditioned_horizon_probability
        ) <= 1e-8,
        "prediction conditioning stages are not linked",
      );
    }
    invariant(
      Math.abs(
        conditioning.conditioned_horizon_probability -
        (1 - data.no_reset_probability)
      ) <= 1e-8,
      "prediction conditioned horizon probability mismatch",
    );
    if (conditioning.applied) {
      invariant(
        ["scheduled", "expected", "started"].includes(
          conditioning.phase,
        ),
        "prediction authority timing phase invalid",
      );
      probability(
        conditioning.prior_reliability,
        "prediction authority timing prior reliability",
      );
      recordReference(
        conditioning.signal_ref,
        "prediction authority timing signal ref",
      );
      range(
        conditioning.asserted_time_range,
        "prediction authority timing range",
      );
    } else {
      invariant(
        conditioning.phase === null &&
        conditioning.prior_reliability === null &&
        conditioning.signal_ref === null &&
        conditioning.asserted_time_range === null,
        "inactive prediction authority timing metadata must be null",
      );
      invariant(
        Math.abs(
          conditioning.base_horizon_probability -
          conditioning.conditioned_horizon_probability
        ) <= 1e-8,
        "inactive prediction authority timing changed probability",
      );
    }
  }
  if (data.recurrence_anchor !== undefined && data.recurrence_anchor !== null) {
    recordReference(
      data.recurrence_anchor.outcome_ref,
      "prediction recurrence anchor outcome ref",
    );
    range(
      data.recurrence_anchor.occurred_time_range,
      "prediction recurrence anchor range",
    );
  }
  probability(data.data_quality?.score, "prediction data quality");
  probability(data.data_quality?.provider_coverage, "prediction provider coverage");
  invariant(
    Number.isInteger(data.data_quality?.outcome_sample_count) &&
      data.data_quality.outcome_sample_count >= 0,
    "prediction outcome sample count invalid",
  );
  probability(
    data.data_quality?.sample_sufficiency,
    "prediction sample sufficiency",
  );
  invariant(Array.isArray(data.feature_snapshot_refs), "prediction feature refs missing");
  invariant(
    data.feature_snapshot_refs.length === data.slots.length,
    "prediction must bind one feature snapshot per slot",
  );
  data.feature_snapshot_refs.forEach((ref, index) => recordReference(ref, `prediction feature ref ${index}`));
  invariant(
    new Set(data.feature_snapshot_refs.map((ref) => `${ref.record_id}@${ref.revision}`)).size ===
      data.feature_snapshot_refs.length,
    "prediction feature refs must be unique",
  );
  invariant(
    data.model?.family &&
    data.model?.version &&
    /^[a-f0-9]{64}$/.test(data.model?.artifact_hash ?? "") &&
    typeof data.model?.model_contract_hash === "string" &&
    data.model.model_contract_hash.startsWith("sha256:") &&
    isUtc(data.model?.training_cutoff),
    "prediction model metadata incomplete",
  );
  invariant(
    Date.parse(data.model.training_cutoff) <= Date.parse(data.knowledge_cutoff),
    "prediction model cannot be trained after its knowledge cutoff",
  );
}

export function assertCanonicalRecord(record) {
  invariant(record && typeof record === "object" && !Array.isArray(record), "record must be an object");
  invariant(record.schema_version === "reset-intel/0.2", "schema version mismatch");
  invariant(RECORD_TYPES.has(record.record_type), "record type unsupported");
  invariant(typeof record.record_id === "string" && record.record_id.length > 0, "record ID missing");
  invariant(Number.isInteger(record.revision) && record.revision >= 1, "revision invalid");
  invariant(isUtc(record.created_at), "created_at must be RFC 3339 UTC");
  invariant(record.producer?.name && record.producer?.version, "producer incomplete");
  invariant(record.data && typeof record.data === "object" && !Array.isArray(record.data), "data invalid");
  if (record.supersedes !== null) recordReference(record.supersedes, "supersedes");

  const data = record.data;
  if (record.record_type === "raw_observation") {
    invariant(data.ingest_provider && data.provider_item_id, "raw observation identity incomplete");
    invariant(data.published_at === null || isUtc(data.published_at), "raw published_at invalid");
    invariant(isUtc(data.first_seen_at) && isUtc(data.fetched_at), "raw collection timestamps invalid");
    if (data.availability_attestation !== null && data.availability_attestation !== undefined) {
      invariant(isUtc(data.availability_attestation.available_at), "raw attested availability invalid");
      invariant(isUtc(data.availability_attestation.verified_at), "raw availability verification time invalid");
      invariant(
        Date.parse(data.availability_attestation.available_at) <= Date.parse(data.fetched_at),
        "raw attested availability cannot be after fetch time",
      );
      invariant(
        ["direct_source_publication", "archive_snapshot", "provider_first_seen"].includes(
          data.availability_attestation.basis,
        ) &&
          typeof data.availability_attestation.attestor_url === "string" &&
          data.availability_attestation.attestor_url.length > 0 &&
          typeof data.availability_attestation.verification === "string" &&
          data.availability_attestation.verification.length > 0,
        "raw availability attestation incomplete",
      );
    }
    invariant(data.author && Array.isArray(data.native_relations) && data.content?.content_hash, "raw observation body incomplete");
  } else if (record.record_type === "normalized_signal") {
    invariant(isUtc(data.available_at), "signal available_at invalid");
    invariant(Array.isArray(data.observation_refs) && data.observation_refs.length > 0, "signal observation refs missing");
    data.observation_refs.forEach((ref, index) => recordReference(ref, `signal observation ref ${index}`));
    scope(data.claim?.scope, "signal scope");
    range(data.claim?.asserted_time_range, "asserted time", true);
    if (data.claim?.impact !== undefined && data.claim.impact !== null) {
      const impact = data.claim.impact;
      invariant(
        [
          "availability",
          "performance",
          "correctness",
          "tool_execution",
          "session_state",
          "quota_accounting",
          "auth",
          "client_ux",
          "other",
        ].includes(impact.category) &&
          ["critical", "high", "medium", "low", "unknown"].includes(
            impact.severity,
          ) &&
          ["active", "investigating", "mitigating", "resolved", "unknown"].includes(
            impact.lifecycle,
          ) &&
          ["individual", "multiple_users", "platform", "unknown"].includes(
            impact.affected_scope,
          ) &&
          Array.isArray(impact.affected_surfaces) &&
          impact.affected_surfaces.length > 0 &&
          new Set(impact.affected_surfaces).size === impact.affected_surfaces.length &&
          impact.affected_surfaces.every((surface) =>
            [
              "cli",
              "ide",
              "api",
              "web",
              "agent_loop",
              "tool_use",
              "mcp",
              "auth",
              "fast_mode",
              "unknown",
            ].includes(surface)
          ) &&
          ["none", "partial", "available", "unknown"].includes(impact.workaround) &&
          [
            "first_party_report",
            "independent_corroboration",
            "official_incident",
            "reproduction",
            "unknown",
          ].includes(impact.evidence_basis),
        "signal impact classification invalid",
      );
    }
    if (
      data.claim?.competitive_context !== undefined &&
      data.claim.competitive_context !== null
    ) {
      const context = data.claim.competitive_context;
      invariant(
        [
          "model_release",
          "coding_agent_release",
          "capability_release",
          "limit_change",
          "pricing_change",
        ].includes(context.kind) &&
          ["direct", "adjacent", "weak", "unknown"].includes(context.relevance) &&
          [
            "announced",
            "preview",
            "general_availability",
            "rolled_out",
            "rumor",
          ].includes(context.stage),
        "signal competitive context invalid",
      );
    }
    probability(data.extraction?.confidence, "extraction confidence");
    invariant(
      /^sha256:[a-f0-9]{64}$/.test(data.extraction?.semantic_policy_hash ?? ""),
      "signal extraction semantic policy hash invalid",
    );
    if (data.extraction?.relevance !== undefined) {
      const relevance = data.extraction.relevance;
      invariant(
        typeof relevance.policy_version === "string" &&
          ["relevant", "irrelevant", "pending_context"].includes(
            relevance.decision,
          ) &&
          typeof relevance.reason_code === "string" &&
          ["self", "reply_parent", "quote", "unresolved_context"].includes(
            relevance.basis,
          ) &&
          Array.isArray(relevance.matched_segments) &&
          Array.isArray(relevance.context_refs),
        "signal relevance decision invalid",
      );
      relevance.context_refs.forEach((ref, index) =>
        recordReference(ref, `signal relevance context ref ${index}`)
      );
      invariant(
        relevance.decision === "relevant" ||
          data.provenance?.feature_eligible === false,
        "non-relevant signal must be feature-ineligible",
      );
    }
    invariant(data.provenance?.root_evidence_id && data.provenance?.independence_group_id, "signal provenance incomplete");
  } else if (record.record_type === "event_candidate") {
    invariant(isUtc(data.as_of) && data.event_cluster_id, "candidate identity incomplete");
    scope(data.scope, "candidate scope");
    range(data.hypothesized_time_range, "candidate time", true);
    invariant(Array.isArray(data.evidence), "candidate evidence missing");
  } else if (record.record_type === "reset_outcome") {
    invariant(isUtc(data.known_at), "outcome known_at invalid");
    invariant(
      data.replay_available_at === undefined ||
      data.replay_available_at === null ||
      isUtc(data.replay_available_at),
      "outcome replay availability invalid",
    );
    scope(data.scope, "outcome scope");
    range(data.occurred_time_range, "outcome time", true);
    invariant(Array.isArray(data.verification) && data.verification.length > 0, "outcome verification missing");
    data.verification.forEach((entry, index) => recordReference(entry.observation_ref, `outcome verification ${index}`));
    if (data.status === "confirmed") {
      invariant(
        data.label_policy_version === OUTCOME_LABEL_POLICY_VERSION &&
        typeof data.event_identity === "string" &&
        data.event_identity.length > 0 &&
        data.occurred_time_range !== null &&
        Array.isArray(data.candidate_refs) &&
        data.candidate_refs.length > 0 &&
        data.verification.every((entry) =>
          entry.kind === "official_confirmation" &&
          typeof entry.independence_group_id === "string" &&
          entry.independence_group_id.length > 0
        ) &&
        record.producer.name === "outcome-adjudicator" &&
        record.producer.version === OUTCOME_ADJUDICATOR_VERSION,
        "confirmed outcome contract incomplete",
      );
    }
  } else if (record.record_type === "feature_snapshot") {
    invariant(isUtc(data.knowledge_cutoff), "feature cutoff invalid");
    invariant(
      /^sha256:[a-f0-9]{64}$/.test(data.config_hash ?? "") &&
      data.feature_schema_version &&
      data.taxonomy_version &&
      data.deduplication_version &&
      data.timezone_database_version &&
      data.extractor_model &&
      data.extractor_model_version &&
      data.extractor_prompt_version &&
      /^sha256:[a-f0-9]{64}$/.test(data.extractor_semantic_policy_hash ?? ""),
      "feature provenance versions incomplete",
    );
    invariant(isUtc(data.target?.start) && isUtc(data.target?.end), "feature target invalid");
    invariant(data.target.base_slot === "PT1H" && data.target.display_horizon === "PT4H", "feature resolution mismatch");
    probability(data.data_quality?.provider_coverage, "feature provider coverage");
    invariant(
      Number.isInteger(data.data_quality?.outcome_sample_count) &&
        data.data_quality.outcome_sample_count >= 0,
      "feature outcome sample count invalid",
    );
    probability(
      data.data_quality?.sample_sufficiency,
      "feature sample sufficiency",
    );
    invariant(Array.isArray(data.source_record_refs), "feature source refs missing");
    data.source_record_refs.forEach((ref, index) =>
      recordReference(ref, `feature source ref ${index}`)
    );
    invariant(Array.isArray(data.coverage_assertion_refs), "feature coverage refs missing");
    data.coverage_assertion_refs.forEach((ref, index) =>
      coverageAssertionReference(ref, `feature coverage ref ${index}`)
    );
    invariant(
      new Set(data.coverage_assertion_refs.map((ref) =>
        `${ref.assertion_id}@${ref.revision}`
      )).size === data.coverage_assertion_refs.length,
      "feature coverage refs must be unique",
    );
  } else if (record.record_type === "prediction") {
    validatePrediction(record);
  } else if (record.record_type === "prediction_settlement") {
    recordReference(data.prediction_ref, "settlement prediction ref");
    invariant(Number.isInteger(data.slot_index) && data.slot_index >= 0 && data.slot_index <= 167, "settlement slot index invalid");
    range(data.window, "settlement window");
    invariant(data.display_horizon === "PT4H", "settlement display horizon mismatch");
    invariant(["positive", "negative", "pending", "censored"].includes(data.status), "settlement status invalid");
    invariant(isUtc(data.settled_at), "settlement time invalid");
    invariant(data.outcome_as_of_mode === "live", "settlement outcome as-of mode invalid");
    invariant(data.coverage_as_of_mode === "live", "settlement coverage as-of mode invalid");
    invariant(Array.isArray(data.outcome_refs), "settlement outcome refs missing");
    data.outcome_refs.forEach((ref, index) => recordReference(ref, `settlement outcome ref ${index}`));
    invariant(Array.isArray(data.coverage_assertion_refs), "settlement coverage refs missing");
    data.coverage_assertion_refs.forEach((ref, index) =>
      coverageAssertionReference(ref, `settlement coverage ref ${index}`)
    );
    invariant(
      new Set(data.coverage_assertion_refs.map((ref) =>
        `${ref.assertion_id}@${ref.revision}`
      )).size === data.coverage_assertion_refs.length,
      "settlement coverage refs must be unique",
    );
    invariant(
      /^sha256:[a-f0-9]{64}$/.test(data.coverage_assertion_snapshot_hash ?? ""),
      "settlement coverage snapshot hash invalid",
    );
    invariant(typeof data.coverage?.complete === "boolean" && Array.isArray(data.coverage?.providers), "settlement coverage invalid");
    invariant(typeof data.reason === "string" && data.reason.length > 0, "settlement reason missing");
  }
  return record;
}
