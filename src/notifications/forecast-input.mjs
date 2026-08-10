import { hashLabel } from "../core/hash.mjs";
import { loadOutcomePublicationProjection } from "../query/history-results.mjs";
import { usableForecastSnapshot } from "./projector.mjs";

const STATE_KEY = "notification-forecast-inputs";
const STATE_SCHEMA_VERSION = "notification-forecast-input-stream/2";
const LEGACY_STATE_SCHEMA_VERSION = "notification-forecast-input-stream/1";
const INPUT_SCHEMA_VERSION = "notification-forecast-input/2";
const STREAMS_BY_STORE = new WeakMap();

function iso(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be an RFC 3339 timestamp`);
  }
  return date.toISOString();
}

function referenceKey(reference) {
  if (
    !reference ||
    typeof reference.record_id !== "string" ||
    reference.record_id.length === 0 ||
    !Number.isInteger(reference.revision) ||
    reference.revision < 1
  ) return null;
  return `${reference.record_id}@${reference.revision}`;
}

function boundedProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function outcomeGateStatus(item) {
  if (item?.verification) return "eligible_confirmed";
  const status = item?.outcome?.data?.status;
  if (["rejected", "cancelled"].includes(status)) return status;
  if (status === "confirmed") return "verification_withdrawn";
  return String(status ?? "unknown");
}

function normalizeOutcomeGateEntry(value) {
  const ref = referenceKey(value?.outcome_ref);
  const range = value?.occurred_time_range ?? null;
  if (
    !ref ||
    typeof value.outcome_token !== "string" ||
    value.outcome_token.length === 0 ||
    typeof value.status !== "string" ||
    value.status.length === 0 ||
    iso(value.known_at, "outcome gate known_at") !== value.known_at ||
    !(
      range === null ||
      (
        typeof range === "object" &&
        !Array.isArray(range) &&
        iso(range.start, "outcome gate range start") === range.start &&
        iso(range.end, "outcome gate range end") === range.end &&
        Date.parse(range.end) > Date.parse(range.start)
      )
    )
  ) {
    throw new TypeError("Invalid notification outcome gate entry");
  }
  return {
    outcome_ref: {
      record_id: value.outcome_ref.record_id,
      revision: value.outcome_ref.revision,
    },
    outcome_token: value.outcome_token,
    status: value.status,
    known_at: value.known_at,
    occurred_time_range: range === null ? null : {
      start: range.start,
      end: range.end,
    },
  };
}

function normalizeOutcomeRevisionGate(value) {
  const revisionToken = value?.revision_token ?? null;
  const latestKnownAt = value?.latest_known_at ?? null;
  const currentOutcomes = value?.current_outcomes ?? [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !(
      (revisionToken === null && latestKnownAt === null) ||
      (
        typeof revisionToken === "string" &&
        revisionToken.length > 0 &&
        iso(latestKnownAt, "outcome revision latest_known_at") === latestKnownAt
      )
    ) ||
    typeof value.closes_episode !== "boolean" ||
    !Array.isArray(currentOutcomes)
  ) {
    throw new TypeError("Invalid notification outcome revision gate");
  }
  const normalizedOutcomes = currentOutcomes.map(normalizeOutcomeGateEntry)
    .sort((left, right) =>
      left.outcome_ref.record_id.localeCompare(right.outcome_ref.record_id) ||
      left.outcome_ref.revision - right.outcome_ref.revision ||
      left.outcome_token.localeCompare(right.outcome_token)
    );
  return {
    revision_token: revisionToken,
    latest_known_at: latestKnownAt,
    closes_episode: value.closes_episode,
    current_outcomes: normalizedOutcomes,
  };
}

export function notificationOutcomeRevisionGate(items = []) {
  if (!Array.isArray(items)) {
    throw new TypeError("Outcome revision gate requires an outcome projection array");
  }
  const revisions = items.map((item) => {
    const outcome = item?.outcome;
    const key = referenceKey(outcome);
    const knownAt = outcome?.data?.known_at;
    if (!key || iso(knownAt, "outcome known_at") !== knownAt) {
      throw new TypeError("Outcome revision gate received an invalid outcome");
    }
    const range = outcome.data.occurred_time_range ?? null;
    const status = outcomeGateStatus(item);
    const verificationRef = item?.verification?.observation_ref ?? null;
    const outcomeToken = hashLabel({
      outcome_ref: { record_id: outcome.record_id, revision: outcome.revision },
      outcome_hash: hashLabel(outcome),
      status,
      verification_ref: verificationRef,
    });
    return {
      outcome_ref: {
        record_id: outcome.record_id,
        revision: outcome.revision,
      },
      outcome_token: outcomeToken,
      status,
      known_at: knownAt,
      occurred_time_range: range === null ? null : {
        start: iso(range.start, "outcome occurred range start"),
        end: iso(range.end, "outcome occurred range end"),
      },
    };
  }).sort((left, right) =>
    left.outcome_ref.record_id.localeCompare(right.outcome_ref.record_id) ||
    left.outcome_ref.revision - right.outcome_ref.revision
  );
  if (revisions.length === 0) {
    return {
      revision_token: null,
      latest_known_at: null,
      closes_episode: false,
      current_outcomes: [],
    };
  }
  const latestKnownAt = revisions.reduce((latest, item) =>
    Date.parse(item.known_at) > Date.parse(latest) ? item.known_at : latest,
  revisions[0].known_at);
  return {
    revision_token: `outcome_gate_${hashLabel(revisions).slice("sha256:".length)}`,
    latest_known_at: latestKnownAt,
    // The shared transition still applies subscriber-relative timing before a
    // changed eligible outcome is allowed to close an episode.
    closes_episode: revisions.some((item) => item.status === "eligible_confirmed"),
    current_outcomes: revisions,
  };
}

export function forecastHorizonProbabilities(prediction) {
  const slots = prediction?.data?.slots;
  if (!Array.isArray(slots) || slots.length !== 168) {
    throw new TypeError("Forecast input requires exactly 168 hourly slots");
  }
  let survival = 1;
  return slots.map((slot, index) => {
    const hazard = boundedProbability(slot?.hazard);
    if (hazard === null) {
      throw new TypeError(`Forecast slot ${index + 1} has an invalid hazard`);
    }
    survival *= 1 - hazard;
    const derived = 1 - survival;
    const recorded = boundedProbability(slot?.reset_by_end_probability);
    if (recorded !== null && Math.abs(recorded - derived) > 1e-9) {
      throw new TypeError(
        `Forecast slot ${index + 1} cumulative probability is inconsistent`,
      );
    }
    return recorded ?? derived;
  });
}

function assertInput(value, { allowMissingSequence = false } = {}) {
  const ref = referenceKey(value?.prediction_ref);
  const probabilities = value?.probabilities;
  normalizeOutcomeRevisionGate(value?.outcome_revision_gate);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema_version !== INPUT_SCHEMA_VERSION ||
    !/^forecast_input_[a-f0-9]{64}$/.test(value.input_id ?? "") ||
    !ref ||
    typeof value.prediction_hash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.prediction_hash) ||
    iso(value.issued_at, "forecast input issued_at") !== value.issued_at ||
    iso(value.emitted_at, "forecast input emitted_at") !== value.emitted_at ||
    iso(value.knowledge_cutoff, "forecast input knowledge_cutoff") !==
      value.knowledge_cutoff ||
    iso(value.expires_at, "forecast input expires_at") !== value.expires_at ||
    Date.parse(value.knowledge_cutoff) > Date.parse(value.issued_at) ||
    Date.parse(value.issued_at) > Date.parse(value.emitted_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.emitted_at) ||
    !["provisional", "validated"].includes(value.serving_stage) ||
    !Array.isArray(probabilities) ||
    probabilities.length !== 168 ||
    probabilities.some((probability, index) =>
      boundedProbability(probability) === null ||
      (index > 0 && probability + 1e-12 < probabilities[index - 1])
    ) ||
    (
      !allowMissingSequence &&
      (!Number.isSafeInteger(value.sequence) || value.sequence < 1)
    )
  ) {
    throw new TypeError("Invalid notification forecast input");
  }
  return value;
}

function emptyState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    next_sequence: 1,
    last_input_id: null,
    inputs: [],
    outcome_revision_gate: {
      revision_token: null,
      latest_known_at: null,
      closes_episode: false,
      current_outcomes: [],
    },
  };
}

function normalizedState(value) {
  if (value === null || value === undefined) return emptyState();
  if (value?.schema_version === LEGACY_STATE_SCHEMA_VERSION) {
    // The first stream contract did not retain the projection clock. It is
    // rebuildable delivery state, so reset it instead of fabricating emitted_at
    // from the model's issued_at timestamp.
    return emptyState();
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema_version !== STATE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.next_sequence) ||
    value.next_sequence < 1 ||
    !Array.isArray(value.inputs) ||
    ![null, "string"].includes(
      value.last_input_id === null ? null : typeof value.last_input_id,
    )
  ) {
    throw new TypeError("Stored notification forecast input stream is invalid");
  }
  value.outcome_revision_gate = normalizeOutcomeRevisionGate(
    value.outcome_revision_gate ?? emptyState().outcome_revision_gate,
  );
  let previous = null;
  for (const input of value.inputs) {
    assertInput(input);
    if (previous !== null && input.sequence !== previous + 1) {
      throw new TypeError("Stored notification forecast inputs are not contiguous");
    }
    previous = input.sequence;
  }
  const tail = value.inputs.at(-1)?.sequence ?? 0;
  if (tail !== value.next_sequence - 1) {
    throw new TypeError("Stored notification forecast input tail is inconsistent");
  }
  if (
    value.last_input_id !== null &&
    value.inputs.at(-1)?.input_id !== value.last_input_id
  ) {
    throw new TypeError("Stored notification forecast input identity is inconsistent");
  }
  return structuredClone(value);
}

function resetError(reason, cursor) {
  const error = new RangeError("Notification forecast input cursor reset required");
  error.code = "forecast_input_cursor_reset_required";
  error.reason = reason;
  error.cursor = cursor;
  return error;
}

export function createForecastInputStream(store, {
  retainedInputs = 512,
  clock = () => new Date(),
} = {}) {
  if (
    typeof store?.readState !== "function" ||
    typeof store?.writeState !== "function"
  ) {
    throw new TypeError("Forecast input stream requires readState/writeState");
  }
  if (!Number.isSafeInteger(retainedInputs) || retainedInputs < 32) {
    throw new TypeError("retainedInputs must be an integer of at least 32");
  }
  const existing = STREAMS_BY_STORE.get(store);
  if (existing) return existing;
  let operationTail = Promise.resolve();
  let outcomeRevisionGateLoader = async () => ({
    revision_token: null,
    latest_known_at: null,
    closes_episode: false,
    current_outcomes: [],
  });

  function enqueue(operation) {
    const result = operationTail.then(operation);
    operationTail = result.catch(() => {});
    return result;
  }

  async function read() {
    return normalizedState(await store.readState(STATE_KEY, null));
  }

  function getCursor() {
    return enqueue(async () => (await read()).next_sequence - 1);
  }

  function bindOutcomeRevisionGateLoader(loader) {
    if (typeof loader !== "function") {
      throw new TypeError("Outcome revision gate loader must be a function");
    }
    outcomeRevisionGateLoader = loader;
  }

  async function resolveCurrentOutcomeRevisionGate(state) {
    const loaded = normalizeOutcomeRevisionGate(await outcomeRevisionGateLoader());
    const previous = normalizeOutcomeRevisionGate(state.outcome_revision_gate);
    if (loaded.revision_token === previous.revision_token) return previous;
    const observedAt = iso(clock(), "outcome gate observation time");
    const effective = loaded.revision_token === null ? loaded : {
      ...loaded,
      latest_known_at:
        Date.parse(loaded.latest_known_at) > Date.parse(observedAt)
          ? loaded.latest_known_at
          : observedAt,
    };
    state.outcome_revision_gate = effective;
    await store.writeState(STATE_KEY, normalizedState(state));
    return effective;
  }

  function currentOutcomeRevisionGate() {
    return enqueue(async () => {
      const state = await read();
      return structuredClone(await resolveCurrentOutcomeRevisionGate(state));
    });
  }

  function latest() {
    return enqueue(async () => structuredClone((await read()).inputs.at(-1) ?? null));
  }

  function tail() {
    return enqueue(async () => {
      const state = await read();
      const outcomeRevisionGate = await resolveCurrentOutcomeRevisionGate(state);
      return {
        cursor: state.next_sequence - 1,
        input: structuredClone(state.inputs.at(-1) ?? null),
        outcome_revision_gate: outcomeRevisionGate,
      };
    });
  }

  function all() {
    return enqueue(async () => structuredClone((await read()).inputs));
  }

  function listAfter(cursor = 0, { limit = 100 } = {}) {
    const numericCursor = Number(cursor);
    if (!Number.isSafeInteger(numericCursor) || numericCursor < 0) {
      throw new TypeError("Forecast input cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("Forecast input page limit must be from 1 through 500");
    }
    return enqueue(async () => {
      const state = await read();
      const outcomeRevisionGate = await resolveCurrentOutcomeRevisionGate(state);
      const tail = state.next_sequence - 1;
      const floor = state.inputs[0]?.sequence ?? state.next_sequence;
      if (numericCursor > tail) throw resetError("ahead_of_tail", tail);
      if (numericCursor < floor - 1) throw resetError("retention_gap", floor - 1);
      const remaining = state.inputs.filter((input) => input.sequence > numericCursor);
      const inputs = remaining.slice(0, limit);
      const nextCursor = inputs.at(-1)?.sequence ?? numericCursor;
      return {
        inputs: structuredClone(inputs),
        cursor: nextCursor,
        next_cursor: String(nextCursor),
        has_more: remaining.length > inputs.length,
        outcome_revision_gate: outcomeRevisionGate,
      };
    });
  }

  function append(candidate) {
    assertInput(candidate, { allowMissingSequence: true });
    return enqueue(async () => {
      const state = await read();
      if (state.last_input_id === candidate.input_id) {
        return {
          inserted: false,
          input: structuredClone(state.inputs.at(-1)),
        };
      }
      const input = assertInput({
        ...structuredClone(candidate),
        sequence: state.next_sequence,
      });
      state.next_sequence += 1;
      state.last_input_id = input.input_id;
      state.inputs.push(input);
      if (state.inputs.length > retainedInputs) {
        state.inputs.splice(0, state.inputs.length - retainedInputs);
      }
      await store.writeState(STATE_KEY, normalizedState(state));
      return { inserted: true, input: structuredClone(input) };
    });
  }

  const stream = {
    all,
    getCursor,
    latest,
    tail,
    listAfter,
    append,
    bindOutcomeRevisionGateLoader,
    currentOutcomeRevisionGate,
  };
  STREAMS_BY_STORE.set(store, stream);
  return stream;
}

export function createForecastInputProjector({
  store,
  config,
  stream = createForecastInputStream(store),
  loadOutcomes = () => loadOutcomePublicationProjection(store, config),
} = {}) {
  let projectionTail = Promise.resolve();
  stream.bindOutcomeRevisionGateLoader(async () =>
    notificationOutcomeRevisionGate(await loadOutcomes())
  );

  async function runProject({ snapshot = null, emittedAt = new Date() } = {}) {
    const emitted = iso(emittedAt, "forecast input projection time");
    const usable = usableForecastSnapshot(snapshot, emitted);
    if (!usable) {
      return { inserted: false, reason: "forecast_not_eligible" };
    }
    const outcomeRevisionGate = await stream.currentOutcomeRevisionGate();
    const latestKnownAt = outcomeRevisionGate.latest_known_at;
    if (
      latestKnownAt !== null &&
      Date.parse(usable.prediction.data.knowledge_cutoff) < Date.parse(latestKnownAt)
    ) {
      return { inserted: false, reason: "forecast_precedes_latest_outcome" };
    }
    const prediction = usable.prediction;
    const predictionRef = {
      record_id: prediction.record_id,
      revision: prediction.revision,
    };
    const inputId = `forecast_input_${hashLabel({
      prediction_ref: predictionRef,
      prediction_hash: snapshot.prediction_hash,
    }).slice("sha256:".length)}`;
    const issuedAt = iso(prediction.data.issued_at, "forecast issued_at");
    const maximumDelay =
      config.runtime.publication.probability_alert.max_delivery_delay_minutes *
      60_000;
    const horizonEnd = Date.parse(prediction.data.horizon?.end);
    const expiresAt = new Date(Math.min(
      Date.parse(issuedAt) + maximumDelay,
      horizonEnd,
    )).toISOString();
    return stream.append({
      schema_version: INPUT_SCHEMA_VERSION,
      input_id: inputId,
      prediction_ref: predictionRef,
      prediction_hash: snapshot.prediction_hash,
      issued_at: issuedAt,
      emitted_at: emitted,
      knowledge_cutoff: iso(
        prediction.data.knowledge_cutoff,
        "forecast knowledge_cutoff",
      ),
      expires_at: expiresAt,
      serving_stage: usable.readiness.serving_stage,
      probabilities: forecastHorizonProbabilities(prediction),
      outcome_revision_gate: outcomeRevisionGate,
    });
  }

  function project(options) {
    const operation = projectionTail.then(() => runProject(options));
    projectionTail = operation.catch(() => {});
    return operation;
  }

  return { project, stream };
}

export {
  INPUT_SCHEMA_VERSION as FORECAST_INPUT_SCHEMA_VERSION,
  STATE_KEY as FORECAST_INPUT_STATE_KEY,
  STATE_SCHEMA_VERSION as FORECAST_INPUT_STATE_SCHEMA_VERSION,
};
