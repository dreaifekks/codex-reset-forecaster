# Design baseline

This document records the design baseline and the current product decisions. The
public overview lives in the [README](../README.md); the detailed contracts are in
[architecture](architecture.md), [data contract](data-contract.md),
[model contract](model-contract.md), [notifications](notifications.md), and
[product requirements](product-requirements.md). Current versions and acceptance
gates are tracked in [implementation status](implementation-status.md).

## Scope

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
walk-forward promotion gate; JSON APIs; forecast plus confirmed-history pages; and
a channel-neutral publication ledger for Atom, Web Push, and Telegram. Personal
quota integration remains deferred.

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
- An authenticated host operator may explicitly attest that a linked authority
  reset candidate completed at a supplied UTC time. That append-only path is
  labeled `silver` and `operator_confirmation`; it re-anchors recurrence and the
  post-outcome refractory curve, but is never presented as an official statement.
- The internal time base is 168 hourly anchors per week.
- At each hourly anchor, the product-facing forecast is the probability of the
  selected qualifying outcome during the next four hours.
- The website derives its next-4-hour, next-24-hour, and seven-day `[7][24]`
  heatmaps from the same 168-slot forecast rather than producing separate models.
- Notifications are a non-canonical projection. Stable delivery includes exact
  authority windows and confirmed outcomes/corrections; probability threshold
  watches remain experimental opt-in and can never be presented as outcomes.
  The website and Telegram bot are result UI/read models: they may lazily fetch
  and cache only the needed forecast projections, but cannot write canonical
  records or contribute to training, labels, calibration, or publication triggers.
  The HTTP event loop serves an in-memory last-good projection only; collection,
  JSONL traversal, settlement, evaluation, and fitting run in a dedicated worker
  isolate and atomically replace that projection only after it is complete.
- Provider adapters only collect and normalize observations. Watchdogs, X feeds,
  official status pages, user-report sources, and other vendors are
  interchangeable providers rather than the core model.
- The checked-in RSSHub X timeline adapter is an exact-evidence transport for
  configured accounts' posts, replies, and reposts. A reply whose own text makes
  an explicit relevant claim can be a `primary_statement`; a reply that is relevant
  only through its parent is bound to the parent's evidence root and remains
  derivative with `derivation: "reply"`, so it cannot confirm an outcome or
  activate authority timing. A marker whose exact relation is missing is retained
  as an auditable, feature-ineligible quarantine item instead of failing every
  otherwise valid item in the feed. A qualifying exact completion statement may
  support a positive outcome after adjudication, but the finite feed never
  establishes outcome coverage or a negative label.
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
  Its independent context queries run concurrently behind a six-hour provider
  gate; the exact RSSHub Tibo timeline has a five-minute provider gate. The
  current shared scheduler checks both on 10-minute boundaries, so these gates do
  not imply independent five-minute polling.
- An exhausted Grok Build usage balance opens a persisted six-hour circuit
  breaker: optional community searches are skipped without failing the pipeline,
  while the last successful source timestamp remains unchanged and can age stale.
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
- immutable prediction history, internal evaluation for promotion, and a public
  history page containing only confirmed reset results and their sources;
- append-only publication events consumed by the default Atom feed, optional Web
  Push, and separate Chinese and English public Telegram bots that share the same
  forecaster while keeping delivery state isolated, with experimental probability
  alerts kept outside default delivery.

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
  -> non-canonical publication events for delivery channels
  -> immediate historical batch bootstrap when needed
  -> append-only prediction settlements and background causal/as-issued validation
  -> at-most-daily batch train/evaluate attempts
```

The bootstrap and validation paths share the same leakage, outcome-confirmation,
coverage, and lineage rules. The distinction is the strength of the performance
claim: provisional use is allowed before the validation sample matures, but it is
displayed as unvalidated and cannot inherit an exploratory or replay score as an
80% claim.
