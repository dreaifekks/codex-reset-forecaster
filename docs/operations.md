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
accounts and queries. It paginates user timelines, preserves native quote/repost
relations, stores raw payloads, and maintains `since_id` cursors. Override
`config/default.json` with a file referenced by `RESET_CONFIG`; never put a token in
that file.

`config/live.example.json` is a starting override. Adjust its backfill start to the
actual entitlement and copy `.env.example` to the ignored `.env` file for Docker
Compose. Pagination exhaustion establishes only `outcome_only` discovery coverage
by default. It must never be described as negative-label coverage.

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

A contiguous archive date grid is not proof that every unlisted hour was observed.
The adapter therefore writes an append-only `outcome_only` coverage assertion by
default and cannot provide training negatives or settle a no-reset window. A
`negative_label_eligible` assertion requires separate, explicit completeness
evidence and is rejected when that evidence is absent. Posts discovered only by
following links from known reset posts are marked outcome-conditioned and excluded
from forecast features.

For a genuine archive walk-forward, that independent attestation must also provide
`replay_available_at`: the UTC instant at which the covered interval was
historically complete and knowable. It must be no earlier than the interval end and
no later than the real import `asserted_at`. This clock is used only in archive
replay; live settlement continues to use `asserted_at`.

Useful commands:

```bash
node src/cli.mjs ingest-x
node src/cli.mjs ingest-gateway --query tibo-reset-signals
node src/cli.mjs ingest-archive
node src/cli.mjs process
node src/cli.mjs train
node src/cli.mjs evaluate
node src/cli.mjs forecast
node src/cli.mjs pipeline --retrain
node src/cli.mjs status
```

`train` creates a challenger, evaluates rolling-origin folds, and promotes it only
when the optimizer converged, the evaluation and challenger compatibility
signatures match, event-window recall is at least 80%, Brier skill beats the
historical baseline, expected calibration error stays within the configured
ceiling, and it improves on an existing champion using the same fold definition.

The 80% value is event-window recall, not ordinary per-hour accuracy. Each held-out
UTC week has one shared fixed alert budget; the selected windows are reused for
every event and for false-alert accounting. The evaluator never reselects a fresh
top-N prefix for each event. It also reports log loss, average precision,
calibration intercept and slope, expected calibration error, false alerts under the
same policy, useful lead time, and policy-peak absolute event offset.

Only providers named in `model.outcome_coverage_providers` may establish negative
label coverage. Context-source availability alone can never turn an unobserved hour
into a negative label.

### Optional X Search Gateway

The provider-neutral runtime can also read the local/LAN X Search Gateway:

```bash
export X_SEARCH_GATEWAY_ENABLED=true
export X_SEARCH_GATEWAY_URL='http://gateway-host:8787'
export X_SEARCH_GATEWAY_PROVIDER=hermes
export X_SEARCH_GATEWAY_TOKEN_FILE='/path/to/gateway-token'
node src/cli.mjs ingest-gateway --query tibo-reset-signals
node src/cli.mjs process
```

Keep the bearer value out of commands, logs, and committed configuration. Hermes
may return faithful summaries rather than exact source text, so the adapter marks
those records as aggregator-only context and outcome adjudication rejects them.
The SocialData upstream can return exact text but may bill a full upstream page
even for a small requested limit; enable it only deliberately. Neither gateway
mode asserts exhaustive timeline coverage, so it cannot create negative labels.

## Scheduled website service

By default, `npm start` only serves saved data. Set
`RESET_SCHEDULER_ENABLED=true` to collect and publish after the next UTC boundary
and, unless disabled, once at startup. A run collects and processes first, freezes
an actual post-collection knowledge cutoff, and starts its 168-hour target at the
next complete hour. `issued_at` is recorded when publication is complete rather
than copied from the run's start. The scheduler prevents overlapping runs and
retries on the following hour after an error. It retrains at the configured daily
interval; failed or non-converged challengers do not replace the champion.

```bash
RESET_SCHEDULER_ENABLED=true npm start
```

The service exposes:

- `GET /api/health`
- `GET /api/forecast/current`
- `GET /api/readiness`
- `GET /api/evidence/recent`
- `GET /api/evaluation/summary`
- `GET /api/evaluation/events`
- `/` for the 4-hour, 24-hour, and 7-day forecast views
- `/accuracy` for separately labeled walk-forward or mature as-issued metrics,
  calibration, and event history

`/api/health` reports every configured provider separately, including its role,
last success, latest unresolved error, age threshold, and effective stale state.
The aggregate compatibility timestamp is informational only: a fresh context
provider cannot mask a stale required exact/outcome source. The current-forecast
endpoint fails closed with HTTP 503 whenever `publication_ready` is false, so
missing negative-label coverage, insufficient real evaluation, stale sources,
pipeline failures, and model/feature integrity failures cannot be presented as a
current probability. The sole exception is an explicitly labeled
`synthetic_demo`; it remains available for local mechanics and carries its full
publication blocker list beside the displayed percentage.

The canonical data directory is append-only under `data/records`. Immutable
coverage assertions live under `data/audit`; `data/state/coverage.json` is only a
rebuildable current view. Provider cursors, evaluations, runtime status, source
payload blobs, and champion/challenger artifacts live under the same configured
data root. Back up the whole root together.

Before enough live forecasts mature, `/accuracy` explicitly shows the as-of-safe
walk-forward result used for model promotion. Once mature saved predictions and the
configured minimum live windows and events exist, the page switches to `as_issued`
evaluation. Those scores use only the immutable hourly forecasts that users could
actually have seen; the two evidence modes are never labeled as one another.
The UI also labels a retrospective import as `ARCHIVE REPLAY` from attested
availability provenance rather than from any specific provider name.

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
`codex-reset-forecaster-data-v1` volume and enables the hourly scheduler.

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

An HTTP `503` with `status: not_ready` is expected before a model has enough covered
confirmed outcomes to pass the promotion gate; the container health check accepts
that application state but still fails on transport or unexpected server errors.
Production deployment verification must additionally require:

- `/api/readiness` reports `publication_ready: true` and `synthetic_only: false`.
- `/api/forecast/current` returns 168 hourly slots.
- At least one configured outcome provider has current
  `negative_label_eligible` assertions with completeness evidence.
- The Tunnel route maps the chosen public hostname to
  `http://codex-reset-forecaster:8787`.
