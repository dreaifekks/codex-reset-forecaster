import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { processRecords } from "../src/pipeline/run.mjs";
import {
  HistoricalMonitorProvider,
  parseHistoricalMonitorHtml,
  timestampFromXSnowflake,
} from "../src/providers/historical-monitor-provider.mjs";
import {
  adequateCoverageIntervals,
  coverageAssertions,
} from "../src/pipeline/coverage.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";

const ITEMS = [
  {
    id: "2075330198887940337",
    at: "2026-07-09T21:24:11.842Z",
    text: "Enjoy a full reset of your usage limits for ChatGPT Work and Codex. Propagating in the next hour.",
  },
  {
    id: "2075641131002700120",
    at: "2026-07-10T17:59:43.835Z",
    text: "We have reset usage limits across Codex and ChatGPT Work.",
  },
];

const LINKED_ITEM = {
  id: "2075200000000000000",
  text: "We are investigating elevated Codex usage drain and working on a fix.",
};

function archiveHtml() {
  const coverage = ["2026-07-09", "2026-07-10", "2026-07-11"]
    .map((date, index) => `<button data-date="${date}" data-count="${index < 2 ? 1 : 0}"></button>`)
    .join("");
  const items = ITEMS.map((item) => `
    <li class="log-item">
      <span data-datetime="${item.at}"></span>
      <p class="log-item-text">${item.text.replaceAll("&", "&amp;")}</p>
      <a href="https://x.com/thsottiaux/status/${item.id}">View</a>
    </li>`).join("");
  return `${coverage}<ol>${items}</ol>`;
}

function oembed(item) {
  const linkedPost = item.id === ITEMS[0].id
    ? ' <a href="https://t.co/incident-context">https://t.co/incident-context</a>'
    : "";
  return {
    url: `https://x.com/thsottiaux/status/${item.id}`,
    author_name: "Tibo",
    author_url: "https://x.com/thsottiaux",
    html: `<blockquote><p lang="en">${item.text}${linkedPost}</p></blockquote>`,
  };
}

test("historical monitor preserves source evidence without treating its date grid as negative coverage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-historical-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    providers: { historical_monitor: {
      enabled: true,
      base_url: "https://archive.example/",
      x_oembed_url: "https://oembed.example/",
    } },
    model: { outcome_coverage_providers: ["historical_monitor"] },
  } });
  const now = new Date("2026-07-12T12:00:00Z");
  const fetchFn = async (input) => {
    const url = new URL(input);
    if (url.origin === "https://archive.example") return new Response(archiveHtml());
    if (url.origin === "https://t.co") {
      return { url: `https://x.com/thsottiaux/status/${LINKED_ITEM.id}` };
    }
    const id = url.searchParams.get("url").match(/status\/(\d+)/)[1];
    const item = [...ITEMS, LINKED_ITEM].find((candidate) => candidate.id === id);
    return new Response(JSON.stringify(oembed(item)), {
      headers: { "content-type": "application/json" },
    });
  };
  const store = await new JsonlStore(directory).init();
  const provider = new HistoricalMonitorProvider({
    config: config.providers.historical_monitor,
    fetchFn,
    now: () => now,
  });
  const collected = await provider.collect(store, { force: true });
  assert.equal(collected.collected, 2);
  assert.equal(collected.verified_items, 2);
  assert.equal(collected.verified_archive_items, 2);
  assert.equal(collected.discovered_linked_items, 0);
  assert.deepEqual(collected.coverage, {
    start: "2026-07-09T00:00:00.000Z",
    end: "2026-07-12T00:00:00.000Z",
  });

  const observations = (await store.all("raw_observation"))
    .filter((record) => record.data.content.media_type === "text/plain");
  assert.equal(observations.length, 2);
  assert.equal(observations[0].data.first_seen_at, now.toISOString());
  assert.equal(observations[0].data.availability_attestation.available_at, ITEMS[0].at);
  assert.equal(observations[0].data.availability_attestation.verification, "x_oembed+snowflake");
  assert.equal(timestampFromXSnowflake(ITEMS[0].id), ITEMS[0].at);
  assert.deepEqual(observations[0].data.native_relations, []);

  const processing = await processRecords(store, config, { now });
  assert.equal(processing.outcomes.adjudicated, 1);
  assert.deepEqual(new Set(processing.normalized.records.map((record) => record.data.available_at)), new Set([
    ...ITEMS.map((item) => item.at),
  ]));
  assert.deepEqual(await adequateCoverageIntervals(store, ["historical_monitor"]), []);
  const assertions = await coverageAssertions(store, ["historical_monitor"]);
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].adequacy, "outcome_only");
  assert.ok(assertions[0].evidence_refs.some((reference) =>
    reference.kind === "archive_snapshot" &&
    reference.html_sha256 &&
    reference.coverage_grid_sha256,
  ));
  assert.equal((await provider.collect(store, { force: true })).collected, 0);
});

test("historical monitor parser rejects gaps and timestamps that do not match X snowflakes", () => {
  assert.throws(
    () => parseHistoricalMonitorHtml(archiveHtml().replace("2026-07-10\"", "2026-07-12\"")),
    /coverage gap|Conflicting archive coverage/,
  );
  assert.throws(
    () => parseHistoricalMonitorHtml(archiveHtml().replace(ITEMS[0].at, "2026-07-09T20:24:11.000Z")),
    /does not match X snowflake/,
  );
  assert.throws(
    () => parseHistoricalMonitorHtml(
      archiveHtml().replace('data-date="2026-07-09" data-count="1"', 'data-date="2026-07-09" data-count="2"'),
    ),
    /item count mismatch.*2026-07-09/,
  );
  assert.throws(
    () => parseHistoricalMonitorHtml(
      archiveHtml().replace('<li class="log-item">', '<li class="log-item-drifted">'),
    ),
    /item count mismatch/,
  );
});
