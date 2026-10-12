import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/core/config.mjs";
import { sha256, stableStringify } from "../src/core/hash.mjs";
import { recordRef } from "../src/core/records.mjs";
import { addHours } from "../src/core/time.mjs";
import { generateDemoHistory } from "../src/demo/history.mjs";
import { modelContractHash } from "../src/model/contract.mjs";
import {
  LIVE_FORECAST_PROMOTION_GUARD_VERSION,
} from "../src/model/live-forecast-guard.mjs";
import { createPublicationProjector } from "../src/notifications/projector.mjs";
import { exportLitePack } from "../src/operators/lite-pack.mjs";
import { adequateCoverageIntervals } from "../src/pipeline/coverage.mjs";
import {
  processRecords,
  runLitePipeline,
  runPipeline,
  trainEvaluatePromote,
} from "../src/pipeline/run.mjs";
import { FixtureProvider } from "../src/providers/fixture-provider.mjs";
import { appendRawObservationRevision } from "../src/providers/raw.mjs";
import { loadConfirmedHistoryResults } from "../src/query/history-results.mjs";
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
import {
  createRequestHandler,
  materializeServingSnapshot,
} from "../src/web/app.mjs";

const NOW = new Date("2026-07-22T18:00:00Z");
const PROMOTION = {
  minimum_event_window_recall: 0.8,
  top_window_hours_per_week: 36,
  require_brier_skill_above: 0,
  maximum_expected_calibration_error: 0.1,
};
// The same model contract with no champion: a refit challenger serves
// provisionally because its evaluation sample can never mature.
const PROVISIONAL = {
  runtime: { provisional_bootstrap: { enabled: true, minimum_outcomes: 3 } },
  model: {
    minimum_live_evaluation_windows: 1_000_000,
    live_forecast_promotion_guard: { enabled: true },
  },
};

function overridesFor(directory, { lite = true, runtime = {}, model = {} } = {}) {
  return {
    providers: {
      rsshub_x_timeline: { enabled: true },
      historical_monitor: { enabled: true },
    },
    runtime: {
      data_dir: directory,
      lite_mode: lite,
      required_source_providers: ["rsshub_x_timeline"],
      publication: { enabled: true },
      ...runtime,
    },
    model: {
      max_iterations: 450,
      minimum_outcomes: 3,
      minimum_live_evaluation_windows: 1008,
      minimum_live_evaluation_events: 6,
      outcome_coverage_providers: ["demo"],
      promotion: PROMOTION,
      ...model,
    },
  };
}

function configFor(directory, options) {
  return loadConfig({ overrides: overridesFor(directory, options) });
}

function temporaryDirectory(t, name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `reset-forecaster-${name}-`))
    .then((directory) => {
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      return directory;
    });
}

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

// Fixture data roots are settled, so an export that would have to wait is a
// failure the test should see at once.
function exportPack(sourceDir, outputDir, config, options = {}) {
  return exportLitePack({
    sourceDir,
    outputDir,
    config,
    now: addHours(NOW, 2),
    waitMs: 0,
    ...options,
  });
}

function guardDecision(passed) {
  return ({ candidate }) => ({
    schema_version: LIVE_FORECAST_PROMOTION_GUARD_VERSION,
    passed,
    blockers: passed ? [] : ["test_rejection"],
    candidate: {
      model_version: candidate.model_version,
      artifact_hash: candidate.artifact_hash,
      model_contract_hash: candidate.model_contract_hash,
      training_cutoff: candidate.training_cutoff,
    },
  });
}

// One pipeline run driven the way the server drives it: the scheduler records
// the run in runtime state, then the serving snapshot and the publication
// ledger are projected from the result.
async function scheduledRun(
  store,
  config,
  now,
  { calls = [], beforeProjection = null, ...pipeline } = {},
) {
  let published = [];
  let projectionFailure = null;
  const scheduler = startScheduler({
    store,
    config: { ...config, runtime: { ...config.runtime, run_on_start: false } },
    now: () => now,
    logger: { info() {}, error() {} },
    run: (runStore, runConfig) =>
      (config.runtime.lite_mode ? runLitePipeline : runPipeline)(
        runStore,
        runConfig,
        { now, providerInstances: fakeProviders(calls, now), ...pipeline },
      ),
    afterState: async ({ status }) => {
      if (status !== "success") return;
      try {
        await beforeProjection?.();
        const snapshot = await materializeServingSnapshot(store, config, {
          materializedAt: now,
          persist: true,
        });
        ({ events: published } = await createPublicationProjector({ store, config })
          .project({ snapshot, emittedAt: now, allowInitialize: true }));
      } catch (error) {
        projectionFailure = error;
      }
    },
  });
  try {
    await scheduler.runNow();
  } finally {
    scheduler.stop();
  }
  if (projectionFailure) throw projectionFailure;
  return { runtime: await store.readState("runtime"), published };
}

