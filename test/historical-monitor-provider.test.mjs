import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import {
  historicalDailyLedgerAttestationReasons,
  historicalDailyLedgerContractHash,
} from "../src/core/coverage-contract.mjs";
import { processRecords, runPipeline } from "../src/pipeline/run.mjs";
import {
  HistoricalMonitorProvider,
  parseHistoricalMonitorHtml,
  timestampFromXSnowflake,
} from "../src/providers/historical-monitor-provider.mjs";
import {
  adequateCoverageIntervals,
  coverageAssertions,
  verifyCoverageAssertionEvidence,
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

const AUTHORITY_OUTCOME_DEFINITION = {
  version: "authority-announced-platform-reset/2",
  event_semantics: "qualifying_authority_completion_statement",
  authority_identity_ids: ["person_tibo_sottiaux"],
  scope_policy: "explicit-platform-or-authority-general-codex/1",
  negative_label_policy: "authoritative_daily_ledger_absence",
};

const AUTHORITY_TARGET = {
  vendor: "openai",
  product: "codex",
  population: "platform",
  plans: ["paid"],
  regions: ["global"],
  quota_bucket: null,
};

const AUTHORITY_ATTESTATION = {
  version: "historical-daily-authority-ledger/1",
  provider: "historical_monitor",
  independent: true,
  attestor: "https://archive.example/",
  method: "contiguous_daily_grid+x_oembed+snowflake",
  exhaustive_for: "qualifying_completed_platform_reset_outcomes",
  target_scope: AUTHORITY_TARGET,
  confirmation_identity_ids: ["person_tibo_sottiaux"],
  day_close_lag_hours: 36,
  minimum_stability_hours: 6,
};

test("authority ledger coverage requires the versioned scope policy", () => {
  const reasons = historicalDailyLedgerAttestationReasons({
    attestation: AUTHORITY_ATTESTATION,
    outcomeDefinition: {
      ...AUTHORITY_OUTCOME_DEFINITION,
      scope_policy: "legacy-explicit-only/1",
    },
    providerName: "historical_monitor",
    sourceUrl: "https://archive.example/",
    target: AUTHORITY_TARGET,
    confirmationIdentityIds: ["person_tibo_sottiaux"],
  });
  assert.ok(reasons.includes("outcome_definition_scope_policy_invalid"));
});

async function authoritativeHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-historical-authority-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clock = {
    now: new Date("2026-07-11T06:00:00.000Z"),
    html: archiveHtml(),
  };
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    outcome_definition: AUTHORITY_OUTCOME_DEFINITION,
    target: AUTHORITY_TARGET,
    providers: { historical_monitor: {
      enabled: true,
      base_url: "https://archive.example/",
      verify_x_oembed: false,
      discover_linked_posts: false,
      coverage_adequacy: "negative_label_eligible",
      coverage_completeness_attestation: AUTHORITY_ATTESTATION,
    } },
    model: { outcome_coverage_providers: ["historical_monitor"] },
  } });
  const store = await new JsonlStore(directory).init();
  const provider = new HistoricalMonitorProvider({
    config: config.providers.historical_monitor,
    target: config.target,
    outcomeDefinition: config.outcome_definition,
    fetchFn: async (input) => {
      assert.equal(new URL(input).origin, "https://archive.example");
      return new Response(clock.html);
    },
    now: () => new Date(clock.now),
  });
  return { clock, config, directory, provider, store };
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

test("historical monitor parser accepts preserved pre-grid items but rejects post-grid future items", () => {
  const preGridHtml = archiveHtml()
    .replace('<button data-date="2026-07-09" data-count="1"></button>', "");
  const parsed = parseHistoricalMonitorHtml(preGridHtml);
  assert.deepEqual(parsed.coverageDates, ["2026-07-10", "2026-07-11"]);
  assert.deepEqual(parsed.items.map((item) => item.id), ITEMS.map((item) => item.id));

  const postGridHtml = archiveHtml()
    .replace('<button data-date="2026-07-10" data-count="1"></button>', "")
    .replace('<button data-date="2026-07-11" data-count="0"></button>', "");
  assert.throws(
    () => parseHistoricalMonitorHtml(postGridHtml),
    /outside coverage grid for 2026-07-10/,
  );
});

