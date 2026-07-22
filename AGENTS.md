# Repository instructions

## Project role

This repository owns platform-level Codex reset timing intelligence: provider
normalization, evidence lineage, confirmed outcome records, feature snapshots,
probability forecasts, calibration, and the interfaces consumed by later personal
optimization.

## Hard boundaries

- Do not make a specific watchdog, X account, community, or vendor API the core
  abstraction. Each source is a provider adapter.
- Do not treat an announcement, rumor, or LLM judgment as a confirmed reset.
- Do not train directly on raw post counts. Collapse quotes, reposts, and derivative
  articles to independent evidence roots.
- Do not let records learned after a forecast cutoff enter that historical forecast.
- Do not use LLM extraction confidence as the reset probability.
- Do not start with reinforcement learning. The reset forecast is an online,
  supervised, discrete-time survival problem. A later notification policy may use a
  bandit or decision process.
- Do not put personal quota state or reset-voucher policy into the platform model.
  Those belong to the downstream optimizer described in
  `docs/personal-optimizer.md`.

## Contract invariants

- Store canonical timestamps as RFC 3339 UTC.
- Store all intervals as half-open `[start, end)` ranges.
- Keep `published_at`, `first_seen_at`, `available_at`, asserted event time,
  occurred event time, and `known_at` semantically separate.
- Canonical records are append-only. Corrections create a new revision and point to
  the exact superseded revision.
- `event_candidate` is a hypothesis. Only `reset_outcome` can settle a label.
- Windows without adequate outcome coverage are `pending` or `censored`, never
  automatic negatives.
- Version provider configuration, taxonomy, extractor prompt/model, deduplication,
  feature schema, model, calibrator, and time-zone database inputs.
- Keep probability, epistemic uncertainty, data quality, and extraction confidence
  as separate fields.

## Modeling rules

- Model hourly conditional hazard. Derive rolling four-hour probability from the
  hourly hazards.
- Do not learn 168 unrelated hour-of-week parameters. Use a smoothed periodic
  baseline such as Fourier features plus strongly regularized intelligence features.
- Use only information with `available_at <= knowledge_cutoff`.
- Evaluate with rolling-origin / walk-forward predictions grouped by event or week.
- Prefer Brier score, log loss, calibration, event recall, false alerts, and useful
  lead time over accuracy.
- A challenger replaces the champion only after it improves out-of-sample
  probability quality and calibration.

## Verification

Run before committing contract changes:

```bash
node scripts/validate.mjs
git diff --check
```

Keep documentation, examples, and `schemas/reset-intel.schema.json` aligned whenever
a canonical field or enum changes.
