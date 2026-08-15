# Product requirements

## Product objective

The MVP is a public reset-forecast website with a versioned operational outcome.
The current live profile estimates when the configured Tibo identity will publish
a qualifying statement that a platform-wide or otherwise unqualified general
Codex quota reset/refill completed during the next seven days. It does not claim
to cover every physical backend reset, and it does not predict a user's ordinary
five-hour or weekly quota-window rollover.

The first release has three product surfaces:

1. a current forecast page with 4-hour, 24-hour, and seven-day views;
2. a historical results page listing confirmed resets and their official sources;
3. an opt-in notification surface backed by one channel-neutral event ledger.

All subscription channels are UI over the same forecast and confirmed-outcome
results. Usage, subscriber, and delivery telemetry remain outside canonical
records and model features. Operational capacity alerts use a separate admin-only
stream and cannot be delivered through an ordinary model-result subscription.

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
  affected scope, affected surface, and workaround, including security/privacy,
  data-integrity, and compatibility failures;
- verifiable competing-model and coding-agent announcements, previews, general
  availability, rollouts, and related limit changes.

Context-only replies, quotes, reposts, copied articles, and summaries are collapsed
to their independent evidence roots. Community volume, momentum, resonance,
disagreement, and raw post count are not model features. Experience reports remain
visible as structured evidence even when they are not yet eligible for the
forecast vector. Current revisions are grouped into append-only impact episodes so
later corroboration, continuing failures, mitigations, workarounds, and resolutions
can be followed over time. Episode pressure is bounded and freshness-decayed; it
must be labeled as impact tracking rather than reset probability.

The live profile also enables a self-hosted RSSHub X timeline route for configured
accounts. Its exact status IDs, author identity, wrapper text, and native
reply/quote/repost relations make it a deterministic evidence origin for posts,
replies, and reposts that are present in the feed. A self-contained relevant reply
may be primary. A reply that needs its parent to become relevant must bind that
parent's evidence root with `derivation: "reply"`, so it cannot confirm an outcome
or activate authority timing. Only an adjudicated qualifying completion statement
can settle a positive outcome. The finite feed cannot prove absence, so RSSHub
never provides outcome coverage or negative labels.

For identities explicitly listed in the versioned authority-reply allowlist, the
adapter may resolve one exact parent for a direct first-person future reset
commitment. That parent can establish only Codex/platform scope; the child keeps
its own primary evidence root and supplies the scheduled phase and asserted time.
The parent and the scheduled child remain unable to confirm an outcome.

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
  -> impact-episode follow-up projection
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

The UI keeps current source health, historical-label maturity delay, and sample
sufficiency distinct. A scalar feature data-quality score may summarize model
inputs, but it must not be presented as overall data or service health.

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
`competition`, and `other_context`. They also expose an exact-source Tibo
`timeline`, including posts that did not produce a normalized signal, and ranked
`impact_episodes` for issue/recovery follow-up. Experience items expose their
structured `impact`; competition items expose `competitive_context`. The UI must
state that impact pressure is not reset probability. A `community` array is
retained for one API compatibility version as a deprecated aggregate of the
non-core groups, but the UI does not present it as community resonance.

## Historical results page

The public historical page is a factual outcome log, not a model-evaluation
surface. It lists the latest eligible revision of every confirmed reset outcome in
reverse occurrence order. Each row contains only the confirmed occurrence interval
and precision, verification time, confirmed status/grade, and the exact official
or operator source used to verify it. Operator-confirmed rows must be visibly
labeled `silver` and must not imply an official completion statement.

The history endpoint is independent of evaluation availability. A missing,
incompatible, incomplete, or failed evaluation must not hide a valid confirmed
outcome. Rejected or cancelled latest revisions, superseded outcome revisions, and
confirmations that no longer satisfy the current outcome contract are not shown.

Brier score, calibration, event recall, false-alert diagnostics, useful lead time,
model versions, and promotion gates are intentionally absent from the public page.
Strict causal walk-forward and as-issued evaluation still run in the background and
remain available to operator APIs for model promotion, publication readiness, and
audit. Every issued prediction used there remains immutable, and no reconstructed
forecast may contain evidence learned after its cutoff.

## Notification surfaces

The stable notification product covers two facts: a newly active exact authority
time window, labeled as not yet confirmed, and a confirmed outcome together with
later corrections, retractions, or verification withdrawals. These topics appear
in `/feed.xml` and are the default for Web Push and Telegram. The first successful
pipeline generation after enablement records a baseline without replaying old
history.

Model probability watches are a separate experimental product. They open at the
subscriber's configured `1..168` hour probability threshold only from a fresh,
serving-ready, non-synthetic prediction at the configured minimum stage, use a
five-percentage-point lower close threshold to avoid repeated 10-minute alerts,
and require explicit subscription. Parameterized Atom, Web Push, and dynamic
Telegram subscriptions share the same rule and emit only an upward crossing;
baseline and close transitions are silent. `/feeds/experimental.xml` and the
static Telegram experimental chat list retain the fixed public rule. Neither an
alert nor model/extraction confidence can confirm a reset.

Every channel displays a new correction event instead of silently editing an old
notification. `verification_withdrawn` means that the current exact verification
contract is no longer satisfied; it must not be phrased as proof that the reset did
not happen. Delivery consumers deduplicate by stable `event_id`, advance by the
global sequence cursor, and drop expired events before queueing and sending. This
prevents duplicate local jobs but does not claim exactly-once delivery after an
ambiguous transport failure. See `docs/notifications.md` for the complete event
contract and safe-enabling rules.

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
- The first enabled publication pass emits no historical backlog. Default Atom,
  Web Push, and Telegram subscriptions carry only `authority` and `outcome`;
  `experimental_probability` always requires explicit opt-in.
- Outcome corrections and withdrawals append a new, idempotent event tied to exact
  canonical revisions; evidence confidence and forecast probability never create
  a confirmed-outcome event.
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
