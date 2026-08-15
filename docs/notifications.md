# Publication and notification contract

The notification subsystem is a channel-neutral projection of reset intelligence.
Atom, Web Push, and Telegram are presentation and delivery UI over model outputs,
equivalent in authority to the website rather than new evidence sources.
It does not add a ninth canonical record type and it cannot settle a forecast.
Canonical records remain governed by `schemas/reset-intel.schema.json`; publication
events use `publication-event/1`, are appended under the audit type
`publication-event`, and are described by
`schemas/publication-event.schema.json`.

## Event classes

| Topic | Events | Default delivery |
| --- | --- | --- |
| `authority` | a new, still-active exact authority time window | yes |
| `outcome` | a confirmed reset or a later correction, retraction, or verification withdrawal | yes |
| `experimental_probability` | a probability watch opening or closing | no; explicit opt-in only |

`authority` is a forward-looking source assertion, not an outcome. Its message
must say that the reset is not confirmed. `experimental_probability` is a model
projection, not evidence or an outcome. It may open only from a serving-ready,
fresh, non-synthetic prediction at or above the configured minimum serving stage.
Policy `publication-policy/2` opens the watch at a next-four-hour probability of
`0.50` and closes it only at or below `0.30`, or when a same-cycle confirmed
outcome ends the watch. Forecast refreshes inside an open watch do not create a new
event. A stale or otherwise unusable forecast neither opens nor closes it.

The projector processes outcomes before forward-looking events. A confirmed
outcome in the same run therefore wins and closes any stale probability watch.
Only `reset_outcome` can produce an `outcome.reset_confirmed.v1` event; an
observation, candidate, extractor confidence, evidence count, LLM judgment, or
forecast probability cannot.

The fixed `publication-policy/2` probability watch remains the shared public
experimental event stream. Its `experimental_probability` entries always use the
public next-four-hour `0.50` open and `0.30` close thresholds; they do not use a
visitor's rule. Parameterized Atom and personalized Web Push reuse the topic name
for subscriber-specific upward crossings, but consume the forecast-input stream
instead of rewriting or appending subscriber events to that ledger. Each fresh
eligible forecast is also projected into the bounded, non-canonical
`notification-forecast-input-stream/2`, containing its exact prediction reference,
model issue time, actual projection `emitted_at`, knowledge cutoff, expiry,
cumulative 1-through-168-hour probability curve, and exact outcome-revision gate.
Channel delivery state then evaluates `notification-preferences/1` with:

- integer `horizon_hours` from `1` through `168`;
- `probability_threshold` from `0.01` through `0.99`;
- a strict `probability > threshold` opening transition;
- a five-percentage-point lower close threshold to prevent repeated alerts near
  the boundary; and
- a silent baseline when a rule is first created or changed, so current high
  probability never creates a synthetic backlog notification.

The gate contains the complete latest-outcome revision token, latest effective
knowledge time, and current outcome entries. A delayed consumer cannot open from a
forecast whose knowledge cutoff predates that gate. Only a newly eligible outcome
whose occurred range ends after the current episode opened closes the watch;
historical corrections do not close and reopen the current episode.

These preferences and watch cursors are rebuildable presentation state. They are
not evidence, canonical records, model features, labels, calibration inputs, or
publication triggers. The website and Telegram bot are read-model UI over these
results: they may lazily request and cache necessary projections, but reading or
subscribing never feeds back into the intelligence pipeline.

## Startup, identity, and delivery time

The first successful pipeline generation observed by the projector is
`baseline_only`: it records current outcome, authority, and probability state but
emits no historical backlog. An empty volume, a partial failed run, or a restart
without a persisted pipeline `last_success_at` cannot establish that baseline.
Subsequent events
carry a monotonically increasing `sequence`, an exact-provenance `event_id`, a
content-stable `delivery_key`, a stable `entity_key`, the exact source record
revisions, the publication policy version and hash, and
`emitted_at`/`expires_at`. The ledger rejects a second event with the same
`delivery_key`. Consumers use `sequence` as their cursor and persist both
`event_id` and a recipient-scoped semantic delivery key. Re-reading, replaying, or
regenerating the same visible notification under a new revision must not create a
second queued delivery. An ambiguous transport failure can still be
at-least-once because Atom, Web Push, and the Telegram Bot API do not provide a
shared exactly-once transaction with this ledger.