// A lite process projects publication from the exported snapshot before its
// first run, exactly as the server does at startup.
async function startupPublication(store, config, now) {
  const snapshot = await store.readState("serving-snapshot", null);
  return (await createPublicationProjector({ store, config })
    .project({ snapshot, emittedAt: now, allowInitialize: true })).events;
}

const COMPLETION_AT = addHours(NOW, 1);
const COMPLETION_STATUS_ID = String(
  (BigInt(COMPLETION_AT.getTime()) - 1288834974657n) << 22n,
);
function appendCompletionStatement(store, config, text, at) {
  return appendRawObservationRevision(store, {
    provider_item_id: COMPLETION_STATUS_ID,
    canonical_url: `https://x.com/thsottiaux/status/${COMPLETION_STATUS_ID}`,
    published_at: COMPLETION_AT.toISOString(),
    author: {
      provider_author_id: "tibo-x-id",
      identity_id: "person_tibo_sottiaux",
      display_handle: "@thsottiaux",
    },
    content: { media_type: "text/plain", text, language: "en" },
    native_relations: [],
    selection_context: {
      feature_eligible: true,
      outcome_conditioned: false,
      selection_method: "rsshub_exact_timeline",
    },
  }, {
    providerName: "rsshub_x_timeline",
    providerVersion: "test",
    config: config.providers.rsshub_x_timeline,
    firstSeenAt: at,
    fetchedAt: at,
  });
}

