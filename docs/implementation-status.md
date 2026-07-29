# Implementation status

This file maps the confirmed MVP requirements to executable evidence. A checked
implementation item means the code path exists and is covered by the repository's
tests; it does not turn synthetic data into evidence of real-world accuracy.

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Provider-neutral collection | Direct X, RSSHub X timeline, X Search Gateway, historical monitor, manual author-timeline JSONL, and fixture adapters with cursors or explicit import clocks, revisioned observations, payload hashes/blobs, isolated failures, and explicit coverage boundaries | provider and data-integrity tests |
| RSSHub exact-evidence origin | Configured account posts/replies/reposts are ingested from JSON Feed with exact X status/author checks, wrapper-snowflake publication time, native relation preservation, conditional requests, and fail-closed ambiguity handling; self-explicit replies recover `primary_statement`, while parent-context-only replies bind the parent root with `derivation: "reply"` and cannot confirm outcomes or activate authority timing; the finite feed creates no outcome coverage or negative labels | RSSHub provider and integration tests |
| Versioned Tibo-authority outcome | `config/tibo-authority-live.json` defines the operational target as a qualifying platform-wide or unqualified general Codex completion statement from the configured Tibo identity, not all physical backend resets; narrower segments, banked vouchers, `started`, scheduled, expected, summary, and rumor claims remain outside the positive label | configuration, pipeline, and data-integrity tests |
| Delayed daily-ledger coverage | A count-reconciled UTC day may become `negative_label_eligible` only after day-end plus 36 hours and two actual fetch observations spanning at least six hours; pre-grid dates remain outcome discovery and promotion is never backdated | historical-provider and coverage tests |
| Standard records | Eight canonical record types, append-only revisions, exact references, UTC timestamps, half-open intervals, and explicit historical availability attestations | `schemas/reset-intel.schema.json`, `examples/`, `scripts/validate.mjs` |
| Evidence independence | Canonical X status identities collapse direct, Gateway, quote, repost, and summary copies to one root; a quote wrapper with its own reset claim is a new primary statement, while inherited quote text and summaries remain derived evidence | extractor, provider, and data-integrity tests |
| Codex experience taxonomy | Relevant issues and recoveries carry category, severity, lifecycle, affected scope/surfaces, workaround, and evidence basis, including security/privacy, data-integrity, and compatibility failures; they remain visible for audit while initially excluded from the forecast vector | relevance, extraction, API, and website tests |
| Impact follow-up episodes | Current experience revisions are grouped by stable topic and bounded time gap into append-only episode revisions with independent-root collapse, lifecycle history, and bounded freshness-decayed pressure; pressure remains display/audit-only and cannot alter the 14-feature champion | impact-episode, schema, pipeline, API, and website tests |
| Competitor release context | Model/coding-agent releases and limit changes carry kind, relevance, and stage; only direct/adjacent non-rumor events enter a maximum recency-decayed feature, so repost volume does not amplify it | relevance, extraction, and model-correctness tests |
| Historical cutoff safety | Feature, training, and evaluation paths select the exact revision available at the cutoff; outcome-conditioned discoveries are feature-ineligible; source publication time controls decay while availability controls visibility | cutoff, extraction, and model-correctness tests |
| Hourly survival model | Ridge logistic discrete-time hazard, smoothed renewal-periodic baseline, interval-censored likelihood, raw-unit coefficient priors converted into stored standardized coordinates, explicit optimizer convergence, versioned `[-3, 3]` standardized-feature clipping, and a frozen support gate that zeros inputs without at least three positive events and 24 negative hours or suppresses a near-perfect duplicate | feature-support, model unit, and correctness tests |
| Exact authority timing | One latest exact configured-author statement mixes versioned prior first-event mass into its asserted interval without also entering the learned intent/overlap vector; summaries and inherited quote evidence are excluded, denials cancel old windows, expired windows deactivate, compatible completed outcomes consume the intent and re-anchor recurrence, and walk-forward uses the same path | extraction and authority-timing tests |
| Completed-cycle transition | A visible confirmed outcome immediately consumes its independence lineage, discounts older independent evidence to half weight, re-anchors recurrence, and applies the live 0–12h refractory recovery before any new authority timing statement | evidence-epoch, refractory, and model-correctness tests |
| Live refit guard | A candidate refit is blocked before provisional issue or promotion when same-snapshot positive clip contributions combine past the limit, raw cumulative probability saturates at 4/24/72 hours, or an OOD probability anomaly occurs; an older provisional fallback must pass the same current guard | live-forecast-guard, readiness, and scheduler tests |
| Provisional bootstrap | The live profile immediately batch-fits eligible history at a frozen cutoff and may issue a forecast marked `validation_status: provisional` as soon as the fit converges and reaches its configured ten-outcome minimum, before the slower strict evaluation attempt finishes; readiness separates `serving_stage: provisional` from validated `publication_ready` and does not claim validated 80% recall | pipeline, readiness, schema, and configuration tests |
| Weekly forecast | One immutable prediction containing 168 contiguous future hourly slots and derived first-event, cumulative, no-reset, and complete rolling-4h probabilities where available | integration test and runtime validator |
| Forecast settlement | Append-only pending, positive, negative, or censored four-hour settlements with exact prediction/outcome refs and coverage evidence | settlement integration test |
| Model promotion | Rolling-origin evaluation uses one fixed alert budget per fold for both recall and false-alert accounting; promotion checks convergence, the current compatibility signature, paired folds, Brier skill, calibration, and challenger improvement | model-correctness and integration tests |
| Forecast website | 4h, 24h, and 7×24 projections of the same prediction, green intensity, exact tooltips, provenance/source freshness, an exact-source Tibo timeline (including unclassified posts), ranked impact episodes explicitly separated from reset probability, separate Codex-experience and competition evidence groups, and a deprecated one-version `community` API alias | API integration test and Playwright browser audit |
| Accuracy website | Clearly separated walk-forward and mature immutable as-issued evaluation, calibration chart, metrics and event table | API integration test and Playwright browser audit |
| Ten-minute operation | Non-overlapping 10-minute collection and hourly-slot feature/forecast refresh, exact coverage-recheck wakeups, at-most-daily batch train/evaluate attempt, frozen training cutoff, stable model fallback, Docker image and health endpoint | scheduler, pipeline, and Docker smoke tests |
| Personal quota optimizer | Deferred by confirmed MVP scope | `docs/personal-optimizer.md` |