`emitted_at` means when the publication projection was appended. It is not source
`published_at`, outcome `known_at`, the asserted future range, the adjudicated
`occurred_time_range`, or a forecast `knowledge_cutoff`. Every outcome event —
confirmation, correction, retraction, or verification withdrawal — expires at the
earlier of `known_at + outcome_max_delivery_delay` and
`occurred_time_range.end + outcome_max_delivery_delay`. A newly learned revision
can therefore update historical audit and accuracy state without reviving an old
Telegram, Web Push, or feed notification. A revision that changes only
lineage, exact references, or `known_at` updates projection state without emitting
a correction; user-visible status, occurred range, label grade, or verification-source
content must materially change. Occurred-range identity uses its start, end, and
precision; parser-only original text or timezone metadata cannot create a visible
correction. Authority delivery expires at the earlier of the asserted range end and
`emitted_at + authority_max_delivery_delay`. A consumer must discard an event whose
`expires_at` has passed both before enqueueing and immediately before delivery.
Expiry suppresses late delivery; it does not delete the audit event.

The cursor API is:

```text
GET /api/notifications/events?after=<sequence>&limit=<1..500>
GET /api/notifications/forecast-inputs?after=<sequence>&limit=<1..500>&horizon_hours=<1..168>&horizon_hours=<1..168>
GET /api/notification-preferences/baseline
```

Without `after`, it returns an empty `events` array and the latest cursor for safe
first-subscription baselining. Only an explicit `after=0` requests retained history.
Telegram dynamic subscriptions also persist their own stable-notification start
time, so an event emitted before the subscription cannot be enqueued merely because
an already-running global cursor request completes after the subscription command.
An `after` cursor ahead of the ledger tail is rejected instead of being silently
accepted. A paged response returns `events`, numeric `cursor`, string
`next_cursor`, and `has_more`. Clients should persist the returned cursor only after
durably recording the scanned page. Topic filtering happens at the consumer; a
skipped experimental event still advances the global cursor.

The forecast-input endpoint follows the same baseline-only request, bounded page,
retention-gap, and ahead-of-tail semantics, and returns the current
`outcome_revision_gate` on every response. Consumers durably store that gate with
their cursor and must evaluate delayed inputs against the returned current gate.
The core stream always retains its full 168-point curve. Supplying one or more
distinct, repeated `horizon_hours` parameters creates a read-only sparse
`notification-forecast-input-view/1` containing only those points; it does not
rewrite the stream. Telegram requests the distinct horizons present in its current
dynamic rules. When it has no probability rule, it omits `after` and requests only
the tail cursor and gate, so no input page or 168-point curve is transferred.

## Revisions and corrections

Canonical outcome history remains append-only. When a newer eligible outcome
revision changes a previously published result, the projector appends a new event;
it never edits or deletes the old item:

- `outcome.reset_corrected.v1` publishes a newer eligible confirmed revision;
- `outcome.reset_retracted.v1` reports that the latest canonical revision is
  rejected or cancelled;
- `outcome.verification_withdrawn.v1` reports that the current confirmation no
  longer satisfies the exact verification contract. This is not an assertion that
  the reset did not happen.

Correction events retain the stable outcome `entity_key`, identify their new exact
canonical refs, and set `supersedes_event_id` to the prior publication event. Feed
readers and bots should present the correction as a new item and treat the latest
event for an entity as current. The factual `/api/history/results` projection shows
only latest eligible confirmations, so an item may disappear there while the
publication ledger still preserves the confirmation and its withdrawal.

## Channels

Stable publication events share one ledger across channels. Personalized
probability Atom, Web Push, and dynamic Telegram delivery additionally consume the
separate forecast-input stream:

- `GET /feed.xml` is the default Atom 1.0 feed for `authority` and `outcome`.
  It is suitable for RSS/Atom readers and never includes probability watches.
