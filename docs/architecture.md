# Architecture

## Objective

Estimate the conditional probability of a versioned operational outcome in each
upcoming time slot, with a primary product view of the next seven days. The current
live profile defines that outcome as a qualifying platform-wide Codex reset/refill
completion statement from the configured Tibo identity; it is not a claim about
every physical backend reset.

The initial product is a website with current 4-hour, 24-hour, and seven-day
heatmaps plus a historical forecast-evaluation page. Personal quota and voucher
optimization is deferred.

The forecaster is provider-neutral. An existing reset watchdog can be referenced or
wrapped as one provider, but its state or notification behavior is not the system of
record.

## Components

### 1. Provider adapters

Each adapter implements the conceptual interface:

```text
poll(cursor) -> RawItem[]
normalize(raw) -> raw_observation
health() -> source-health observation
```

Adapters own cursors, network retries, idempotent collection, canonical URLs, and
raw payload references. They do not decide whether a reset is likely.

Initial provider classes may include:

- official product/status/changelog sources;
- named product-team social accounts;
- X, Reddit, Hacker News, and other community feeds;
- release and public-development activity sources;
- other model vendors, retained under their own subject vendor and product.

The MVP begins with an X adapter. Its configuration identifies a Tibo account as
the primary confirmation source and a separate set of community and ecosystem
sources as context. This source choice does not change the provider-neutral record
or adapter contracts.

An optional X Search Gateway adapter can supply additional current context. The
current default upstream is `grokbuild`, backed by the gateway's local Grok CLI.
Grokbuild and the `hermes` rollback upstream both return search-derived summaries,
so their results use a summary media type and are always treated as aggregator
signals: they cannot confirm an outcome, receive original-Tibo feature authority,
or assert observation coverage. An exact text provider such as SocialData may
preserve a qualifying Tibo statement, but
gateway search still cannot establish negative coverage because its result set is
not an exhaustive timeline.

The disabled-by-default historical-monitor adapter is an outcome-discovery source.
It saves the complete source HTML and parsed grid, verifies archived source
identities and timestamps, requires each UTC day's parsed item count to match the
page's `data-count`, and emits append-only coverage assertions. Under
`config/archive-evaluation.example.json`, its daily grid remains `outcome_only`;
contiguity alone does not prove the absence of an unlisted event. Links followed
from known outcome posts are explicitly outcome-conditioned and
feature-ineligible.

`config/tibo-authority-live.json` adds a narrower, versioned contract for the
qualifying-Tibo-completion target. Each grid day has one count-reconciled authority
ledger. It may advance from pending discovery to
`negative_label_eligible` only after the ledger is observed in at least two real
fetches separated by six hours or more and the final fetch is no earlier than 36
hours after UTC day-end. Days before the archive's first grid date remain
outcome-discovery-only. The promotion time is the actual later fetch time, so an
initial deployment cannot backfill those days as information that was known at
day-end.

Direct X timeline pagination also defaults to `outcome_only`: exhausting every
page proves what an account posted, not that every platform reset must have been
posted. It may produce negative-label coverage only under the supported,
versioned outcome-exhaustiveness contract and a separately pinned independent
attestation covering the exact target, confirmation identity set, interval, and
expiry.

### 2. Append-only intelligence log

Every collection, extraction, event hypothesis, outcome, feature snapshot,
prediction, and prediction settlement is written as an immutable, versioned
record. This permits exact as-of replay and prevents a late backfill from silently
changing an old forecast.

### 3. Claim extraction

A versioned rule/LLM extractor converts text into a small taxonomy:

- event type;
- phase and stance;
- product and affected scope;
- asserted time range and its precision;
- source role and evidence provenance;
- extraction confidence.

Product is not copied from the model target. The extractor distinguishes Codex,
ChatGPT Work, unknown, and explicit multi-product statements. Only Codex or a
multi-product statement explicitly containing Codex can confirm a Codex outcome.

The active extractor contract is configuration, not a hidden code constant. Its
`model`, `model_version`, `prompt_version`, and semantic policy hash are bound to
every normalized signal and into model artifacts and evaluation provenance. The
hash covers the normalized target and stable provider-neutral
identity/role/confirmation policy. Upgrading the extractor or changing that
semantic policy replays every exact raw-observation revision.

The extractor does not emit the final reset probability.

### 4. Event linking and evidence dependencies

Deterministic relationships are linked first: canonical X status IDs across
providers, identical URLs, native quotes, reposts, thread identifiers, and exact
content hashes. Semantic linking then uses subject vendor, product, event type,
overlapping asserted times, and constrained text similarity.

The linker records whether evidence is independent, quoted, reposted, summarized,
supporting, or contradicting. Twenty derivative reports from one original post
remain one independent evidence root.

### 5. As-of feature builder

At every cutoff, the builder creates immutable features using only record revisions
available by that cutoff. Availability decides whether information may be seen;
source publication/asserted event time decides its age. A newly fetched summary of
an old post therefore does not become a fresh event. Features summarize authority,
recency, independence, contradiction, explicit timing overlap, activity anomalies,
release/incident proximity, and provider health.

