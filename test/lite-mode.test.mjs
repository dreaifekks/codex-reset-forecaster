import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { recordRef } from "../src/core/records.mjs";
import { addHours } from "../src/core/time.mjs";
import { generateDemoHistory } from "../src/demo/history.mjs";
import { modelContractHash } from "../src/model/contract.mjs";
import { exportLitePack } from "../src/operators/lite-pack.mjs";
import { adequateCoverageIntervals } from "../src/pipeline/coverage.mjs";
import {
  processRecords,
  runLitePipeline,
  runPipeline,
  trainEvaluatePromote,
} from "../src/pipeline/run.mjs";
import { FixtureProvider } from "../src/providers/fixture-provider.mjs";
import {
  PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
  createFrozenProbabilityProfileProvider,
} from "../src/query/probability-profile-worker.mjs";
import {
  NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
  PROBABILITY_THRESHOLD_PROFILE_VERSION,
} from "../src/query/probability-threshold-profile.mjs";
import { getReadiness } from "../src/runtime/readiness.mjs";
import { startScheduler } from "../src/runtime/scheduler.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { createRequestHandler } from "../src/web/app.mjs";

const NOW = new Date("2026-07-22T18:00:00Z");

function configFor(directory, { lite = true, runtime = {}, model = {} } = {}) {
  return loadConfig({ overrides: {
    providers: {
      rsshub_x_timeline: { enabled: true },
      historical_monitor: { enabled: true },
    },
    runtime: {
      data_dir: directory,
      lite_mode: lite,
      required_source_providers: ["rsshub_x_timeline"],
      ...runtime,
    },
    model: {
      max_iterations: 450,
      minimum_outcomes: 3,
      minimum_live_evaluation_windows: 1008,
      minimum_live_evaluation_events: 6,
      outcome_coverage_providers: ["demo"],
      promotion: {
        minimum_event_window_recall: 0.8,
        top_window_hours_per_week: 36,
        require_brier_skill_above: 0,
        maximum_expected_calibration_error: 0.1,
      },
      ...model,
    },
  } });
}

function temporaryDirectory(t, name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `reset-forecaster-${name}-`))
    .then((directory) => {
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      return directory;
    });
}

// One full-mode data root with a promoted champion, its walk-forward evaluation,
// two issued forecasts, and their settlements, plus one pack exported from it.
// Every test works on its own copy.
let fullDataRoot = null;
let litePack = null;
test.after(async () => {
  if (fullDataRoot) await fs.rm(await fullDataRoot, { recursive: true, force: true });
  if (litePack) await fs.rm(path.dirname(await litePack), { recursive: true, force: true });
});

function sharedFullDataRoot() {
  fullDataRoot ??= (async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "reset-forecaster-lite-full-"),
    );
    const config = await configFor(directory, { lite: false });
    const store = await new JsonlStore(directory).init();
    const fixture = generateDemoHistory({ now: NOW, days: 84 });
    await new FixtureProvider({ items: fixture, name: "demo", now: () => NOW })
      .collect(store);
    await processRecords(store, config, { now: NOW });
    const trained = await trainEvaluatePromote(store, config, { now: NOW });
    assert.equal(trained.promotion.promoted, true);
    for (const now of [NOW, addHours(NOW, 1)]) {
      const run = await runPipeline(store, config, { now, collect: false });
      assert.equal(run.status, "completed");
    }
    return directory;
  })();
  return fullDataRoot;
}

function sharedLitePack() {
  litePack ??= sharedFullDataRoot().then(async (source) => {
    const pack = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "reset-forecaster-lite-pack-")),
      "pack",
    );
    await exportLitePack({
      sourceDir: source,
      outputDir: pack,
      config: await configFor(source, { lite: false }),
      now: NOW,
    });
    return pack;
  });
  return litePack;
}

async function copyOf(t, shared, name) {
  const directory = await temporaryDirectory(t, name);
  await fs.cp(await shared, directory, { recursive: true });
  return directory;
}

const fullDataRootCopy = (t) => copyOf(t, sharedFullDataRoot(), "lite-full-copy");
const litePackCopy = (t) => copyOf(t, sharedLitePack(), "lite-pack-copy");

function fakeProviders(calls, now) {
  return {
    rsshub_x_timeline: {
      providerName: "rsshub_x_timeline",
      async collect(store) {
        calls.push("rsshub_x_timeline");
        await store.writeState("rsshub-x-timeline-provider", {
          provider: "rsshub_x_timeline",
          last_success_at: now.toISOString(),
          last_error: null,
        });
        return { collected: 0 };
      },
    },
    historical_monitor: {
      providerName: "historical_monitor",
      async collect() {
        calls.push("historical_monitor");
        return { collected: 0 };
      },
    },
  };
}

