import { createRecord, producer, recordRef } from "../core/records.mjs";
import {
  extractorContract,
  matchesExtractorContract,
} from "../core/extractor-contract.mjs";
import { addHours, ceilHour, clamp, differenceInHours, hourOfWeek, toUtcIso } from "../core/time.mjs";
import {
  normalizeCoverageIntervals,
} from "../pipeline/coverage.mjs";
import { confirmationIdentityIds } from "../core/sources.mjs";
import { selectCurrentSignals } from "../pipeline/signal-selection.mjs";
import {
  buildOutcomeEligibilityContext,
  isEligibleConfirmedOutcome,
} from "../pipeline/outcomes.mjs";
import {
  AS_OF_MODE,
  latestObservationsAsOf,
  latestOutcomesAsOf,
  latestSignalsAsOf,
  outcomeAvailableAt,
} from "./as-of.mjs";
import {
  COVERAGE_AS_OF_MODE,
  adequateCoverageAssertionsAsOf,
  coverageAssertionRevisions,
} from "./coverage-as-of.mjs";
import {
  isResetTimingSignal,
  isResetTimingSignalActiveAt,
} from "./signal-lifecycle.mjs";
import {
  isAuthorityTimingSupportSignal,
  matchesAuthorityTimingTarget,
} from "./authority-timing-eligibility.mjs";
import {
  DEFAULT_POST_OUTCOME_EVIDENCE_POLICY,
  postOutcomeEvidenceWeight,
} from "./evidence-epoch.mjs";

export const FEATURE_SNAPSHOT_PRODUCER_VERSION = "0.3.3";

export const FEATURE_NAMES = [
  "weekly_sin_1",
  "weekly_cos_1",
  "weekly_sin_2",
  "weekly_cos_2",
  "weekly_sin_3",
  "weekly_cos_3",
  "daily_sin_1",
  "daily_cos_1",
  "daily_sin_2",
  "daily_cos_2",
  "renewal_periodic_kernel",
  "asserted_time_overlap",
  "official_incident_decay",
  "competitor_model_release_decay",
];

function exponentialDecay(hours, halfLife) {
  if (hours < 0) return 0;
  return 2 ** (-hours / halfLife);
}

function circularDistance(left, right, period) {
  const distance = Math.abs(left - right) % period;
  return Math.min(distance, period - distance);
}

function rangeMidpoint(range) {
  return new Date((Date.parse(range.start) + Date.parse(range.end)) / 2);
}

function historicalResetKernel(target, outcomes) {
  const targetHours = target.getTime() / 3_600_000;
  const eventHours = outcomes.map((outcome) =>
    rangeMidpoint(outcome.data.occurred_time_range).getTime() / 3_600_000,
  );
  const intervals = eventHours.slice(1).map((value, index) => value - eventHours[index]);
  const age = eventHours.length === 0 ? null : targetHours - eventHours.at(-1);
  const logBandwidth = 1;
  const renewal = age === null || age < 0 || intervals.length === 0
    ? 0
    : intervals.reduce((sum, interval) => {
      const distance = (Math.log1p(age) - Math.log1p(interval)) / logBandwidth;
      return sum + Math.exp(-0.5 * distance ** 2);
    }, 0) / intervals.length;
  const targetHour = target.getUTCHours() + target.getUTCMinutes() / 60;
  const targetWeekHour = ((target.getUTCDay() + 6) % 7) * 24 + targetHour;
  const daily = eventHours.length === 0 ? 0 : outcomes.reduce((sum, outcome) => {
    const occurred = rangeMidpoint(outcome.data.occurred_time_range);
    const eventHour = occurred.getUTCHours() + occurred.getUTCMinutes() / 60;
    const distance = circularDistance(targetHour, eventHour, 24) / 6;
    return sum + Math.exp(-0.5 * distance ** 2);
  }, 0) / outcomes.length;
  const weekly = eventHours.length === 0 ? 0 : outcomes.reduce((sum, outcome) => {
    const occurred = rangeMidpoint(outcome.data.occurred_time_range);
    const eventHour = ((occurred.getUTCDay() + 6) % 7) * 24 +
      occurred.getUTCHours() + occurred.getUTCMinutes() / 60;
    const distance = circularDistance(targetWeekHour, eventHour, 168) / 36;
    return sum + Math.exp(-0.5 * distance ** 2);
  }, 0) / outcomes.length;
  return {
    renewal,
    daily,
    weekly,
    combined: renewal + daily + 0.5 * weekly,
  };
}

