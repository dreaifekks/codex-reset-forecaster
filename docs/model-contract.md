# Model contract

## Prediction target

The target is the actual start of a platform-level Codex quota reset/refill.
Announcement time is a feature, not the target.

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

The `q_t` values plus the no-reset probability sum to one. If recurrent resets are
later supported, the record declares that event process explicitly and consumers
must not apply the first-event identity.

## Version 0.1 model

Use a strongly regularized Bayesian or ridge discrete-time hazard model:

```text
cloglog(h_t) = intercept
             + smooth_weekly_periodicity(t)
             + time_since_last_reset(t)
             + intelligence_features(t)
```

The weekly baseline uses a small number of Fourier terms and coarse weekday/weekend
effects rather than 168 unrelated parameters.

Initial intelligence features should remain small and interpretable:

- recency-decayed explicit official/team reset claims;
- overlap between asserted event ranges and the target slot;
- independent supporting and contradicting evidence roots;
- development activity anomaly over 4/12/24/72 hours;
- time since a release, incident, or capacity restoration signal;
- community growth and disagreement after source-dependency collapse;
- provider coverage, delay, and health;
- cross-vendor ecosystem information with an initial effect strongly shrunk toward
  zero.

Raw author identifiers, raw post counts, free text, and high-dimensional embeddings
are not version 0.1 prediction features. Embeddings may assist event linking.

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
- Rumors and predicted event candidates remain features only.
- A reset known to occur within `[L, U)` uses an interval-censored likelihood rather
  than an invented timestamp.
- A healthy, sufficiently observed period without a reset may be negative.
- A provider outage, missing coverage, or unresolved outcome creates a censored or
  pending period, not a negative.
- Overlapping rolling four-hour views are derived outputs, not independent training
  samples.

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

Primary measures:

- Brier score and Brier skill relative to the historical baseline;
- log loss;
- calibration intercept/slope and reliability plots;
- precision-recall behavior for the rare event;
- event recall within the highest-ranked windows;
- false alerts per month;
- useful median lead time and timing error.

Accuracy is not a primary measure. A flexible calibrator such as isotonic regression
must wait until there are enough independent outcomes; initial calibration should be
strongly regularized and trained only on historical out-of-sample predictions.

## Forecast output

A production weekly prediction contains:

- issue time and knowledge cutoff;
- event process and affected scope;
- 168 consecutive hourly slots when the full seven-day horizon is available;
- hourly hazard, first-reset mass, cumulative probability, and rolling four-hour
  probability per slot;
- no-reset probability for a first-event forecast;
- uncertainty and data quality separate from probability;
- model, training cutoff, calibrator, and feature schema versions.
