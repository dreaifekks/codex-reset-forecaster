# Data contract

## Canonical envelope

All records use the same versioned envelope:

```json
{
  "schema_version": "reset-intel/0.2",
  "record_type": "normalized_signal",
  "record_id": "sig_01J...",
  "revision": 1,
  "supersedes": null,
  "created_at": "2026-07-23T05:00:00Z",
  "producer": {
    "name": "claim-extractor",
    "version": "0.1.0",
    "config_hash": "sha256:..."
  },
  "data": {}
}
```

Corrections create a new revision. References always include both `record_id` and
`revision` so that historical forecasts remain reproducible.

`config_hash` binds configuration that can change collection semantics, taxonomy,
extraction, features, labels, or the model. Deployment-only runtime values such as
the data directory, bind address, port, and scheduler timing are excluded; moving
the same immutable forecast between hosts must not invalidate its model contract.

## Record types

### `raw_observation`

Provider-neutral source material. Important fields include provider and native
identifier, canonical URL, publication/collection times, author identity, native
relations, content hash, text, a raw payload reference, and an optional historical
availability attestation.

The provider/native identifier is the stable record identity. If a later fetch
changes normalized material, the collector appends the next revision, preserves
the original `first_seen_at`, records the new `fetched_at`, and points
`supersedes` to the exact prior revision. `material_hash` identifies the normalized
material while `content.raw_payload_hash` identifies the saved provider payload.
Selection/timing metadata records whether discovery was outcome-conditioned and
separates source publication time from provider observation time.

`availability_attestation` never replaces collection timestamps. It may establish
an earlier model-usable time for an archive replay only when the adapter records all
of the following: the attested UTC time, a constrained basis, the attestor URL, the
verification time, and the verification method. The current historical monitor
uses `direct_source_publication` only after the X oEmbed response confirms the
configured author and source ID and the X snowflake independently agrees with the
publication timestamp. Unattested imports use their real fetch time.

### `normalized_signal`

A structured claim extracted from one or more observations. It carries the subject,
event type, phase, stance, affected scope, asserted time range, author certainty,
source role, evidence root, independence group, extraction version, and extraction
confidence.

### `event_candidate`

A revisable hypothesis that links supporting and contradicting signals. Evidence
entries explicitly state their provenance relationship and independence group.

### `reset_outcome`

The only record that can settle the selected, versioned target. It includes the
observed occurrence interval, when that result became known, label grade,
verification evidence, scope, and related candidates.

Under `config/tibo-authority-live.json`, the operational target is a qualifying
primary statement from the configured Tibo identity that a platform-wide Codex
reset/refill completed. It is not a claim that every physical backend reset is
covered. A `started`, scheduled, expected, rumor, summary, or model-generated
statement may support a candidate but does not create a gold outcome. The provider
post still remains a `raw_observation`; adjudication creates the separate
`reset_outcome` record.

`event_identity` is stable across repeated observations of the same platform event.
It is derived from the canonical evidence root and asserted occurrence interval,
not from the day on which the collector happened to observe it. A later completion
statement revises or supersedes the same outcome instead of creating a second
event.

### `feature_snapshot`

An immutable feature vector with its forecast target, knowledge cutoff, feature
schema version, provider coverage, and exact source record references.

### `prediction`

A seven-day list of hourly hazard and derived probabilities, plus the no-reset
probability, uncertainty, data quality, model version, training cutoff, calibrator,
and feature snapshot references.

### `prediction_settlement`

An immutable assessment of the as-issued prediction's current four-hour window.
It is `pending` before maturity, `positive` only when a confirmed outcome overlaps,
`negative` only with adequate confirmation-source coverage, and `censored` when the
window matured without adequate coverage. Every decision retains the exact
`coverage_assertion_refs` and a hash of the complete assertion snapshot used at
`settled_at`; a negative is valid only when those assertions jointly cover the
whole half-open window. A later outcome, superseding/revoked coverage assertion,
or coverage backfill creates a new revision that supersedes the exact earlier
settlement.