async function lines(file) {
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
}

async function absent(file) {
  await assert.rejects(fs.access(file), { code: "ENOENT" });
}

test("lite mode requires an explicit required-source list", async () => {
  await assert.rejects(
    loadConfig({ overrides: { runtime: { lite_mode: true } } }),
    /runtime\.lite_mode/,
  );
});

test("lite pipeline infers from the stored model without training, evaluation, or settlement", async (t) => {
  const directory = await litePackCopy(t);
  const config = await configFor(directory);
  const store = await new JsonlStore(directory).init();
  const models = ["models/champion.json", "models/challenger.json"];
  const modelsBefore = await Promise.all(models.map((file) =>
    fs.readFile(path.join(directory, file), "utf8")
  ));
  const blobNamespacesBefore = await fs.readdir(path.join(directory, "blobs"));

  const calls = [];
  const firstNow = addHours(NOW, 2);
  const first = await runLitePipeline(store, config, {
    now: firstNow,
    providerInstances: fakeProviders(calls, firstNow),
  });
  assert.equal(first.status, "completed");
  assert.deepEqual(calls, ["rsshub_x_timeline"]);
  assert.deepEqual(Object.keys(first.collection), ["rsshub_x_timeline"]);
  assert.deepEqual(first.training, {
    succeeded: false,
    skipped: true,
    reason_code: "lite_mode",
  });
  assert.equal(first.settlements, null);
  assert.equal(first.issuedEvaluation, null);
  assert.equal(first.forecast.inserted, true);
  assert.equal(first.forecast.prediction.data.slots.length, 168);
  assert.equal(first.forecast.prediction.data.model.validation_status, "validated");

  const secondNow = addHours(NOW, 3);
  const second = await runLitePipeline(store, config, {
    now: secondNow,
    providerInstances: fakeProviders(calls, secondNow),
  });
  const retained = (await lines(
    path.join(directory, "records", "feature_snapshot.jsonl"),
  )).map((line) => recordRef(JSON.parse(line)));
  assert.deepEqual(retained, second.forecast.prediction.data.feature_snapshot_refs);
  assert.equal((await store.all("prediction")).length, 3);

  assert.deepEqual(await Promise.all(models.map((file) =>
    fs.readFile(path.join(directory, file), "utf8")
  )), modelsBefore);
  assert.deepEqual(
    await fs.readdir(path.join(directory, "blobs")),
    blobNamespacesBefore,
  );
  await absent(path.join(directory, "records", "prediction_settlement.jsonl"));
  await absent(path.join(directory, "state", "issued-evaluation-summary.json"));
  await absent(path.join(directory, "state", "walk-forward-summary.json"));
  await absent(path.join(directory, "state", "champion-evaluation.json"));

  const readiness = await getReadiness(
    await new JsonlStore(directory).init(),
    config,
    { now: secondNow },
  );
  assert.equal(readiness.prediction_integrity.valid, true);
  assert.equal(readiness.serving_ready, true);
  assert.equal(readiness.serving_stage, "validated");
});

test("lite pipeline refuses a full data root and leaves its feature snapshots alone", async (t) => {
  const directory = await fullDataRootCopy(t);
  const config = await configFor(directory);
  const store = await new JsonlStore(directory).init();
  const snapshotFile = path.join(directory, "records", "feature_snapshot.jsonl");
  const before = await fs.readFile(snapshotFile, "utf8");
  const calls = [];
  await assert.rejects(
    runLitePipeline(store, config, {
      now: addHours(NOW, 2),
      providerInstances: fakeProviders(calls, NOW),
    }),
    /only runs on a data root created by export-lite/,
  );
  assert.deepEqual(calls, []);
  assert.equal((await lines(snapshotFile)).length, 336);
  assert.equal(await fs.readFile(snapshotFile, "utf8"), before);
});