test("authoritative daily coverage requires two stable snapshots and uses the second fetch clocks", async (t) => {
  const { clock, config, provider, store } = await authoritativeHarness(t);

  const first = await provider.collect(store, { force: true });
  assert.equal(first.coverage_pending, true);
  assert.deepEqual(first.coverage_assertions, []);
  assert.deepEqual(first.coverage_waiting, {
    schema_version: "coverage-waiting/1",
    status: "observing",
    reason_code: "coverage_stability_observation_pending",
    provider_id: "historical_monitor",
    candidate_count: 1,
    earliest_first_observed_at: "2026-07-11T06:00:00.000Z",
    earliest_recheck_at: "2026-07-11T12:00:00.000Z",
    observed_at: "2026-07-11T06:00:00.000Z",
  });
  assert.deepEqual(
    (await store.readState("historical-monitor-provider")).coverage_waiting,
    first.coverage_waiting,
  );
  assert.deepEqual(
    await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config },
    ),
    [],
  );

  const candidates = await store.readState("historical-monitor-coverage-candidates");
  assert.match(
    candidates.days["2026-07-09"].first_observation_ref,
    /^blob:\/\//,
  );
  assert.match(
    candidates.days["2026-07-09"].first_observation_hash,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(candidates.days["2026-07-09"], {
    coverage_contract_hash:
      candidates.days["2026-07-09"].coverage_contract_hash,
    authority_policy_hash: candidates.days["2026-07-09"].authority_policy_hash,
    day_ledger_hash: candidates.days["2026-07-09"].day_ledger_hash,
    first_observed_at: "2026-07-11T06:00:00.000Z",
    first_observation_ref:
      candidates.days["2026-07-09"].first_observation_ref,
    first_observation_hash:
      candidates.days["2026-07-09"].first_observation_hash,
    last_observed_at: "2026-07-11T06:00:00.000Z",
    observation_count: 1,
  });

  clock.now = new Date("2026-07-11T12:00:00.000Z");
  const second = await provider.collect(store);
  assert.equal(second.skipped, undefined);
  assert.equal(second.coverage_pending, false);
  assert.equal(second.coverage_waiting, null);
  assert.equal(second.coverage_assertions.length, 1);
  const [assertion] = second.coverage_assertions;
  assert.equal(assertion.start, "2026-07-09T00:00:00.000Z");
  assert.equal(assertion.end, "2026-07-10T00:00:00.000Z");
  assert.equal(assertion.adequacy, "negative_label_eligible");
  assert.equal(assertion.asserted_at, "2026-07-11T12:00:00.000Z");
  assert.equal(assertion.replay_available_at, "2026-07-11T12:00:00.000Z");
  assert.equal(assertion.evidence_refs[0].exhausted_at, "2026-07-11T12:00:00.000Z");
  assert.equal(assertion.evidence_refs[0].replay_available_at, "2026-07-11T12:00:00.000Z");

  const evidence = await store.readBlob(assertion.evidence_refs[0].ref);
  assert.equal(evidence.asserted_at, "2026-07-11T12:00:00.000Z");
  assert.equal(evidence.exhausted_at, "2026-07-11T12:00:00.000Z");
  assert.equal(evidence.replay_available_at, "2026-07-11T12:00:00.000Z");
  assert.deepEqual(await adequateCoverageIntervals(
    store,
    ["historical_monitor"],
    { config },
  ), [{
    start: "2026-07-09T00:00:00.000Z",
    end: "2026-07-10T00:00:00.000Z",
  }]);
});

test("pipeline waits without training or publishing while coverage stabilizes", async (t) => {
  const { clock, config, provider, store } = await authoritativeHarness(t);
  const result = await runPipeline(store, config, {
    now: clock.now,
    providerInstances: { historical_monitor: provider },
  });

  assert.equal(result.status, "waiting_for_coverage");
  assert.equal(result.training.succeeded, false);
  assert.equal(result.training.skipped, true);
  assert.equal(
    result.training.reason_code,
    "coverage_stability_observation_pending",
  );
  assert.equal(result.forecast, null);
  assert.deepEqual(result.coverage_waiting, {
    schema_version: "coverage-waiting/1",
    status: "waiting_for_coverage",
    reason_code: "coverage_stability_observation_pending",
    providers: ["historical_monitor"],
    candidate_count: 1,
    earliest_first_observed_at: "2026-07-11T06:00:00.000Z",
    earliest_recheck_at: "2026-07-11T12:00:00.000Z",
    recheck_due: false,
    observed_at: "2026-07-11T06:00:00.000Z",
  });
  assert.deepEqual(
    await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config },
    ),
    [],
  );
  assert.deepEqual(await store.all("prediction"), []);
});