## Local mechanics evidence

The fixed synthetic run below exercises the complete ingestion-to-publication path
without claiming real-world accuracy:

```bash
RESET_DATA_DIR=/tmp/codex-reset-forecaster-v023-20260722 \
  node src/cli.mjs demo-seed --now 2026-07-22T18:00:00Z
RESET_DATA_DIR=/tmp/codex-reset-forecaster-v023-20260722 \
  npm run demo:start
```

The resulting scores are deliberately not pinned in this document: they can change
when the algorithm or fixture changes and are printed by the command for that exact
run. The website labels them `SYNTHETIC DEMO`, and readiness keeps
`real_walk_forward_acceptance_proven` false.

## Invalidated historical score

An earlier local experiment inferred negative coverage from a contiguous date grid
on a third-party reset archive and selected precursor posts by following links from
known reset posts. That process was outcome-conditioned and could not prove that
unlisted hours were negatives. Its reported recall, Brier, calibration, false-alert,
and promoted-champion results are invalid as acceptance evidence.

The adapter now stores the complete HTML, parsed grid, hashes, and append-only
coverage assertion. Under the default archive profile, the assertion is
`outcome_only`, and linked discoveries carry `feature_eligible: false`. Neither
can create training negatives or historical forecast features.

The narrower `config/tibo-authority-live.json` profile uses a separate,
independently attested daily authority-ledger contract for the outcome “qualifying
Tibo completion statement.” A grid day starts pending and becomes
`negative_label_eligible` only when the same ledger is seen in at least two real
fetches separated by six hours or more and the final observation is at least 36
hours after UTC day-end. Days before the grid starts are still
outcome-discovery-only. `replay_available_at` is the later promotion fetch, not
day-end, so first deployment does not manufacture historical knowledge.
Previously saved evaluations and champions are rejected by version/compatibility
checks rather than silently reused.

## Provisional bootstrap and remaining validated acceptance

The Tibo-authority definition and delayed daily-ledger contract are implemented.
The live service now has eligible historical coverage and a compatible,
converged challenger trained from it. The live profile now permits that existing
history to be batch-fit immediately and, once its ten-outcome bootstrap minimum is
met, served as a clearly labeled provisional forecast. It does not wait for future
wall-clock data merely to start training. Strict causal walk-forward and immutable
as-issued validation continue in the background without blocking that provisional
use.

The current honest state is still not `validated`: no causal out-of-sample fold has
matured under the new availability clock, and no compatible champion satisfies the
original validation gate. A provisional response therefore must not say that 80%
event-window recall or production accuracy has already been verified.

Validated live accuracy still requires all of the following:

1. keep the service running with `config/tibo-authority-live.json` so each new
   closed UTC ledger completes the 36-hour/two-fetch/six-hour stability gate;
2. keep collecting adequate
   `negative_label_eligible` coverage;
3. evaluate at least 1,008 hourly windows and 20 eligible events;
4. report live settlements under `as_issued` without substituting archive replay;
5. pass the frozen fixed-budget recall, Brier-skill, calibration, convergence, and
   compatibility gates on data that did not influence the policy design.

Provider signals continue to refresh hourly-slot as-of features and forecasts on
the 10-minute pipeline cadence. Model parameters are batch-refit at most every 24
hours from labels mature at the frozen training cutoff. Confirmed positive
intervals do not wait for negative-label coverage to extend across the event hour;
complete coverage is still mandatory before any hour can become a negative example.
Records that arrive during a fit are left for the next batch rather than
restarting the running optimizer. Each due batch performs the training and
compatible walk-forward evaluation attempt in the same pipeline run; there is no
separate weekly evaluation scheduler.

Use `node src/cli.mjs status` or `GET /api/readiness` to inspect those gates without
printing credentials. Readiness reports synthetic-only and outcome-only data
separately and sets `real_walk_forward_acceptance_proven` only for a passing,
compatible evaluation using currently configured, non-synthetic,
negative-label-eligible coverage. It also blocks publication for stale forecasts,
stale exact sources, a current pipeline error, or an incompatible champion.
