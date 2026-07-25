# Implementation status

This file maps the confirmed MVP requirements to executable evidence. A checked
implementation item means the code path exists and is covered by the repository's
tests; it does not turn synthetic data into evidence of real-world accuracy.

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Provider-neutral collection | Direct X, X Search Gateway, historical monitor, and fixture adapters with cursors, revisioned observations, payload hashes/blobs, isolated failures, and explicit coverage assertions | provider and data-integrity tests |
| Versioned Tibo-authority outcome | `config/tibo-authority-live.json` defines the operational target as a qualifying platform-wide or unqualified general Codex completion statement from the configured Tibo identity, not all physical backend resets; narrower segments, banked vouchers, `started`, scheduled, expected, summary, and rumor claims remain outside the positive label | configuration, pipeline, and data-integrity tests |
| Delayed daily-ledger coverage | A count-reconciled UTC day may become `negative_label_eligible` only after day-end plus 36 hours and two actual fetch observations spanning at least six hours; pre-grid dates remain outcome discovery and promotion is never backdated | historical-provider and coverage tests |
| Standard records | Seven canonical record types, append-only revisions, exact references, UTC timestamps, half-open intervals, and explicit historical availability attestations | `schemas/reset-intel.schema.json`, `examples/`, `scripts/validate.mjs` |
| Evidence independence | Canonical X status identities collapse direct, Gateway, quote, repost, and summary copies to one root; summaries remain derived evidence | extractor, provider, and data-integrity tests |
| Historical cutoff safety | Feature, training, and evaluation paths select the exact revision available at the cutoff; outcome-conditioned discoveries are feature-ineligible; source publication time controls decay while availability controls visibility | cutoff, extraction, and model-correctness tests |
| Hourly survival model | Ridge logistic discrete-time hazard, smoothed renewal-periodic baseline, interval-censored likelihood, explicit optimizer convergence, and separately labeled uncertainty | model unit and correctness tests |
| Weekly forecast | One immutable prediction containing 168 contiguous future hourly slots and derived first-event, cumulative, no-reset, and complete rolling-4h probabilities where available | integration test and runtime validator |
| Forecast settlement | Append-only pending, positive, negative, or censored four-hour settlements with exact prediction/outcome refs and coverage evidence | settlement integration test |
| Model promotion | Rolling-origin evaluation uses one fixed alert budget per fold for both recall and false-alert accounting; promotion checks convergence, the current compatibility signature, paired folds, Brier skill, calibration, and challenger improvement | model-correctness and integration tests |
| Forecast website | 4h, 24h, and 7×24 projections of the same prediction, green intensity, exact tooltips, provenance and source freshness | API integration test and Playwright browser audit |
| Accuracy website | Clearly separated walk-forward and mature immutable as-issued evaluation, calibration chart, metrics and event table | API integration test and Playwright browser audit |
| Hourly operation | Non-overlapping hourly scheduler with exact coverage-recheck wakeups, daily retraining attempt, stable champion fallback, Docker image and health endpoint | scheduler unit test and Docker smoke test |
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

## Remaining live acceptance

The Tibo-authority definition and delayed daily-ledger contract are implemented,
but the current honest state is still not publication-ready. A first run creates
pending daily candidates; it does not immediately create eligible historical
negatives. There is not yet a compatible real-data evaluation or champion that
satisfies the publication gate.

Public live accuracy requires all of the following:

1. run the service with `config/tibo-authority-live.json` and keep observing the
   same closed UTC ledgers through the 36-hour/two-fetch/six-hour stability gate;
2. keep collecting immutable hourly predictions and adequate
   `negative_label_eligible` coverage;
3. evaluate at least 1,008 hourly windows and 20 eligible events;
4. report live settlements under `as_issued` without substituting archive replay;
5. pass the frozen fixed-budget recall, Brier-skill, calibration, convergence, and
   compatibility gates on data that did not influence the policy design.

Use `node src/cli.mjs status` or `GET /api/readiness` to inspect those gates without
printing credentials. Readiness reports synthetic-only and outcome-only data
separately and sets `real_walk_forward_acceptance_proven` only for a passing,
compatible evaluation using currently configured, non-synthetic,
negative-label-eligible coverage. It also blocks publication for stale forecasts,
stale exact sources, a current pipeline error, or an incompatible champion.