test("a hot-switched authority contract forces a fresh stability observation", async (t) => {
  const {
    clock,
    config,
    directory,
    provider,
    store,
  } = await authoritativeHarness(t);
  await provider.collect(store, { force: true });
  clock.now = new Date("2026-07-11T12:00:00.000Z");
  await provider.collect(store, { force: true });
  assert.equal(
    (await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config },
    )).length,
    1,
  );

  const switchedIdentity = "person_tibo_sottiaux_contract_v2";
  const switchedTarget = {
    ...AUTHORITY_TARGET,
    quota_bucket: "contract-v2",
  };
  const switchedOutcomeDefinition = {
    ...AUTHORITY_OUTCOME_DEFINITION,
    authority_identity_ids: [switchedIdentity],
  };
  const switchedAttestation = {
    ...AUTHORITY_ATTESTATION,
    target_scope: switchedTarget,
    confirmation_identity_ids: [switchedIdentity],
    minimum_stability_hours: 7,
  };
  const switchedConfig = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
    outcome_definition: switchedOutcomeDefinition,
    target: switchedTarget,
    providers: { historical_monitor: {
      enabled: true,
      base_url: "https://archive.example/",
      verify_x_oembed: false,
      discover_linked_posts: false,
      coverage_adequacy: "negative_label_eligible",
      coverage_completeness_attestation: switchedAttestation,
      confirmation_identities: [{
        username: "thsottiaux",
        identity_id: switchedIdentity,
        source_role: "product_lead",
      }],
    } },
    model: { outcome_coverage_providers: ["historical_monitor"] },
  } });

  const currentVerification = await verifyCoverageAssertionEvidence(
    store,
    (await coverageAssertions(store, ["historical_monitor"]))[0],
    { config: switchedConfig },
  );
  assert.equal(currentVerification.valid, false);
  assert.ok(
    currentVerification.reasons.includes(
      "historical_daily_ledger_current_contract_mismatch",
    ),
  );
  assert.deepEqual(
    await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config: switchedConfig },
    ),
    [],
  );

  clock.now = new Date("2026-07-11T12:01:00.000Z");
  const switchedProvider = new HistoricalMonitorProvider({
    config: switchedConfig.providers.historical_monitor,
    target: switchedConfig.target,
    outcomeDefinition: switchedConfig.outcome_definition,
    fetchFn: async (input) => {
      assert.equal(new URL(input).origin, "https://archive.example");
      return new Response(clock.html);
    },
    now: () => new Date(clock.now),
  });
  const refreshed = await switchedProvider.collect(store);
  assert.equal(refreshed.skipped, undefined);
  assert.equal(refreshed.invalidated_coverage_assertions, 1);
  assert.equal(refreshed.coverage_pending, true);
  assert.deepEqual(refreshed.coverage_waiting, {
    schema_version: "coverage-waiting/1",
    status: "observing",
    reason_code: "coverage_stability_observation_pending",
    provider_id: "historical_monitor",
    candidate_count: 1,
    earliest_first_observed_at: "2026-07-11T12:01:00.000Z",
    earliest_recheck_at: "2026-07-11T19:01:00.000Z",
    observed_at: "2026-07-11T12:01:00.000Z",
  });
  const [invalidated] = await coverageAssertions(
    store,
    ["historical_monitor"],
  );
  assert.equal(invalidated.revision, 2);
  assert.equal(invalidated.adequacy, "outcome_only");
  assert.equal(invalidated.replay_available_at, null);
  const state = await store.readState("historical-monitor-provider");
  assert.equal(
    state.coverage_contract_hash,
    historicalDailyLedgerContractHash({
      attestation: switchedAttestation,
      outcomeDefinition: switchedOutcomeDefinition,
      providerName: "historical_monitor",
      sourceUrl: "https://archive.example/",
      target: switchedTarget,
      confirmationIdentityIds: [switchedIdentity],
    }),
  );
});

