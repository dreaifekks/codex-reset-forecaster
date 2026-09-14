import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.mjs";
import { addHours, floorHour } from "../src/core/time.mjs";
import { generateDemoHistory } from "../src/demo/history.mjs";
import { issueForecast } from "../src/model/forecast.mjs";
import { FixtureProvider } from "../src/providers/fixture-provider.mjs";
import {
  processRecords,
  runPipeline,
  trainEvaluatePromote,
} from "../src/pipeline/run.mjs";
import { JsonlStore } from "../src/store/jsonl-store.mjs";
import { createRequestHandler, evidenceTierForSignal } from "../src/web/app.mjs";
import {
  addCoverageInterval,
  verifiedCoverageAssertionRevisions,
} from "../src/pipeline/coverage.mjs";
import {
  evaluateIssuedForecasts,
  verifyIssuedEvaluationArtifact,
} from "../src/model/issued-evaluation.mjs";
import { settleIssuedPredictions } from "../src/model/settlement.mjs";
import {
  assessEvaluationCompatibility,
  getReadiness,
} from "../src/runtime/readiness.mjs";
import { hashLabel } from "../src/core/hash.mjs";

test("repository license metadata and bundled GitHub mark stay attributable", async () => {
  const [licenseText, packageText, lockText, notices, githubMark] = await Promise.all([
    fs.readFile(new URL("../LICENSE", import.meta.url), "utf8"),
    fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/github-mark.svg", import.meta.url), "utf8"),
  ]);
  assert.match(licenseText, /Apache License\s+Version 2\.0, January 2004/);
  assert.equal(JSON.parse(packageText).license, "Apache-2.0");
  assert.equal(JSON.parse(lockText).packages[""].license, "Apache-2.0");
  assert.match(notices, /Primer Octicons/);
  assert.match(githubMark, /viewBox="0 0 24 24"/);
});

test("evidence view keeps only Tibo and authoritative Codex or ChatGPT product events in core", () => {
  const config = {
    providers: {
      test: {
        confirmation_identities: [{ identity_id: "person_tibo_sottiaux" }],
      },
    },
  };
  const signal = ({
    identity = null,
    role = "official",
    eventType = "release",
    vendor = "openai",
    product = "codex",
    impact = null,
    competitiveContext = null,
  } = {}) => ({
    data: {
      claim: {
        event_type: eventType,
        scope: { vendor, product },
        impact,
        competitive_context: competitiveContext,
      },
      provenance: {
        source_identity_id: identity,
        source_role: role,
      },
    },
  });
  const observation = (text) => ({ data: { content: { text } } });

  assert.equal(
    evidenceTierForSignal(
      signal({ identity: "person_tibo_sottiaux", role: "product_lead", eventType: "quota_reset" }),
      observation("Reset usage limits."),
      config,
    ),
    "core",
  );
  assert.equal(
    evidenceTierForSignal(signal(), observation("Codex released a new coding model."), config),
    "core",
  );
  assert.equal(
    evidenceTierForSignal(
      signal({ eventType: "incident" }),
      observation("A ChatGPT incident is fixed."),
      config,
    ),
    "core",
  );
  assert.equal(
    evidenceTierForSignal(signal(), observation("OpenAI released a new Sora model."), config),
    "other_context",
  );
  assert.equal(
    evidenceTierForSignal(
      signal({ role: "aggregator" }),
      observation("Codex released a new coding model."),
      config,
    ),
    "other_context",
  );
  assert.equal(
    evidenceTierForSignal(
      signal({ vendor: "other", product: "competing_model" }),
      observation("Claude released a new model."),
      config,
    ),
    "other_context",
  );
  assert.equal(
    evidenceTierForSignal(
      signal({
        role: "community",
        eventType: "experience_issue",
        impact: { severity: "medium" },
      }),
      observation("Codex CLI hangs during tool use."),
      config,
    ),
    "experience",
  );
  assert.equal(
    evidenceTierForSignal(
      signal({
        role: "official",
        eventType: "competitor_model_release",
        vendor: "other",
        product: "competing_model",
        competitiveContext: {
          kind: "model_release",
          relevance: "adjacent",
          stage: "rolled_out",
        },
      }),
      observation("Claude 5 was released."),
      config,
    ),
    "competition",
  );
});

test("confirmed history stays available when evaluation storage is unavailable", async (t) => {
  const config = await loadConfig();
  let evaluationReads = 0;
  let recordReads = 0;
  const store = {
    async all(recordType) {
      recordReads += 1;
      assert.ok([
        "reset_outcome",
        "normalized_signal",
      ].includes(recordType));
      return [];
    },
    async allByRefs(recordType, refs) {
      recordReads += 1;
      assert.equal(recordType, "raw_observation");
      assert.deepEqual(refs, []);
      return [];
    },
    async readState() {
      evaluationReads += 1;
      throw new Error("evaluation storage must not be read");
    },
    async readModel() {
      evaluationReads += 1;
      throw new Error("model storage must not be read");
    },
  };
  const server = http.createServer(createRequestHandler({ store, config }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/history/results`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [] });
  const repeated = await fetch(
    `http://127.0.0.1:${address.port}/api/history/results`,
  );
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { results: [] });
  assert.equal(evaluationReads, 0);
  assert.equal(recordReads, 3, "the derived history view should be cached");
});