function independentLatest(signals) {
  const latest = new Map();
  const authority = new Map([
    ["official", 5],
    ["product_lead", 4],
    ["product_team_member", 3],
    ["employee", 2],
    ["community", 1],
    ["aggregator", 0],
    ["unknown", 0],
  ]);
  const derivation = new Map([
    ["primary_statement", 3],
    ["independent_observation", 3],
    ["quotes", 1],
    ["repost", 1],
    ["reply", 1],
    ["summarizes", 1],
    ["unknown", 0],
  ]);
  for (const signal of signals) {
    const key = signal.data.provenance.independence_group_id;
    const previous = latest.get(key);
    const rank = [
      authority.get(signal.data.provenance.source_role) ?? 0,
      derivation.get(signal.data.provenance.derivation) ?? 0,
      signal.data.available_at,
    ];
    const previousRank = previous ? [
      authority.get(previous.data.provenance.source_role) ?? 0,
      derivation.get(previous.data.provenance.derivation) ?? 0,
      previous.data.available_at,
    ] : null;
    if (!previousRank || rank[0] > previousRank[0] ||
        (rank[0] === previousRank[0] && rank[1] > previousRank[1]) ||
        (rank[0] === previousRank[0] && rank[1] === previousRank[1] && rank[2] > previousRank[2])) {
      latest.set(key, signal);
    }
  }
  return [...latest.values()];
}

function providerHealth(record, fallback) {
  if (!record) return fallback;
  try {
    return JSON.parse(record.data.content.text).ok === true ? 1 : 0;
  } catch {
    return 0;
  }
}

function exactRefKey(ref) {
  return `${ref.record_id}@${ref.revision}`;
}

function matchesTargetScope(signal, targetScope) {
  return matchesAuthorityTimingTarget(signal, targetScope);
}

function usesExactAuthorityTimingPath(
  signal,
  observationsByExactRef,
  confirmationIdentities,
  targetScope,
  authorityTimingPolicy,
) {
  const observation = observationsByExactRef.get(
    exactRefKey(signal?.data?.observation_refs?.[0] ?? {}),
  );
  return isAuthorityTimingSupportSignal({
    signal,
    observation,
    policy: authorityTimingPolicy,
    confirmationIdentityIds: confirmationIdentities,
    targetScope,
  });
}

function isPrimaryStatement(signal) {
  return signal.data.provenance?.derivation === "primary_statement";
}

export function matchesExpectedExtractor(signal, expectedExtractor) {
  return matchesExtractorContract(signal, expectedExtractor);
}

function signalEventTime(signal, observationsByExactRef, observationsById) {
  for (const ref of signal.data.observation_refs ?? []) {
    const observation = observationsByExactRef.get(exactRefKey(ref)) ??
      observationsById.get(ref.record_id);
    if (observation?.data?.published_at) return new Date(observation.data.published_at);
  }
  const asserted = signal.data.claim.asserted_time_range;
  return asserted ? rangeMidpoint(asserted) : null;
}