- `GET /feeds/experimental.xml` includes all three topics and is an explicit
  experimental subscription. Its probability entries are the fixed public 4-hour
  watch (`0.50` open, `0.30` close), not the visitor's personalized rule.
- `GET /feeds/probability.xml?horizon_hours=<1..168>&probability_threshold=<0.01..0.99>&after=<baseline-sequence>`
  is a parameterized Atom view over eligible forecast inputs. It baselines the
  exact cursor embedded in the generated URL, emits only later upward crossings,
  applies the same hysteresis, and retains generated entries for 24 hours from
  their actual `emitted_at`. That Atom retention is independent of the shorter
  Web Push delivery expiry. If the cursor has been pruned or is ahead after a
  stream reset, the feed stays valid, reconstructs fail-closed, and can rearm only
  after retained observations establish a safe state. The URL itself is the
  subscription rule and baseline; it does not create server-side subscriber
  identity. Atom replays each retained input with the outcome gate captured when
  that input was emitted, then exposes only crossings whose gate still matches the
  current outcome generation. Feed and entry identities bind that baseline and
  any reset marker.
- Web Push defaults to `authority` and `outcome`. A browser must explicitly request
  `experimental_probability`. That topic uses the subscription's versioned
  `preferences`, a per-endpoint forecast-input cursor, and the shared transition
  state machine. Only an upward crossing produces a push; baseline and close
  transitions are silent. Subscriptions and delivery cursors are rebuildable
  state, not canonical intelligence.
- The Telegram bot can show `/forecast`, `/report`, `/history`, and `/lastreset`.
  `/subscribe` enables stable notifications; `/subscribe probability 24h 60%`
  sets the same personalized rule, `/subscribe experimental` is a `4h/50%`
  compatibility alias, and `/subscription` shows the current rule. Dynamic users
  consume forecast inputs, not the fixed global experimental ledger. The first
  forecast-input poll and every rule/cursor reset are silent; only an upward
  crossing queues a message, and close/rearm is silent.
  Its persistent `telegram-bot-state/4` outbox deduplicates stable event jobs by
  recipient, topic, and visible title/body after removing the generated send-time
  footer, while retaining `event_id` as a second exact key. Both keys survive a
  restart, so a regenerated event ID cannot resend the same visible message.

The website advertises the stable feed with Atom autodiscovery metadata. Its
notification configuration dialog controls the same horizon/threshold pair for
Web Push and generates the matching parameterized Atom URL only after the cheap
baseline endpoint returns the current cursor; failure never produces a replaying
fallback link. The probability checkbox changes only whether Web Push subscribes
to `experimental_probability`. For progressive disclosure, the page shows or hides
the shared probability controls and parameterized Atom generator together; that UI
visibility is not authorization, and the parameterized HTTP feed remains publicly
available independently of Web Push support or subscription state. The server
generates all 28 slider horizons from one read-only historical context, retains a
lineage-bound last-good snapshot across process restarts, and refreshes it
asynchronously at startup and after each successful
pipeline run. Expiry uses stale-while-revalidate: the prior valid horizon is returned
immediately while one forced background refresh regenerates the whole set. The
browser requests the explicit `view=compact` transport projection, which is publicly
cacheable for ten minutes with a bounded stale window; omitting `view` retains the
complete existing profile response. The browser also retains its own exact-horizon
ten-minute page cache. Range
input remains debounced while it moves, but the final `change` value bypasses that
delay; a completed exact-horizon request may seed only that horizon and may never
replace another selected view. A cache miss never blanks an already rendered chart:
the prior horizon remains visibly marked as a temporary, non-interactive reference
until the exact selected horizon replaces it atomically. Only a dialog with no
rendered profile uses the full loading state.

On a first-ever startup with no last-good snapshot, HTTP reads fail fast with `503`
and `Retry-After: 5` while the independent background warm continues; a request is
never attached to the worker's longer cold-scan budget. While the same dialog and
horizon remain selected, the browser follows that bounded retry signal for at most
two minutes and replaces the warming state when the profile becomes available.

