# Operations

## Local verification

The runtime has no third-party package dependencies and requires Node.js 22 or
newer.

```bash
npm test
npm run validate
git diff --check
```

To create a clearly marked synthetic dataset, train the full pipeline, run the
walk-forward gate, and issue a forecast:

```bash
RESET_DATA_DIR=/tmp/reset-forecaster-demo npm run demo:seed
RESET_DATA_DIR=/tmp/reset-forecaster-demo npm run demo:start
```

The demo exists only to validate pipeline and model mechanics. Its score must never
be presented as measured real-world accuracy. `demo:seed` and `demo:start` share
the explicit demo model contract. Starting the same data root with ordinary
`npm start` fails closed as an incompatible live contract.

## Live X collection

Set an X API bearer token outside version control:

```bash
export X_BEARER_TOKEN='...'
npm run pipeline -- --retrain
```

For Docker Compose, keep the token out of `.env`: write only the token value to
`./.secrets/x-bearer-token`, set its mode to `400` or `600`, set
`X_BEARER_TOKEN_FILE=/run/secrets/x-bearer-token`, and leave
`X_BEARER_TOKEN_FILE_HOST=./.secrets/x-bearer-token`. The file is mounted
read-only. An empty `X_BEARER_TOKEN_FILE` keeps direct X disabled.

The default provider follows the configured Tibo identity and configured context
accounts and queries. It paginates user timelines, preserves native
reply/quote/repost relations, stores raw payloads, and maintains `since_id`
cursors. Override
`config/default.json` with a file referenced by `RESET_CONFIG`; never put a token in
that file.

`config/live.example.json` is a generic direct-X starting override. Adjust its
backfill start to the actual entitlement when using that profile.
`.env.example` instead selects `config/tibo-authority-live.json`; copy it to the
ignored `.env` file only when that narrower announcement target is intended.
Pagination exhaustion establishes only `outcome_only` discovery coverage by
default. It must never be described as negative-label coverage.

An initial history import may set `providers.x.backfill_start` to an RFC 3339 UTC
timestamp. Exhausting every page proves only that the configured timelines were
read; an account can omit a reset, so this remains `outcome_only`. If the
configured page limit is reached while a continuation token remains, no coverage
assertion is advanced, the source is marked degraded, and its cursor is retained
so the same range can be retried after increasing `max_pages_per_poll`. For context
history beyond the recent-search entitlement,
set `providers.x.search_endpoint` to the full-archive endpoint available to the X
API project.

An archive backfill does not rewrite history. X supplies the original
`published_at`, while this system records the actual current `first_seen_at` and
`available_at`. A post first obtained today cannot enter a forecast cutoff from
last month. Backfill can establish outcome history and, when pagination is
complete, retrospective confirmation-source coverage; it cannot by itself prove
that the signal model would have worked before the collector existed. A real
walk-forward acceptance result therefore needs either continuously accumulated
live records or an imported archive that carries independently trustworthy
historical availability timestamps.

Every exhaustive confirmation poll advances outcome-discovery coverage only
through the instant when the poll started (minus optional
`providers.x.coverage_safety_lag_seconds`), never through its later completion
time. The immutable poll evidence still records the actual completion time. This
prevents posts published while pagination is running from being silently counted
as observed negatives. Context timelines, searches, and revision rechecks have
separate success/failure clocks: their failures degrade the context health group
without making a successful required confirmation source stale.

X coverage becomes `negative_label_eligible` only when
`providers.x.outcome_exhaustiveness_contract` names the supported
`x-outcome-exhaustiveness/1` contract and pins a separate JSON attestation by
immutable SHA-256. The attestation must use
`x-outcome-exhaustiveness-attestation/1`, name an independent attestor and method,
cover the exact target scope and complete configured confirmation-identity set,
cover the asserted half-open interval, and remain unexpired at assertion time.
Missing, unreadable, hash-mismatched, wrong-scope, incomplete, or expired
attestations fail closed to `outcome_only`; the default configuration is `null`.
An empty X timeline is therefore never a training negative on its own.

### RSSHub exact X timeline

The provider `rsshub_x_timeline` reads configured account posts, replies, and
reposts from the self-hosted HTTPS origin in `RSSHUB_BASE_URL`. The checked-in live
profile enables `https://rss.dreaife.tokyo`; the adapter requests the JSON Feed
form of:

