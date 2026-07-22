# Architecture

## Objective

Estimate the conditional probability that an actual platform-level Codex quota
reset or refill will occur in each upcoming time slot, with a primary product view
of the next seven days.

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

### 2. Append-only intelligence log

Every collection, extraction, event hypothesis, outcome, feature snapshot, and
prediction is written as an immutable, versioned record. This permits exact as-of
replay and prevents a late backfill from silently changing an old forecast.

### 3. Claim extraction

A versioned rule/LLM extractor converts text into a small taxonomy:

- event type;
- phase and stance;
- product and affected scope;
- asserted time range and its precision;
- source role and evidence provenance;
- extraction confidence.

The extractor does not emit the final reset probability.

### 4. Event linking and evidence dependencies

Deterministic relationships are linked first: identical URLs, native quotes,
reposts, thread identifiers, and exact content hashes. Semantic linking then uses
subject vendor, product, event type, overlapping asserted times, and constrained
text similarity.

The linker records whether evidence is independent, quoted, reposted, summarized,
supporting, or contradicting. Twenty derivative reports from one original post
remain one independent evidence root.

### 5. As-of feature builder

At every hourly cutoff, the builder creates immutable features using only records
available at that cutoff. Features summarize authority, recency, independence,
contradiction, explicit timing overlap, activity anomalies, release/incident
proximity, and provider health.

### 6. Forecaster and calibrator

The first model family is a strongly regularized discrete-time hazard model. It
produces hourly hazards, first-event mass, cumulative probability, and a rolling
four-hour probability. A separately versioned calibrator is fitted only to saved
out-of-sample predictions.

### 7. Outcome adjudication and settlement

Announcements are evidence, not outcomes. Outcomes are confirmed from direct
platform observations or sufficiently strong independent confirmation and retain an
observed time interval and label grade. Missing coverage yields censored windows.

### 8. Personal optimizer

The platform forecast is consumed by a later rolling optimizer together with a
user's quota state, regular reset window, demand, and expiring reset vouchers. This
layer recommends use-now, wait, or latest-use decisions without retraining the
platform model.

## Runtime cadence

- Hourly: collect, normalize, extract, link, freeze features, and issue a new
  seven-day forecast.
- After a forecast slot matures: settle it as positive, negative, pending, or
  censored using outcome coverage.
- Daily: update a challenger with newly settled information.
- Weekly: run full walk-forward evaluation and consider challenger promotion.
- Continuously: retain the last stable champion as the rollback target.