export function featureVectorAt({
  config = null,
  targetTime,
  knowledgeCutoff,
  signals,
  outcomes,
  observations,
  coverageIntervals = [],
  coverageAssertionRecords = null,
  confirmationIdentityIds = new Set(),
  expectedExtractor = null,
  targetScope = null,
  authorityTimingPolicy = null,
  evidenceCarryoverPolicy = DEFAULT_POST_OUTCOME_EVIDENCE_POLICY,
  outcomeCoverageProviders = null,
  excludedSourceRecordIds = new Set(),
  excludedIndependenceGroupIds = new Set(),
  asOfMode = AS_OF_MODE.LIVE,
  coverageAsOfMode = COVERAGE_AS_OF_MODE.LIVE,
}) {
  const target = new Date(targetTime);
  const targetEnd = addHours(target, 1);
  const cutoff = toUtcIso(knowledgeCutoff);
  const cutoffMs = Date.parse(cutoff);
  const visibleCoverageIntervals = coverageAssertionRecords === null
    ? coverageIntervals
    : normalizeCoverageIntervals(adequateCoverageAssertionsAsOf(
      coverageAssertionRecords,
      cutoff,
      null,
      coverageAsOfMode,
    ));
  const signalRecords = selectCurrentSignals(
    latestSignalsAsOf(signals, cutoff, asOfMode)
      .filter((signal) => matchesExpectedExtractor(signal, expectedExtractor)),
  );
  const outcomeRecords = latestOutcomesAsOf(outcomes, cutoff, asOfMode);
  const observationRecords = latestObservationsAsOf(observations, cutoff, asOfMode);
  const observationsByExactRef = new Map(
    observationRecords.map((observation) => [exactRefKey(observation), observation]),
  );
  const observationsById = new Map(
    observationRecords.map((observation) => [observation.record_id, observation]),
  );
  const knownSignals = independentLatest(
    signalRecords.filter((signal) =>
      Date.parse(signal.data.available_at) <= cutoffMs &&
      !excludedIndependenceGroupIds.has(signal.data.provenance.independence_group_id) &&
      !(signal.data.observation_refs ?? []).some((ref) =>
        excludedSourceRecordIds.has(ref.record_id),
      ),
    ),
  );
  const outcomeEligibility = buildOutcomeEligibilityContext({
    observations: observationRecords,
    signals: signalRecords,
    config,
  });
  outcomeEligibility.expectedExtractor = expectedExtractor;
  outcomeEligibility.target = targetScope;
  const knownOutcomes = outcomeRecords
    .filter((outcome) =>
      Date.parse(outcomeAvailableAt(outcome, asOfMode)) <= cutoffMs &&
      outcome.data.occurred_time_range &&
      !excludedSourceRecordIds.has(outcome.record_id) &&
      isEligibleConfirmedOutcome(outcome, {
        ...outcomeEligibility,
        confirmationIdentityIds,
      }),
    )
    .sort((a, b) => a.data.occurred_time_range.start.localeCompare(b.data.occurred_time_range.start));
  const activeResetTimingSignals = new Set(
    knownSignals.filter((signal) =>
      matchesTargetScope(signal, targetScope) &&
      isResetTimingSignalActiveAt(signal, {
        outcomes: knownOutcomes,
        targetTime: target,
      })
    ),
  );
  const latestOutcome = knownOutcomes
    .filter((outcome) => rangeMidpoint(outcome.data.occurred_time_range) < target)
    .at(-1);
  const position = hourOfWeek(target);
  const angle = (2 * Math.PI * position) / 168;
  const dailyAngle = (2 * Math.PI * target.getUTCHours()) / 24;
  const resetKernel = historicalResetKernel(target, knownOutcomes);
  const recent = knownSignals.flatMap((signal) => {
    const eventTime = signalEventTime(signal, observationsByExactRef, observationsById);
    if (!eventTime) return [];
    const age = differenceInHours(target, eventTime);
    return age >= 0 && age <= 24 * 14
      ? [{
          signal,
          age,
          weight: postOutcomeEvidenceWeight({
            signal,
            eventTime,
            latestOutcome,
            policy: evidenceCarryoverPolicy,
          }),
        }]
      : [];
  });
  const sourceRecords = observationRecords.filter((observation) =>
    !excludedSourceRecordIds.has(observation.record_id),
  );
  const latestHealthRecord = sourceRecords
    .filter((record) =>
      record.data.content.media_type === "application/vnd.reset-provider-health+json" &&
      (!outcomeCoverageProviders || outcomeCoverageProviders.has(record.data.ingest_provider)),
    )
    .sort((left, right) => left.data.fetched_at.localeCompare(right.data.fetched_at))
    .at(-1);
  const coveringInterval = visibleCoverageIntervals.find((interval) =>
    Date.parse(interval.start) <= cutoffMs && Date.parse(interval.end) >= cutoffMs,
  );
  const latestCoverageEnd = visibleCoverageIntervals
    .map((interval) => Date.parse(interval.end))
    .filter((end) => end <= cutoffMs)
    .sort((left, right) => left - right)
    .at(-1);
  const delayHours = coveringInterval
    ? 0
    : latestCoverageEnd === undefined
      ? 168
      : Math.max(0, (cutoffMs - latestCoverageEnd) / (60 * 60 * 1000));
  const coverage = delayHours <= 2 ? 1 : delayHours <= 6 ? 0.8 : delayHours <= 24 ? 0.4 : 0.1;
  const health = providerHealth(latestHealthRecord, coverage);

  const supports = recent.filter(({ signal }) => signal.data.claim.stance === "supports");
  const features = {
    weekly_sin_1: Math.sin(angle),
    weekly_cos_1: Math.cos(angle),
    weekly_sin_2: Math.sin(2 * angle),
    weekly_cos_2: Math.cos(2 * angle),
    weekly_sin_3: Math.sin(3 * angle),
    weekly_cos_3: Math.cos(3 * angle),
    renewal_periodic_kernel: resetKernel.combined,
    daily_sin_1: Math.sin(dailyAngle),
    daily_cos_1: Math.cos(dailyAngle),
    daily_sin_2: Math.sin(2 * dailyAngle),
    daily_cos_2: Math.cos(2 * dailyAngle),
    official_incident_decay: supports.reduce((sum, { signal, age, weight }) =>
      sum + (confirmationIdentityIds.has(signal.data.provenance.source_identity_id) &&
        signal.data.provenance.source_role !== "aggregator" &&
        isPrimaryStatement(signal) &&
        ["incident", "capacity_restore"].includes(signal.data.claim.event_type)
        ? weight * exponentialDecay(age, 24)
        : 0), 0),
    asserted_time_overlap: knownSignals.reduce((sum, signal) => {
      if (signal.data.claim.stance !== "supports") return sum;
      if (!matchesTargetScope(signal, targetScope)) return sum;
      if (
        usesExactAuthorityTimingPath(
          signal,
          observationsByExactRef,
          confirmationIdentityIds,
          targetScope,
          authorityTimingPolicy,
        )
      ) return sum;
      if (
        isResetTimingSignal(signal) &&
        !activeResetTimingSignals.has(signal)
      ) return sum;
      const range = signal.data.claim.asserted_time_range;
      if (!range || Date.parse(range.start) >= targetEnd.getTime() || Date.parse(range.end) <= target.getTime()) {
        return sum;
      }
      const authority = ["official", "product_lead", "product_team_member"].includes(
        signal.data.provenance.source_role,
      ) && isPrimaryStatement(signal) ? 1 : 0.35;
      const eventTime = signalEventTime(
        signal,
        observationsByExactRef,
        observationsById,
      );
      const weight = eventTime
        ? postOutcomeEvidenceWeight({
            signal,
            eventTime,
            latestOutcome,
            policy: evidenceCarryoverPolicy,
          })
        : 1;
      return sum + authority * weight;
    }, 0),
    competitor_model_release_decay: Math.max(0, ...recent.map(({ signal, age, weight }) =>
      ["competitor_model_release", "competitor_limit_change"].includes(
        signal.data.claim.event_type,
      ) &&
      ["direct", "adjacent"].includes(
        signal.data.claim.competitive_context?.relevance,
      ) &&
      signal.data.claim.competitive_context?.stage !== "rumor" &&
      signal.data.claim.scope.vendor === "other"
        ? weight * exponentialDecay(age, 36)
        : 0)),
  };

  return {
    features,
    dataQuality: {
      provider_coverage: coverage,
      max_delay_seconds: Math.round(Math.min(delayHours, 168) * 3600),
      outcome_sample_count: knownOutcomes.length,
      sample_sufficiency: Math.min(1, knownOutcomes.length / 20),
      out_of_distribution:
        knownOutcomes.length < 20 || delayHours > 6 || health < 0.5,
    },
    sourceRecords: [...new Map([
      ...recent.map(({ signal }) => signal),
      ...knownOutcomes,
      ...(latestHealthRecord ? [latestHealthRecord] : []),
    ].map((record) => [exactRefKey(record), record])).values()],
  };
}

