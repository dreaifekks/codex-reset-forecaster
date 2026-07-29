import { runPipeline } from "../pipeline/run.mjs";
import {
  aggregateCoverageWaiting,
  normalizeCoverageWaitingSummary,
} from "../core/coverage-waiting.mjs";
import { normalizeEvaluationWaiting } from "../model/evaluation.mjs";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function untilNextCadence(now, delayMs, intervalMinutes) {
  const current = now.getTime();
  const intervalMs = intervalMinutes * MINUTE_MS;
  const boundary = Math.ceil(current / intervalMs) * intervalMs;
  let target = boundary + delayMs;
  if (target <= current) target += intervalMs;
  return target - current;
}

function untilNextRun(now, delayMs, intervalMinutes, preferredAt = null) {
  const cadenceDelay = untilNextCadence(now, delayMs, intervalMinutes);
  const preferredMs = Date.parse(preferredAt);
  if (!Number.isFinite(preferredMs) || preferredMs <= now.getTime()) {
    return cadenceDelay;
  }
  return Math.min(
    cadenceDelay,
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
    const intervalMinutes = Number(
      config.runtime.scheduler_interval_minutes ?? 60,
    );
    if (stopped) {
      scheduledFor = null;
      return;
    }
    const current = now();
    const waitMs = untilNextRun(
      current,
      delayMs,
      intervalMinutes,
      preferredAt,
    );
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
      const lastRetrainRequest = Date.parse(
        state.last_retrain_requested_at ?? state.last_training_at ?? "",
      );
      const retrain = !Number.isFinite(lastRetrainRequest) ||
        startedAt.getTime() - lastRetrainRequest >=
          config.runtime.retrain_interval_hours * HOUR_MS;
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: startedAt.toISOString(),
        last_run_started_at: startedAt.toISOString(),
        last_retrain_requested_at: retrain
          ? startedAt.toISOString()
          : state.last_retrain_requested_at ?? state.last_training_at ?? null,
      });
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
      const promotionBlocked = result.status === "promotion_blocked"
        ? result.promotion_guard ?? result.training?.promotion_guard ?? null
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
      if (
        result.status === "promotion_blocked" &&
        promotionBlocked?.passed !== false
      ) {
        throw new Error(
          "Pipeline returned promotion_blocked without a rejected guard decision",
        );
      }
      if (!waitingStatus && !promotionBlocked && !result.forecast?.prediction) {
        throw new Error("Pipeline completed without issuing a forecast");
      }
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: null,
        last_run_started_at: startedAt.toISOString(),
        last_success_at: finishedAt.toISOString(),
        last_run_duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        last_status: trainingError
          ? "degraded"
          : promotionBlocked
            ? "promotion_blocked"
            : waitingStatus ?? "completed",
        last_waiting: coverageWaiting,
        last_evaluation_waiting: evaluationWaiting,
        ...(trainingError
          ? { last_failure_at: finishedAt.toISOString() }
          : {}),
        last_training_at: result.training?.succeeded
          ? finishedAt.toISOString()
          : state.last_training_at ?? null,
        last_retrain_requested_at: retrain
          ? startedAt.toISOString()
          : state.last_retrain_requested_at ?? state.last_training_at ?? null,
        last_evaluation_at: result.training?.evaluation
          ? finishedAt.toISOString()
          : state.last_evaluation_at ?? null,
        last_promotion_status:
          result.training?.promotion?.reason ??
          (result.training?.promotion?.promoted ? "promoted" : null) ??
          state.last_promotion_status ??
          null,
        last_promotion_guard:
          promotionBlocked ??
          result.training?.promotion_guard ??
          state.last_promotion_guard ??
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
      } else if (promotionBlocked) {
        logger.info?.(
          `forecast pipeline blocked candidate promotion: ` +
          `${promotionBlocked.blockers?.join(", ") || "guard rejected"}`,
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
