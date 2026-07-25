# Product requirements

## Product objective

The MVP is a public reset-forecast website with a versioned operational outcome.
The current live profile estimates when the configured Tibo identity will publish
a qualifying statement that a platform-wide Codex quota reset/refill completed
during the next seven days. It does not claim to cover every physical backend
reset, and it does not predict a user's ordinary five-hour or weekly quota-window
rollover.

The first release has two product surfaces:

1. a current forecast page with 4-hour, 24-hour, and seven-day views;
2. a historical evaluation page showing how previously issued forecasts performed.

Personal quota and reset-voucher recommendations are explicitly deferred.

## Source scope

The initial implementation uses an X provider with two configured source groups.
These are adapter configuration, not platform-wide core abstractions.

### Confirmation source

A configured Tibo identity defines the operational outcome in
`config/tibo-authority-live.json`. An exact primary statement becomes a positive
outcome only when it explicitly states that a platform-wide Codex reset/refill
completed. A `started` statement, summary, rumor, expectation, hint, schedule, or
model judgment remains a signal or candidate and cannot settle a forecast.

The confirmation post's publication time and the adjudicated event time remain
separate. When the post provides no exact occurrence timestamp, a versioned
adjudication rule records an occurrence interval and its precision rather than
silently copying `published_at` into `occurred_time_range`.

### Context sources

The context set may include:

- other Tibo posts available before a forecast cutoff;
- OpenAI/Codex product, release, capacity, and incident discussion;
- independent community discussion and changes in its intensity or disagreement;
- competing-vendor model releases, quota changes, and related ecosystem events.

Quotes, reposts, copied articles, and summaries are collapsed to independent
evidence roots. Raw post count is not a model feature.

For development-time outcome discovery, the historical-monitor adapter may import
an external daily archive only after it verifies the configured author, exact
source ID, and publication timestamp against the direct X representation. This is
an adapter and not a privileged core source. Its attested publication time supports
record reconstruction; its actual import time remains `first_seen_at`. Under the
default archive profile, the date grid is `outcome_only`, and links selected from
known outcome posts are never forecast features.

The live Tibo-authority profile applies a separate daily-ledger completeness
contract to grid dates only. A UTC day remains pending until the same
count-reconciled ledger has been fetched at least twice over six actual hours and
the final fetch occurs at least 36 hours after day-end. Only then may its absence
of a qualifying completion statement become `negative_label_eligible`. Dates
before the grid begins support outcome discovery only. The later fetch time is
recorded as availability; first deployment never rewrites those days as if they
had already been known.

## Forecast lifecycle

```text
configured provider adapters
  -> append-only raw observations
  -> normalized claims
  -> evidence dependency and event linking
  -> hourly as-of feature snapshots
  -> hourly hazard model
  -> one 168-hour forecast
  -> website views and later settlement

qualifying Tibo completion statement
  -> reset outcome
  -> historical settlement, evaluation, and controlled retraining
```

A qualifying completion statement may settle the operational outcome, but it must
not be included as an input to a forecast issued before the statement was
available. Historical training and evaluation use only records with
`available_at <= knowledge_cutoff`.

## Model scope

The MVP uses a small, interpretable, strongly regularized discrete-time hazard
model. Candidate features include:

- a smooth renewal-periodic kernel over prior confirmed reset gaps, UTC hour of
  day, and hour of week;
- overlap with an explicitly asserted future reset interval;
- recency-decayed, pre-confirmation configured-author reset intent and incidents;
- independent community evidence volume, growth, and disagreement;
- recent competing-vendor model or quota events;
- provider health, delay, and coverage.

Cross-vendor and community effects start strongly shrunk toward zero and remain
only if walk-forward evaluation shows stable value. Deep learning and reinforcement
learning are outside the MVP.

## Current forecast page

The backend emits one ordered list of up to 168 consecutive one-hour UTC slots.
The frontend converts those slots to the selected display time zone and derives:

- the next 4 hours: four hourly cells;
- the next 24 hours: 24 hourly cells;
- the next 7 days: the same 168 slots grouped, in order, into a `[7][24]`
  rolling heatmap.

All three views use the same saved prediction. An hourly cell uses
`first_reset_probability` for its green intensity, while the current
`rolling_4h_probability` supplies the next-four-hour summary. Color is supplemented
by a numeric probability, time-range tooltip, and data-quality or uncertainty
indicator so that color alone does not carry meaning.

A rolling four-hour value is defined only when four complete hourly hazards are
available from that anchor. A missing tail window is displayed as unavailable,
never silently shortened to a one-, two-, or three-hour probability.

The `[7][24]` grid is a rolling 168-hour view beginning at the forecast horizon,
not seven local calendar dates. Display-time-zone conversion changes the labels but
does not reorder the canonical UTC slots.

The page also displays the forecast issue time, knowledge cutoff, display time
zone, source freshness, and current model version.

## Historical evaluation page

Every issued prediction is immutable. Evaluation uses the forecast that was
actually available at its issue time and never a reconstruction containing later
evidence.

During the pre-launch period, the page may fall back to the separately labeled,
compatible as-of-safe walk-forward evaluation used for champion promotion. Each
fold uses one shared alert set under the configured budget for both recall and
false-alert counts. It switches to live `as_issued` reporting only after the
configured minimum number of mature forecast windows and confirmed events exists.
An evaluation made with an older coverage, feature, model, data, or fold signature
is invalidated rather than displayed.

The page includes:

- rolling Brier score and Brier skill against the historical baseline;
- a calibration chart comparing forecast probability buckets with observed rates;
- recall of confirmed events within the highest-ranked forecast windows;
- false high-probability alerts over time;
- useful lead time before confirmed events;
- an event table containing forecast issue time, highest-ranked windows, confirmed
  occurrence interval, settlement result, score, and model version.

Plain classification accuracy is not a primary metric because always predicting
no reset can appear accurate for a rare event.

## Deferred personal strategy

User accounts, remaining quota, ordinary five-hour and weekly reset times, demand,
reset-voucher count and expiry, and use-now/wait recommendations are not required
for the MVP. The future optimizer consumes the platform forecast without changing
its probabilities or retraining its model.

## MVP acceptance criteria

- A healthy run produces a saved forecast of 168 consecutive hourly slots.
- The 4-hour, 24-hour, and seven-day displays are projections of the same forecast.
- Every displayed forecast identifies its knowledge cutoff and source freshness.
- Only a qualifying completion statement can create a positive operational
  outcome under the live profile.
- A first Tibo-authority deployment leaves daily ledger coverage pending; a
  negative-eligible day needs day-end plus 36 hours and at least two actual fetches
  spanning six hours.
- All live historical scores are computed from immutable as-issued predictions;
  walk-forward validation is labeled separately.
- Provider failure or incomplete observation coverage is represented as degraded
  data quality or censoring, not as evidence that no reset occurred.
- Model acceptance on real data requires optimizer convergence, at least 80%
  event-window recall under the configured shared alert budget, positive Brier
  skill over the historical baseline, and expected calibration error no greater
  than 0.10, evaluated over at least 1,008 hourly windows and 20 eligible events.
  The same selected alert set is used to count false alerts. Rows learned after an
  event never become inputs to an earlier forecast.
  Synthetic fixtures can exercise this gate but can never satisfy real-world
  acceptance.
