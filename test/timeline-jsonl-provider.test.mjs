import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { normalizeNewObservations } from "../src/pipeline/extract.mjs";
import {
  parseTimelineJsonl,
  TimelineJsonlProvider,
} from "../src/providers/timeline-jsonl-provider.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

function row(overrides = {}) {
  return {
    id: "2081254182502465981",
    platform: "twitter",
    author: "thsottiaux",
    createdAt: "Sun Jul 26 05:43:59 +0000 2026",
    text: "We will reset Codex usage limits for all paid users in the next hour.",
    url: "https://x.com/thsottiaux/status/2081254182502465981",
    likes: 1434,
    ...overrides,
  };
}

async function temporaryStore(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    store: await new JsonlStore(directory).init(),
  };
}

test("manual timeline import preserves observation time, identity policy, and no coverage", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-timeline-jsonl-");
  const filePath = path.join(directory, "timeline.jsonl");
  await fs.writeFile(filePath, `${JSON.stringify(row())}\n`, "utf8");
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
  } });
  let observedAt = new Date("2026-07-26T08:00:00Z");
  const provider = new TimelineJsonlProvider({
    filePath,
    config,
    now: () => observedAt,
  });

  const first = await provider.collect(store);
  assert.deepEqual(first, {
    provider: "timeline_jsonl",
    format_version: "author-timeline-jsonl/1",
    collected: 1,
    unchanged: 0,
    records: 1,
    coverage_created: false,
    health: { ok: true, delay_seconds: 0 },
  });
  const [observation] = await store.all("raw_observation");
  assert.equal(observation.data.ingest_provider, "timeline_jsonl");
  assert.equal(observation.data.published_at, "2026-07-26T05:43:59.000Z");
  assert.equal(observation.data.first_seen_at, "2026-07-26T08:00:00.000Z");
  assert.equal(observation.data.fetched_at, "2026-07-26T08:00:00.000Z");
  assert.equal(observation.data.availability_attestation, null);
  assert.equal(observation.data.author.identity_id, "person_tibo_sottiaux");
  assert.deepEqual(observation.data.selection_context, {
    feature_eligible: true,
    outcome_conditioned: false,
    selection_method: "recent_author_timeline_export",
  });
  assert.deepEqual(await store.readState("coverage", { providers: {} }), {
    providers: {},
  });
  assert.deepEqual(await store.allAudit("coverage_assertion"), []);

  await normalizeNewObservations(store, config, { now: observedAt });
  const [signal] = await store.all("normalized_signal");
  assert.equal(signal.data.available_at, "2026-07-26T08:00:00.000Z");
  assert.equal(signal.data.provenance.source_identity_id, "person_tibo_sottiaux");
  assert.equal(signal.data.provenance.source_role, "product_lead");
  assert.equal(signal.data.provenance.selection_bias, null);

  observedAt = new Date("2026-07-26T09:00:00Z");
  const repeated = await provider.collect(store);
  assert.equal(repeated.collected, 0);
  assert.equal(repeated.unchanged, 1);
  assert.equal(
    (await store.all("raw_observation", { latestOnly: false })).length,
    1,
  );
});

test("timeline parser rejects invalid or ambiguous exports before collection", async (t) => {
  const { directory, store } = await temporaryStore(t, "reset-timeline-invalid-");
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
  } });
  const mismatched = [
    row(),
    row({
      id: "2081229262452097169",
      url: "https://x.com/other/status/2081229262452097169",
    }),
  ];
  const filePath = path.join(directory, "invalid.jsonl");
  await fs.writeFile(
    filePath,
    mismatched.map((value) => JSON.stringify(value)).join("\n"),
    "utf8",
  );
  await assert.rejects(
    new TimelineJsonlProvider({ filePath, config }).collect(store),
    /URL author does not match author/,
  );
  assert.deepEqual(await store.all("raw_observation"), []);

  assert.throws(
    () => parseTimelineJsonl(
      `${JSON.stringify(row())}\n${JSON.stringify(row())}`,
      config,
    ),
    /duplicates status id/,
  );
  assert.throws(
    () => parseTimelineJsonl(JSON.stringify(row({ createdAt: "not-a-date" })), config),
    /invalid createdAt/,
  );
  assert.throws(
    () => parseTimelineJsonl(JSON.stringify(row({
      url: "https://example.test/thsottiaux/status/2081254182502465981",
    })), config),
    /invalid X status URL/,
  );
  const [retweet] = parseTimelineJsonl(JSON.stringify(row({
    text: "RT @someone: We will reset Codex usage limits.",
  })), config);
  assert.equal(retweet.selection_context.feature_eligible, false);
});

test("ingest-timeline CLI imports a valid JSONL file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-timeline-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "timeline.jsonl");
  await fs.writeFile(filePath, JSON.stringify(row()), "utf8");
  const before = Date.now();
  const childEnv = { ...process.env, RESET_DATA_DIR: directory };
  delete childEnv.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["src/cli.mjs", "ingest-timeline", "--file", filePath],
    {
      cwd: projectRoot,
      env: childEnv,
    },
  );
  const after = Date.now();
  assert.ok(stdout.trim(), `ingest-timeline produced no JSON: ${stderr}`);
  const result = JSON.parse(stdout);
  assert.equal(result.collected, 1);
  assert.equal(result.coverage_created, false);

  const store = await new JsonlStore(directory).init();
  const [observation] = await store.all("raw_observation");
  assert.ok(Date.parse(observation.data.first_seen_at) >= before);
  assert.ok(Date.parse(observation.data.first_seen_at) <= after);
  assert.equal(observation.data.first_seen_at, observation.data.fetched_at);
  assert.equal(observation.data.availability_attestation, null);
});