// One full-mode data root that the scheduler has run twice: a promoted champion
// with its walk-forward evaluation, two forecasts with settlements, and a
// publication ledger holding one confirmed primary-source completion. Every
// test works on its own copy, or on a copy of a pack exported from it.
const shared = new Map();
const sharedDirectories = [];
test.after(async () => {
  for (const directory of sharedDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
function sharedDirectory(name, build) {
  if (!shared.has(name)) {
    shared.set(name, fs.mkdtemp(
      path.join(os.tmpdir(), `reset-forecaster-lite-${name}-`),
    ).then(async (directory) => {
      sharedDirectories.push(directory);
      await build(directory);
      return directory;
    }));
  }
  return shared.get(name);
}

function sharedFullDataRoot() {
  return sharedDirectory("full", async (directory) => {
    const config = await configFor(directory, { lite: false });
    const store = await new JsonlStore(directory).init();
    const fixture = generateDemoHistory({ now: NOW, days: 84 });
    await new FixtureProvider({ items: fixture, name: "demo", now: () => NOW })
      .collect(store);
    await processRecords(store, config, { now: NOW });
    const trained = await trainEvaluatePromote(store, config, { now: NOW });
    assert.equal(trained.promotion.promoted, true);
    await scheduledRun(store, config, NOW);
    await appendCompletionStatement(
      store,
      config,
      "Codex usage limits were reset for all paid users.",
      COMPLETION_AT,
    );
    const { runtime, published } = await scheduledRun(store, config, COMPLETION_AT);
    assert.equal(runtime.last_status, "completed");
    assert.deepEqual(
      published.map((event) => event.event_type),
      ["outcome.reset_confirmed.v1"],
    );
  });
}

function sharedProvisionalDataRoot() {
  return sharedDirectory("provisional", async (directory) => {
    await fs.cp(await sharedFullDataRoot(), directory, { recursive: true });
    await fs.rm(path.join(directory, "models", "champion.json"));
    const config = await configFor(directory, { lite: false, ...PROVISIONAL });
    const { runtime } = await scheduledRun(
      await new JsonlStore(directory).init(),
      config,
      addHours(NOW, 2),
      { retrain: true, assessPromotionGuard: guardDecision(true) },
    );
    assert.equal(runtime.last_status, "waiting_for_evaluation", runtime.last_error);
  });
}

function sharedPack(name, source, options) {
  return sharedDirectory(name, async (directory) => {
    const sourceDir = await source();
    await exportPack(
      sourceDir,
      path.join(directory, "pack"),
      await configFor(sourceDir, { lite: false, ...options }),
    );
  }).then((directory) => path.join(directory, "pack"));
}

async function copyOf(t, source, name) {
  const directory = await temporaryDirectory(t, name);
  await fs.cp(await source, directory, { recursive: true });
  return directory;
}

const fullDataRootCopy = (t) => copyOf(t, sharedFullDataRoot(), "lite-full-copy");
const provisionalDataRootCopy = (t) =>
  copyOf(t, sharedProvisionalDataRoot(), "lite-provisional-copy");
const litePackCopy = (t) =>
  copyOf(t, sharedPack("pack", sharedFullDataRoot), "lite-pack-copy");
const provisionalPackCopy = (t) => copyOf(
  t,
  sharedPack("provisional-pack", sharedProvisionalDataRoot, PROVISIONAL),
  "lite-provisional-pack-copy",
);

async function lines(file) {
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
}

async function absent(file) {
  await assert.rejects(fs.access(file), { code: "ENOENT" });
}

// Runs `action` once, at the moment `operation` first opens `file`.
async function whileOpening(file, action, operation) {
  const open = fs.open;
  let ran = false;
  fs.open = async (target, ...rest) => {
    if (target === file && !ran) {
      ran = true;
      await action();
    }
    return open(target, ...rest);
  };
  try {
    const result = await operation();
    assert.equal(ran, true, `${file} was never opened`);
    return result;
  } finally {
    fs.open = open;
  }
}

// Runs `action` once, right after `operation` has first read `file`, whichever
// way it reads it.
async function afterFirstRead(file, action, operation) {
  const original = { readFile: fs.readFile, copyFile: fs.copyFile };
  let ran = false;
  for (const method of Object.keys(original)) {
    fs[method] = async (target, ...rest) => {
      const result = await original[method](target, ...rest);
      if (target === file && !ran) {
        ran = true;
        await action();
      }
      return result;
    };
  }
  try {
    const result = await operation();
    assert.equal(ran, true, `${file} was never read`);
    return result;
  } finally {
    Object.assign(fs, original);
  }
}

// Replaces the champion with a new immutable artifact, as a promotion does.
async function promoteNextChampion(store, trainingCutoff) {
  const promoted = {
    ...await store.readModel("champion"),
    training_cutoff: trainingCutoff.toISOString(),
  };
  promoted.model_version = `${promoted.model_version}-next`;
  for (const field of ["artifact_hash", "promoted_at", "promotion_evaluation"]) {
    delete promoted[field];
  }
  promoted.artifact_hash = sha256(stableStringify(promoted));
  await store.writeModel("champion", promoted);
  return promoted;
}

// Starts the real server process in lite mode on a data root and reports how
// far it got: whether it began listening, and how it exited.
async function startLiteServer(t, directory) {
  const configFile = path.join(
    await temporaryDirectory(t, "lite-server-config"),
    "config.json",
  );
  await fs.writeFile(configFile, JSON.stringify(overridesFor(directory)));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      RESET_CONFIG: configFile,
      RESET_DATA_DIR: directory,
      RESET_SCHEDULER_ENABLED: "false",
      HOST: "127.0.0.1",
      PORT: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  let listened = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!listened && stdout.includes("listening")) {
      listened = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { listened, code, stderr };
}

test("lite mode requires an explicit required-source list", async () => {
  await assert.rejects(
    loadConfig({ overrides: { runtime: { lite_mode: true } } }),
    /runtime\.lite_mode/,
  );
});

test("lite pipeline infers from the exported model without training, evaluation, or settlement", async (t) => {
  const directory = await litePackCopy(t);
  const config = await configFor(directory);
  const store = await new JsonlStore(directory).init();
  const modelBefore = await fs.readFile(
    path.join(directory, "models", "champion.json"),
    "utf8",
  );
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

  assert.equal(
    await fs.readFile(path.join(directory, "models", "champion.json"), "utf8"),
    modelBefore,
  );
  assert.deepEqual(await fs.readdir(path.join(directory, "models")), [
    "artifacts",
    "champion.json",
  ]);
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
  assert.equal(await fs.readFile(snapshotFile, "utf8"), before);
});

test("lite pipeline refuses a real pack under a different model contract before touching it", async (t) => {
  const directory = await litePackCopy(t);
  const config = await configFor(directory);
  const drifted = await configFor(directory, {
    model: { lambda: config.model.lambda + 1 },
  });
  assert.notEqual(modelContractHash(drifted), modelContractHash(config));
  const store = await new JsonlStore(directory).init();
  const records = ["feature_snapshot", "normalized_signal", "prediction"]
    .map((type) => path.join(directory, "records", `${type}.jsonl`));
  const before = await Promise.all(records.map((file) => fs.readFile(file, "utf8")));
  const calls = [];
  await assert.rejects(
    runLitePipeline(store, drifted, {
      now: addHours(NOW, 3),
      providerInstances: fakeProviders(calls, NOW),
    }),
    /Lite mode cannot serve the exported champion .* under model contract sha256:/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(
    await Promise.all(records.map((file) => fs.readFile(file, "utf8"))),
    before,
  );
});

test("a rejected provisional forecast leaves the forecast on display verifiable", async (t) => {
  const directory = await provisionalPackCopy(t);
  const config = await configFor(directory, PROVISIONAL);
  const store = await new JsonlStore(directory).init();

  const accepted = await scheduledRun(store, config, addHours(NOW, 3), {
    assessPromotionGuard: guardDecision(true),
  });
  assert.equal(accepted.runtime.last_status, "completed");
  const served = (await store.all("prediction"))
    .find((prediction) =>
      prediction.record_id === accepted.runtime.last_prediction_id
    );
  assert.equal(served.data.model.validation_status, "provisional");
  const servedReadiness = await getReadiness(store, config, { now: addHours(NOW, 3) });
  assert.equal(servedReadiness.serving_ready, true);
  assert.equal(servedReadiness.serving_stage, "provisional");

  const rejected = await runLitePipeline(store, config, {
    now: addHours(NOW, 4),
    providerInstances: fakeProviders([], addHours(NOW, 4)),
    assessPromotionGuard: guardDecision(false),
  });
  assert.equal(rejected.status, "promotion_blocked");
  assert.equal(rejected.forecast, null);
  assert.equal(rejected.promotion_guard.passed, false);
  // Runtime state still names the accepted run, which isolates whether the
  // forecast on display lost anything from the rejection itself.
  const afterRejection = await getReadiness(
    await new JsonlStore(directory).init(),
    config,
    { now: addHours(NOW, 4) },
  );
  assert.equal(
    afterRejection.current_forecast.horizon_start,
    served.data.horizon.start,
  );
  assert.deepEqual(afterRejection.prediction_integrity, servedReadiness.prediction_integrity);
  assert.equal(afterRejection.serving_ready, true);

  const reissued = await runLitePipeline(store, config, {
    now: addHours(NOW, 5),
    providerInstances: fakeProviders([], addHours(NOW, 5)),
    assessPromotionGuard: guardDecision(true),
  });
  assert.equal(reissued.status, "completed");
  assert.equal(reissued.training.promotion_guard.passed, true);
  assert.equal(
    (await lines(path.join(directory, "records", "feature_snapshot.jsonl"))).length,
    168,
  );
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
  const servedPrediction = (await sourceStore.all("prediction"))
    .sort((left, right) => left.data.issued_at.localeCompare(right.data.issued_at))
    .at(-1);
  const champion = await sourceStore.readModel("champion");
  const pack = path.join(await temporaryDirectory(t, "lite-pack"), "pack");

  const manifest = await exportPack(source, pack, sourceConfig);
  assert.equal(manifest.source.model_contract_hash, modelContractHash(sourceConfig));
  assert.deepEqual(manifest.prediction_ref, {
    ...recordRef(servedPrediction),
    issued_at: servedPrediction.data.issued_at,
  });
  assert.deepEqual(manifest.model, {
    role: "champion",
    version: champion.model_version,
    artifact_hash: champion.artifact_hash,
    validation_status: "validated",
    training_cutoff: champion.training_cutoff,
  });
  await absent(path.join(pack, "records", "prediction_settlement.jsonl"));
  await absent(path.join(pack, "blobs", "walk-forward-evaluation"));
  await absent(path.join(pack, "state", "walk-forward-summary.json"));
  await absent(path.join(pack, "state", "champion-evaluation.json"));
  await absent(path.join(pack, "models", "challenger.json"));
  assert.deepEqual(await fs.readdir(path.join(pack, "blobs")), ["demo-coverage"]);
  assert.equal(
    await fs.readFile(path.join(pack, "records", "raw_observation.jsonl"), "utf8"),
    rawObservations,
  );
  assert.deepEqual(
    (await lines(path.join(pack, "records", "prediction.jsonl"))).map(JSON.parse),
    [servedPrediction],
  );
  assert.deepEqual(
    (await lines(path.join(pack, "records", "feature_snapshot.jsonl")))
      .map((line) => recordRef(JSON.parse(line))),
    servedPrediction.data.feature_snapshot_refs,
  );
  await assert.rejects(
    exportPack(source, pack, sourceConfig),
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
    version: champion.model_version,
    validation_status: "validated",
    training_cutoff: champion.training_cutoff,
  });
  assert.equal(health.lite_mode.pack.exported_at, now.toISOString());
  const readiness = await (await fetch(`${liteBase}/api/readiness`)).json();
  assert.equal(readiness.lite_mode.enabled, true);

  const fullBase = await serve(sourceStore, sourceConfig);
  const fullHealth = await (await fetch(`${fullBase}/api/health`)).json();
  assert.equal("lite_mode" in fullHealth, false);
});

test("a lite instance started from a pack publishes nothing the full instance has not published", async (t) => {
  const directory = await litePackCopy(t);
  const config = await configFor(directory);
  const store = await new JsonlStore(directory).init();
  const ledger = path.join(directory, "audit", "publication-event.jsonl");
  const ledgerBefore = await fs.readFile(ledger, "utf8");
  assert.equal(
    await fs.readFile(
      path.join(await sharedFullDataRoot(), "audit", "publication-event.jsonl"),
      "utf8",
    ),
    ledgerBefore,
  );

  assert.deepEqual(await startupPublication(store, config, addHours(NOW, 2)), []);
  for (const hours of [2, 3]) {
    const { runtime, published } = await scheduledRun(
      store,
      config,
      addHours(NOW, hours),
    );
    assert.equal(runtime.last_status, "completed");
    assert.deepEqual(published, []);
  }
  assert.equal(await fs.readFile(ledger, "utf8"), ledgerBefore);
});

test("an export that a writer overtakes mid-copy still yields a pack with no missing evidence", async (t) => {
  const source = await fullDataRootCopy(t);
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  const historyAtCut = await loadConfirmedHistoryResults(sourceStore, sourceConfig);
  const pack = path.join(await temporaryDirectory(t, "lite-race-pack"), "pack");

  // The writer revises the confirmed completion and re-adjudicates it after the
  // export has started copying: later files now describe a newer revision than
  // the files copied before them.
  await whileOpening(
    path.join(source, "records", "normalized_signal.jsonl"),
    async () => {
      await appendCompletionStatement(
        sourceStore,
        sourceConfig,
        "Codex usage limits were reset for all paid users. Thank you!",
        addHours(NOW, 2),
      );
      await processRecords(sourceStore, sourceConfig, { now: addHours(NOW, 2) });
    },
    () => exportPack(source, pack, sourceConfig),
  );

  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  assert.deepEqual(await loadConfirmedHistoryResults(store, config), historyAtCut);
  const ledger = path.join(pack, "audit", "publication-event.jsonl");
  const ledgerBefore = await fs.readFile(ledger, "utf8");
  assert.deepEqual(await startupPublication(store, config, addHours(NOW, 2)), []);
  const { runtime, published } = await scheduledRun(store, config, addHours(NOW, 2));
  assert.equal(runtime.last_status, "completed");
  assert.deepEqual(published, []);
  assert.equal(await fs.readFile(ledger, "utf8"), ledgerBefore);
});

test("export refuses a data root with unpublished changes and leaves no pack behind", async (t) => {
  const source = await fullDataRootCopy(t);
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  await appendCompletionStatement(
    sourceStore,
    sourceConfig,
    "Codex usage limits were reset for all paid users. Thank you!",
    addHours(NOW, 2),
  );
  await processRecords(sourceStore, sourceConfig, { now: addHours(NOW, 2) });
  const pack = path.join(await temporaryDirectory(t, "lite-pending-pack"), "pack");
  await assert.rejects(
    exportPack(source, pack, sourceConfig),
    /did not settle .* has not emitted \(outcome\.reset_corrected\.v1\)/,
  );
  assert.deepEqual(await fs.readdir(pack), []);

  // Once the full instance has published the correction itself, the same data
  // root exports, and the lite instance has nothing left to say.
  const { published } = await scheduledRun(sourceStore, sourceConfig, addHours(NOW, 2));
  assert.deepEqual(
    published.map((event) => event.event_type),
    ["outcome.reset_corrected.v1"],
  );
  await exportPack(source, pack, sourceConfig);
  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  assert.deepEqual(await startupPublication(store, config, addHours(NOW, 2)), []);
  assert.deepEqual(
    await loadConfirmedHistoryResults(store, config),
    await loadConfirmedHistoryResults(sourceStore, sourceConfig),
  );
});

test("export refuses a data root whose records reference evidence it does not hold", async (t) => {
  const source = await fullDataRootCopy(t);
  const rawFile = path.join(source, "records", "raw_observation.jsonl");
  const observations = await lines(rawFile);
  const completion = observations.findIndex((line) =>
    JSON.parse(line).data.provider_item_id === COMPLETION_STATUS_ID
  );
  await fs.writeFile(
    rawFile,
    observations.toSpliced(completion, 1).map((line) => `${line}\n`).join(""),
  );
  const pack = path.join(await temporaryDirectory(t, "lite-open-pack"), "pack");
  await assert.rejects(
    exportPack(source, pack, await configFor(source, { lite: false })),
    /Lite pack is not closed: .* references missing obs_/,
  );
  assert.deepEqual(await fs.readdir(pack), []);
});

test("a model promoted during export does not separate the exported pointer from its artifact", async (t) => {
  const source = await fullDataRootCopy(t);
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  const served = await sourceStore.readModel("champion");
  const pack = path.join(await temporaryDirectory(t, "lite-promotion-pack"), "pack");

  // The promotion lands after the last completed run, so the pack must still
  // carry the model that run served, whole.
  const manifest = await whileOpening(
    path.join(source, "records", "raw_observation.jsonl"),
    () => promoteNextChampion(sourceStore, addHours(NOW, 2)),
    () => exportPack(source, pack, sourceConfig),
  );
  assert.notEqual(
    (await sourceStore.readModel("champion")).artifact_hash,
    served.artifact_hash,
  );
  assert.equal(manifest.model.artifact_hash, served.artifact_hash);

  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  assert.equal((await store.readModel("champion")).artifact_hash, served.artifact_hash);
  assert.equal(
    (await store.readModelArtifact(served.artifact_hash)).artifact_hash,
    served.artifact_hash,
  );
  const now = addHours(NOW, 2);
  const run = await runLitePipeline(store, config, {
    now,
    providerInstances: fakeProviders([], now),
  });
  assert.equal(run.forecast.prediction.data.model.artifact_hash, served.artifact_hash);
  const readiness = await getReadiness(store, config, { now });
  assert.equal(readiness.serving_ready, true);
  assert.equal(readiness.serving_stage, "validated");
});

test("a model the full instance stopped serving cannot be exported for lite serving", async (t) => {
  const source = await provisionalDataRootCopy(t);
  const failing = {
    ...PROVISIONAL,
    model: {
      live_forecast_promotion_guard: { enabled: true },
      promotion: { ...PROMOTION, maximum_expected_calibration_error: 0 },
    },
  };
  const sourceConfig = await configFor(source, { lite: false, ...failing });
  const sourceStore = await new JsonlStore(source).init();
  // With a mature sample the refit challenger fails the calibration gate, so
  // the full instance stops issuing even though an older provisional forecast
  // from a stored, contract-compatible challenger is still fresh.
  const { runtime } = await scheduledRun(sourceStore, sourceConfig, addHours(NOW, 3), {
    retrain: true,
    assessPromotionGuard: guardDecision(true),
  });
  assert.equal(runtime.last_status, "error");
  assert.match(runtime.last_error, /No model passed the promotion gate/);
  assert.equal(
    (await getReadiness(sourceStore, sourceConfig, { now: addHours(NOW, 3) }))
      .model.challenger.ready,
    true,
  );

  const pack = path.join(await temporaryDirectory(t, "lite-failed-pack"), "pack");
  await assert.rejects(
    exportPack(source, pack, sourceConfig, { now: addHours(NOW, 3) }),
    /issued no forecast \(status error: No model passed the promotion gate/,
  );
  assert.deepEqual(await fs.readdir(pack), []);
});

test("export waits for a completed run to be projected instead of mixing it with the previous round", async (t) => {
  const source = await fullDataRootCopy(t);
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  const packs = await temporaryDirectory(t, "lite-round-packs");
  const now = addHours(NOW, 2);
  // This round has something to publish: a correction of the confirmed
  // completion.
  await appendCompletionStatement(
    sourceStore,
    sourceConfig,
    "Codex usage limits were reset for all paid users. Thank you!",
    now,
  );

  let early = null;
  let waiting = null;
  const { runtime, published } = await scheduledRun(sourceStore, sourceConfig, now, {
    // The scheduler has recorded the run; the serving snapshot and the
    // publication ledger still describe the round before it.
    beforeProjection: async () => {
      early = await exportPack(source, path.join(packs, "early"), sourceConfig)
        .then(() => null, (error) => error);
      waiting = exportPack(source, path.join(packs, "pack"), sourceConfig, {
        waitMs: 60_000,
        pollMs: 5,
      });
    },
  });
  assert.deepEqual(
    published.map((event) => event.event_type),
    ["outcome.reset_corrected.v1"],
  );
  assert.match(
    early?.message ?? "exported a pack before the run was projected",
    /did not settle on one completed pipeline run within 0 s: the serving snapshot has not been materialized/,
  );
  assert.deepEqual(await fs.readdir(path.join(packs, "early")), []);

  const manifest = await waiting;
  assert.equal(manifest.capture.attempts > 1, true);
  assert.equal(manifest.prediction_ref.record_id, runtime.last_prediction_id);
  const pack = path.join(packs, "pack");
  const ledger = path.join(pack, "audit", "publication-event.jsonl");
  const sourceLedger = await fs.readFile(
    path.join(source, "audit", "publication-event.jsonl"),
    "utf8",
  );
  assert.equal(await fs.readFile(ledger, "utf8"), sourceLedger);

  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  assert.deepEqual(await startupPublication(store, config, now), []);
  const firstLiteRun = await scheduledRun(store, config, addHours(NOW, 3));
  assert.equal(firstLiteRun.runtime.last_status, "completed");
  assert.deepEqual(firstLiteRun.published, []);
  assert.equal(await fs.readFile(ledger, "utf8"), sourceLedger);
});

test("a run that completes while export reads state is exported as one whole round", async (t) => {
  const source = await fullDataRootCopy(t);
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  const pack = path.join(await temporaryDirectory(t, "lite-crossing-pack"), "pack");
  const now = addHours(NOW, 3);

  // Between two state reads the full instance promotes another model and
  // completes a run with it.
  let promoted = null;
  const manifest = await afterFirstRead(
    path.join(source, "state", "runtime.json"),
    async () => {
      promoted = await promoteNextChampion(sourceStore, now);
      await scheduledRun(sourceStore, sourceConfig, now);
    },
    () => exportPack(source, pack, sourceConfig, { now, waitMs: 60_000, pollMs: 5 }),
  );
  const runtime = await sourceStore.readState("runtime");
  assert.equal(manifest.prediction_ref.record_id, runtime.last_prediction_id);
  assert.equal(manifest.model.artifact_hash, promoted.artifact_hash);

  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  const seed = await store.readState("serving-snapshot");
  assert.deepEqual(seed.prediction_ref, {
    record_id: manifest.prediction_ref.record_id,
    revision: manifest.prediction_ref.revision,
  });
  assert.deepEqual(await store.readState("runtime"), runtime);
  assert.deepEqual(
    (await store.all("prediction")).map(recordRef),
    [seed.prediction_ref],
  );
  assert.equal(
    (await store.readModelArtifact(seed.prediction.data.model.artifact_hash))
      .artifact_hash,
    manifest.model.artifact_hash,
  );

  const server = http.createServer(createRequestHandler({
    store,
    config,
    now: () => now,
    servingSnapshotProvider: { get: () => seed },
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (
    await fetch(`http://127.0.0.1:${server.address().port}/api/health`)
  ).json();
  assert.equal(health.serving_ready, true);
  assert.equal(health.current_prediction_ref.record_id, manifest.prediction_ref.record_id);
  assert.equal(health.lite_mode.model.version, manifest.model.version);
});

test("a lite process refuses to start on a serving snapshot its pack does not back", async (t) => {
  // Another round of the full instance, served from another model.
  const source = await fullDataRootCopy(t);
  const sourceConfig = await configFor(source, { lite: false });
  const sourceStore = await new JsonlStore(source).init();
  await promoteNextChampion(sourceStore, addHours(NOW, 3));
  await scheduledRun(sourceStore, sourceConfig, addHours(NOW, 3));

  const mixed = await litePackCopy(t);
  await fs.copyFile(
    path.join(source, "state", "serving-snapshot.json"),
    path.join(mixed, "state", "serving-snapshot.json"),
  );
  const refused = await startLiteServer(t, mixed);
  assert.equal(refused.listened, false);
  assert.notEqual(refused.code, 0);
  assert.match(
    refused.stderr,
    /Lite serving snapshot shows forecast pred_\w+@1, which this data root does not hold/,
  );

  // The same pack with its own snapshot starts, also after lite runs have
  // replaced the exported snapshot with forecasts of their own.
  const pack = await litePackCopy(t);
  const config = await configFor(pack);
  const store = await new JsonlStore(pack).init();
  for (const hours of [2, 3]) {
    assert.equal((await startLiteServer(t, pack)).listened, true);
    await scheduledRun(store, config, addHours(NOW, hours));
  }
});

test("lite pack keeps only the latest revision of each impact episode", async (t) => {
  const source = await fullDataRootCopy(t);
  const episode = (recordId, revision) =>
    JSON.stringify({ record_id: recordId, revision });
  await fs.appendFile(
    path.join(source, "records", "impact_episode.jsonl"),
    [episode("imp_a", 1), episode("imp_b", 1), episode("imp_a", 2)]
      .map((line) => `${line}\n`).join(""),
  );
  const pack = path.join(await temporaryDirectory(t, "lite-impact-pack"), "pack");
  await exportPack(source, pack, await configFor(source, { lite: false }));
  assert.deepEqual(
    (await lines(path.join(pack, "records", "impact_episode.jsonl")))
      .filter((line) => /"imp_[ab]"/.test(line)),
    [episode("imp_a", 2), episode("imp_b", 1)],
  );
});

test("the trial-model status and warning say validation is paused only in lite mode", async () => {
  const source = await fs.readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const pageFunctions = [
    "isProvisionalServing",
    "setStatus",
    "renderLiteMode",
    "renderPublicationWarning",
    "renderHealth",
  ].map((name) =>
    source.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`))[0]
  ).join("");
  const render = (language, liteMode) => {
    const elements = new Map();
    const element = (selector) => {
      if (!elements.has(selector)) {
        elements.set(selector, {
          hidden: true,
          textContent: "",
          classList: { add() {}, remove() {}, toggle() {} },
          setAttribute() {},
          querySelector: (child) => element(`${selector} ${child}`),
        });
      }
      return elements.get(selector);
    };
    const page = new Function(
      "document",
      "tr",
      "formatCompactTime",
      "challengerReady",
      "renderDataStatus",
      `${pageFunctions}return { renderPublicationWarning, renderHealth };`,
    )(
      { querySelector: element },
      (chinese, english) => language === "en" ? english : chinese,
      (value) => String(value),
      () => true,
      () => {},
    );
    // The page renders both from the health response of a provisional forecast.
    const health = {
      data: {
        status: "degraded",
        serving_ready: true,
        serving_stage: "provisional",
        serving_blockers: [],
        publication_ready: false,
        ...(liteMode ? {
          lite_mode: { model: { training_cutoff: "2026-10-11T12:50:08.086Z" } },
        } : {}),
      },
    };
    const forecast = { data: { data: {}, serving: { status: "provisional" } } };
    page.renderPublicationWarning(forecast, health);
    page.renderHealth(forecast, health, health);
    return {
      status: element("#source-status .status-text").textContent,
      warning: element("#publication-warning").textContent,
      liteNoticeShown: !element("#lite-mode-notice").hidden,
    };
  };

  assert.deepEqual(render("zh", true), {
    status: "试用模型 · 严格验证已暂停",
    warning: "试用模型：当前概率已开放试用，严格验证已暂停，尚未完成。",
    liteNoticeShown: true,
  });
  assert.deepEqual(render("en", true), {
    status: "Trial model · Strict validation paused",
    warning:
      "Trial model: probabilities are available, but strict validation is paused and has not been completed.",
    liteNoticeShown: true,
  });
  assert.deepEqual(render("zh", false), {
    status: "试用模型 · 严格验证积累中",
    warning: "试用模型：当前概率已开放试用，严格验证仍在积累中。",
    liteNoticeShown: false,
  });
  assert.deepEqual(render("en", false), {
    status: "Trial model · Strict validation accumulating",
    warning:
      "Trial model: probabilities are available while strict validation continues to accumulate.",
    liteNoticeShown: false,
  });
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
