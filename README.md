# Codex Reset Forecaster

Design baseline for a provider-neutral system with a versioned forecast outcome.
The live profile in `config/tibo-authority-live.json` estimates when the configured
Tibo identity will publish a qualifying, platform-wide Codex reset/refill
completion statement. It does not claim to observe every physical backend reset.
The versioned live scope policy accepts either an explicit platform-wide statement
or a completed general Codex reset statement with no narrower plan, account, or
region qualifier. Banked vouchers and narrower segments stay outside the target.

The repository contains the contracts plus a zero-dependency Node.js prototype:
direct X, RSSHub X timeline, X Search Gateway, historical-monitor, and fixture
adapters; append-only records and acquisition audit data; deterministic extraction
and adjudication; feature snapshots; a regularized hourly hazard model; a
walk-forward promotion gate; JSON APIs; and the forecast/evaluation website.
Personal quota integration remains deferred.

The operating policy separates immediate usefulness from validated performance. A
first deployment batch-fits a clearly labeled `provisional` bootstrap from the
eligible historical data already available at its training cutoff; it does not wait
for weeks of new wall-clock data before it may train or be inspected. Strict causal
walk-forward and immutable `as_issued` evidence continue accumulating in the
background. Until the original 1,008-window, 20-event promotion gate passes, the
bootstrap must not claim that 80% event-window recall or production accuracy has
been validated.

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
  official status pages, user-report sources, and other vendors are
  interchangeable providers rather than the core model.
- The checked-in RSSHub X timeline adapter is an exact-evidence transport for
  configured accounts' posts, replies, and reposts. A reply whose own text makes
  an explicit relevant claim can be a `primary_statement`; a reply that is relevant
  only through its parent is bound to the parent's evidence root and remains
  derivative with `derivation: "reply"`, so it cannot confirm an outcome or
  activate authority timing. A qualifying exact completion statement may support
  a positive outcome after adjudication, but the finite feed never establishes
  outcome coverage or a negative label.
- Text models extract stable claims. A statistical hazard model produces the final
  probability.
- Search matches are candidates, not signals. A versioned provider-neutral
  relevance gate checks the post and any exact reply/quote context first; personal
  quota errors, requests, generic discussion, and unresolved ambiguous replies do
  not enter features.
- The extractor recognizes the versioned Codex mode aliases `ultra` and `/fast`
  inside relevant reset claims. A post that quotes older evidence still owns a
  `primary_statement` when its own text makes the reset claim; a wrapper that only
  inherits quoted text remains derivative.
- New provider intelligence is incorporated into as-of features and a fresh
  forecast on the 10-minute pipeline cadence; the forecast slots and conditional
  hazards remain hourly, and this refresh does not wait for parameter retraining.
- A timed authority statement raises probability only while its asserted window
  remains active. Window expiry or a compatible confirmed reset removes it from
  the probability path; the confirmed reset then anchors the next recurrence
  cycle instead of leaving the pre-reset alert elevated. Exact authority timing is
  excluded from the learned baseline so the same statement is not counted twice.
- The optional X Search Gateway currently defaults to `grokbuild`. Both Grokbuild
  and the `hermes` rollback path are summary/context-only inputs: they may adjust
  features but cannot confirm an outcome or establish negative-label coverage.
  Its independent context queries run concurrently behind a 30-minute provider
  gate; the exact RSSHub Tibo timeline has a five-minute provider gate. The
  current shared scheduler checks both on 10-minute boundaries, so these gates do
  not imply independent five-minute polling.
- Context collection targets Codex experience issues and recoveries, classified by
  impact and severity, including security/privacy, data-integrity, and
  compatibility failures, plus non-rumor competitor model or coding-agent releases.
  Independent issue evidence is also grouped into append-only impact episodes whose
  bounded, freshness-decayed pressure shows whether a problem is persisting,
  spreading, mitigating, or resolved over time.
  Community post volume, momentum, resonance, and disagreement are not prediction
  features. Experience reports are initially display/audit evidence; a competitor
  event contributes at most one recency-decayed value after dependency collapse,
  so repost volume cannot amplify it. Impact-episode pressure is likewise an
  intelligence-layer measurement, not the current reset probability.
