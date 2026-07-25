# Codex Reset Forecaster

Design baseline for a provider-neutral system with a versioned forecast outcome.
The live profile in `config/tibo-authority-live.json` estimates when the configured
Tibo identity will publish a qualifying, platform-wide Codex reset/refill
completion statement. It does not claim to observe every physical backend reset.

The repository contains the contracts plus a zero-dependency Node.js prototype:
direct X, X Search Gateway, historical-monitor, and fixture adapters; append-only
records and acquisition audit data; deterministic extraction and adjudication;
feature snapshots; a regularized hourly hazard model; a walk-forward promotion
gate; JSON APIs; and the forecast/evaluation website. Personal quota integration
remains deferred.

The live profile is implemented, but a first deployment begins with pending daily
coverage. The repository does not yet contain the 1,008 evaluated hourly windows
and 20 eligible events required to claim measured forecasting accuracy or
production publication readiness.

## Current decisions

- Outcome meaning is versioned rather than tied to a provider adapter. The current
  live deployment target is a qualifying completion statement from the configured
  Tibo identity.
- A `started` statement, schedule, expectation, rumor, summary, or model judgment
  is not a positive outcome.
- The internal time base is 168 hourly anchors per week.
- At each hourly anchor, the product-facing forecast is the probability of the
  selected qualifying outcome during the next four hours.
- The website derives its next-4-hour, next-24-hour, and seven-day `[7][24]`
  heatmaps from the same 168-slot forecast rather than producing separate models.
- Provider adapters only collect and normalize observations. Watchdogs, X feeds,
  official status pages, community sources, and other vendors are interchangeable
  providers rather than the core model.
- Text models extract stable claims. A statistical hazard model produces the final
  probability.
- New intelligence may change the current forecast immediately. Model parameters
  change only after an outcome is confirmed and the prediction can be settled.
- Personal quota windows and expiring reset vouchers are a downstream optimization
  layer and do not redefine the platform forecast. This layer is not part of the
  initial website MVP.

## Confirmed MVP

The first website release covers:

- collection of Tibo posts and a configured set of relevant X community sources;
- contextual signals such as competing-vendor model announcements and changes in
  independent community discussion;
- provider-neutral normalization, provenance tracking, and dependency-aware
  deduplication;
- a small, strongly regularized hourly hazard model;
- a single 168-hour forecast rendered as 4-hour, 24-hour, and seven-day heatmaps;
- immutable prediction history and an evaluation page for calibration, Brier
  score, event-window recall, false alerts, and useful lead time.

The MVP does not include user accounts, personal five-hour or weekly quota state,
reset-voucher inventory, or personalized voucher recommendations. Those remain a
separate follow-up described in `docs/personal-optimizer.md`.

## Core flow

```text
providers
  -> append-only raw observations
  -> normalized claims
  -> event candidates and evidence-dependency graph
  -> as-of feature snapshots
  -> hourly hazard and rolling four-hour forecast
  -> confirmed outcomes
  -> append-only prediction settlements, calibration, and controlled model updates
```

## Repository layout

```text
AGENTS.md                    Repository boundaries and working rules
docs/architecture.md        System components and lifecycle
docs/data-contract.md       Canonical records, timestamps, and provenance
docs/model-contract.md      Forecast target, model, training, and evaluation
docs/product-requirements.md
                             Confirmed MVP scope and website surfaces
docs/personal-optimizer.md  Later personal quota/voucher optimization interface
docs/operations.md          Live collection, scheduling, API, and Docker operation
docs/implementation-status.md
                             Requirement-to-verification matrix and external gates
schemas/reset-intel.schema.json
                             JSON Schema for the canonical record envelope
examples/                   Provider-neutral example records
scripts/validate.mjs        Zero-dependency contract checks
```

## Validate

```bash
node scripts/validate.mjs
```

## Run

```bash
npm test
RESET_DATA_DIR=/tmp/reset-forecaster-demo npm run demo:seed
RESET_DATA_DIR=/tmp/reset-forecaster-demo npm run demo:start
```

See `docs/operations.md` before enabling live X collection. Synthetic demo results
validate implementation mechanics only and are never accepted as real-world model
accuracy. The dedicated demo start command loads the same frozen model contract
used by `demo:seed`; ordinary `npm start` deliberately keeps the live contract.

To import the historical monitor as outcome-discovery evidence under the default
archive profile (network access required):

```bash
export RESET_CONFIG="$PWD/config/archive-evaluation.example.json"
export RESET_DATA_DIR="$PWD/data/archive"
node src/cli.mjs ingest-archive
node src/cli.mjs process
node src/cli.mjs status
```

The generated archive data is ignored by Git. Preserve that data directory if an
exact audit of a particular run is required. The adapter saves the source HTML,
parsed date grid, hashes, and verification payloads, but its date grid is
`outcome_only`: it does not prove that hours without listed posts are true
negatives. Training therefore refuses to use that source for negative labels
unless a separate, explicit completeness attestation is configured and audited.
Linked posts discovered from a known outcome are retained only as
outcome-conditioned audit evidence and are excluded from forecast features.

For the live Tibo-authority profile, select the checked-in deployment config
explicitly:

```bash
export RESET_CONFIG="$PWD/config/tibo-authority-live.json"
export RESET_DATA_DIR="$PWD/data/tibo-authority"
node src/cli.mjs ingest-archive
node src/cli.mjs process
node src/cli.mjs status
```

This profile uses the archive's UTC daily grid as a versioned authority ledger,
not as proof of every physical reset. A grid day can become
`negative_label_eligible` only after day-end plus 36 hours and after at least two
actual fetches of the same ledger separated by six hours or more. Dates before the
grid begins remain outcome-discovery-only. The first live import therefore leaves
eligible days pending, and any later promotion records its real fetch time instead
of backdating coverage to day-end. See `docs/operations.md` for service switching
and restart commands.

## Status

Version `0.2.0` with canonical contract `reset-intel/0.2` implements the website
prototype and keeps the personal optimizer as a post-MVP TODO. Synthetic fixtures
exercise the mechanics only. Any model or evaluation artifact created under the
older inferred-archive-coverage policy is incompatible with the current feature,
deduplication, coverage, and evaluation contracts and must not be served as current
evidence. The Tibo-authority outcome definition and delayed daily-ledger coverage
contract are checked in, but the current honest state remains not ready: initial
coverage is pending, and publication still needs at least 1,008 evaluated hourly
windows, 20 eligible events, and a compatible challenger that passes the
fixed-policy walk-forward and calibration gates.
