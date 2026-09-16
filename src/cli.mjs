#!/usr/bin/env node

import process from "node:process";
import { loadConfig } from "./core/config.mjs";
import { recordRef } from "./core/records.mjs";
import { floorHour } from "./core/time.mjs";
import { JsonlStore } from "./store/jsonl-store.mjs";
import { FixtureProvider } from "./providers/fixture-provider.mjs";
import { XProvider } from "./providers/x-provider.mjs";
import { XSearchGatewayProvider } from "./providers/x-search-gateway-provider.mjs";
import { HistoricalMonitorProvider } from "./providers/historical-monitor-provider.mjs";
import { TimelineJsonlProvider } from "./providers/timeline-jsonl-provider.mjs";
import { RsshubXProvider } from "./providers/rsshub-x-provider.mjs";
import { DEMO_CONFIG_OVERRIDES } from "./demo/config.mjs";
import { generateDemoHistory } from "./demo/history.mjs";
import {
  processRecords,
  runPipeline,
  trainEvaluatePromote,
} from "./pipeline/run.mjs";
import { evaluateWalkForward } from "./model/evaluation.mjs";
import { issueForecast } from "./model/forecast.mjs";
import { evaluateIssuedForecasts } from "./model/issued-evaluation.mjs";
import { getReadiness } from "./runtime/readiness.mjs";
import { settleIssuedPredictions } from "./model/settlement.mjs";
import { confirmManualPlatformReset } from "./operators/manual-reset.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const command = process.argv[2] ?? "help";
const config = await loadConfig({
  overrides: command === "demo-seed" ? DEMO_CONFIG_OVERRIDES : {},
});
const store = await new JsonlStore(config.runtime.data_dir).init();
const nowArgument = argument("--now");
const now = new Date(nowArgument ?? new Date().toISOString());

