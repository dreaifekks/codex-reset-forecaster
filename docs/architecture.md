# Architecture

## Objective

Estimate the conditional probability of a versioned operational outcome in each
upcoming time slot, with a primary product view of the next seven days. The current
live profile defines that outcome as a qualifying platform-wide Codex reset/refill
completion statement from the configured Tibo identity; it is not a claim about
every physical backend reset.

The initial product is a website with current 4-hour, 24-hour, and seven-day
heatmaps plus a confirmed reset-history page. Model evaluation remains an internal
promotion and audit surface. Personal quota and voucher optimization is deferred.

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
- exact account timelines and curated user reports;
- release and public-development activity sources;
- other model vendors, retained under their own subject vendor and product.

The MVP begins with X adapters. Their configuration identifies a Tibo account as
the primary confirmation source and a separate set of Codex-experience and
competitor-release sources as context. This source choice does not change the
provider-neutral record or adapter contracts.

The RSSHub X timeline adapter polls configured account routes as JSON Feed and
preserves the exact wrapper status ID, account identity, text, and native
reply/quote/repost relations. Wrapper publication time is derived from its X
snowflake; `first_seen_at` and `fetched_at` remain the real collection clocks.
Ambiguous identity, relation, RT, quote-body, or timestamp metadata fails closed
rather than being inferred. A reply whose own text contains an explicit relevant
claim owns its status root and may be a `primary_statement`. A reply whose own
text is relevant only with its exact parent context is bound to the parent evidence
root with `derivation: "reply"`; it cannot confirm an outcome or activate exact
authority timing. This makes RSSHub an exact transport for positive observations,
including a completion statement that may later qualify through adjudication. It
does not make a scheduled statement an outcome, and a finite timeline feed cannot
prove that no qualifying statement or reset occurred. RSSHub therefore has
`exact_evidence` and `context_discovery` capabilities but never contributes
outcome coverage or negative labels.

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

A provider-neutral, versioned topic-relevance policy first checks the candidate
post itself and any resolved reply/quote observations. Personal quota errors,
requests for a reset, generic discussion, and explicit non-claims remain
auditable but are feature-ineligible. A reply or quote may inherit context only
from an exact related observation; a missing relation body is
`pending_context`, not guessed from the search query.

Context inheritance never grants primary authority. When a reply's own text is an
explicit relevant operational claim, relevance uses `self` and the reply keeps its
own primary evidence root. When the reply is meaningful only because an exact
parent contains the operational claim, relevance uses `reply_parent`, the signal
binds the parent reference/root, and normalized provenance uses the non-primary
`derivation: "reply"`. Such a context-only reply may remain auditable context but
cannot adjudicate an outcome or enter the exact-authority timing conditioner.

One configured exception covers direct future reset commitments from identities
in `extractor.authority_reply_identity_ids`. If the exact reply parent establishes
the target product and platform-wide scope, the child remains self-basis with its
own primary root and supplies the scheduled phase and time. Parent text is a
scope-only dependency and can never contribute phase, timing, authority, or
outcome evidence.

The rule/LLM extractor then converts relevant text into a small taxonomy:

- event type;
- phase and stance;
- product and affected scope;
- asserted time range and its precision;
- Codex experience impact, severity, lifecycle, affected surfaces, and workaround;
- competitor release kind, relevance, and delivery stage;
- source role and evidence provenance;
- extraction confidence.

Product is not copied from the model target. The extractor distinguishes Codex,
ChatGPT Work, unknown, and explicit multi-product statements. Only Codex or a
multi-product statement containing Codex can confirm a Codex outcome. Within a
relevant reset claim, the versioned aliases `ultra` and `/fast` identify Codex
modes even when the product name is omitted.

Native relations do not automatically make the wrapper derivative. If a quote
wrapper's own text contains the operational claim, that wrapper is its own
`primary_statement` evidence root. If the wrapper contributes no reset claim and
only inherits the quoted observation's text, it remains `quotes`-derived and
cannot confirm an outcome.

