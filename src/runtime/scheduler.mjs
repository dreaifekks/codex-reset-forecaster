import { runPipeline } from "../pipeline/run.mjs";
import {
  aggregateCoverageWaiting,
  normalizeCoverageWaitingSummary,
} from "../core/coverage-waiting.mjs";
import { normalizeEvaluationWaiting } from "../model/evaluation.mjs";

const HOUR_MS = 3_600_000;

function untilNextHour(now, delayMs) {
  const current = now.getTime();
  const boundary = Math.ceil(current / HOUR_MS) * HOUR_MS;
  let target = boundary + delayMs;
  if (target <= current) target += HOUR_MS;
  return target - current;
}

function untilNextRun(now, delayMs, preferredAt = null) {
  const hourlyDelay = untilNextHour(now, delayMs);
  const preferredMs = Date.parse(preferredAt);
  if (!Number.isFinite(preferredMs) || preferredMs <= now.getTime()) {
    return hourlyDelay;
  }
  return Math.min(
    hourlyDelay,
    preferredMs - now.getTime() + delayMs,
  );
}

export function startScheduler({
  store,
  config,
  now = () => new Date(),
  logger = console,
  run = runPipeline,
}) {
  let timer = null;
  let stopped = false;
  let running = false;
  let scheduledFor = null;

  function schedule(preferredAt = null) {
    if (timer) clearTimeout(timer);
    const delayMs = Math.max(0, Number(config.runtime.scheduler_delay_seconds ?? 5) * 1_000);
    if (stopped) {
      scheduledFor = null;
      return;
    }
    const current = now();
    const waitMs = untilNextRun(current, delayMs, preferredAt);
    scheduledFor = new Date(current.getTime() + waitMs).toISOString();
    timer = setTimeout(execute, waitMs);
  }

  async function execute() {
    if (running || stopped) return;
    timer = null;
    scheduledFor = null;
    running = true;
    const startedAt = now();
    let preferredNextRunAt = null;
    try {
      const state = await store.readState("runtime", {});
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: startedAt.toISOString(),
        last_run_started_at: startedAt.toISOString(),
      });
      const lastTraining = state.last_training_at ? Date.parse(state.last_training_at) : 0;
      const retrain = !lastTraining ||
        startedAt.getTime() - lastTraining >= config.runtime.retrain_interval_hours * HOUR_MS;
      const result = await run(store, config, { clock: now, collect: true, retrain });
      const finishedAt = now();
      const coverageWaiting = result.status === "waiting_for_coverage"
        ? normalizeCoverageWaitingSummary(result.coverage_waiting, {
          now: finishedAt,
        })
        : null;
      const pendingCoverageRecheck = aggregateCoverageWaiting(
        Object.values(result.collection ?? {})
          .filter((entry) => entry?.required === true)
          .map((entry) => entry.coverage_waiting),
        { now: finishedAt },
      );
      const evaluationWaiting = result.status === "waiting_for_evaluation"
        ? normalizeEvaluationWaiting(result.evaluation_waiting)
        : null;
      const waitingStatus = coverageWaiting
        ? "waiting_for_coverage"
        : evaluationWaiting
          ? "waiting_for_evaluation"
          : null;
      const trainingError = result.status === "completed_with_training_error"
        ? String(result.training?.error ?? "").trim() || null
        : null;
      const nextCoverageRecheck = coverageWaiting ?? pendingCoverageRecheck;
      if (nextCoverageRecheck && !nextCoverageRecheck.recheck_due) {
        preferredNextRunAt = nextCoverageRecheck.earliest_recheck_at;
      }
      if (
        ["waiting_for_coverage", "waiting_for_evaluation"].includes(result.status) &&
        !waitingStatus
      ) {
        throw new Error(`Pipeline returned invalid ${result.status} details`);
      }
      if (result.status === "completed_with_training_error" && !trainingError) {
        throw new Error(
          "Pipeline returned completed_with_training_error without error details",
        );
      }
      if (!waitingStatus && !result.forecast?.prediction) {
        throw new Error("Pipeline completed without issuing a forecast");
      }
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: null,
        last_run_started_at: startedAt.toISOString(),
        last_success_at: finishedAt.toISOString(),
        last_run_duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        last_status: trainingError ? "degraded" : waitingStatus ?? "completed",
        last_waiting: coverageWaiting,
        last_evaluation_waiting: evaluationWaiting,
        ...(trainingError
          ? { last_failure_at: finishedAt.toISOString() }
          : {}),
        last_training_at: result.training?.succeeded
          ? finishedAt.toISOString()
          : state.last_training_at ?? null,
        last_evaluation_at: result.training?.evaluation
          ? finishedAt.toISOString()
          : state.last_evaluation_at ?? null,
        last_promotion_status:
          result.training?.promotion?.reason ??
          (result.training?.promotion?.promoted ? "promoted" : null) ??
          state.last_promotion_status ??
          null,
        last_prediction_id:
          result.forecast?.prediction?.record_id ??
          state.last_prediction_id ??
          null,
        last_collection: result.collection,
        last_timing: result.timing ?? null,
        last_error: trainingError,
      });
      if (coverageWaiting) {
        logger.info?.(
          `forecast pipeline waiting for coverage stability: ` +
          `${coverageWaiting.candidate_count} candidate(s)`,
        );
      } else if (evaluationWaiting) {
        logger.info?.(
          `forecast pipeline waiting for evaluation data: ` +
          `${evaluationWaiting.evaluated_windows} window(s), ` +
          `${evaluationWaiting.evaluated_events} event(s)`,
        );
      } else if (trainingError) {
        logger.error?.(
          `forecast pipeline reused the stable champion after training failure: ` +
          trainingError,
        );
      } else {
        logger.info?.(`forecast pipeline completed: ${result.forecast.prediction.record_id}`);
      }
    } catch (error) {
      const state = await store.readState("runtime", {});
      const failedAt = now();
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: null,
        last_run_started_at: startedAt.toISOString(),
        last_failure_at: failedAt.toISOString(),
        last_run_duration_ms: Math.max(0, failedAt.getTime() - startedAt.getTime()),
        last_status: "error",
        last_error: error.message,
      });
      logger.error?.(`forecast pipeline failed: ${error.stack ?? error.message}`);
    } finally {
      running = false;
      schedule(preferredNextRunAt);
    }
  }

  if (config.runtime.run_on_start) void execute();
  else schedule();

  return {
    async runNow() {
      if (timer) clearTimeout(timer);
      timer = null;
      scheduledFor = null;
      await execute();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      scheduledFor = null;
    },
    get running() {
      return running;
    },
    get nextRunAt() {
      return scheduledFor;
    },
  };
}