```text
/twitter/user/<handle>/includeReplies=true&includeRts=1&showSymbolForRetweetAndReply=1&count=100?format=json
```

Run one collection and normalization pass with:

```bash
export RESET_CONFIG="$PWD/config/tibo-authority-live.json"
export RSSHUB_BASE_URL='https://rss.dreaife.tokyo'
node src/cli.mjs ingest-rsshub
node src/cli.mjs process
```

For another profile, set `RSSHUB_X_ENABLED=true` or enable
`providers.rsshub_x_timeline` in its override. The base URL must be a credential-free
HTTPS origin. The adapter bounds response size and request time, supports ETag and
Last-Modified revalidation, and rejects a feed whose account identity, status ID,
wrapper publication time, or quote boundary cannot be verified. A single
reply/RT marker mismatch is quarantined as raw, feature-ineligible evidence rather
than promoted or allowed to fail an otherwise valid snapshot; the snapshot still
fails closed when fewer than `minimum_items` fully verified entries remain. For
reposts it derives `published_at` from the wrapper status snowflake rather than
copying the original post's feed date.

A reply with a self-contained explicit relevant claim keeps its own status root
and may be a `primary_statement`. A reply such as “same here” or “still seeing
this” becomes relevant only after its exact parent is present. That signal must
include the parent reference, bind the parent evidence root, and record the
non-primary `derivation: "reply"`; it cannot confirm an outcome or activate
authority timing. If the parent is missing, the reply remains `pending_context`
instead of inheriting meaning from a query or feed title.

For an identity in the versioned authority-reply allowlist, the adapter may resolve one exact reply
parent when the reply's own text contains a first-person future reset commitment.
The parent is stored as feature-ineligible context and may establish only the
Codex/platform subject. It cannot supply the reply's phase or asserted time, and
it cannot become outcome evidence. A weekday such as `on Monday` is interpreted
as that UTC calendar day's half-open range, clipped at publication time when the
statement is made on that same weekday; the newly resolved context's actual fetch
time remains the signal availability boundary.

This is the exact positive-observation path, not an outcome-coverage path. A
present exact completion statement may become outcome evidence only after the
normal target/source/phase adjudication. Scheduled, expected, or started
statements remain signals. A finite or empty feed cannot prove absence and the
runtime rejects `rsshub_x_timeline` in `model.outcome_coverage_providers`; it never
creates negative labels.

The default scheduler runs every 10 minutes and the RSSHub source contract uses a
five-minute eligibility gate. Because it shares the scheduler, effective polls are
currently no more frequent than the next 10-minute run. Once the source exposes a
new item, it is available to that collection/recalculation run without waiting for
daily training. This cadence is an acquisition target, not a guarantee about X or
RSSHub upstream availability.

### Manual author timeline JSONL import

Use the provider-neutral manual importer for an exported X/Twitter author
timeline whose JSONL rows contain `id`, `platform`, `author`, `createdAt`, `text`,
and optionally `url`:

```bash
node src/cli.mjs ingest-timeline --file /absolute/path/to/timeline.jsonl
node src/cli.mjs process
```

The importer accepts only `x` or `twitter` rows with valid status IDs, timestamps,
and matching author/status URLs. It validates the complete file before appending
records, rejects duplicate IDs inside one export, and is idempotent when the same
unchanged export is imported again. Configured usernames are mapped to their
canonical identity IDs, so an exported `thsottiaux` row becomes
`person_tibo_sottiaux` and later normalization obtains its `source_role` from the
existing identity policy.

This is a recent timeline export, not a historical availability attestation.
`published_at` comes from `createdAt`, while `first_seen_at` and `fetched_at` are
the actual import time. The importer sets `outcome_conditioned=false` and
`selection_method=recent_author_timeline_export`, but creates no coverage
assertion. Missing posts therefore never become negative labels, and imported
posts cannot leak into forecasts whose knowledge cutoff predates the import.
Rows using the conventional `RT @handle:` form remain stored for audit but are
marked feature-ineligible because the export lacks the original post ID needed to
prove an independent evidence root.
Run `train` or `pipeline --retrain --no-collect` separately when those newly
processed records should be considered by a new challenger.

### Historical outcome discovery