test("lite pipeline rechecks a provisional model once and issues from the guarded snapshots", async (t) => {
  const directory = await litePackCopy(t);
  await fs.rm(path.join(directory, "models", "champion.json"));
  const config = await configFor(directory, {
    runtime: { provisional_bootstrap: { enabled: true, minimum_outcomes: 3 } },
    model: { live_forecast_promotion_guard: { enabled: true } },
  });
  const store = await new JsonlStore(directory).init();
  const predictionsBefore = (await store.all("prediction")).length;
  const now = addHours(NOW, 2);
  let guarded = null;
  const guard = (passed) => ({ candidate, previous, snapshots }) => {
    assert.equal(previous, null);
    guarded = { candidate, snapshots };
    return { passed, blockers: passed ? [] : ["test_rejection"] };
  };

  const blocked = await runLitePipeline(store, config, {
    now,
    collect: false,
    assessPromotionGuard: guard(false),
  });
  assert.equal(blocked.status, "promotion_blocked");
  assert.equal(blocked.forecast, null);
  assert.equal(blocked.promotion_guard.passed, false);
  assert.equal((await store.all("prediction")).length, predictionsBefore);
  assert.deepEqual(
    (await lines(path.join(directory, "records", "feature_snapshot.jsonl")))
      .map((line) => recordRef(JSON.parse(line))),
    guarded.snapshots.map(recordRef),
  );

  const issued = await runLitePipeline(store, config, {
    now,
    collect: false,
    assessPromotionGuard: guard(true),
  });
  assert.equal(issued.status, "completed");
  assert.equal(issued.training.promotion_guard.passed, true);
  const prediction = issued.forecast.prediction;
  assert.equal(prediction.data.model.validation_status, "provisional");
  assert.equal(prediction.data.model.artifact_hash, guarded.candidate.artifact_hash);
  assert.deepEqual(
    prediction.data.feature_snapshot_refs,
    guarded.snapshots.map(recordRef),
  );
});

test("lite pipeline stops before collection when no stored model matches the contract", async (t) => {
  const source = await temporaryDirectory(t, "lite-empty-source");
  const directory = path.join(await temporaryDirectory(t, "lite-empty"), "pack");
  await exportLitePack({
    sourceDir: source,
    outputDir: directory,
    config: await configFor(source, { lite: false }),
  });
  const config = await configFor(directory);
  const store = await new JsonlStore(directory).init();
  const calls = [];
  await assert.rejects(
    runLitePipeline(store, config, {
      now: NOW,
      providerInstances: fakeProviders(calls, NOW),
    }),
    /Lite mode has no stored model compatible with model contract sha256:/,
  );
  assert.deepEqual(calls, []);
});