try {
  if (command === "demo-seed") {
    const fixture = generateDemoHistory({ now });
    const collection = await new FixtureProvider({ items: fixture, name: "demo", now: () => now }).collect(store);
    const processing = await processRecords(store, config, { now });
    const training = await trainEvaluatePromote(store, config, { now });
    if (!training.promotion.promoted && !(await store.readModel("champion"))) {
      throw new Error(`Demo model failed promotion gate: ${JSON.stringify(training.evaluation.gate)}`);
    }
    const forecast = await issueForecast(store, config, {
      knowledgeCutoff: now,
      clock: () => now,
    });
    output({
      demo_data: fixture.metadata,
      collection,
      processing: {
        normalized: processing.normalized.normalized,
        linked: processing.linked.linked,
        adjudicated: processing.outcomes.adjudicated,
      },
      evaluation: training.evaluation.metrics,
      gate: training.evaluation.gate,
      promoted: training.promotion.promoted,
      prediction_id: forecast.prediction.record_id,
    });
  } else if (command === "ingest-x") {
    output(await new XProvider({
      config: config.providers.x,
      target: config.target,
    }).collect(store));
  } else if (command === "ingest-gateway") {
    const gatewayConfig = structuredClone(config.providers.x_search_gateway);
    const queryName = argument("--query");
    if (queryName) {
      gatewayConfig.queries = gatewayConfig.queries.filter((query) => query.name === queryName);
      if (gatewayConfig.queries.length === 0) {
        throw new Error(`Unknown X Search Gateway query: ${queryName}`);
      }
    }
    output(await new XSearchGatewayProvider({
      config: gatewayConfig,
    }).collect(store));
  } else if (command === "ingest-rsshub") {
    output(await new RsshubXProvider({
      config: config.providers.rsshub_x_timeline,
    }).collect(store));
  } else if (command === "ingest-archive") {
    output(await new HistoricalMonitorProvider({
      config: config.providers.historical_monitor,
      target: config.target,
      outcomeDefinition: config.outcome_definition,
      evidencePolicy: config.live_evidence_policy,
    }).collect(store, { force: true }));
  } else if (command === "ingest-timeline") {
    const filePath = argument("--file");
    if (!filePath) throw new TypeError("ingest-timeline requires --file PATH");
    output(await new TimelineJsonlProvider({
      filePath,
      config,
    }).collect(store));
  } else if (command === "confirm-reset") {
    if (!process.argv.includes("--offline")) {
      throw new Error(
        "confirm-reset requires --offline after the live writer has been stopped",
      );
    }
    if (!process.argv.includes("--attest-platform")) {
      throw new Error(
        "confirm-reset requires --attest-platform to distinguish a platform outcome from personal quota state",
      );
    }
    const sourceStatus = argument("--source-status");
    const actor = argument("--actor");
    const effectiveAtArgument = argument("--effective-at");
    const agoHoursArgument = argument("--ago-hours");
    if (!sourceStatus || !actor) {
      throw new TypeError(
        "confirm-reset requires --source-status STATUS and --actor ID",
      );
    }
    if (Boolean(effectiveAtArgument) === Boolean(agoHoursArgument)) {
      throw new TypeError(
        "confirm-reset requires exactly one of --effective-at ISO or --ago-hours HOURS",
      );
    }
    let effectiveAt = effectiveAtArgument;
    if (agoHoursArgument) {
      const agoHours = Number(agoHoursArgument);
      if (!Number.isFinite(agoHours) || agoHours <= 0 || agoHours > 168) {
        throw new RangeError("--ago-hours must be greater than 0 and at most 168");
      }
      effectiveAt = new Date(now.getTime() - agoHours * 3_600_000);
    }
    const result = await confirmManualPlatformReset(store, config, {
      sourceStatus,
      effectiveAt,
      actor,
      note: argument("--note", ""),
      knownAt: now,
    });
    output({
      inserted: result.inserted,
      unchanged: result.unchanged,
      reason: result.reason,
      outcome_ref: recordRef(result.outcome),
      observation_ref: recordRef(result.observation),
      candidate_ref: recordRef(result.candidate),
      status: result.outcome.data.status,
      label_grade: result.outcome.data.label_grade,
      occurred_time_range: result.outcome.data.occurred_time_range,
      known_at: result.outcome.data.known_at,
    });
  } else if (command === "process") {
    output(await processRecords(store, config, { now }));
  } else if (command === "train") {
    const result = await runPipeline(store, config, {
      now,
      collect: false,
      retrain: true,
    });
    output({
      evaluation: result.training?.evaluation ?? null,
      promotion: result.training?.promotion ?? null,
      promotion_guard: result.promotion_guard,
    });
  } else if (command === "evaluate") {
    await settleIssuedPredictions(store, config, { settlementCutoff: floorHour(now) });
    output({
      walk_forward: await evaluateWalkForward(store, config, { evaluationCutoff: floorHour(now) }),
      as_issued: await evaluateIssuedForecasts(store, config, { evaluationCutoff: floorHour(now) }),
    });
  } else if (command === "forecast") {
    output(await issueForecast(store, config, {
      knowledgeCutoff: now,
      clock: () => now,
    }));
  } else if (command === "pipeline") {
    const pipelineOptions = {
      collect: !process.argv.includes("--no-collect"),
      retrain: process.argv.includes("--retrain"),
    };
    if (nowArgument) pipelineOptions.now = now;
    output(await runPipeline(store, config, pipelineOptions));
  } else if (command === "status") {
    output(await getReadiness(store, config));
  } else {
    process.stdout.write(`Codex Reset Forecaster\n\nCommands:\n  demo-seed [--now ISO]\n  ingest-x\n  ingest-gateway [--query NAME]\n  ingest-rsshub\n  ingest-archive\n  ingest-timeline --file PATH\n  confirm-reset --offline --attest-platform --source-status STATUS --actor ID (--effective-at ISO | --ago-hours HOURS) [--note TEXT] [--now ISO]\n  process\n  train [--now ISO]\n  evaluate [--now ISO]\n  forecast [--now ISO]\n  pipeline [--retrain] [--no-collect] [--now ISO]\n  status\n`);
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
