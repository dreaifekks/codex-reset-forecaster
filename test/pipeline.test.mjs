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
  assert.match(page, /app\.js\?v=forecast-lazy-1/);
  assert.match(page, /styles\.css\?v=forecast-lazy-1/);
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
  assert.match(accuracyPage, /accuracy\.js\?v=history-results-2/);
  assert.match(accuracyPage, /确认发生时间/);
  assert.match(accuracyPage, /官方确认时间/);
  assert.match(accuracyScript, /\/api\/history\/results/);
  assert.match(accuracyScript, /rel="noopener noreferrer"/);
  assert.match(accuracyScript, /source\?\.published_at/);
  assert.match(accuracyScript, /请求超时/);
  assert.doesNotMatch(accuracyScript, /\/api\/evaluation\//);
  assert.doesNotMatch(
    `${accuracyPage}\n${accuracyScript}`,
    /历史精度|历史预测精度|历史事件召回率|概率误差|相对基线|校准曲线|高概率误报|策略非事件|提前量中位数|发布评估|评估已失效/,
  );
  assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'self'/);

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
