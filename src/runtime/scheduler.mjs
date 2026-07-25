import { runPipeline } from "../pipeline/run.mjs";

const HOUR_MS = 3_600_000;

function untilNextHour(now, delayMs) {
  const current = now.getTime();
  const boundary = Math.ceil(current / HOUR_MS) * HOUR_MS;
  let target = boundary + delayMs;
  if (target <= current) target += HOUR_MS;
  return target - current;
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

  function schedule() {
    if (timer) clearTimeout(timer);
    const delayMs = Math.max(0, Number(config.runtime.scheduler_delay_seconds ?? 5) * 1_000);
    if (!stopped) timer = setTimeout(execute, untilNextHour(now(), delayMs));
  }

  async function execute() {
    if (running || stopped) return;
    running = true;
    const startedAt = now();
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
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: null,
        last_run_started_at: startedAt.toISOString(),
        last_success_at: finishedAt.toISOString(),
        last_run_duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        last_training_at: result.training?.succeeded
          ? finishedAt.toISOString()
          : state.last_training_at ?? null,
        last_prediction_id: result.forecast.prediction.record_id,
        last_collection: result.collection,
        last_timing: result.timing ?? null,
        last_error: null,
      });
      logger.info?.(`forecast pipeline completed: ${result.forecast.prediction.record_id}`);
    } catch (error) {
      const state = await store.readState("runtime", {});
      const failedAt = now();
      await store.writeState("runtime", {
        ...state,
        current_run_started_at: null,
        last_run_started_at: startedAt.toISOString(),
        last_failure_at: failedAt.toISOString(),
        last_run_duration_ms: Math.max(0, failedAt.getTime() - startedAt.getTime()),
        last_error: error.message,
      });
      logger.error?.(`forecast pipeline failed: ${error.stack ?? error.message}`);
    } finally {
      running = false;
      schedule();
    }
  }

  if (config.runtime.run_on_start) void execute();
  else schedule();

  return {
    async runNow() {
      if (timer) clearTimeout(timer);
      await execute();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get running() {
      return running;
    },
  };
}
