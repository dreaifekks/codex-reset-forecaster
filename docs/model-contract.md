# Model contract

## Prediction target

The outcome definition is versioned and included in the model contract hash.
Under `config/tibo-authority-live.json`, the target is a qualifying primary
statement from the configured Tibo identity that a platform-wide Codex quota
reset/refill completed. The versioned live policy also treats a completed general
Codex reset statement as platform-wide when it has no narrower plan, account, or
region qualifier. This is a deliberately observable operational label; it does
not represent every physical backend reset. Banked vouchers, narrower segments,
`started`, scheduled, expected, rumor, summary, or model-generated claims are not
positive outcomes.

The internal resolution is one hour. A week therefore has 168 hourly anchor
positions. At anchor `t`, the conditional hourly hazard is:

```text
h_t = P(reset in [t, t+1h) | no earlier reset, information available at t)
```

The product-facing rolling four-hour probability is:

```text
P(reset in next 4h) = 1 - product(1 - h_(t+k)), k = 0..3
```

When modeling the first reset in the horizon:

```text
q_t = h_t * product(1 - h_j), j < t
P(no reset in horizon) = product(1 - h_j), all horizon slots j
```

Here, `reset` is shorthand for the qualifying outcome defined by the selected
versioned profile. The `q_t` values plus the no-outcome probability sum to one. If
recurrent outcomes are later supported, the record declares that event process
explicitly and consumers must not apply the first-event identity.

## Version 0.2 model

Use a strongly regularized Bayesian or ridge discrete-time hazard model:

```text
logit(h_t) = intercept
           + smooth_weekly_periodicity(t)
           + time_since_last_reset(t)
           + intelligence_features(t)
```

The checked-in MVP implements the ridge-logistic form above. Its penalty is centered
on versioned coefficient priors. Most features use a zero prior; explicit source
intent and the smoothed historical baseline use small non-zero priors so a rare but
semantically direct statement such as “reset tomorrow morning” is not treated as
meaningless before the first identical training example. The trained artifact
stores the complete prior vector plus optimizer method, objective, gradient norm,
iteration count, tolerance, and convergence status. Reaching `max_iterations` is a
failed training attempt, not convergence, and such a challenger cannot be promoted.
A complementary log-log link remains a compatible challenger family, but it must
pass the same walk-forward and calibration gates before replacing the champion.

The periodic baseline never learns 168 unrelated parameters. The current feature
schema uses this causal, smoothed renewal-periodic score:

```text
renewal = mean exp(-0.5 * ((log1p(age) - log1p(old_gap)) / 1.0)^2)
daily   = mean circular_gaussian(target_hour, old_event_hour, bandwidth=6h)
weekly  = mean circular_gaussian(target_week_hour, old_event_week_hour, bandwidth=36h)
renewal_periodic_kernel = renewal + daily + 0.5 * weekly
```

For live forecasts, only confirmed outcomes with `known_at <= knowledge_cutoff`
enter these terms. A labeled archive replay may instead use the separately
attested `replay_available_at`; it never rewrites canonical `known_at`. The broad
kernels are intentional: they express a smooth renewal and periodic baseline
without memorizing individual dates or hours.

The trained version `reset-features/0.2.6` remains small and interpretable:

- three weekly Fourier harmonics and two daily Fourier harmonics;
- the renewal-periodic kernel above;
- overlap between asserted event ranges and the target slot;
- recency-decayed configured-author reset intent and incident evidence;
- community growth and disagreement after source-dependency collapse;
- competing-vendor release context;
- provider coverage, delay, and health.

Other extracted evidence remains in canonical records and may be evaluated by a
challenger, but it is not automatically added to the champion. This prevents a
small event history from fitting dozens of weak context fields.

For the X-first MVP, the configured inputs are limited to Tibo posts available
before the cutoff and a curated community/ecosystem source set. A Tibo post used to
confirm an outcome cannot be exposed as a feature to an earlier historical
forecast. Community activity is aggregated after evidence-dependency collapse;
raw post count is never substituted for independent evidence.

Availability and recency are different clocks. `available_at` determines whether a
record is visible at a cutoff; a verified source publication or asserted event time
determines signal age. If an aggregator fetches an old post today, that fact may
become newly visible today but it does not become a fresh product event. Signals
selected by following links from a known outcome are feature-ineligible.

Raw author identifiers, raw post counts, free text, and high-dimensional embeddings
are not version 0.2 prediction features. Embeddings may assist event linking.

## Cross-vendor data

Other vendors may contribute to shared relationships without becoming OpenAI labels.
A later hierarchical model may use:

```text
vendor hazard = vendor baseline
              + shared activity/incident relationships
              + vendor-specific evidence effects
```

Vendor-specific effects remain strongly regularized. Cross-vendor features are
promoted only after walk-forward ablation demonstrates stable incremental value.

## Labels and censoring

- Gold and silver outcomes may settle model labels with appropriate quality weight.
- Under the live Tibo-authority profile, only a qualifying `completed` primary
  statement from the configured identity can be positive. `started`, scheduled,
  expected, rumor, summary, and predicted event candidates remain signals or
  features only.
- A reset known to occur within `[L, U)` uses one interval-censored likelihood over
  the eligible hourly hazards rather than one positive label per overlapping hour
  or an invented exact timestamp.
- A healthy, sufficiently observed period without a reset may be negative.
- A provider outage, missing coverage, or unresolved outcome creates a censored or
  pending period, not a negative.