test("covered end-to-end pipeline passes the meaningful 80% gate and serves the website", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reset-forecaster-integration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: { data_dir: directory },
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
    },
  } });
  const store = await new JsonlStore(directory).init();
  const now = new Date("2026-07-22T18:00:00Z");
  const fixture = generateDemoHistory({ now, days: 84 });
  const collection = await new FixtureProvider({ items: fixture, name: "demo", now: () => now }).collect(store);
  assert.ok(collection.collected > 0);

  const processing = await processRecords(store, config, { now });
  assert.equal(processing.outcomes.adjudicated, fixture.items.filter((item) => item.content.text.startsWith("We have now")).length);
  const scheduledSignals = processing.normalized.records.filter((signal) => signal.data.claim.phase === "scheduled");
  assert.ok(scheduledSignals.length > 0);
  const outcomeObservationIds = new Set(
    (await store.all("reset_outcome")).flatMap((outcome) =>
      outcome.data.verification.map((entry) => entry.observation_ref.record_id),
    ),
  );
  for (const signal of scheduledSignals.filter((item) => item.data.provenance.source_identity_id === "person_tibo_sottiaux")) {
    assert.ok(!outcomeObservationIds.has(signal.data.observation_refs[0].record_id), "scheduled post leaked into labels");
  }

  let fittedBeforeEvaluation = null;
  const trained = await trainEvaluatePromote(store, config, {
    now,
    onTrained: async (training) => {
      fittedBeforeEvaluation = training.model.artifact_hash;
      assert.equal(await store.readState("walk-forward-summary", null), null);
    },
  });
  assert.equal(fittedBeforeEvaluation, trained.training.model.artifact_hash);
  assert.equal(
    trained.evaluation.gate.passed,
    true,
    `synthetic evaluation gate failed: ${JSON.stringify(trained.evaluation.metrics)}`,
  );
  assert.equal(trained.evaluation.evidence_mode, "synthetic_replay");
  assert.ok(trained.evaluation.metrics.event_window_recall >= 0.8);
  assert.ok(trained.evaluation.metrics.brier_skill > 0);
  assert.ok(trained.evaluation.metrics.expected_calibration_error <= 0.1);
  assert.ok(trained.evaluation.metrics.average_precision > 0);
  assert.ok(Number.isFinite(trained.evaluation.metrics.calibration_intercept));
  assert.ok(Number.isFinite(trained.evaluation.metrics.calibration_slope));
  assert.ok(Array.isArray(trained.evaluation.metrics.false_high_probability_alerts_by_month));
  assert.ok(
    Number.isFinite(
      trained.evaluation.metrics.median_policy_peak_absolute_error_hours,
    ),
  );
  assert.ok(trained.evaluation.events.every((event) =>
    event.forecast_issued_at && event.ranked_window && event.model_version && event.settlement,
  ));
  assert.equal(trained.promotion.promoted, true);

  const forecast = await issueForecast(store, config, {
    knowledgeCutoff: floorHour(now),
    clock: () => now,
  });
  assert.equal(forecast.prediction.data.slots.length, 168);
  assert.equal(forecast.prediction.data.data_quality.provider_coverage, 1);
  assert.equal(forecast.prediction.data.model.validation_status, "validated");
  assert.equal((await issueForecast(store, config, {
    knowledgeCutoff: floorHour(now),
    clock: () => now,
  })).inserted, false, "same model/cutoff publication must be idempotent");
  const pendingSettlement = await settleIssuedPredictions(store, config, {
    settlementCutoff: now,
  });
  assert.equal(pendingSettlement.records[0].data.status, "pending");

  await addCoverageInterval(store, "demo", now, addHours(now, 8));
  const futureCompletionAt = addHours(now, 2.1);
  await new FixtureProvider({
    name: "demo",
    now: () => addHours(now, 3),
    items: [{
      provider_item_id: "issued-evaluation-completion",
      canonical_url: "https://example.invalid/demo/issued-evaluation-completion",
      published_at: futureCompletionAt.toISOString(),
      first_seen_at: futureCompletionAt.toISOString(),
      fetched_at: addHours(now, 3).toISOString(),
      author: {
        provider_author_id: "thsottiaux",
        identity_id: "person_tibo_sottiaux",
        display_handle: "@thsottiaux",
      },
      native_relations: [],
      content: {
        media_type: "text/plain",
        text: "We have now fully reset Codex usage limits across all paid plans. Enjoy!",
        language: "en",
      },
    }],
  }).collect(store);
  await processRecords(store, config, { now: addHours(now, 3) });
  const positiveSettlement = await settleIssuedPredictions(store, config, {
    settlementCutoff: addHours(now, 5),
  });
  assert.equal(positiveSettlement.records[0].data.status, "positive");
  assert.equal(positiveSettlement.records[0].revision, 2);
  const issuedEvaluation = await evaluateIssuedForecasts(store, config, {
    evaluationCutoff: addHours(now, 5),
  });
  assert.equal(issuedEvaluation.mode, "as_issued");
  assert.equal(issuedEvaluation.metrics.evaluated_windows, 1);
  assert.equal(issuedEvaluation.metrics.evaluated_events, 1);

  const laterCutoff = addHours(now, 8);
  const laterForecast = await issueForecast(store, config, {
    knowledgeCutoff: laterCutoff,
    clock: () => laterCutoff,
  });
  assert.equal(laterForecast.inserted, true);
  const censoredSettlement = await settleIssuedPredictions(store, config, {
    settlementCutoff: addHours(now, 13),
  });
  assert.equal(censoredSettlement.records.length, 1);
  assert.equal(censoredSettlement.records[0].data.prediction_ref.record_id, laterForecast.prediction.record_id);
  assert.equal(censoredSettlement.records[0].data.status, "censored");
  assert.equal(censoredSettlement.records[0].data.coverage.complete, false);

  const completenessManifest = {
    method: "synthetic_fixture_exhaustion",
    exhausted_at: addHours(now, 13).toISOString(),
    interval: {
      start: laterCutoff.toISOString(),
      end: addHours(now, 13).toISOString(),
    },
  };
  const completenessHash = hashLabel(completenessManifest);
  const completenessRef = await store.writeBlob(
    "pipeline-test-coverage",
    completenessHash,
    completenessManifest,
  );
  await addCoverageInterval(store, "demo", laterCutoff, addHours(now, 13), {
    adequacy: "negative_label_eligible",
    asserted_at: addHours(now, 13),
    evidence_refs: [{
      kind: "complete_poll",
      ref: completenessRef,
      sha256: completenessHash,
      method: completenessManifest.method,
      exhausted_at: completenessManifest.exhausted_at,
    }],
  });
  const negativeSettlement = await settleIssuedPredictions(store, config, {
    settlementCutoff: addHours(now, 13),
  });
  assert.equal(negativeSettlement.records.length, 1);
  assert.equal(negativeSettlement.records[0].data.status, "negative");
  assert.equal(negativeSettlement.records[0].revision, 2);
  assert.equal(negativeSettlement.records[0].supersedes.revision, 1);
  const twoWindowEvaluation = await evaluateIssuedForecasts(store, config, {
    evaluationCutoff: addHours(now, 13),
  });
  assert.equal(twoWindowEvaluation.metrics.evaluated_windows, 2);
  assert.equal(twoWindowEvaluation.metrics.evaluated_events, 1);
  const readiness = await getReadiness(store, config);
  assert.equal(readiness.synthetic_only, true);
  assert.equal(readiness.model.challenger.available, true);
  assert.equal(readiness.model.challenger.ready, true);
  assert.equal(readiness.model.challenger.converged, true);
  assert.ok(readiness.model.challenger.example_count > 0);
  assert.ok(readiness.model.challenger.event_count > 0);
  assert.equal(readiness.model.real_walk_forward_acceptance_proven, false);

  await store.writeState("x-search-gateway-provider", {
    upstream_provider: "hermes",
    last_success_at: "2026-07-22T17:30:00.000Z",
    last_error: null,
  });

  const server = http.createServer(createRequestHandler({
    store,
    config,
    now: () => laterCutoff,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const [
    healthResponse,
    forecastResponse,
    evaluationResponse,
    historyResponse,
    evidenceResponse,
    pageResponse,
    appScriptResponse,
    accuracyPageResponse,
    accuracyScriptResponse,
    stylesResponse,
    englishPageResponse,
    englishAccuracyPageResponse,
    localeChoiceResponse,
    sitemapResponse,
    robotsResponse,
    englishManifestResponse,
    socialPreviewZhResponse,
    socialPreviewEnResponse,
    englishAliasResponse,
  ] = await Promise.all([
    fetch(`${base}/api/health`),
    fetch(`${base}/api/forecast/current`),
    fetch(`${base}/api/evaluation/summary`),
    fetch(`${base}/api/history/results`),
    fetch(`${base}/api/evidence/recent`),
    fetch(`${base}/`),
    fetch(`${base}/app.js`),
    fetch(`${base}/accuracy`),
    fetch(`${base}/accuracy.js`),
    fetch(`${base}/styles.css`),
    fetch(`${base}/en`),
    fetch(`${base}/en/accuracy`),
    fetch(`${base}/locale-choice.js`),
    fetch(`${base}/sitemap.xml`),
    fetch(`${base}/robots.txt`),
    fetch(`${base}/manifest-en.webmanifest`),
    fetch(`${base}/social-preview-zh.png`),
    fetch(`${base}/social-preview-en.png`),
    fetch(`${base}/en/index.html?source=alias`, { redirect: "manual" }),
  ]);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(
    health.evaluation_gate_passed,
    true,
    `health evaluation compatibility failed: ${JSON.stringify(health.evaluation_invalidated)}`,
  );
  assert.equal(health.provider_last_success_at, "2026-07-22T17:30:00.000Z");
  assert.equal(health.providers.x_search_gateway.upstream_provider, "hermes");
  assert.equal(forecastResponse.status, 200);
  assert.equal(historyResponse.status, 200);
  assert.equal(accuracyPageResponse.status, 200);
  assert.equal(accuracyScriptResponse.status, 200);
  assert.equal(stylesResponse.status, 200);
  assert.equal(englishPageResponse.status, 200);
  assert.equal(englishAccuracyPageResponse.status, 200);
  assert.equal(localeChoiceResponse.status, 200);
  assert.equal(sitemapResponse.status, 200);
  assert.equal(robotsResponse.status, 200);
  assert.equal(englishManifestResponse.status, 200);
  assert.equal(socialPreviewZhResponse.status, 200);
  assert.equal(socialPreviewEnResponse.status, 200);
  assert.equal(englishAliasResponse.status, 308);
  assert.equal(englishAliasResponse.headers.get("location"), "/en?source=alias");
  assert.equal(pageResponse.headers.get("content-language"), "zh-CN");
  assert.equal(accuracyPageResponse.headers.get("content-language"), "zh-CN");
  assert.equal(englishPageResponse.headers.get("content-language"), "en");
  assert.equal(englishAccuracyPageResponse.headers.get("content-language"), "en");
  assert.match(sitemapResponse.headers.get("content-type"), /application\/xml/);
  assert.match(robotsResponse.headers.get("content-type"), /text\/plain/);
  assert.equal(socialPreviewZhResponse.headers.get("content-type"), "image/png");
  assert.equal(socialPreviewEnResponse.headers.get("content-type"), "image/png");
  assert.equal(accuracyScriptResponse.headers.get("cache-control"), "no-cache");
  assert.equal(stylesResponse.headers.get("cache-control"), "no-cache");
  const servedForecast = await forecastResponse.json();
  assert.equal(servedForecast.data.slots.length, 168);
  assert.equal(servedForecast.serving.synthetic_demo, true);
  assert.equal(servedForecast.serving.publication_ready, false);
  assert.ok(servedForecast.serving.publication_blockers.includes("synthetic_only"));
  assert.ok((await evaluationResponse.json()).metrics.event_window_recall >= 0.8);
  const history = await historyResponse.json();
  assert.ok(history.results.length > 0);
  assert.ok(history.results.every((result) => result.status === "confirmed"));
  assert.ok(history.results.every((result) => result.source?.observation_ref));
  assert.ok(history.results.every((result) => !("evaluation" in result)));
  assert.deepEqual(
    history.results.map((result) => result.occurred_time_range.start),
    history.results
      .map((result) => result.occurred_time_range.start)
      .toSorted((left, right) => right.localeCompare(left)),
  );
  const evidence = await evidenceResponse.json();
  assert.ok(evidence.core.length > 0);
  assert.ok(evidence.community.length > 0);
  assert.ok(Array.isArray(evidence.experience));
  assert.ok(Array.isArray(evidence.competition));
  assert.ok(Array.isArray(evidence.other_context));
  assert.ok(evidence.core.every((item) => item.source_identity_id === "person_tibo_sottiaux"));
  assert.ok(evidence.community.every((item) => item.source_identity_id !== "person_tibo_sottiaux"));
  assert.ok(evidence.items.every((item) => item.scope && "derivation" in item && "published_at" in item.source));
  const page = await pageResponse.text();
  const appScript = await appScriptResponse.text();
  const accuracyPage = await accuracyPageResponse.text();
  const accuracyScript = await accuracyScriptResponse.text();
  const styles = await stylesResponse.text();
  const englishPage = await englishPageResponse.text();
  const englishAccuracyPage = await englishAccuracyPageResponse.text();
  const localeChoiceScript = await localeChoiceResponse.text();
  const sitemap = await sitemapResponse.text();
  const robots = await robotsResponse.text();
  const englishManifest = await englishManifestResponse.json();
  const socialPreviewZh = Buffer.from(await socialPreviewZhResponse.arrayBuffer());
  const socialPreviewEn = Buffer.from(await socialPreviewEnResponse.arrayBuffer());

  for (const preview of [socialPreviewZh, socialPreviewEn]) {
    assert.ok(preview.length > 100_000);
    assert.deepEqual(
      [...preview.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(preview.readUInt32BE(16), 1200);
    assert.equal(preview.readUInt32BE(20), 630);
    assert.deepEqual(
      [...preview.subarray(-12)],
      [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130],
    );
  }

  assert.match(page, /<html lang="zh-CN">/);
  assert.match(page, /<link rel="canonical" href="https:\/\/codexreset\.dreaife\.tokyo\/">/);
  assert.match(page, /hreflang="en" href="https:\/\/codexreset\.dreaife\.tokyo\/en"/);
  assert.match(page, /hreflang="x-default" href="https:\/\/codexreset\.dreaife\.tokyo\/en"/);
  assert.match(accuracyPage, /<link rel="canonical" href="https:\/\/codexreset\.dreaife\.tokyo\/accuracy">/);
  assert.match(accuracyPage, /hreflang="en" href="https:\/\/codexreset\.dreaife\.tokyo\/en\/accuracy"/);
  assert.match(englishPage, /<html lang="en">/);
  assert.match(englishPage, /<link rel="canonical" href="https:\/\/codexreset\.dreaife\.tokyo\/en">/);
  assert.match(englishPage, /hreflang="zh-Hans" href="https:\/\/codexreset\.dreaife\.tokyo\/"/);
  assert.match(englishPage, /<h1>7-Day Reset Forecast<\/h1>/);
  assert.match(englishAccuracyPage, /<link rel="canonical" href="https:\/\/codexreset\.dreaife\.tokyo\/en\/accuracy">/);
  assert.match(englishAccuracyPage, /<h1>Reset History<\/h1>/);
  assert.match(englishPage, /data-locale-choice="zh">中文<\/a>/);
  assert.match(page, /data-locale-choice="en">EN<\/a>/);

  const publicOrigin = "https://codexreset.dreaife.tokyo";
  const websiteNodes = [];
  for (const expected of [
    {
      html: page,
      url: `${publicOrigin}/`,
      type: "WebPage",
      language: "zh-CN",
      name: "Codex 重置预测：未来 7 天额度重置概率",
      description: "查看未来 168 小时 Codex 付费计划全平台额度重置概率、每小时风险、最新信号与已确认重置记录。",
      image: `${publicOrigin}/social-preview-zh.png`,
      imageAlt: "Codex 重置预测的未来 168 小时每小时概率可视化",
    },
    {
      html: accuracyPage,
      url: `${publicOrigin}/accuracy`,
      type: "CollectionPage",
      language: "zh-CN",
      name: "Codex 已确认重置历史 · Codex 重置预测",
      description: "查看 Codex 付费计划已经确认发生的额度重置结果、发生时间、确认等级与来源。",
      image: `${publicOrigin}/social-preview-zh.png`,
      imageAlt: "Codex 重置预测的未来 168 小时每小时概率可视化",
    },
    {
      html: englishPage,
      url: `${publicOrigin}/en`,
      type: "WebPage",
      language: "en",
      name: "Codex Reset Forecast: 7-Day Quota Reset Probability",
      description: "See the probability of a Codex platform-wide quota reset over the next 168 hours, hourly risk, current signals, and confirmed reset history.",
      image: `${publicOrigin}/social-preview-en.png`,
      imageAlt: "Codex Reset Forecast 168-hour hourly probability visualization",
    },
    {
      html: englishAccuracyPage,
      url: `${publicOrigin}/en/accuracy`,
      type: "CollectionPage",
      language: "en",
      name: "Confirmed Codex Reset History · Codex Reset Forecast",
      description: "See confirmed Codex quota reset outcomes, occurrence times, official confirmation times, and sources.",
      image: `${publicOrigin}/social-preview-en.png`,
      imageAlt: "Codex Reset Forecast 168-hour hourly probability visualization",
    },
  ]) {
    const structuredData = [...expected.html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    )].map((match) => JSON.parse(match[1]));
    assert.equal(structuredData.length, 1);
    assert.equal(structuredData[0]["@context"], "https://schema.org");
    const nodes = structuredData[0]["@graph"] ?? [structuredData[0]];
    const pageNode = nodes.find((node) => node["@id"] === `${expected.url}#webpage`);
    assert.ok(pageNode, `missing structured page node for ${expected.url}`);
    assert.equal(pageNode["@type"], expected.type);
    assert.equal(pageNode.url, expected.url);
    assert.equal(pageNode.name, expected.name);
    assert.equal(pageNode.description, expected.description);
    assert.equal(pageNode.inLanguage, expected.language);
    assert.deepEqual(pageNode.isPartOf, { "@id": `${publicOrigin}/#website` });
    assert.equal(pageNode.image, expected.image);
    websiteNodes.push(...nodes.filter((node) => node["@type"] === "WebSite"));

    for (const metadata of [
      `<meta property="og:image" content="${expected.image}">`,
      '<meta property="og:image:type" content="image/png">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${expected.imageAlt}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${expected.image}">`,
      `<meta name="twitter:image:alt" content="${expected.imageAlt}">`,
    ]) assert.ok(expected.html.includes(metadata), `missing metadata: ${metadata}`);
  }
  assert.equal(websiteNodes.length, 1);
  assert.deepEqual(websiteNodes[0], {
    "@type": "WebSite",
    "@id": `${publicOrigin}/#website`,
    url: `${publicOrigin}/`,
    name: "Codex 重置预测",
    alternateName: [
      "Codex Reset Forecast",
      "Codex Reset",
      "codexreset.dreaife.tokyo",
    ],
    description: "查看未来 168 小时 Codex 付费计划全平台额度重置概率、每小时风险、最新信号与已确认重置记录。",
    inLanguage: ["zh-CN", "en"],
  });

  assert.match(localeChoiceScript, /navigator\.languages/);
  assert.match(localeChoiceScript, /language\.toLowerCase\(\)\.startsWith\("zh"\)/);
  assert.doesNotMatch(localeChoiceScript, /(?:window\.)?location\s*=/);
  assert.deepEqual(englishManifest.lang, "en");
  assert.equal(englishManifest.start_url, "/en");
  for (const path of ["/", "/accuracy", "/en", "/en/accuracy"]) {
    assert.match(sitemap, new RegExp(`<loc>https://codexreset\\.dreaife\\.tokyo${path === "/" ? "/" : path}<\\/loc>`));
  }
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/codexreset\.dreaife\.tokyo\/sitemap\.xml/);
  assert.match(page, /每小时重置概率/);
  assert.match(page, /未来 7 天重置概率/);
  assert.match(page, /未来 168 小时内发生重置的可能性/);
  assert.match(page, /id="probability-72h"/);
  assert.match(page, /id="data-quality-tooltip"/);
  assert.match(page, /id="heat-tooltip"/);
  assert.match(page, /id="heat-detail" data-mode="empty"/);
  assert.match(page, /<dialog class="signal-dialog"/);
  assert.match(page, /id="signal-dialog-source-link"/);
  assert.match(appScript, /aria-haspopup", "dialog"/);
  assert.match(appScript, /rel="noopener noreferrer"/);
  assert.match(appScript, /reset_by_end_probability/);
  assert.match(appScript, /clearSlotSelection/);
  assert.match(appScript, /showHourlySlotDetail/);
  assert.match(appScript, /showSelectedSlotDetail/);
  assert.match(appScript, /restoreSlotDetail/);
  assert.match(appScript, /let selectedSlotDetail = null/);
  assert.match(
    appScript,
    /selectedSlotDetail = \{ slot, cumulativeProbability, index: selectedIndex \}/,
  );
  assert.match(appScript, /createRangeBackdrop/);
  assert.match(appScript, /roundedPolygonPath/);
  assert.match(appScript, /updateRangeBackdrop\(selectedIndex\)/);
  assert.match(appScript, /const column = Math\.floor\(selectedIndex \/ 12\)/);
  assert.match(appScript, /if \(column > 0 && row < 11\)/);
  assert.match(
    appScript,
    /const notchX = previousBox\.right \+ padding/,
  );
  assert.match(appScript, /backdrop\.append\(path\)/);
  assert.match(appScript, /detail\.dataset\.mode = "hourly"/);
  assert.match(appScript, /detail\.dataset\.mode = "cumulative"/);
  assert.match(appScript, /range-selected/);
  assert.match(
    appScript,
    /levelForProbability\(slot\.first_reset_probability,\s*maximum\)/,
  );
  assert.match(appScript, /const relative = probability \/ maximum/);
  assert.doesNotMatch(appScript, /Math\.sqrt\(probability \/ maximum\)/);
  assert.match(appScript, /closest\("\.contribution-cell"\)/);
  assert.match(appScript, /未来\$\{dayNames\[dayIndex\]\}天内重置概率/);
  assert.doesNotMatch(appScript, /button\.title\s*=/);
  assert.doesNotMatch(appScript, /textContent = `\$\{dateFormatter[^`]+起`/);
  assert.match(styles, /\.heat-tooltip/);
  assert.doesNotMatch(styles, /\.contribution-cell\.range-selected/);
  assert.match(styles, /\.range-backdrop-path/);
  assert.match(styles, /z-index: -1/);
  assert.match(styles, /drop-shadow\(0 0 3px rgba\(255, 255, 255, 0\.3\)\)/);
  assert.match(styles, /stroke-linejoin: round/);
  assert.match(styles, /padding: 6px;/);
  assert.doesNotMatch(
    page,
    /未来 168 小时内的重置概率|未重置概率|与 OpenAI 无关联|时间与模型|指标含义/,
  );
  assert.doesNotMatch(
    appScript,
    /未重置概率|与 OpenAI 无关联|原始陈述/,
  );
  assert.match(appScript, /模型已训练 · 评估中/);
  assert.match(appScript, /实时来源正常/);
  assert.match(appScript, /负标签按审计延迟成熟/);
  assert.doesNotMatch(appScript, /data_quality\?\.score/);
  assert.match(page, /app\.js\?v=reset-review-1/);
  assert.match(page, /styles\.css\?v=seo-i18n-1/);
  assert.match(
    page,
    /href="https:\/\/t\.me\/codex_reset_7day_bot"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?>Telegram Bot<\/a>/,
  );
  assert.match(
    appScript,
    /notification-preferences\.js\?v=seo-i18n-1/,
  );
  assert.match(
    page,
    /<header class="site-header">[\s\S]*?<div class="header-brand-group">[\s\S]*?class="brand"[\s\S]*?class="repository-link"[\s\S]*?href="https:\/\/github\.com\/dreaifekks\/codex-reset-forecaster"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?<img class="repository-mark"[\s\S]*?<\/div>[\s\S]*?<nav aria-label="主导航">[\s\S]*?<\/header>[\s\S]*?<main class="page-shell">/,
  );
  assert.match(
    accuracyPage,
    /<header class="site-header">[\s\S]*?<div class="header-brand-group">[\s\S]*?class="brand"[\s\S]*?class="repository-link"[\s\S]*?href="https:\/\/github\.com\/dreaifekks\/codex-reset-forecaster"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?<img class="repository-mark"[\s\S]*?<\/div>[\s\S]*?<nav aria-label="主导航">[\s\S]*?<\/header>[\s\S]*?<main class="page-shell">/,
  );
  const mainNavigation = page.match(/<nav aria-label="主导航">[\s\S]*?<\/nav>/)?.[0] ?? "";
  const historyNavigation = accuracyPage.match(/<nav aria-label="主导航">[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.equal((mainNavigation.match(/<a\b/g) ?? []).length, 2);
  assert.equal((historyNavigation.match(/<a\b/g) ?? []).length, 2);
  assert.doesNotMatch(`${mainNavigation}\n${historyNavigation}`, /github/i);
  const mainHeading = page.match(/<section class="page-heading">[\s\S]*?<\/section>/)?.[0] ?? "";
  const historyHeading = accuracyPage.match(/<section class="page-heading">[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(`${mainHeading}\n${historyHeading}`, /repository-link/);
  assert.doesNotMatch(`${page}\n${accuracyPage}`, /repository-link-label|repository-url/);
  assert.doesNotMatch(`${page}\n${accuracyPage}\n${styles}`, /repository-strip/);
  assert.match(accuracyPage, /styles\.css\?v=seo-i18n-1/);
  assert.match(styles, /\.header-brand-group\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/);
  assert.match(styles, /\.repository-link\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/);
  assert.match(styles, /\.page-shell\s*\{[\s\S]*?padding:\s*44px 24px 40px;/);
  assert.match(styles, /\.repository-mark[\s\S]*?filter:\s*invert\(1\)/);
  assert.match(page, /<legend>选择提醒内容<\/legend>/);
  assert.match(page, /预测时间有变化/);
  assert.match(page, /重置结果有更新/);
  assert.match(page, /概率达到我的门槛/);
  assert.match(page, /浏览器通知 · 也包含在稳定 Atom/);
  assert.match(page, /浏览器通知 · 可生成个性化 Atom/);
  assert.match(
    page,
    /id="notification-topic-probability"[^>]*aria-controls="notification-probability-rule"[^>]*aria-expanded="false"/,
  );
  assert.match(
    page,
    /id="notification-probability-rule"[^>]*data-enabled="false" hidden inert/,
  );
  assert.equal((page.match(/id="notification-threshold"/g) ?? []).length, 1);
  const thresholdInput = page.match(
    /<input\s+class="calibration-threshold-input"[\s\S]*?>/,
  )?.[0] ?? "";
  assert.notEqual(thresholdInput, "");
  assert.doesNotMatch(thresholdInput, /\shidden(?:\s|>)|aria-hidden|tabindex="-1"/);
  assert.match(
    page,
    /id="notification-threshold"[\s\S]*?type="range"[\s\S]*?min="1"[\s\S]*?max="99"[\s\S]*?step="1"/,
  );
  assert.match(
    page,
    /id="notification-probability-rule"[\s\S]*class="personalized-feed"[\s\S]*<\/section>\s*<aside class="feed-options"/,
  );
  assert.match(
    page,
    /href="\/feed\.xml" target="_blank" rel="noopener noreferrer">稳定事件流（权威时间窗 \+ 确认与修正）/,
  );
  assert.match(
    page,
    /href="\/feeds\/experimental\.xml" target="_blank" rel="noopener noreferrer">稳定事件 \+ 公共 4h 实验观察/,
  );
  assert.match(page, /公共实验源固定使用 4 小时 \/ 50% 的观察规则/);
  assert.match(
    styles,
    /calibration-card:has\(\.calibration-threshold-input:focus-visible\)[\s\S]*outline: 2px solid #86efac/,
  );
  assert.match(
    styles,
    /\.calibration-crosshair\[hidden\],[\s\S]*?\.calibration-marker\[hidden\][\s\S]*?display:\s*none/,
  );
  assert.match(page, /id="calibration-threshold-range"/);
  assert.match(page, /触发阈值 · 50%/);
  assert.match(
    styles,
    /\.calibration-threshold-range\s*\{[\s\S]*?fill:\s*url\(#calibration-threshold-fill\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 680px\)[\s\S]*?\.feed-option-links\s*\{[\s\S]*?flex:\s*none/,
  );
  assert.match(page, /滚动到此处后加载核心信号/);
  assert.match(appScript, /current_prediction_ref/);
  assert.match(appScript, /snapshot_url/);
  assert.match(appScript, /IntersectionObserver/);
  assert.match(appScript, /cache: "default"/);
  assert.doesNotMatch(appScript, /\/api\/forecast\/current/);
  assert.doesNotMatch(appScript, /\/api\/readiness/);
  assert.match(page, /href="\/accuracy">历史结果</);
  assert.match(accuracyPage, /<h1>历史结果<\/h1>/);
  assert.match(accuracyPage, /只列出已经确认发生的 Codex 重置结果/);
  assert.match(accuracyPage, /id="result-table"/);
  assert.match(accuracyPage, /accuracy\.js\?v=seo-i18n-1/);
  assert.match(accuracyPage, /确认发生时间/);
  assert.match(accuracyPage, /确认时间/);
  assert.match(accuracyPage, /状态与等级/);
  assert.match(accuracyScript, /\/api\/history\/results/);
  assert.match(accuracyScript, /rel="noopener noreferrer"/);
  assert.match(accuracyScript, /source\?\.published_at/);
  assert.match(accuracyScript, /请求超时/);
  assert.doesNotMatch(accuracyScript, /\/api\/evaluation\//);
  assert.doesNotMatch(
    `${accuracyPage}\n${accuracyScript}`,
    /历史精度|历史预测精度|历史事件召回率|概率误差|相对基线|校准曲线|高概率误报|策略非事件|提前量中位数|发布评估|评估已失效/,
  );
  const contentSecurityPolicy = pageResponse.headers.get("content-security-policy");
  assert.match(contentSecurityPolicy, /default-src 'self'/);
  assert.match(
    contentSecurityPolicy,
    /script-src[^;]*https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js/,
  );
  assert.match(
    contentSecurityPolicy,
    /script-src[^;]*https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\//,
  );
  assert.match(contentSecurityPolicy, /connect-src[^;]*'self'/);

  const issuedArtifact = await store.readBlob(
    twoWindowEvaluation.provenance.row_sample_ref,
  );
  const settlementCoverageKeys = new Set(
    issuedArtifact.rows.flatMap((row) =>
      row.settlement_coverage_assertion_refs ?? []
    ).map((ref) => `${ref.assertion_id}@${ref.revision}`),
  );
  const baselineOnlyRef = issuedArtifact.rows.flatMap((row) =>
    row.baseline_coverage_assertion_refs ?? []
  ).find((ref) =>
    !settlementCoverageKeys.has(`${ref.assertion_id}@${ref.revision}`)
  );
  assert.ok(baselineOnlyRef, "fixture needs baseline-only coverage provenance");
  const assertionsBeforeCorrection = await verifiedCoverageAssertionRevisions(
    store,
    config.model.outcome_coverage_providers,
    { config },
  );
  const baselineAssertion = assertionsBeforeCorrection.find((assertion) =>
    assertion.assertion_id === baselineOnlyRef.assertion_id &&
    assertion.revision === baselineOnlyRef.revision
  );
  assert.ok(baselineAssertion);
  await addCoverageInterval(
    store,
    baselineAssertion.provider,
    baselineAssertion.start,
    baselineAssertion.end,
    {
      assertion_id: baselineAssertion.assertion_id,
      asserted_at: addHours(now, 14),
      mode: baselineAssertion.mode,
      adequacy: "outcome_only",
      rationale: "test correction after the as-issued baseline cutoff",
    },
  );
  const correctedAssertions = await verifiedCoverageAssertionRevisions(
    store,
    config.model.outcome_coverage_providers,
    { config },
  );
  const verification = await verifyIssuedEvaluationArtifact(
    store,
    twoWindowEvaluation,
  );
  const compatibilityOptions = {
    champion: await store.readModel("champion"),
    outcomeRevisions: await store.all("reset_outcome", { latestOnly: false }),
    predictionRevisions: await store.all("prediction", { latestOnly: false }),
    settlementRevisions: await store.all("prediction_settlement", { latestOnly: false }),
    evaluationArtifactVerification: verification,
  };
  const strictCompatibility = assessEvaluationCompatibility(
    twoWindowEvaluation,
    config,
    correctedAssertions,
    compatibilityOptions,
  );
  assert.ok(
    strictCompatibility.reasons.includes("coverage_assertion_revision_superseded"),
  );
  const displayCompatibility = assessEvaluationCompatibility(
    twoWindowEvaluation,
    config,
    correctedAssertions,
    {
      ...compatibilityOptions,
      allowAsIssuedBaselineSuperseded: true,
    },
  );
  assert.equal(displayCompatibility.compatible, true);
  assert.ok(
    displayCompatibility.warnings.includes(
      "baseline_coverage_assertion_revision_superseded",
    ),
  );

  await store.writeState("champion-evaluation", null);
  await store.writeState("walk-forward-summary", null);
  await store.writeState("evaluation-summary", null);
  const preliminaryResponse = await fetch(`${base}/api/evaluation/summary`);
  const preliminary = await preliminaryResponse.json();
  assert.equal(preliminaryResponse.status, 200, JSON.stringify(preliminary));
  assert.equal(preliminary.reporting_status, "preliminary");
  assert.equal(preliminary.sample_gate.sample_threshold_passed, false);
  assert.equal(preliminary.metric_availability.brier_skill, false);
  assert.equal(preliminary.reporting_view.status, "available");
  assert.equal(preliminary.reporting_view.scope, "current_model_release");
  assert.equal(
    preliminary.reporting_view.source_evaluation_artifact_hash,
    preliminary.evaluation_artifact_hash,
  );
  assert.equal(preliminary.reporting_view.metrics.evaluated_windows, 2);
  assert.equal(preliminary.reporting_view.metrics.evaluated_events, 1);
  assert.equal(
    preliminary.reporting_view.sample_gate.sample_threshold_passed,
    false,
  );
  const [allEventsResponse, reportingEventsResponse] = await Promise.all([
    fetch(`${base}/api/evaluation/events`),
    fetch(`${base}/api/evaluation/events?scope=reporting`),
  ]);
  const allEvents = await allEventsResponse.json();
  const reportingEvents = await reportingEventsResponse.json();
  assert.equal(allEvents.scope, "all_history");
  assert.equal(reportingEvents.scope, "reporting");
  assert.equal(
    reportingEvents.events.length,
    preliminary.reporting_view.events.length,
  );
  assert.ok(allEvents.events.length >= reportingEvents.events.length);
  assert.equal((await getReadiness(store, config)).publication_ready, false);
  await store.writeState("issued-evaluation-summary", null);
  const historyWithoutEvaluationResponse = await fetch(`${base}/api/history/results`);
  const historyWithoutEvaluation = await historyWithoutEvaluationResponse.json();
  assert.equal(historyWithoutEvaluationResponse.status, 200);
  assert.deepEqual(historyWithoutEvaluation, history);
});

test("live coverage can fit a challenger while causal walk-forward remains pending", async (t) => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "reset-forecaster-evaluation-wait-",
  ));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ overrides: {
    runtime: {
      data_dir: directory,
      provisional_bootstrap: {
        enabled: false,
        minimum_outcomes: 3,
      },
    },
    model: {
      max_iterations: 450,
      minimum_outcomes: 3,
      minimum_live_evaluation_windows: 1008,
      minimum_live_evaluation_events: 20,
      outcome_coverage_providers: ["x"],
    },
  } });
  const store = await new JsonlStore(directory).init();
  const now = new Date("2026-07-25T20:07:30.000Z");
  const fixture = generateDemoHistory({ now, days: 42 });
  await new FixtureProvider({
    items: fixture,
    name: "x",
    now: () => now,
  }).collect(store);

  const result = await runPipeline(store, config, {
    now,
    collect: false,
    retrain: true,
  });

  assert.equal(result.status, "waiting_for_evaluation");
  assert.equal(result.training.succeeded, true);
  assert.equal(result.training.status, "waiting_for_evaluation");
  assert.equal(
    result.evaluation_waiting.reason_code,
    "walk_forward_coverage_cutoff_pending",
  );
  assert.equal(
    result.evaluation_waiting.evaluation_cutoff,
    "2026-07-25T20:00:00.000Z",
  );
  assert.equal(result.evaluation_waiting.evaluated_windows, 0);
  assert.equal(result.evaluation_waiting.minimum_evaluation_windows, 1008);
  assert.equal(result.evaluation_waiting.minimum_evaluation_events, 20);
  assert.equal(result.forecast, null);
  assert.ok(await store.readModel("challenger"));
  assert.equal(
    (await store.readModel("challenger")).training_cutoff,
    result.timing.knowledge_cutoff,
  );
  assert.equal(
    await store.readModel("champion", { invalidAsNull: true }),
    null,
  );
  assert.deepEqual(await store.all("prediction"), []);

  const firstChallenger = await store.readModel("challenger");
  assert.ok(firstChallenger.event_count >= 3);
  config.runtime.provisional_bootstrap.enabled = true;
  const earlyProvisional = await runPipeline(store, config, {
    now: addHours(now, 1),
    collect: false,
    retrain: true,
  });
  const refreshedChallenger = await store.readModel("challenger");
  assert.equal(earlyProvisional.status, "waiting_for_evaluation");
  assert.equal(earlyProvisional.training.succeeded, true);
  assert.ok(earlyProvisional.forecast?.prediction);
  assert.equal(
    earlyProvisional.forecast.prediction.data.model.validation_status,
    "provisional",
  );
  assert.equal(
    earlyProvisional.forecast.prediction.data.model.artifact_hash,
    refreshedChallenger.artifact_hash,
  );

  const repeated = await runPipeline(store, config, {
    now: addHours(now, 2),
    collect: false,
    retrain: false,
  });
  const reusedChallenger = await store.readModel("challenger");
  assert.equal(repeated.status, "waiting_for_evaluation");
  assert.equal(repeated.training.succeeded, false);
  assert.equal(repeated.training.skipped, true);
  assert.equal(repeated.training.reused_challenger, true);
  assert.equal(
    repeated.evaluation_waiting.reason_code,
    "walk_forward_fold_pending",
  );
  assert.equal(
    repeated.evaluation_waiting.evaluation_cutoff,
    "2026-07-25T22:00:00.000Z",
  );
  assert.equal(
    reusedChallenger.artifact_hash,
    refreshedChallenger.artifact_hash,
  );
  assert.equal(reusedChallenger.trained_at, refreshedChallenger.trained_at);
  assert.ok(repeated.forecast?.prediction);
  assert.equal(
    repeated.forecast.prediction.data.model.validation_status,
    "provisional",
  );
  assert.equal(
    repeated.forecast.prediction.data.model.artifact_hash,
    refreshedChallenger.artifact_hash,
  );
  assert.equal(
    await store.readModel("champion", { invalidAsNull: true }),
    null,
  );
  assert.equal((await store.all("prediction")).length, 2);
});