The current champion deliberately trains on ten low-dimensional fields. Its main
baseline is a causal renewal-periodic kernel built from outcomes already known at
the cutoff: a Gaussian kernel over historical reset gaps in log-hours, a circular
UTC hour-of-day kernel, and a wider circular hour-of-week kernel. Explicit asserted
time overlap and configured-author reset intent or incident evidence have small,
versioned coefficient priors. Community momentum, disagreement, competitor
release context, and provider quality remain available but start at a zero prior.

### 6. Forecaster and calibrator

The first model family is a ridge discrete-time logistic hazard model. Ridge
penalties shrink coefficients toward versioned domain priors rather than assuming
every prior mean is zero. Training records optimizer convergence and refuses
promotion when it has only exhausted the iteration limit. It produces hourly
hazards, first-event mass, cumulative probability, and a rolling four-hour
probability. Probability, epistemic uncertainty, source/data quality, and
extraction confidence remain separate. A separately versioned calibrator is fitted
only to saved out-of-sample predictions.

Bootstrap fitting and performance validation are separate lifecycle concerns. When
eligible historical labels already exist, the service may batch-fit a provisional
model immediately at a frozen cutoff; training does not need to wait for new
wall-clock observations merely to begin. That artifact is useful for provisional
forecasts, but its existence is not evidence that the 80% event-window-recall gate
has passed. Causal walk-forward folds and immutable as-issued settlements continue
to accumulate independently until the validated gate is satisfied.

### 7. Outcome adjudication and settlement

A source post remains evidence rather than being stored directly as an outcome.
The versioned adjudicator creates the separate canonical outcome only when the
configured operational definition is satisfied, and it retains the observed time
interval and label grade. Missing coverage yields censored windows.

For `config/tibo-authority-live.json`, an exact primary completion statement from
the configured Tibo identity qualifies when it explicitly covers the platform or
describes a general Codex reset with no narrower plan, account, or region
qualifier. That versioned statement policy is the operational target; it does not
imply that the system covers every physical backend reset. Banked vouchers,
narrower segments, `started` statements, schedules, expectations, hints, rumors,
summaries, and model judgments remain candidates or signals and cannot create a
positive outcome. Publication time, asserted event time, canonical occurrence
interval, availability, and system knowledge time remain distinct.

Each issued forecast's current four-hour window receives an append-only settlement.
Before maturity it is pending; after maturity it is positive, negative, or censored
according to confirmed outcomes and confirmation-source coverage. Later evidence
creates a superseding revision rather than mutating the old assessment.

### 8. Personal optimizer

This component is a post-MVP TODO. The platform forecast is consumed by a later
rolling optimizer together with a user's quota state, regular reset window,
demand, and expiring reset vouchers. This layer recommends use-now, wait, or
latest-use decisions without retraining the platform model.

### 9. Website projection and evaluation

The serving layer reads one saved 168-slot forecast. It slices the first four and
24 slots for short-range views and reshapes the full rolling horizon, in order,
into seven 24-hour heatmap rows. Time-zone conversion changes display labels, not
slot order or canonical UTC storage.

The evaluation view joins immutable as-issued predictions with settled outcomes.
It reports calibration and rare-event forecast quality rather than plain
classification accuracy.

Before live forecasts mature, the same page may show a clearly labeled compatible
walk-forward reconstruction. Every fold uses one shared fixed alert budget, and
the same selected set defines both event recall and false alerts. It never chooses
a different top-N prefix for each known event. A reconstruction is never relabeled
as `as_issued`, and an old evaluation whose configuration, data, feature, model, or
fold signature no longer matches is not served.

A provisional forecast is likewise labeled as provisional on every surface. It may
be used while strict validation accumulates, but it cannot be described as having
validated 80% recall, validated accuracy, or production-calibrated probabilities.
The eventual validated state uses the original real-data sample, calibration, and
compatibility gates; provisional use does not weaken those gates.

## Runtime cadence

- Bootstrap: when no compatible usable model exists, batch-fit immediately from
  historical labels that are mature and available at the frozen training cutoff.
  Do not wait for future wall-clock data solely to start the fit.
- Hourly: collect, normalize, extract, link, freeze features, and issue a new
  seven-day forecast. New provider signals can therefore change features and
  probabilities without a parameter refit.
- After a forecast slot matures: settle it as positive, negative, pending, or
  censored using outcome coverage.
- At most every 24 hours: batch-fit a challenger from labels mature by that run's
  cutoff, run the compatible walk-forward evaluation attempt, and consider
  promotion. This is one daily batch train/evaluate attempt, not a separate weekly
  evaluator. A pending stored challenger may be re-evaluated between fits as causal
  fold coverage matures; that does not change its parameters or retrain it.
- During a fit: keep its cutoff and inputs frozen. Data arriving after the cutoff is
  queued naturally for the next batch and does not restart the running fit.
- In the background: accumulate causal walk-forward and immutable as-issued
  evidence until the original validated gate is met.
- Continuously: retain the last stable champion as the rollback target.