export function featuresToArray(features) {
  return FEATURE_NAMES.map((name) => Number(features[name] ?? 0));
}

export async function buildForecastFeatureSnapshots(store, config, {
  knowledgeCutoff = new Date(),
  horizonStart = null,
  horizonHours = 168,
  createdAt = new Date(),
} = {}) {
  const extractor = extractorContract(config);
  const [
    signals,
    outcomes,
    observations,
    coverageAssertionRecords,
  ] =
    await Promise.all([
    store.all("normalized_signal", { latestOnly: false }),
    store.all("reset_outcome", { latestOnly: false }),
    store.all("raw_observation", { latestOnly: false }),
    coverageAssertionRevisions(
      store,
      config.model.outcome_coverage_providers,
      { config },
    ),
  ]);
  const confirmationIds = confirmationIdentityIds(config);
  const cutoff = new Date(knowledgeCutoff);
  if (Number.isNaN(cutoff.getTime())) throw new TypeError("Invalid forecast knowledge cutoff");
  const firstTarget = horizonStart === null ? ceilHour(cutoff) : new Date(horizonStart);
  if (Number.isNaN(firstTarget.getTime())) throw new TypeError("Invalid forecast horizon start");
  if (firstTarget.getTime() < cutoff.getTime() || ceilHour(firstTarget).getTime() !== firstTarget.getTime()) {
    throw new RangeError("Forecast horizon start must be an hourly boundary at or after knowledge cutoff");
  }
  const selectedCoverageAssertions = adequateCoverageAssertionsAsOf(
    coverageAssertionRecords,
    cutoff,
    config.model.outcome_coverage_providers,
  );
  const coverageIntervals = normalizeCoverageIntervals(selectedCoverageAssertions);
  const candidates = [];
  for (let index = 0; index < horizonHours; index += 1) {
    const targetStart = addHours(firstTarget, index);
    const targetEnd = addHours(targetStart, 1);
    const vector = featureVectorAt({
      config,
      targetTime: targetStart,
      knowledgeCutoff: cutoff,
      signals,
      outcomes,
      observations,
      coverageIntervals,
      coverageAssertionRecords,
      confirmationIdentityIds: confirmationIds,
      expectedExtractor: extractor,
      targetScope: config.target,
      authorityTimingPolicy: config.model.authority_timing,
      evidenceCarryoverPolicy: config.model.evidence_carryover,
      outcomeCoverageProviders: new Set(config.model.outcome_coverage_providers),
    });
    const candidate = createRecord({
      recordType: "feature_snapshot",
      // A writer revision changes the stored payload, not the model input contract.
      naturalKey: `${config.config_hash}:${config.feature_schema_version}:${toUtcIso(cutoff)}:${toUtcIso(targetStart)}:${FEATURE_SNAPSHOT_PRODUCER_VERSION}`,
      createdAt,
      producer: producer("as-of-feature-builder", FEATURE_SNAPSHOT_PRODUCER_VERSION, {
        config_hash: config.config_hash,
        feature_schema_version: config.feature_schema_version,
        taxonomy_version: config.taxonomy_version,
        deduplication_version: config.deduplication_version,
        timezone_database_version: config.timezone_database_version,
        extractor_model: extractor.model,
        extractor_model_version: extractor.model_version,
        extractor_prompt_version: extractor.prompt_version,
        extractor_semantic_policy_hash: extractor.semantic_policy_hash,
      }),
      data: {
        knowledge_cutoff: toUtcIso(cutoff),
        config_hash: config.config_hash,
        feature_schema_version: config.feature_schema_version,
        taxonomy_version: config.taxonomy_version,
        deduplication_version: config.deduplication_version,
        timezone_database_version: config.timezone_database_version,
        extractor_model: extractor.model,
        extractor_model_version: extractor.model_version,
        extractor_prompt_version: extractor.prompt_version,
        extractor_semantic_policy_hash: extractor.semantic_policy_hash,
        target: {
          start: toUtcIso(targetStart),
          end: toUtcIso(targetEnd),
          base_slot: "PT1H",
          display_horizon: "PT4H",
        },
        features: vector.features,
        data_quality: vector.dataQuality,
        source_record_refs: vector.sourceRecords.map(recordRef),
        coverage_assertion_refs: selectedCoverageAssertions.map((assertion) => ({
          assertion_id: assertion.assertion_id,
          revision: assertion.revision,
        })),
      },
    });
    candidates.push(candidate);
  }
  const results = await store.appendOrReuseMany(candidates);
  return {
    snapshots: results.map((result) => result.record),
    inserted: results.filter((result) => result.inserted).length,
  };
}

export function dataQualityScore(snapshot) {
  const quality = snapshot.data.data_quality;
  return clamp(
    quality.provider_coverage * quality.sample_sufficiency,
    0,
    1,
  );
}
