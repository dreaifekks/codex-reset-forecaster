import { hashLabel } from "../core/hash.mjs";
import {
  OUTCOME_ADJUDICATOR_VERSION,
  OUTCOME_LABEL_POLICY_VERSION,
} from "../core/outcome-contract.mjs";
import { confirmedOutcomeHistoryRow, loadOutcomePublicationProjection } from "../query/history-results.mjs";
import {
  createPublicationLedger,
  publicationDeliveryKey,
  PUBLICATION_EVENT_SCHEMA_VERSION,
} from "./ledger.mjs";
import {
  authorityNotification,
  forecastReport,
  outcomeNotification,
  probabilityNotification,
} from "./report.mjs";

const STATE_KEY = "publication-projection";
const STATE_SCHEMA_VERSION = "publication-projection-state/1";
const STAGE_RANK = new Map([["blocked", 0], ["provisional", 1], ["validated", 2]]);

function refKey(reference) {
  return reference ? `${reference.record_id}@${reference.revision}` : null;
}

function eventId(eventType, identity) {
  return `pub_${hashLabel({ event_type: eventType, identity }).slice("sha256:".length)}`;
}

function iso(clockValue) {
  const date = clockValue instanceof Date ? new Date(clockValue) : new Date(clockValue);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid publication time");
  return date.toISOString();
}