test("a changed authoritative day ledger revokes eligibility until the new ledger stabilizes", async (t) => {
  const { clock, config, provider, store } = await authoritativeHarness(t);
  await provider.collect(store, { force: true });
  clock.now = new Date("2026-07-11T12:00:00.000Z");
  await provider.collect(store, { force: true });
  assert.equal((await coverageAssertions(store, ["historical_monitor"]))[0].revision, 1);

  clock.html = archiveHtml().replace(
    ITEMS[0].text,
    "Enjoy a full reset of your usage limits for ChatGPT Work and Codex. The rollout is now complete.",
  );
  clock.now = new Date("2026-07-11T13:00:00.000Z");
  const changed = await provider.collect(store, { force: true });
  assert.equal(changed.coverage_pending, true);
  assert.deepEqual(changed.coverage_assertions, []);
  assert.deepEqual(
    await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config },
    ),
    [],
  );
  const revoked = (await coverageAssertions(store, ["historical_monitor"]))[0];
  assert.equal(revoked.revision, 2);
  assert.equal(revoked.adequacy, "outcome_only");
  assert.equal(revoked.replay_available_at, null);

  const candidates = await store.readState("historical-monitor-coverage-candidates");
  assert.equal(candidates.days["2026-07-09"].first_observed_at, "2026-07-11T13:00:00.000Z");
  assert.equal(candidates.days["2026-07-09"].observation_count, 1);

  clock.now = new Date("2026-07-11T19:00:00.000Z");
  const restabilized = await provider.collect(store, { force: true });
  assert.equal(restabilized.coverage_pending, false);
  assert.equal(restabilized.coverage_assertions.length, 1);
  const restored = restabilized.coverage_assertions[0];
  assert.equal(restored.revision, 3);
  assert.equal(restored.adequacy, "negative_label_eligible");
  assert.equal(restored.asserted_at, "2026-07-11T19:00:00.000Z");
  assert.equal(restored.replay_available_at, "2026-07-11T19:00:00.000Z");
});

test("removing an attested day from the authority grid revokes its negative-label eligibility", async (t) => {
  const { clock, config, provider, store } = await authoritativeHarness(t);
  await provider.collect(store, { force: true });
  clock.now = new Date("2026-07-11T12:00:00.000Z");
  await provider.collect(store, { force: true });

  clock.html = archiveHtml().replace(
    '<button data-date="2026-07-09" data-count="1"></button>',
    "",
  );
  clock.now = new Date("2026-07-11T13:00:00.000Z");
  const changed = await provider.collect(store, { force: true });
  assert.equal(changed.coverage_pending, true);
  assert.deepEqual(changed.coverage_assertions, []);
  assert.deepEqual(
    await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config },
    ),
    [],
  );
  const revoked = (await coverageAssertions(
    store,
    ["historical_monitor"],
  ))[0];
  assert.equal(revoked.revision, 2);
  assert.equal(revoked.adequacy, "outcome_only");
  assert.match(revoked.rationale, /absent from the current authority ledger/);
});

test("tampered authoritative archive semantics fail closed on evidence re-verification", async (t) => {
  const { clock, config, provider, store } = await authoritativeHarness(t);
  await provider.collect(store, { force: true });
  clock.now = new Date("2026-07-11T12:00:00.000Z");
  const collected = await provider.collect(store, { force: true });
  const assertion = collected.coverage_assertions[0];
  const evidence = await store.readBlob(assertion.evidence_refs[0].ref);
  const snapshot = await store.readBlob(evidence.archive_snapshot_ref);
  snapshot.html = snapshot.html.replace(ITEMS[0].text, "Tampered reset statement");

  const [namespace, fileName] = evidence.archive_snapshot_ref
    .slice("blob://".length)
    .split("/");
  await fs.writeFile(
    path.join(store.root, "blobs", namespace, fileName),
    `${JSON.stringify(snapshot)}\n`,
    "utf8",
  );

  const verification = await verifyCoverageAssertionEvidence(
    store,
    assertion,
    { config },
  );
  assert.equal(verification.valid, false);
  assert.ok(verification.reasons.includes("historical_daily_ledger_archive_snapshot_mismatch"));
  assert.deepEqual(
    await adequateCoverageIntervals(
      store,
      ["historical_monitor"],
      { config },
    ),
    [],
  );
});