The historical chart uses as-issued predictions and eligible covered outcomes. Its
density is separate from the strictly-threshold-above historical reset rate. The
drawing is focused to the historical mean plus or minus four population standard
deviations on the existing one-percentage-point grid; clipped outlying windows are
counted visibly but remain in every statistic, sample gate, and threshold result.
For a browser with no saved preference or manual threshold edit, the initial UI
suggestion is the mean plus two standard deviations, rounded upward to a real 1%
point. It does not change the channel-neutral `4h/50%` compatibility default and
never overwrites a saved or manually selected rule. Clicking or dragging the chart,
and keyboard edits on its range control, stay on real one-percentage-point profile
points. The selected threshold stays visible as a labeled dashed line, with a
subtle filled range from the displayed lower bound to that line; an out-of-domain
saved threshold is pinned to the nearest chart edge and labeled as outside rather
than being clamped. A point estimate is hidden until that point
has at least 20 non-overlapping windows; eligible points retain their Wilson 95%
interval. `preliminary` or insufficient samples must never be labeled as model
confidence or validated reliability.

Atom entry IDs and channel delivery keys use `event_id`. Atom `published` and
`updated` use `emitted_at`; they must not imply when an underlying reset occurred.
The checked-in RSSHub adapter is an input provider and is unrelated to these output
Atom feeds.

## Safe enabling

Publication and every credential-bearing transport fail closed. The baseline
configuration keeps publication disabled; the selected live profile may enable the
channel-neutral ledger. A fresh deployment still produces no backlog because of
`baseline_only`.

Web Push remains disabled until one persistent VAPID key JSON file is generated,
kept outside the repository with mode `0400` or `0600`, and mounted read-only. The
enabled runtime rejects inline private keys and any other file mode. Only its public
key may be returned to the browser; the private key must not appear in HTML, API
responses, `.env`, configuration committed to Git, or logs. Use HTTPS outside
localhost and keep subscription mutation same-origin. Same-origin headers are not
authentication and can be forged by a non-browser client. Before setting
`WEB_PUSH_ENABLED=true` on a public origin, the edge proxy must enforce a strict
per-client rate limit and a verified anti-automation challenge such as Turnstile on
`POST` and `DELETE /api/web-push/subscriptions`. Without that edge control, public
Web Push remains an intentional deployment blocker. The application accepts only
known browser-push service hostnames and revalidates stored endpoints before every
send; this limits egress but does not prevent subscription-capacity abuse.

The Telegram service is not started by the default Compose profile. Enable its
separate profile only after mounting a token-only file with mode `0400` or `0600`
and setting at least one positive `TELEGRAM_ADMIN_USER_IDS` value. The bot formats
timestamps in `Asia/Tokyo` by default, a fixed UTC+9 IANA zone. Every rendered
timestamp carries its resolved offset (for example `UTC+9`); set
`TELEGRAM_DISPLAY_TIME_ZONE` to another valid IANA zone to override it without
changing canonical UTC storage. The bot is public in one-to-one chats: it accepts
an ordinary user only when Telegram reports
`chat.type=private` and `chat.id=from.id`, so users do not need to be pre-enrolled
in an allowlist. Optional `TELEGRAM_BLOCKED_USER_IDS` is an abuse kill switch.
Groups are disabled by default; an explicitly listed negative
`TELEGRAM_ALLOWED_GROUP_CHAT_IDS` chat is read-only, requires commands addressed
to the bot username, and cannot change subscriptions. Static notification lists
may contain only administrators' private-chat IDs or explicitly allowed groups.

`/traffic` and capacity alerts are operations-plane data, not publication events.
They require an independent bearer token read from a regular `0400` or `0600`
file, are available only in an administrator's own private chat, and use a
separate durable cursor/outbox job class. Ordinary `/subscribe` state cannot
authorize these alerts. Never put either token in `.env`, checked-in JSON, command
output, health responses, or logs. Run exactly one bot replica against a bot-data
volume. State is bound to the Telegram bot ID, but the JSON state file deliberately
has a single writer and is not a multi-replica coordination database.

See `examples/publication-event.json` for a stable outcome event. It is validated
separately from canonical examples by `node scripts/validate.mjs`.