`config/archive-evaluation.example.json` enables the disabled-by-default
`historical_monitor` adapter in `outcome_only` mode. The adapter reads the daily
grid from [`codex-resets.com`](https://codex-resets.com/), verifies listed posts
using X oEmbed plus their snowflake timestamps, and saves the complete source HTML,
parsed grid, hashes, and verification payloads. A source or timestamp mismatch
fails the import rather than weakening the evidence silently. The import also
reconciles parsed posts by snowflake UTC date against every daily `data-count`, so
an HTML parser drift that silently drops an item fails closed.

```bash
export RESET_CONFIG="$PWD/config/archive-evaluation.example.json"
export RESET_DATA_DIR="$PWD/data/archive"
node src/cli.mjs ingest-archive
node src/cli.mjs process
node src/cli.mjs status
```

The import stores the real current `first_seen_at`. Its separately validated
`availability_attestation` allows the exact public source text to be replayed from
its historical publication time. The generated directory and raw payload blobs are
ignored by Git; preserve them together for exact auditability because the external
page can change.

A contiguous archive date grid is not proof that every unlisted physical reset was
observed. Under the default archive profile, the adapter therefore writes an
append-only `outcome_only` coverage assertion and cannot provide training negatives
or settle a no-outcome window. A `negative_label_eligible` assertion requires a
separate, explicit completeness contract for the exact operational target and is
rejected when that contract is absent. Posts discovered only by following links
from known reset posts are marked outcome-conditioned and excluded from forecast
features.

For a genuine archive walk-forward, that independent attestation must also provide
`replay_available_at`: the UTC instant at which the covered interval was
historically complete and knowable. It must be no earlier than the interval end and
no later than the real import `asserted_at`. This clock is used only in archive
replay; live settlement continues to use `asserted_at`.

### Tibo-authority live profile

`config/tibo-authority-live.json` is the checked-in deployment profile for the
narrow operational target “a qualifying completion statement from the configured
Tibo identity.” It does not claim to detect every physical backend reset. An exact
primary completion statement qualifies when it explicitly covers the platform or
describes a general Codex reset without a narrower plan, account, or region
qualifier. Banked vouchers, narrower segments, `started`, scheduled, expected,
rumor, summary, and model-generated claims remain outside the positive label.

The profile enables a versioned UTC daily authority ledger:

- pre-grid dates remain outcome-discovery-only;
- a grid day first becomes a pending candidate;
- the same count-reconciled ledger must be seen in at least two actual fetches
  separated by six hours or more;
- the promoting fetch must occur at least 36 hours after UTC day-end;
- `asserted_at` and `replay_available_at` use that real promoting fetch, never
  day-end or the first deployment time.

The configured refresh interval is 15 minutes, but elapsed stability is measured
from real fetch timestamps. A first run cannot immediately create eligible
negative history. Run the profile locally with a dedicated data root:

```bash
export RESET_CONFIG="$PWD/config/tibo-authority-live.json"
export RESET_DATA_DIR="$PWD/data/tibo-authority"
node src/cli.mjs ingest-archive
node src/cli.mjs process
node src/cli.mjs status
```

Keep the scheduler running for subsequent observations, or invoke
`ingest-archive` again after the required elapsed time. Do not alter timestamps or
reseed data to bypass the stability gate.

To switch an existing Compose service, edit the ignored `.env` file:

```dotenv
RESET_CONFIG=/app/config/tibo-authority-live.json
HISTORICAL_MONITOR_ENABLED=true
RSSHUB_BASE_URL=https://rss.dreaife.tokyo
```

Then recreate only the application container while preserving the external data
volume:

```bash
docker compose -f compose.yaml -f compose.cloudflare.yaml \
  up --build -d --no-deps reset-forecaster
curl http://127.0.0.1:8799/api/readiness
```

`run_on_start` performs the initial collection and seeds the pending ledger
candidates. Do not start a second manual ingestion process while the scheduled
pipeline is running.

While coverage is waiting, the scheduler keeps the normal 10-minute cadence and
also wakes just after `earliest_recheck_at` when that deadline falls before the
next scheduled run. A due stability recheck bypasses the provider's normal refresh
interval so that this wakeup performs a real second observation.

Do not run `down -v` and do not copy a seed over the existing volume. The outcome
definition changes the model compatibility signature, so an older champion or
evaluation is retained for audit but is not served as compatible evidence.
Immediately after switching, the pipeline uses eligible historical records already
present at its cutoff to batch-fit a provisional bootstrap; it does not wait for
future wall-clock collection merely to begin training. The live profile enables
this path once the batch contains at least ten eligible outcomes. If that minimum
or negative-label coverage is still missing, HTTP 503/not-ready remains expected.
A provisional HTTP 200 forecast is explicitly labeled `provisional` and must not be
described as validated 80% performance. The `validated` state still requires at
least 1,008 evaluated hourly windows, 20 eligible events, and a passing compatible
walk-forward/calibration evaluation.

Useful commands:

```bash
node src/cli.mjs ingest-x
node src/cli.mjs ingest-gateway --query tibo-reset-signals
node src/cli.mjs ingest-rsshub
node src/cli.mjs ingest-archive
node src/cli.mjs process
node src/cli.mjs train
node src/cli.mjs evaluate
node src/cli.mjs forecast
node src/cli.mjs pipeline --retrain
node src/cli.mjs status
```

`train` batch-fits a challenger at one frozen cutoff and performs the compatible
rolling-origin evaluation attempt in the same command; it does not itself issue a
forecast. `pipeline --retrain` performs collection, fit/evaluation, and forecast
issuance together. Under the enabled provisional-bootstrap policy, a converged
challenger with the configured minimum eligible outcomes may then issue a clearly
labeled provisional forecast while strict validation remains pending. It becomes
validated only when the evaluation and challenger compatibility signatures match,
event-window recall is at least 80%, Brier skill beats the historical baseline,
expected calibration error stays within the configured ceiling, and it satisfies
the existing champion comparison on the same fold definition.

The 80% value is a validated event-window recall threshold, not ordinary per-hour
accuracy and not a provisional-bootstrap claim. Each held-out UTC week has one
shared fixed alert budget; the selected windows are reused for every event and for
false-alert accounting. The evaluator never reselects a fresh top-N prefix for each
event. It also reports log loss, average precision, calibration intercept and slope,
expected calibration error, false alerts under the same policy, useful lead time,
and policy-peak absolute event offset.

Only providers named in `model.outcome_coverage_providers` may establish negative
label coverage. Context-source availability alone can never turn an unobserved hour
into a negative label.

### Optional X Search Gateway

The provider-neutral runtime can also read the local/LAN X Search Gateway:

```bash
export X_SEARCH_GATEWAY_ENABLED=true
export X_SEARCH_GATEWAY_URL='http://gateway-host:8787'
export X_SEARCH_GATEWAY_PROVIDER=grokbuild
export X_SEARCH_GATEWAY_TOKEN_FILE='/path/to/gateway-token'
node src/cli.mjs ingest-gateway --query tibo-reset-signals
node src/cli.mjs process
```

Keep the bearer value out of commands, logs, and committed configuration.
`grokbuild` is the current gateway default and runs the local Grok CLI search path.
Its output is search-derived rather than attested source text, so the adapter marks
those records as aggregator-only context and outcome adjudication rejects them.
The adapter replays the gateway's `all_events` only when bootstrapping a new local
provider state; later polls consume the gateway's incremental `events` result so
wording changes in already-seen summaries do not masquerade as newly discovered
posts. For X status URLs, `published_at` is derived deterministically from the
status snowflake when the search response omits or varies `created_at`.
The default context provider gate is 30 minutes. The shared scheduler checks that
gate on its 10-minute boundaries; it is not a separate 30-minute timer.
Independent configured queries are requested concurrently and then merged in
configuration order. One failed query is reported without discarding successful
query results and is retried at the next scheduler boundary without advancing the
full-success gate, while an all-query failure still fails the provider run.
If the Grokbuild path is unavailable, set `X_SEARCH_GATEWAY_PROVIDER=hermes` as a
rollback; Hermes receives the same summary/context-only treatment. The SocialData
upstream can return exact text but may bill a full upstream page even for a small
requested limit; enable it only deliberately. No gateway mode asserts exhaustive
timeline coverage, so gateway results cannot create negative labels.

## Scheduled website service

By default, `npm start` only serves saved data. Set
`RESET_SCHEDULER_ENABLED=true` to collect and publish after the next UTC boundary
and, unless disabled, once at startup. A run collects and processes first, freezes
an actual post-collection knowledge cutoff, and starts its 168-hour target at the
next complete hour. `issued_at` is recorded when publication is complete rather
than copied from the run's start. The scheduler prevents overlapping runs. The
checked-in `runtime.scheduler_interval_minutes` is 10, so the provider/forecast
pipeline retries on the following 10-minute boundary after an error, while
parameter-refit requests remain limited by the configured batch interval.

New provider signals are normalized into the next run's hourly-slot feature
snapshots and may change that forecast within the 10-minute cadence without
changing model parameters. Parameter updates are reproducible batch fits at most
once per configured 24-hour interval.
Each batch uses only labels mature and available at its frozen training cutoff and
performs the walk-forward evaluation attempt in the same run; there is no separate
weekly evaluator. Data that arrives while training is running is left for the next
batch and does not restart the current fit. Failed or non-converged challengers do
not replace the stable model. A failed retrain request is also rate-limited by the
same interval instead of launching the optimizer again every 10-minute run. A
stored challenger can be re-evaluated between batch fits as a causal fold becomes
scorable; this does not retrain it or alter its parameters. If a mature evaluation
sample fails the quality gate, a validated champion remains active. With no
validated champion, new forecasts fail closed until a later batch using newly
mature data passes or the operator explicitly changes the training contract.

Every fit also applies `feature-support-gate/1`: a learned input needs non-zero
support in at least three independent positive intervals and 24 covered negative
hours, and near-perfect duplicate columns are reduced to one representative.
`live-forecast-promotion-guard/2` then checks current 4-, 24-, and 72-hour raw
probabilities plus same-snapshot combined clip contributions. If an old provisional
model does not pass that current guard, `/api/forecast/current` returns 503 instead
of continuing to expose its saved prediction.

```bash
RESET_SCHEDULER_ENABLED=true npm start
```

The service exposes:

- `GET /api/health`
- `GET /api/forecast/current`
- `GET /api/forecast/snapshots/:record_id/:revision`
- `GET /api/readiness`
- `GET /api/evidence/recent`
- `GET /api/history/results`
- `GET /api/evaluation/summary`
- `GET /api/evaluation/events`
- `/` for the 4-hour, 24-hour, and 7-day forecast views
- `/accuracy` for the confirmed reset history (the path is retained for bookmark
  compatibility)

`GET /api/evidence/recent` returns semantic arrays `core`, `experience`,
`competition`, and `other_context`, plus a combined `items` view. It also returns
up to 12 exact-source `timeline` entries for the configured Tibo confirmation
identity, including posts that did not match a normalized signal, and up to eight
current `impact_episodes` ranked by pressure and recency. Experience items include
`impact`; competition items include `competitive_context`; every evidence item
states whether it was known at the forecast cutoff, whether it was actually
feature-eligible, and its exact source/collection provenance. Thus a displayed
experience report can have `known_at_forecast_cutoff=true` while
`included_in_forecast=false`. Impact pressure is a bounded follow-up measurement,
not reset probability. Each episode exposes its pressure `as_of` and policy
binding; `impact_tracking.enabled=false` returns no historical episodes rather
than presenting stale append-only state as current. For one compatibility version
the endpoint also returns
deprecated `community`, equal to the aggregate of the three non-core groups. New
clients must use the semantic arrays; the website no longer treats community
resonance as a signal. The browser loads this evidence endpoint only when an
evidence section approaches the viewport, and reloads it after the exact current
prediction reference changes. Evidence is not part of the forecast page's
first-render critical path. This reduces initial work without changing the
underlying 10-minute collection scheduler.

`/api/health` reports every configured provider separately, including its role,
last success, latest unresolved error, age threshold, and effective stale state.
The aggregate compatibility timestamp is informational only: a fresh context
provider cannot mask a stale required exact/outcome source. Provisional availability
and validated readiness are separate. Insufficient causal/as-issued evaluation by
itself does not block an eligible provisional forecast, but the response remains
explicitly labeled `provisional`, retains the validation blockers, and must not be
presented as a validated probability. Missing legal training coverage, stale
required sources, or model/feature integrity failures still fail closed. Pipeline
failures remain visible and prevent validated publication; a still-fresh compatible
stable forecast may continue serving under its existing stage. An explicitly
labeled `synthetic_demo` remains available only for local mechanics and carries its
full blocker list beside the displayed percentage.

The same health response exposes `current_prediction_ref` with the exact
`record_id`, `revision`, and immutable snapshot URL. The browser always refreshes
this small dynamic response, but downloads the full prediction only when that exact
reference changes. The snapshot endpoint serves only the exact prediction
currently named by the persisted serving projection, contains only that canonical
record, uses a strong ETag, and is safe for long-lived immutable HTTP caching.
Unknown or older refs return `404` without scanning prediction history. The
`/api/forecast/current` alias and `/api/health` remain `no-store` because serving
eligibility, source freshness, and runtime status can change while a prediction
record stays unchanged. A cached snapshot is never enough to override a current
fail-closed health result.

On process start, the service rebuilds or verifies the serving projection before
starting the configured run-on-start pipeline. While that one-time warmup is in
flight and no prior valid projection exists, `/api/health` returns a fast
`503` with `status: "warming"` instead of holding the request open behind a large
JSONL scan. The page retries this state after 30 seconds. Once the projection is
ready, the ordinary 10-minute scheduler begins and refreshes it after every final
success or failure state.

`GET /api/readiness` makes the split machine-readable. An eligible bootstrap reports
`serving_ready: true` and `serving_stage: "provisional"` while
`publication_ready` remains false until the original validated gate passes.
`serving_blockers` control whether any forecast can be returned;
`publication_blockers` explain why it cannot yet be called validated.

When an outcome provider has complete-day candidates undergoing its required
stability observation but no adequate interval yet, this is an expected wait
rather than `pipeline_error`. Readiness and health expose
`pipeline_status: "waiting_for_coverage"` plus `coverage_waiting` with the
candidate count, earliest first observation, and earliest reliable recheck time.
Publication remains blocked with `negative_label_coverage_pending`, and the
forecast endpoint continues to return HTTP 503.

Once coverage is adequate, fitting the challenger and proving it out of sample
remain separate steps. If the challenger is saved but no causal walk-forward fold
has matured yet, the run succeeds with
`pipeline_status: "waiting_for_evaluation"` and `evaluation_waiting`. With the live
profile's enabled bootstrap policy and at least ten eligible outcomes, that same
compatible challenger may issue a forecast whose model metadata says
`validation_status: "provisional"` immediately after fitting, while strict
evaluation continues in the same run; it is not written as a validated champion.
If the provisional minimum is not met, `forecast` remains null. The scheduler
records the successful fit time and reuses the compatible challenger between daily
retraining intervals. If a compatible validated champion already exists, it
continues issuing validated forecasts while the challenger waits.

The live profile also runs `live-forecast-promotion-guard/1` before a newly fitted
or reused challenger can issue a provisional prediction or enter evaluation.
Reused artifacts are checked again against the current live snapshots, so enabling
or tightening the guard cannot inherit an unattested provisional alias. Readiness
and health expose the last guard decision, compared model refs, probability
deltas, clip-bound feature diagnostics, blockers, and restoration result. A
rejected new candidate restores the prior challenger pointer; the serving champion
remains in service. A rejected bootstrap or reused challenger without a serving
fallback is recorded as `pipeline_status: "promotion_blocked"` together with its
guard decision. On a feature-contract migration with no compatible baseline,
bootstrap uses the configured absolute four-hour saturation ceiling rather than
silently falling back to audit-only mode.

Training freezes the exact post-processing knowledge cutoff, so coverage that
becomes verifiably available a few minutes after an hour boundary can be used in
that run without backdating it. Walk-forward scoring remains aligned to the
completed UTC hour. When the exact training cutoff has coverage but the hourly
evaluation cutoff does not yet have it, the run reports
`walk_forward_coverage_cutoff_pending` instead of a pipeline failure.
Provider records and labels that arrive after the frozen cutoff are deliberately
excluded from the running batch and enter the following batch; do not cancel or
restart training to include them.
New daily coverage candidates keep their exact recheck wake-up even while the
top-level pipeline is waiting for evaluation, so a deadline just after an hour
boundary is not deferred beyond the next scheduled run.

The canonical data directory is append-only under `data/records`. Immutable
coverage assertions live under `data/audit`; `data/state/coverage.json` is only a
rebuildable current view. Provider cursors, evaluations, runtime status, source
payload blobs, and champion/challenger artifacts live under the same configured
data root. Back up the whole root together.

One configured data root has exactly one writer process. Do not run a manual
pipeline command against the live server's data directory, and do not overlap two
containers during a rollout; request concurrency inside one process is serialized,
but the JSONL store intentionally has no cross-process writer lock. Read-only
backup and inspection remain safe.

`feature_snapshot.jsonl` remains canonical. A rebuildable exact-reference sidecar
under `data/indexes` records byte offsets for deterministic existence checks and
targeted reads, so a new 10-minute forecast does not scan the full multi-gigabyte
JSONL file merely to prove that its 168 new snapshot IDs are absent. Canonical rows
are appended before sidecar progress is checkpointed; after a crash, startup
recovers only the unindexed canonical tail, and a missing or invalid sidecar is
rebuilt from the JSONL source of truth.

`data/state/serving-snapshot.json` is likewise a rebuildable serving projection.
It atomically binds one exact prediction to the structural readiness/evaluation
result completed for the same runtime watermark. Request-time code rechecks the
dynamic clock, provider freshness, and runtime status instead of rerunning the
full structural audit for every browser request. A completed scheduler run
refreshes the projection after final runtime state is written.

`/accuracy` is intentionally a confirmed-history page despite its retained legacy
path. It calls `/api/history/results`, lists the latest eligible confirmed outcome
revisions and exact official sources, and does not depend on evaluation state.
Walk-forward and `as_issued` scores remain available through operator APIs and
continue to govern promotion and validated publication. Those scores use only the
immutable hourly forecasts that users could actually have seen; evidence modes are
never labeled as one another.

The history projection remains on the append-only JSONL store; it does not require
a separate SQL database. The endpoint loads outcome and signal types only when
requested, resolves raw observations by exact verification refs, and shares one
30-second derived result across concurrent requests. HTML, JavaScript, and CSS are
served with revalidation so a deployment cannot combine new markup with an older
cached script. The history browser request also fails visibly after 15 seconds
instead of leaving the initial loading row indefinitely.

## Docker

```bash
cp .env.example .env
docker volume create codex-reset-forecaster-data-v1
docker run --rm \
  -v "$PWD/data/refresh-20260725:/seed:ro" \
  -v codex-reset-forecaster-data-v1:/data \
  alpine:3.20 \
  sh -ceu 'test -z "$(ls -A /data)"; cp -a /seed/. /data/'
docker compose -f compose.yaml -f compose.cloudflare.yaml up --build -d
curl http://127.0.0.1:8799/api/health
curl http://127.0.0.1:8799/api/readiness
```

The local production container binds only to loopback on host port `8799`; the
Cloudflare Tunnel reaches it over the configured external Docker network using the alias
`codex-reset-forecaster`. It persists `/data` in the explicitly created
`codex-reset-forecaster-data-v1` volume and enables the 10-minute scheduler.

The volume must be seeded only while it is new and empty. Preserve the complete
data root together: canonical records, blobs, provider state, coverage,
evaluations, and champion/challenger models. Never merge a snapshot into a
non-empty running volume.

The X Search Gateway bearer stays in the existing mode-600 host token file and is
mounted read-only at `/run/secrets/x-search-gateway-token`. Direct X collection
remains disabled unless `X_BEARER_TOKEN` or `X_BEARER_TOKEN_FILE` is deliberately
supplied; Compose mounts the latter read-only at `/run/secrets/x-bearer-token`.
Disabled token mounts default to `/dev/null`, so a fresh deployment does not
require placeholder secret files. When enabling either provider, set its
`*_TOKEN_FILE_HOST` to the real mode-400/600 host file.

An HTTP `503` with `status: waiting` is expected while coverage candidates are
completing their stability observation and no saved prediction exists. If an old
prediction exists, the top-level status can instead be `stale`; use
`pipeline_status` and `coverage_waiting` for the current pipeline state.
`status: not_ready` applies when no expected wait or saved prediction is known.
The container health check accepts these application states but still fails on
transport or unexpected server errors.
Production deployment verification must additionally require:

- `/api/readiness` reports `publication_ready: true` and `synthetic_only: false`.
- `/api/forecast/current` returns 168 hourly slots.
- `/api/health` points at the same exact prediction reference, and its immutable
  snapshot URL returns that canonical record with a strong ETag.
- At least one configured outcome provider has current
  `negative_label_eligible` assertions with completeness evidence.
- The Tunnel route maps the chosen public hostname to
  `http://codex-reset-forecaster:8787`.