test("lite pack carries only what inference reads and starts a serving lite instance", async (t) => {
  const source = await fullDataRootCopy(t);
  const rawObservations = await fs.readFile(
    path.join(source, "records", "raw_observation.jsonl"),
    "utf8",
  );
  await fs.appendFile(
    path.join(source, "records", "raw_observation.jsonl"),
    "{\"record_type\":\"raw_obs",
  );
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  const latestPrediction = (await sourceStore.all("prediction"))
    .sort((left, right) => left.data.issued_at.localeCompare(right.data.issued_at))
    .at(-1);
  const pack = path.join(await temporaryDirectory(t, "lite-pack"), "pack");

  const manifest = await exportLitePack({
    sourceDir: source,
    outputDir: pack,
    config: sourceConfig,
    now: NOW,
  });
  assert.equal(manifest.source.model_contract_hash, modelContractHash(sourceConfig));
  assert.deepEqual(manifest.prediction_ref, {
    ...recordRef(latestPrediction),
    issued_at: latestPrediction.data.issued_at,
  });
  assert.equal(
    manifest.model.training_cutoff,
    (await sourceStore.readModel("champion")).training_cutoff,
  );
  await absent(path.join(pack, "records", "prediction_settlement.jsonl"));
  await absent(path.join(pack, "blobs", "walk-forward-evaluation"));
  await absent(path.join(pack, "state", "walk-forward-summary.json"));
  await absent(path.join(pack, "state", "champion-evaluation.json"));
  await absent(path.join(pack, "indexes"));
  assert.deepEqual(await fs.readdir(path.join(pack, "blobs")), ["demo-coverage"]);
  assert.equal(
    await fs.readFile(path.join(pack, "records", "raw_observation.jsonl"), "utf8"),
    rawObservations,
  );
  assert.deepEqual(
    (await lines(path.join(pack, "records", "prediction.jsonl"))).map(JSON.parse),
    [latestPrediction],
  );
  assert.deepEqual(
    (await lines(path.join(pack, "records", "feature_snapshot.jsonl")))
      .map((line) => recordRef(JSON.parse(line))),
    latestPrediction.data.feature_snapshot_refs,
  );
  await assert.rejects(
    exportLitePack({ sourceDir: source, outputDir: pack, config: sourceConfig }),
    /not empty/,
  );

  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  assert.deepEqual(
    await adequateCoverageIntervals(store, ["demo"], { config }),
    await adequateCoverageIntervals(sourceStore, ["demo"], { config: sourceConfig }),
  );
  const now = addHours(NOW, 2);
  const run = await runLitePipeline(store, config, {
    now,
    providerInstances: fakeProviders([], now),
  });
  assert.equal(run.status, "completed");
  await store.writeState("runtime", {
    last_success_at: now.toISOString(),
    last_status: "completed",
    last_prediction_id: run.forecast.prediction.record_id,
    last_error: null,
  });

  const serve = async (handlerStore, handlerConfig) => {
    const server = http.createServer(createRequestHandler({
      store: handlerStore,
      config: handlerConfig,
      now: () => now,
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const liteBase = await serve(store, config);
  const health = await (await fetch(`${liteBase}/api/health`)).json();
  assert.equal(health.serving_ready, true);
  assert.equal(health.current_prediction_ref.record_id, run.forecast.prediction.record_id);
  assert.deepEqual(health.lite_mode.collected_providers, ["rsshub_x_timeline"]);
  assert.ok(health.lite_mode.paused.includes("training"));
  assert.deepEqual(health.lite_mode.model, {
    version: run.forecast.prediction.data.model.version,
    validation_status: "validated",
    training_cutoff: manifest.model.training_cutoff,
  });
  assert.equal(health.lite_mode.pack.exported_at, NOW.toISOString());
  const readiness = await (await fetch(`${liteBase}/api/readiness`)).json();
  assert.equal(readiness.lite_mode.enabled, true);

  const fullBase = await serve(sourceStore, sourceConfig);
  const fullHealth = await (await fetch(`${fullBase}/api/health`)).json();
  assert.equal("lite_mode" in fullHealth, false);
});

test("lite pack keeps only the latest impact episode revision of an otherwise empty data root", async (t) => {
  const source = await temporaryDirectory(t, "lite-impact-source");
  await fs.mkdir(path.join(source, "records"));
  const episode = (recordId, revision) =>
    JSON.stringify({ record_id: recordId, revision });
  await fs.writeFile(
    path.join(source, "records", "impact_episode.jsonl"),
    [episode("imp_a", 1), episode("imp_b", 1), episode("imp_a", 2)]
      .map((line) => `${line}\n`).join(""),
  );
  const pack = path.join(await temporaryDirectory(t, "lite-impact-pack"), "pack");
  const manifest = await exportLitePack({
    sourceDir: source,
    outputDir: pack,
    config: await configFor(source, { lite: false }),
  });
  assert.equal(manifest.prediction_ref, null);
  assert.equal(manifest.model, null);
  assert.deepEqual(
    await lines(path.join(pack, "records", "impact_episode.jsonl")),
    [episode("imp_a", 2), episode("imp_b", 1)],
  );
});

test("lite scheduler never requests a retrain", async (t) => {
  const directory = await temporaryDirectory(t, "lite-scheduler");
  const store = await new JsonlStore(directory).init();
  let retrain = null;
  const scheduler = startScheduler({
    store,
    config: {
      runtime: {
        run_on_start: false,
        retrain_interval_hours: 24,
        lite_mode: true,
      },
    },
    now: () => NOW,
    logger: { info() {}, error() {} },
    run: async (_store, _config, options) => {
      retrain = options.retrain;
      return {
        status: "completed",
        training: { succeeded: false, skipped: true, reason_code: "lite_mode" },
        forecast: { prediction: { record_id: "pred_lite" } },
      };
    },
  });
  t.after(() => scheduler.stop());
  await scheduler.runNow();
  assert.equal(retrain, false);
  const state = await store.readState("runtime");
  assert.equal(state.last_status, "completed");
  assert.equal(state.last_retrain_requested_at, null);
  assert.equal(state.last_training_at, null);
});

test("frozen probability profiles serve the exported seed and never rebuild", async () => {
  const contextHash = `sha256:${"a".repeat(64)}`;
  const profile = {
    schema_version: NOTIFICATION_THRESHOLD_CALIBRATION_VERSION,
    detail_schema_version: PROBABILITY_THRESHOLD_PROFILE_VERSION,
    horizon_hours: 24,
    points: [],
    distribution_summary: {},
    lineage: { context_generation_hash: contextHash },
  };
  const provider = createFrozenProbabilityProfileProvider({
    schema_version: PROBABILITY_PROFILE_SNAPSHOT_SCHEMA_VERSION,
    generated_at: "2026-07-22T18:00:00.000Z",
    profiles: [{
      horizon_hours: 24,
      cached_at: "2026-07-22T18:00:00.000Z",
      expires_at: "2026-07-22T18:10:00.000Z",
      context_generation_hash: contextHash,
      profile,
    }],
  });
  await provider.warm(undefined, { force: true });
  assert.deepEqual(await provider.get(24), profile);
  await assert.rejects(provider.get(48), { code: "probability_profile_unavailable" });
  await provider.stop();
});