- Model parameters are batch-refit at most once every 24 hours and only from
  labels that are mature and available at the frozen training cutoff. Confirmed
  positive intervals can enter immediately; only negative hours require complete
  outcome coverage. Records that arrive while a fit is running enter the next
  batch instead of restarting the current fit.
- A learnable feature must have non-zero support in at least three independent
  positive event intervals and 24 covered negative hours. Unsupported,
  zero-variance, or near-perfect duplicate columns are fixed to zero and audited
  in the model artifact rather than extrapolated from one coincidence.
- The live guard checks raw cumulative probability at 4, 24, and 72 hours and
  combines same-snapshot clip-bound contributions. A rejected old provisional
  model is not silently restored.
- `provisional` means usable bootstrap, not measured 80% performance. `validated`
  remains reserved for the original causal/as-issued sample and quality gates.
- Personal quota windows and expiring reset vouchers are a downstream optimization
  layer and do not redefine the platform forecast. This layer is not part of the
  initial website MVP.

## Confirmed MVP

The first website release covers:

- exact collection of configured Tibo posts, replies, and reposts through direct
  X or RSSHub, with provider-neutral provenance;
- Codex experience issues and recoveries classified by severity, lifecycle,
  affected scope, and surface;
- non-rumor competing-model and coding-agent announcements, previews, and
  releases, collapsed to independent evidence roots;
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
  -> topic/context relevance decisions
  -> normalized claims
  -> append-only impact episodes for issue/recovery follow-up
  -> event candidates and evidence-dependency graph
  -> 10-minute as-of refreshes of hourly-slot feature snapshots
  -> hourly hazard and rolling four-hour forecast
  -> confirmed outcomes
  -> immediate historical batch bootstrap when needed
  -> append-only prediction settlements and background causal/as-issued validation
  -> at-most-daily batch train/evaluate attempts
```

The bootstrap and validation paths share the same leakage, outcome-confirmation,
coverage, and lineage rules. The distinction is the strength of the performance
claim: provisional use is allowed before the validation sample matures, but it is
displayed as unvalidated and cannot inherit an exploratory or replay score as an
80% claim.

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

Version `0.4.0` with canonical contract `reset-intel/0.2` implements the website
prototype and keeps the personal optimizer as a post-MVP TODO. Synthetic fixtures
exercise the mechanics only. Any model or evaluation artifact created under the
older inferred-archive-coverage policy is incompatible with the current feature,
deduplication, coverage, and evaluation contracts and must not be served as current
evidence. The Tibo-authority outcome definition and delayed daily-ledger coverage
contract are checked in. The live profile batch-fits existing eligible history
immediately as a provisional bootstrap; no claim of validated 80% performance
follows from that fit. The `validated` status still requires at least 1,008
evaluated hourly windows, 20 eligible events, and a compatible challenger that
passes the fixed-policy walk-forward and calibration gates.

The current checked-in configuration contract is `provider-config/0.3.3`, with
`reset-taxonomy/0.3.1`, `reset-features/0.3.1`, `reset-dedup/0.2.3`, and extractor
rules `0.3.2` (`reset-extract/rules-0.3.2`). The model contract also binds the
`winsorized-zscore/1` transform:
standardized feature values are clipped to `[-3, 3]` during fitting and live
inference. Coefficient priors use raw-feature logit units and are converted into
the standardized training coordinates recorded in each artifact.

Once a qualifying completion outcome is visible, the live profile immediately
starts a new recurrence cycle. It consumes the completed evidence lineage, halves
the carry-over of independent evidence published before the outcome boundary, and
applies a versioned 12-hour refractory recovery to near-term hazards. A new exact
authority statement after completion may still raise the next-cycle forecast.