## Time semantics

The following values must never be substituted for one another:

| Field | Meaning |
| --- | --- |
| `published_at` | Time claimed by the source/provider |
| `first_seen_at` | First time this system obtained the item |
| `fetched_at` | Time of a particular fetch |
| `availability_attestation.available_at` | Independently verified historical time at which the exact source was public; optional and never the time this collector first saw it |
| `available_at` | Time normalized information became model-usable |
| `asserted_time_range` | Time range claimed by the source |
| `occurred_time_range` | Later adjudicated interval for the selected operational outcome |
| `known_at` | Time the outcome became known to the system |
| `replay_available_at` | Optional independently attested historical availability used only for an explicitly labeled archive replay; never a replacement for `known_at` |
| `knowledge_cutoff` | Latest information a forecast may use |

All canonical times are RFC 3339 UTC. All ranges are half-open `[start, end)`.
Provider-local or author-inferred time zones are retained as interpretation metadata,
not used as replacements for canonical UTC. The runtime resolves the `system`
configuration sentinel to Node's concrete `tzdata-<version>` value before hashing
configuration or producing feature snapshots.

An outcome-confirmation post does not make `published_at` and
`occurred_time_range` interchangeable. If the source does not state an exact event
time, a versioned adjudication policy records an interval and its precision.

For an ordinary live or unattested backfill observation, signal `available_at` is
no earlier than the actual fetch. For a verified archive or direct-source backfill
replay, the first normalized revision may use independently attested historical
availability. Any later correction uses its real correction time. `first_seen_at`
always remains the actual import time in both cases, so archive replay and live
`as_issued` evidence remain distinguishable.

Canonical envelope `created_at` and outcome `known_at` always record when this
system actually created or adjudicated the record. A verified archive may carry an
earlier signal `available_at` and outcome `replay_available_at` for a clearly
labeled historical replay, but those attested clocks never backdate the canonical
creation or system-knowledge clocks.

## Claim taxonomy

Initial event types:

- `quota_reset`
- `quota_refill`
- `limit_policy_change`
- `capacity_restore`
- `incident`
- `release`
- `development_activity`
- `competitor_limit_change`

Initial phases:

- `rumor`
- `expected`
- `scheduled`
- `started`
- `completed`
- `denied`
- `cancelled`

Stance is one of `supports`, `contradicts`, `neutral`, or `unknown`.

Product scope is extracted from the text rather than inherited from the forecast
target. OpenAI signals use `codex`, `chatgpt_work`, `unknown`, or
`multi_product`; a multi-product scope carries an explicit unique `products`
membership array. A Codex outcome requires an explicit `codex` scope or a
`multi_product` scope whose membership contains `codex`. ChatGPT Work-only and
unknown reset statements remain context and cannot settle a Codex label.

## Evidence independence

Deduplication has three different layers and none may replace another:

1. exact duplicate content/provider items;
2. semantic restatements or derived coverage;
3. signals referring to the same candidate reset event.

`independence_group_id` identifies the root information source. Reposts, quotes,
articles, and summaries derived from that root do not create additional independent
votes. Evidence relations include `independent`, `quotes`, `repost`, `summarizes`,
and `unknown`.

The configured extractor contract binds `model`, `model_version`,
`prompt_version`, and `semantic_policy_hash`. The semantic policy hash is computed
from the normalized forecast target plus the provider-neutral identity,
source-role, and confirmation/context policy. Provider order and plan/region array
order do not affect it. When any bound value changes, normalization reprocesses
every stored raw-observation revision, not only the latest revision.
The replayed signal has `created_at` equal to the replay time. If that exact raw
revision was already extracted, its new signal also has `available_at` equal to
the replay time so a historical forecast cannot see an extractor result that did
not yet exist.

Consumers select one current extraction for an exact observation revision and
then the latest observation revision, so extractor upgrades do not turn one post
into multiple votes. If the corrected current claim changes a previously confirmed
outcome interval, adjudication appends a new outcome revision and points to the
exact superseded revision.