function addMilliseconds(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function earliestTimestamp(...values) {
  return new Date(Math.min(...values.map((value) => Date.parse(value))))
    .toISOString();
}

function outcomeStatus(item) {
  if (item.verification) return "eligible_confirmed";
  if (["rejected", "cancelled"].includes(item.outcome.data.status)) {
    return item.outcome.data.status;
  }
  if (item.outcome.data.status === "confirmed") {
    const outcome = item.outcome;
    if (
      outcome.data.label_policy_version !== OUTCOME_LABEL_POLICY_VERSION ||
      outcome.producer?.name !== "outcome-adjudicator" ||
      outcome.producer?.version !== OUTCOME_ADJUDICATOR_VERSION
    ) return "contract_pending";
    return "verification_withdrawn";
  }
  return String(item.outcome.data.status ?? "unknown");
}

function outcomeRow(item) {
  return confirmedOutcomeHistoryRow(
    item.outcome,
    item.source,
    item.verification,
  );
}

function outcomeDeliveryFingerprint(row) {
  const source = row?.source;
  const range = row?.occurred_time_range;
  return hashLabel({
    occurred_time_range: range ? {
      start: range.start ?? null,
      end: range.end ?? null,
      precision: range.precision ?? null,
    } : null,
    label_grade: row?.label_grade ?? null,
    source: source ? {
      canonical_url: source.canonical_url ?? null,
      display_handle: source.display_handle ?? null,
      text: source.text ?? null,
      published_at: source.published_at ?? null,
    } : null,
  });
}

function materialOutcomeTransition(previous, currentStatus, currentRow) {
  return previous === null ||
    previous.status !== currentStatus ||
    outcomeDeliveryFingerprint(previous.row) !==
      outcomeDeliveryFingerprint(currentRow);
}

// Projection state tracks both the latest observed canonical revision and the
// last material state used as the delivery baseline. A stale, failed, or
// temporarily unverifiable intermediate state must not become the comparison
// point for a later notification when no event about that state was delivered.
function outcomeDeliveryBaseline(previous) {
  if (!previous) return null;
  return {
    status: previous.delivery_status ?? previous.status,
    row: previous.delivery_row ?? previous.row,
  };
}

function usableForecastSnapshot(snapshot, emittedAt) {
  const prediction = snapshot?.prediction;
  const readiness = snapshot?.readiness;
  const exactRef = refKey(snapshot?.prediction_ref);
  if (
    !prediction ||
    exactRef !== refKey(prediction) ||
    snapshot.prediction_hash !== hashLabel(prediction) ||
    readiness?.serving_ready !== true ||
    readiness?.synthetic_only === true ||
    readiness?.current_forecast?.status !== "fresh" ||
    Date.parse(prediction.data.knowledge_cutoff) > Date.parse(prediction.data.issued_at) ||
    Date.parse(prediction.data.issued_at) > Date.parse(emittedAt) ||
    Date.parse(prediction.data.horizon?.end) <= Date.parse(emittedAt)
  ) return null;
  return { prediction, readiness };
}

function authorityKey(report) {
  const authority = report?.authority_conditioning;
  if (
    authority?.applied !== true ||
    !authority.signal_ref ||
    !authority.asserted_time_range ||
    !Number.isFinite(Date.parse(authority.asserted_time_range.end))
  ) return null;
  return refKey(authority.signal_ref);
}

function initialState({
  emittedAt,
  policyHash,
  outcomeItems,
  report,
  probability,
  openThreshold,
}) {
  const authority = authorityKey(report);
  return {
    schema_version: STATE_SCHEMA_VERSION,
    initialized_at: emittedAt,
    updated_at: emittedAt,
    policy_hash: policyHash,
    outcomes: Object.fromEntries(outcomeItems.map((item) => [
      item.outcome.record_id,
      (() => {
        const status = outcomeStatus(item);
        const row = outcomeRow(item);
        return {
          revision: item.outcome.revision,
          status,
          row,
          delivery_status: status,
          delivery_row: row,
          published_event_id: null,
        };
      })(),
    ])),
    seen_authority_signal_refs: authority ? [authority] : [],
    active_authority_signal_ref: authority,
    probability_watch: probability === null ? null : {
      active: probability >= openThreshold,
      episode_id: null,
      opened_event_id: null,
      opened_at: null,
      report,
      last_probability: probability,
    },
    last_prediction_ref: report ? refKey(report.prediction_ref) : null,
  };
}

function publicationEvent({
  eventType,
  entityKey,
  topic,
  emittedAt,
  expiresAt = null,
  policy,
  source,
  report,
  notification,
  supersedesEventId = null,
  experimental = false,
}) {
  const id = eventId(eventType, {
    entity_key: entityKey,
    source,
    policy_hash: policy.hash,
    supersedes_event_id: supersedesEventId,
  });
  const event = {
    schema_version: PUBLICATION_EVENT_SCHEMA_VERSION,
    event_id: id,
    event_type: eventType,
    entity_key: entityKey,
    topic,
    emitted_at: emittedAt,
    expires_at: expiresAt,
    experimental,
    supersedes_event_id: supersedesEventId,
    policy: {
      version: policy.version,
      hash: policy.hash,
    },
    source,
    report: {
      ...report,
      default_delivery: !experimental,
    },
    title: notification.title,
    summary: notification.body,
    url: notification.url,
    notification,
  };
  return {
    ...event,
    delivery_key: publicationDeliveryKey(event),
  };
}

export function createPublicationProjector({
  store,
  config,
  publicBaseUrl = config.runtime.public_base_url,
  ledger = createPublicationLedger(store),
  loadOutcomes = () => loadOutcomePublicationProjection(store, config),
} = {}) {
  const policy = config.runtime.publication;
  const policyDescriptor = {
    version: policy.policy_version,
    hash: hashLabel(policy),
  };
  let projectionTail = Promise.resolve();

  async function runProject({
    snapshot = null,
    emittedAt = new Date(),
    allowInitialize = true,
  } = {}) {
    const emitted = iso(emittedAt);
    if (!policy.enabled) return { initialized: false, events: [], cursor: await ledger.getCursor() };
    const outcomeItems = await loadOutcomes();
    const usable = usableForecastSnapshot(snapshot, emitted);
    const report = usable
      ? forecastReport(usable.prediction, usable.readiness, publicBaseUrl)
      : null;
    const probability = report?.probabilities?.next_4h ?? null;
    const latestOutcomeKnownAt = outcomeItems.reduce((latest, item) => {
      const candidate = item.outcome?.data?.known_at ?? null;
      if (!Number.isFinite(Date.parse(candidate))) return latest;
      return latest === null || Date.parse(candidate) > Date.parse(latest)
        ? candidate
        : latest;
    }, null);
    let state = await store.readState(STATE_KEY, null);
    if (!state) {
      if (!allowInitialize || (outcomeItems.length === 0 && report === null)) {
        return {
          initialized: false,
          deferred: true,
          events: [],
          cursor: await ledger.getCursor(),
        };
      }
      state = initialState({
        emittedAt: emitted,
        policyHash: policyDescriptor.hash,
        outcomeItems,
        report,
        probability,
        openThreshold: policy.probability_alert.open_threshold,
      });
      await store.writeState(STATE_KEY, state);
      return { initialized: true, events: [], cursor: await ledger.getCursor() };
    }
    if (
      state.schema_version !== STATE_SCHEMA_VERSION ||
      typeof state.outcomes !== "object" ||
      !Array.isArray(state.seen_authority_signal_refs)
    ) {
      throw new Error("Stored publication projection state is invalid");
    }

    const pending = [];
    let liveConfirmation = false;
    let watchCycleConfirmation = false;
    for (const item of outcomeItems) {
      const outcome = item.outcome;
      const currentStatus = outcomeStatus(item);
      const currentRow = outcomeRow(item);
      const previous = state.outcomes[outcome.record_id] ?? null;
      const deliveryBaseline = outcomeDeliveryBaseline(previous);
      if (
        previous?.revision === outcome.revision &&
        previous?.status === currentStatus
      ) continue;
      if (!materialOutcomeTransition(
        deliveryBaseline,
        currentStatus,
        currentRow,
      )) {
        state.outcomes[outcome.record_id] = {
          revision: outcome.revision,
          status: currentStatus,
          row: currentRow,
          delivery_status: currentStatus,
          delivery_row: currentRow,
          published_event_id: previous.published_event_id,
        };
        continue;
      }
      if (
        previous?.status === "contract_pending" &&
        currentStatus === "eligible_confirmed" &&
        !previous.published_event_id
      ) {
        state.outcomes[outcome.record_id] = {
          revision: outcome.revision,
          status: currentStatus,
          row: currentRow,
          delivery_status: currentStatus,
          delivery_row: currentRow,
          published_event_id: null,
        };
        continue;
      }
      const knownAtMs = Date.parse(outcome.data.known_at);
      const initializedMs = Date.parse(state.initialized_at);
      const isLive = Number.isFinite(knownAtMs) &&
        knownAtMs >= initializedMs &&
        knownAtMs <= Date.parse(emitted);
      const knownExpiresAt = Number.isFinite(knownAtMs)
        ? addMilliseconds(
            outcome.data.known_at,
            policy.outcome_max_delivery_delay_hours * 3_600_000,
          )
        : null;
      const occurredEnd = currentRow?.occurred_time_range?.end ?? null;
      const expiresAt = knownExpiresAt && Number.isFinite(Date.parse(occurredEnd))
        ? earliestTimestamp(
            knownExpiresAt,
            addMilliseconds(
              occurredEnd,
              policy.outcome_max_delivery_delay_hours * 3_600_000,
            ),
          )
        : knownExpiresAt;
      const isDeliverable = isLive && Date.parse(expiresAt) > Date.parse(emitted);
      let kind = null;
      if (currentStatus === "eligible_confirmed") {
        liveConfirmation ||= isLive;
        if (isLive) {
          const openedAt = state.probability_watch?.opened_at ?? null;
          const occurredEnd = outcome.data.occurred_time_range?.end ?? null;
          watchCycleConfirmation ||= state.probability_watch?.active === true && (
            openedAt === null ||
            (Number.isFinite(Date.parse(occurredEnd)) &&
              Date.parse(occurredEnd) > Date.parse(openedAt))
          );
        }
        if (isDeliverable) {
          kind = previous?.published_event_id ? "corrected" : "confirmed";
        }
      } else if (previous?.published_event_id && isDeliverable) {
        kind = ["rejected", "cancelled"].includes(currentStatus)
          ? "retracted"
          : currentStatus === "verification_withdrawn"
            ? "verification_withdrawn"
            : null;
      }
      let publishedEventId = previous?.published_event_id ?? null;
      if (kind) {
        const eventType = kind === "verification_withdrawn"
          ? "outcome.verification_withdrawn.v1"
          : `outcome.reset_${kind}.v1`;
        const row = kind === "retracted" && deliveryBaseline?.row
          ? deliveryBaseline.row
          : currentRow;
        const notification = outcomeNotification(row, publicBaseUrl, kind);
        const candidate = publicationEvent({
          eventType,
          entityKey: `reset_outcome:${outcome.record_id}`,
          topic: "outcome",
          emittedAt: emitted,
          expiresAt,
          policy: policyDescriptor,
          source: {
            outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
            verification_ref: item.verification?.observation_ref ?? null,
          },
          report: { outcome: row, correction_kind: kind },
          notification,
          supersedesEventId: previous?.published_event_id ?? null,
        });
        const appended = await ledger.append(candidate);
        if (appended.inserted) pending.push(appended.event);
        publishedEventId = appended.event.event_id;
      }
      state.outcomes[outcome.record_id] = {
        revision: outcome.revision,
        status: currentStatus,
        row: currentRow,
        delivery_status: kind
          ? currentStatus
          : deliveryBaseline?.status ?? currentStatus,
        delivery_row: kind
          ? currentRow
          : deliveryBaseline?.row ?? currentRow,
        published_event_id: publishedEventId,
      };
    }

    const activeWatch = state.probability_watch?.active === true;
    const shouldCloseWatch = activeWatch && (
      watchCycleConfirmation ||
      (usable && probability <= policy.probability_alert.close_threshold)
    );
    if (shouldCloseWatch) {
      if (state.probability_watch.opened_event_id) {
        const closeReport = report ?? state.probability_watch.report;
        const notification = probabilityNotification(closeReport, { opened: false });
        const candidate = publicationEvent({
          eventType: "forecast.reset_watch.closed.v1",
          entityKey: `forecast_watch:${state.probability_watch.episode_id}`,
          topic: "experimental_probability",
          emittedAt: emitted,
          expiresAt: addMilliseconds(
            emitted,
            policy.probability_alert.max_delivery_delay_minutes * 60_000,
          ),
          policy: policyDescriptor,
          source: { prediction_ref: closeReport.prediction_ref },
          report: { forecast: closeReport, reason: watchCycleConfirmation ? "same_cycle_outcome_confirmed" : "probability_below_close_threshold" },
          notification,
          supersedesEventId: state.probability_watch.opened_event_id,
          experimental: true,
        });
        const appended = await ledger.append(candidate);
        if (appended.inserted) pending.push(appended.event);
      }
      state.probability_watch = {
        active: false,
        episode_id: null,
        opened_event_id: null,
        opened_at: null,
        report,
        last_probability: probability,
      };
    }

    const authority = authorityKey(report);
    const forecastIncludesLatestOutcomes = latestOutcomeKnownAt === null ||
      Date.parse(report?.knowledge_cutoff) >=
        Date.parse(latestOutcomeKnownAt);
    if (
      usable &&
      forecastIncludesLatestOutcomes &&
      authority &&
      Date.parse(report.authority_conditioning.asserted_time_range.end) > Date.parse(emitted) &&
      !state.seen_authority_signal_refs.includes(authority)
    ) {
      const notification = authorityNotification(report);
      const candidate = publicationEvent({
        eventType: "forecast.authority_window.opened.v1",
        entityKey: `authority_signal:${authority}`,
        topic: "authority",
        emittedAt: emitted,
        expiresAt: earliestTimestamp(
          report.authority_conditioning.asserted_time_range.end,
          addMilliseconds(
            emitted,
            policy.authority_max_delivery_delay_hours * 3_600_000,
          ),
        ),
        policy: policyDescriptor,
        source: {
          prediction_ref: report.prediction_ref,
          signal_ref: report.authority_conditioning.signal_ref,
        },
        report: { forecast: report },
        notification,
      });
      const appended = await ledger.append(candidate);
      if (appended.inserted) pending.push(appended.event);
      state.seen_authority_signal_refs.push(authority);
      state.seen_authority_signal_refs = state.seen_authority_signal_refs.slice(-256);
    }
    state.active_authority_signal_ref = authority;

    const minimumRank = STAGE_RANK.get(policy.probability_alert.minimum_stage);
    const stageRank = STAGE_RANK.get(report?.serving_stage) ?? 0;
    const forecastDelayMs = usable
      ? Date.parse(emitted) - Date.parse(report.issued_at)
      : Infinity;
    const mayOpenWatch = policy.probability_alert.enabled &&
      usable &&
      forecastIncludesLatestOutcomes &&
      !liveConfirmation &&
      state.probability_watch?.active !== true &&
      stageRank >= minimumRank &&
      probability >= policy.probability_alert.open_threshold &&
      forecastDelayMs >= 0 &&
      forecastDelayMs <= policy.probability_alert.max_delivery_delay_minutes * 60_000;
    if (mayOpenWatch) {
      const episodeId = `watch_${hashLabel({
        policy_hash: policyDescriptor.hash,
        prediction_ref: report.prediction_ref,
      }).slice("sha256:".length)}`;
      const notification = probabilityNotification(report, { opened: true });
      const candidate = publicationEvent({
        eventType: "forecast.reset_watch.opened.v1",
        entityKey: `forecast_watch:${episodeId}`,
        topic: "experimental_probability",
        emittedAt: emitted,
        expiresAt: addMilliseconds(
          emitted,
          policy.probability_alert.max_delivery_delay_minutes * 60_000,
        ),
        policy: policyDescriptor,
        source: { prediction_ref: report.prediction_ref },
        report: { forecast: report },
        notification,
        experimental: true,
      });
      const appended = await ledger.append(candidate);
      const opened = appended.event;
      if (appended.inserted) pending.push(opened);
      state.probability_watch = {
        active: true,
        episode_id: episodeId,
        opened_event_id: opened.event_id,
        opened_at: emitted,
        report,
        last_probability: probability,
      };
    } else if (usable && state.probability_watch) {
      state.probability_watch.report = report;
      state.probability_watch.last_probability = probability;
    }

    state.policy_hash = policyDescriptor.hash;
    state.updated_at = emitted;
    state.last_prediction_ref = report ? refKey(report.prediction_ref) : state.last_prediction_ref;
    await store.writeState(STATE_KEY, state);
    return {
      initialized: false,
      events: pending,
      cursor: await ledger.getCursor(),
    };
  }

  function project(options) {
    const operation = projectionTail.then(() => runProject(options));
    projectionTail = operation.catch(() => {});
    return operation;
  }

  return { project, ledger };
}

export {
  STATE_KEY as PUBLICATION_STATE_KEY,
  STATE_SCHEMA_VERSION as PUBLICATION_STATE_SCHEMA_VERSION,
  usableForecastSnapshot,
};