The active extractor contract is configuration, not a hidden code constant. Its
`model`, `model_version`, `prompt_version`, topic-relevance policy version, and
semantic policy hash are bound to every normalized signal and into model
artifacts and evaluation provenance. The hash covers the normalized target,
stable provider-neutral identity/role/confirmation policy, and topic-relevance
policy. Upgrading the extractor or changing that semantic policy replays every
exact raw-observation revision.

The extractor does not emit the final reset probability.

### 4. Event linking and evidence dependencies

Deterministic relationships are linked first: canonical X status IDs across
providers, identical URLs, native replies, quotes, reposts, thread identifiers,
and exact content hashes. Semantic linking then uses subject vendor, product,
event type, overlapping asserted times, and constrained text similarity.

The linker records whether evidence is independent, a reply, quoted, reposted,
summarized, supporting, or contradicting. Event-candidate evidence uses
`provenance_relation: "reply"` for the parent-bound reply case. Twenty derivative
reports from one original post remain one independent evidence root.

Experience issues and recoveries are additionally folded into versioned,
append-only `impact_episode` revisions before event-candidate linking; the
projection does not depend on a candidate becoming a confirmed event. Episode
construction operates on current extractor-compatible normalized revisions and
independent evidence roots, applies a bounded temporal clustering gap, and binds
its policy, taxonomy, extractor, and deduplication contracts. Its
freshness-decayed pressure preserves severity, scope, persistence, and lifecycle
movement without turning copied-post volume into impact. The pressure is a
display/audit measurement for follow-up tracking; it is not an estimate of reset
probability and is not part of the current champion feature vector.

### 5. As-of feature builder

At every cutoff, the builder creates immutable features using only record revisions
available by that cutoff. Availability decides whether information may be seen;
source publication/asserted event time decides its age. A newly fetched summary of
an old post therefore does not become a fresh event. Features summarize authority,
recency, independence, contradiction, explicit timing overlap, activity anomalies,
and release/incident proximity. Provider health, delay, and coverage are recorded
as separate data-quality metadata rather than probability inputs.

The current feature contract deliberately trains on fourteen low-dimensional
fields. Its main
baseline is a causal renewal-periodic kernel built from outcomes already known at
the cutoff: a Gaussian kernel over historical reset gaps in log-hours, a circular
UTC hour-of-day kernel, and a wider circular hour-of-week kernel. Explicit asserted
time overlap and configured-author incident evidence have small, versioned
coefficient priors. Exact configured-author reset intent remains in the canonical
snapshot for diagnosis but is excluded from the learned probability vector; its
timing effect belongs to the authority conditioner. Community volume, momentum,
resonance, and disagreement are not features. Codex experience reports remain
canonical display/audit evidence in this first version and do not enter the
forecast vector. A direct or adjacent non-rumor competitor model/coding-agent
event contributes a single recency-decayed maximum after evidence-root collapse,
not a sum of posts. The renewal-periodic kernel and competitor release context
start at a zero prior and must earn their influence from training evidence.

Reset-timing features share one as-of lifecycle with the authority conditioner.
An asserted range contributes only before its half-open end, and a compatible
confirmed reset occurring after the statement consumes it once that outcome is
known. Expired or consumed statements no longer contribute intent diagnostics or
asserted-time overlap. An active exact authority statement is also excluded from
baseline overlap so the conditioner does not reuse the same evidence.

### 6. Forecaster and calibrator

The first model family is a ridge discrete-time logistic hazard model. Ridge
penalties shrink coefficients toward versioned domain priors rather than assuming
every prior mean is zero. Training records optimizer convergence and refuses
promotion when it has only exhausted the iteration limit. It produces hourly
hazards, first-event mass, cumulative probability, and a rolling four-hour
probability. Probability, epistemic uncertainty, source/data quality, and
extraction confidence remain separate. A separately versioned calibrator is fitted
only to saved out-of-sample predictions.

Training and inference use the same versioned standardized-feature transform.
After subtracting the stored mean and dividing by the stored scale, each feature
is clipped to `[-3, 3]`. The clip and transform version are persisted in the model
artifact and bound into the model contract so a rare feature with a tiny training
scale cannot create an unbounded live logit shift.

