# Product requirements

## Product objective

The MVP is a public reset-forecast website with a versioned operational outcome.
The current live profile estimates when the configured Tibo identity will publish
a qualifying statement that a platform-wide or otherwise unqualified general
Codex quota reset/refill completed during the next seven days. It does not claim
to cover every physical backend reset, and it does not predict a user's ordinary
five-hour or weekly quota-window rollover.

The first release has two product surfaces:

1. a current forecast page with 4-hour, 24-hour, and seven-day views;
2. a historical evaluation page showing how previously issued forecasts performed.

Personal quota and reset-voucher recommendations are explicitly deferred.

## Source scope

The initial implementation uses an X provider with two configured source groups.
These are adapter configuration, not platform-wide core abstractions.

### Confirmation source

A configured Tibo identity defines the operational outcome in
`config/tibo-authority-live.json`. An exact primary completion statement becomes
a positive outcome when it explicitly covers the platform or describes a general
Codex reset without a narrower plan, account, or region qualifier. Banked
vouchers, narrower segments, `started` statements, summaries, rumors,
expectations, hints, schedules, and model judgments remain signals or candidates
and cannot settle a forecast.

The confirmation post's publication time and the adjudicated event time remain
separate. When the post provides no exact occurrence timestamp, a versioned
adjudication rule records an occurrence interval and its precision rather than
silently copying `published_at` into `occurred_time_range`.

### Context sources

The context set may include:

- other Tibo posts available before a forecast cutoff;
- OpenAI/Codex product, release, capacity, and incident discussion;
- Codex experience issues and recoveries, classified by severity, lifecycle,
  affected scope, affected surface, and workaround;
- verifiable competing-model and coding-agent announcements, previews, general
  availability, rollouts, and related limit changes.

Context-only replies, quotes, reposts, copied articles, and summaries are collapsed
to their independent evidence roots. Community volume, momentum, resonance,
disagreement, and raw post count are not model features. Experience reports remain
visible as structured evidence even when they are not yet eligible for the
forecast vector.

The live profile also enables a self-hosted RSSHub X timeline route for configured
accounts. Its exact status IDs, author identity, wrapper text, and native
reply/quote/repost relations make it a deterministic evidence origin for posts,
replies, and reposts that are present in the feed. A self-contained relevant reply
may be primary. A reply that needs its parent to become relevant must bind that
parent's evidence root with `derivation: "reply"`, so it cannot confirm an outcome
or activate authority timing. Only an adjudicated qualifying completion statement
can settle a positive outcome. The finite feed cannot prove absence, so RSSHub
never provides outcome coverage or negative labels.

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
  -> 10-minute refreshes of hourly-slot as-of feature snapshots
  -> hourly hazard model
  -> one 168-hour forecast
  -> website views and later settlement

qualifying Tibo completion statement
  -> reset outcome
  -> historical settlement and controlled retraining

eligible history available at bootstrap cutoff
  -> immediate provisional batch fit
  -> provisional forecast use

causal walk-forward folds plus mature issued forecasts
  -> background validation
  -> validated status after the original promotion gate passes
```

A qualifying completion statement may settle the operational outcome, but it must
not be included as an input to a forecast issued before the statement was
available. Historical training and evaluation use only records with
`available_at <= knowledge_cutoff`.

Once that outcome is available, the same run must stop treating the completed
plan as future evidence, re-anchor the next-event cycle, discount independent
pre-outcome context, and suppress near-term next-reset hazard through the
versioned refractory recovery. Completion remains a positive outcome, not a
fabricated negative label. A later exact authority statement begins a new timing
intent and may raise the next-cycle forecast.

Bootstrap does not wait for new real time to pass when eligible historical data is
already present. It freezes a training cutoff and fits one reproducible batch from
the mature labels available by that cutoff. Data collected while the batch is
running is not allowed into the frozen fit and does not restart it; it becomes input
to the next batch.

## Model scope

The MVP uses a small, interpretable, strongly regularized discrete-time hazard
model. Candidate features include:

- a smooth renewal-periodic kernel over prior confirmed reset gaps, UTC hour of
  day, and hour of week;
- overlap with an explicitly asserted future reset interval;
- recency-decayed configured-author incidents, while exact timed reset intent is
  handled once by the authority conditioner rather than duplicated in the
  learned vector;
- a single recency-decayed value for a recent direct or adjacent non-rumor
  competing-model, coding-agent, or limit event.

The competitor effect starts strongly shrunk toward zero and remains only if
walk-forward evaluation shows stable value. Multiple posts derived from the same
event cannot add probability mass. Codex experience severity is initially an
audit/display taxonomy rather than a probability feature; promoting it later
requires a separately versioned challenger and causal ablation. Deep learning and
reinforcement learning are outside the MVP.

Provider health, delay, and coverage remain separate data-quality outputs. They
must not enter the probability vector, because observation quality can otherwise
be mistaken for event risk.

The model has two product statuses:

- `provisional`: an immediately usable bootstrap fit whose causal/as-issued
  validation sample is still accumulating. It must not claim 80% validated recall
  or validated accuracy.
- `validated`: a compatible model whose real-data evaluation satisfies the
  original window, event, recall, Brier-skill, calibration, convergence, and
  lineage gates.

This status split changes when a forecast may be used, not which records are legal
training inputs. Confirmed outcomes, negative-label coverage, censoring, as-of
cutoffs, evidence independence, and revision lineage remain equally strict in both
states.

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
zone, source freshness, current model version, and provisional or validated status.
A provisional page states explicitly that the 80% event-window-recall threshold has
not yet been validated; it does not turn an exploratory replay score into a
performance claim.

The recent-evidence endpoint and page separate `core`, `experience`,
`competition`, and `other_context`. Experience items expose their structured
`impact`; competition items expose `competitive_context`. A `community` array is
retained for one API compatibility version as a deprecated aggregate of the
non-core groups, but the UI does not present it as community resonance.

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

Strict causal and as-issued validation runs in the background and does not block
clearly labeled provisional forecast use. A provisional model may show sample
counts and exploratory diagnostics, but the historical page must keep “not yet
validated” distinct from both a passing walk-forward result and mature as-issued
performance.

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
- Existing eligible historical data can immediately produce a frozen-cutoff,
  batch-fit provisional forecast; the system does not wait for future wall-clock
  collection before beginning that fit.
- New provider signals update hourly-slot as-of features and predictions on the
  10-minute collection/recalculation cadence. Model parameters are batch-refit at
  most every 24 hours from labels mature at the training cutoff; data arriving
  during a fit enters the next batch without restarting it.
- Provisional use does not imply that 80% recall has been measured or validated.
  The page exposes that status while causal/as-issued evidence accumulates in the
  background.
- Validated model acceptance on real data requires optimizer convergence, at least 80%
  event-window recall under the configured shared alert budget, positive Brier
  skill over the historical baseline, and expected calibration error no greater
  than 0.10, evaluated over at least 1,008 hourly windows and 20 eligible events.
  The same selected alert set is used to count false alerts. Rows learned after an
  event never become inputs to an earlier forecast.
  Synthetic fixtures can exercise this gate but can never satisfy real-world
  acceptance.