- Overlapping rolling four-hour views are derived outputs, not independent training
  samples.

For the live profile, an absent qualifying statement becomes a negative only
through the versioned UTC daily-ledger contract. A grid day must be observed at
least twice across six actual hours, and its final observation must occur at least
36 hours after day-end. Pre-grid time remains outcome-discovery-only. The
promotion's actual fetch time is its replay availability, so the first deployment
cannot manufacture earlier as-of coverage.

## Online lifecycle

New information follows two paths:

1. Immediately recompute the current as-of features and forecast.
2. Update model parameters only after outcomes mature and predictions are settled.

Early updates should be small batches rather than one parameter update per post.
Maintain a stable champion and train a challenger. Preserve a long-term baseline
while using controlled recent-data decay to adapt to policy changes.

## Validation and calibration

Use rolling-origin / walk-forward evaluation:

```text
train through week N -> predict week N+1 -> save predictions -> advance
```

Never randomly split neighboring hourly rows. Group uncertainty estimation by week
or independent reset event.

Each hourly reconstruction uses only information available at that issue time.
Every held-out UTC week then receives one shared, frozen alert set under the
configured budget (36 rolling four-hour starts by default). All events in that fold
are scored against the same set, and false alerts are counted from that same set.
The evaluator never reselects a different top-N prefix after looking at each event.
This is a reconstruction ranking metric, not a claim that those alerts were
historically delivered.

Primary measures:

- Brier score and Brier skill relative to the historical baseline;
- log loss;
- calibration intercept/slope and reliability plots;
- precision-recall behavior for the rare event;
- event recall within the highest-ranked windows;
- false alerts per month under the same fixed alert policy;
- useful median lead time and the absolute offset between each event and the
  highest-probability policy-selected window issued before it. This is reported
  as `median_policy_peak_absolute_error_hours`; it is not derived from a window
  selected after checking whether that window overlaps the event.

Accuracy is not a primary measure. A flexible calibrator such as isotonic regression
must wait until there are enough independent outcomes; initial calibration should be
strongly regularized and trained only on historical out-of-sample predictions.
Current model artifacts therefore record the explicit no-op calibrator
`identity-hourly-hazard/1`. It does not fit calibration parameters on the present
small sample; observed calibration is still measured by the promotion gate. A
future non-identity calibrator must have its own version and must be fitted only
from frozen out-of-fold predictions after the sample threshold is reached.

## Forecast output

A production weekly prediction contains:

- issue time and knowledge cutoff;
- event process and affected scope;
- 168 consecutive hourly slots beginning at the next complete hour when the full
  seven-day horizon is available;
- hourly hazard, first-reset mass, cumulative probability, and rolling four-hour
  probability per slot;
- no-reset probability for a first-event forecast;
- uncertainty and data quality separate from probability;
- model, training cutoff, calibrator, and feature schema versions.

`issued_at` is the actual publication time after collection, processing, and
forecast computation. It is never backdated to scheduler start. The knowledge
cutoff records the latest usable information, while the horizon start is a separate
time. A rolling four-hour value is either based on four full hourly hazards or is
`null`; a tail value is never silently shortened.

The backend keeps this output as one ordered hourly slot list. The website derives
the next-4-hour and next-24-hour views by slicing it and derives the seven-day
`[7][24]` heatmap by grouping the same slots, in order, into seven 24-hour rows.
These are views of one forecast, not separate prediction targets. An hourly cell's
primary color value is its `first_reset_probability`; the current-anchor
`rolling_4h_probability` is shown as the next-four-hour summary.

## Historical evaluation product

The website evaluation page is computed from immutable as-issued predictions and
later settled outcomes. It includes rolling Brier score and baseline skill,
calibration, confirmed-event recall within the highest-ranked windows, false
high-probability alerts, and useful lead time. An event-level table retains the
forecast issue time, ranked window, actual occurrence interval, settlement, score,
and model version.

Before enough issued forecasts and confirmed events have matured, the page may
show the separately labeled walk-forward promotion evaluation. A walk-forward or
verified archive reconstruction is never labeled `as_issued`, and live accuracy
never substitutes a forecast recomputed with later evidence.

Production publication requires at least 1,008 evaluated hourly windows and 20
eligible events by default. A lower training `minimum_outcomes` remains useful
for experimental fitting, but does not establish live probability validity.
Feature snapshots and predictions expose `outcome_sample_count` and continuous
`sample_sufficiency = min(1, outcome_sample_count / 20)`; forecasts remain
out-of-distribution below 20 eligible historical outcomes.

The checked-in Tibo-authority profile and its coverage policy do not satisfy these
sample gates by themselves. Initial ledger observations are pending, and
publication remains blocked until a compatible real-data evaluation reaches both
thresholds and passes the quality and calibration gates.

Every evaluation exposes an explicit, provider-neutral `evidence_mode`:
`synthetic_replay`, `archive_replay`, `historical_walk_forward`, or `as_issued`.
Archive replay is inferred from independently attested availability that predates
the collector's real `first_seen_at`; it is not inferred from a provider name.

It also stores a provenance signature covering configuration, feature/taxonomy/
deduplication versions, extractor model/prompt versions, exact coverage-assertion
revisions, fold definition, model versions, frozen sample, and training algorithm.
The model-contract hash and training artifact bind the same extractor contract.
Promotion and the website reject a summary whose signature does not match its
challenger or the current runtime.

Plain accuracy is not reported as the headline measure because the target is rare
and a constant no-reset predictor would dominate it without being useful.