The versioned feature-support gate runs before every full fit and walk-forward
refit. It counts independent positive event intervals separately from covered
negative hours, freezes unsupported or zero-variance columns at zero, and removes
near-perfect duplicate columns deterministically. Those decisions and counts are
stored in the model artifact, so live inference cannot reactivate a feature that
was unavailable or supported by only one outcome at training time.

Configured coefficient priors are expressed as logit change per one raw feature
unit. Training converts each prior into standardized coordinates by multiplying it
by the stored feature scale; the raw and effective vectors plus the versioned
coordinate policy are persisted in the artifact.

After the baseline hazards, a qualifying confirmed outcome first applies a
versioned refractory multiplier for the new recurrence cycle. The live curve
starts at `0.001` at the outcome range end and recovers monotonically to one over
12 hours. This is a next-event prior, not a negative label. The completed
independence lineage is removed from feature carry-over; other evidence published
before the outcome boundary keeps half weight, while later independent evidence
keeps full weight.

After that step, a versioned exact-authority timing conditioner may
mix first-event mass into one active asserted interval, then invert that mass back
to hourly hazards. The interval's total authority mass follows the statement's
phase reliability, while its hourly allocation follows a tempered version of the
model's complete within-window baseline shape; a day-only statement therefore
does not create a uniform-hour assumption. Partial boundary hours use
exposure-adjusted hazards, with a duration-uniform fallback when no usable
baseline mass exists. It uses only as-of-visible primary evidence, never a summary or
extraction confidence, and the walk-forward evaluator builds the same complete
asserted-range allocation basis before scoring a four-hour slice. Until
timed-statement collection has an exhaustive denominator, its phase reliability
is exposed as a semantic prior rather than described as learned accuracy. A newly
confirmed compatible reset consumes the old assertion and re-anchors the next
first-reset forecast in the same pipeline run without waiting for retraining.
If no completion arrives, the assertion stops conditioning probability when its
half-open timing window ends.

Bootstrap fitting and performance validation are separate lifecycle concerns. When
eligible historical labels already exist, the service may batch-fit a provisional
model immediately at a frozen cutoff; training does not need to wait for new
wall-clock observations merely to begin. That artifact is useful for provisional
forecasts, but its existence is not evidence that the 80% event-window-recall gate
has passed. Causal walk-forward folds and immutable as-issued settlements continue
to accumulate independently until the validated gate is satisfied.

Before a refit may replace or bootstrap the live model,
`live-forecast-promotion-guard/2` audits current live snapshots through 72 hours.
A provisional challenger reused without a refit is rechecked as well. The guard
rejects excessive same-snapshot combined clip contributions and raw-model
cumulative saturation at 4, 24, or 72 hours. Generic data-quality OOD status alone
remains an audit signal, but an OOD probability anomaly is blocking. A rejected
provisional fallback must pass a second bootstrap check before it can continue
serving.

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

Recent evidence is projected into semantic `core`, `experience`, `competition`,
and `other_context` groups. A separate exact-source `timeline` shows recent Tibo
posts even when no normalized signal matched, so collection freshness is not
confused with topic selection. Experience entries carry the structured impact
classification, while competition entries carry the structured release context.
Current `impact_episodes` expose ranked issue/recovery follow-up with the explicit
warning that episode pressure is not reset probability. The API retains
`community` for one compatibility version as a deprecated aggregate of the three
non-core groups; the website no longer uses community resonance as a product
concept.

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
- Every 10 minutes: collect, normalize, extract, link, freeze hourly-slot
  features, and issue a new seven-day forecast. New provider signals can therefore
  change probabilities without a parameter refit.
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

The hourly slots are the forecast target resolution, not the serving-cache
lifetime. Two successful 10-minute runs can use the same fitted model while
producing different immutable predictions because their knowledge cutoffs differ.
Serving clients therefore identify a forecast by its exact
`record_id@revision`, never by model version alone. The snapshot keeps canonical
RFC 3339 UTC slot boundaries; browser time-zone formatting is a presentation-only
projection and does not create another forecast variant.