Feature selection requires the exact signal `semantic_policy_hash`; old
extractions cannot survive a target or role-policy change. The complete extractor
contract is also included in the model contract hash. Feature snapshots copy
`extractor_model`, `extractor_model_version`, and `extractor_prompt_version`
alongside the other versioned provenance fields. They also retain the exact
`coverage_assertion_refs` used at the knowledge cutoff.

## Outcome grades

- `gold`: an explicit official completion that satisfies the current
  `label_policy_version` and exact extractor/source-identity contract.
- `silver`: multiple genuinely independent observations with adequate scope and
  timing agreement.
- `rumor`: unverified information. It remains an input signal and cannot create a
  confirmed outcome.

`direct_platform_observation` is reserved for a future versioned and allowlisted
probe adapter. No such adapter is trusted in the current release, so records using
that verification kind are not label-eligible. A confirmed label must be produced
by the versioned outcome adjudicator, retain a stable event identity and candidate
reference, and resolve to the exact official observation plus current extraction.

If the outcome time is known only within an interval, retain that interval for
interval-censored training. If monitoring coverage is insufficient, do not create a
negative outcome.

## Outcome coverage assertions

Negative labels are governed by a separate append-only audit stream,
`audit/coverage_assertion.jsonl`. `state/coverage.json` is only its rebuildable
current projection. Each assertion includes:

- a stable assertion ID, revision, and exact superseded revision;
- provider, half-open UTC interval, mode, and asserted time;
- optional `replay_available_at`, distinct from the real `asserted_at`, when an
  independent completeness attestation proves when archived coverage was
  historically knowable;
- `adequacy`, either `outcome_only` or `negative_label_eligible`;
- structured evidence references and a rationale.

`outcome_only` means the source can help discover or verify positive events but says
nothing about hours with no item. `negative_label_eligible` requires completeness
evidence containing a payload reference, SHA-256 hash, method, and exhaustion time.
Training and negative settlement consume only current
`negative_label_eligible` assertions. A contiguous date grid, a successful search,
an exhausted account timeline, an account with no posts, or a green provider
health check is not completeness evidence by itself. Direct X additionally
requires a versioned outcome-exhaustiveness contract plus a hash-pinned,
independent immutable attestation that exactly covers target scope, the complete
confirmation identity set, the asserted interval, and its validity/expiry.
Live processing always uses `asserted_at`. Archive replay may use
`replay_available_at` only when the exact evidence entry is an independently
attested completeness manifest; otherwise it also falls back to `asserted_at`.

The Tibo-authority live profile defines one narrow completeness manifest:
`historical-daily-authority-ledger/1`. It applies only to the operational outcome
“qualifying completion statement from the configured Tibo identity” and never
claims exhaustive knowledge of physical backend resets. Its rules are:

- each assertion covers exactly one half-open UTC day from the archive's daily
  grid and binds the reconciled `data-count`, verified source items, target scope,
  identity set, policy, source HTML, and hashes;
- dates before the first grid date may discover positive outcomes but cannot
  create negative-label coverage;
- a new or changed day ledger begins as a pending candidate;
- promotion requires at least two actual fetch observations of the unchanged
  ledger spanning six hours or more, with the promoting fetch no earlier than 36
  hours after day-end;
- `asserted_at`, evidence exhaustion time, and `replay_available_at` all use that
  real promoting fetch time. They are never replaced with day-end or an earlier
  first-deployment time.

This contract permits an absent qualifying statement on a stable closed ledger to
form a negative label for that operational target only. A changed ledger
invalidates the prior evidence and begins a new stability window.

## Provider separation

`ingest_provider` describes how the record was collected. `subject.vendor` and
`subject.product` describe what it is about. A record collected through an X
provider about Anthropic is not an OpenAI label. Cross-vendor learning uses partial
pooling while preserving vendor-specific outcomes and baselines.
