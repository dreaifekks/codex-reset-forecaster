# Data contract

## Canonical envelope

All records use the same versioned envelope:

```json
{
  "schema_version": "reset-intel/0.1",
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

## Record types

### `raw_observation`

Provider-neutral source material. Important fields include provider and native
identifier, canonical URL, publication/collection times, author identity, native
relations, content hash, text, and a raw payload reference.

### `normalized_signal`

A structured claim extracted from one or more observations. It carries the subject,
event type, phase, stance, affected scope, asserted time range, author certainty,
source role, evidence root, independence group, extraction version, and extraction
confidence.

### `event_candidate`

A revisable hypothesis that links supporting and contradicting signals. Evidence
entries explicitly state their provenance relationship and independence group.

### `reset_outcome`

The only record that can settle the target. It includes the observed occurrence
interval, when that result became known, label grade, verification evidence, scope,
and related candidates.

### `feature_snapshot`

An immutable feature vector with its forecast target, knowledge cutoff, feature
schema version, provider coverage, and exact source record references.

### `prediction`

A seven-day list of hourly hazard and derived probabilities, plus the no-reset
probability, uncertainty, data quality, model version, training cutoff, calibrator,
and feature snapshot references.

## Time semantics

The following values must never be substituted for one another:

| Field | Meaning |
| --- | --- |
| `published_at` | Time claimed by the source/provider |
| `first_seen_at` | First time this system obtained the item |
| `fetched_at` | Time of a particular fetch |
| `available_at` | Time normalized information became model-usable |
| `asserted_time_range` | Time range claimed by the source |
| `occurred_time_range` | Later adjudicated reset interval |
| `known_at` | Time the outcome became known to the system |
| `knowledge_cutoff` | Latest information a forecast may use |

All canonical times are RFC 3339 UTC. All ranges are half-open `[start, end)`.
Provider-local or author-inferred time zones are retained as interpretation metadata,
not used as replacements for canonical UTC.

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

## Evidence independence

Deduplication has three different layers and none may replace another:

1. exact duplicate content/provider items;
2. semantic restatements or derived coverage;
3. signals referring to the same candidate reset event.

`independence_group_id` identifies the root information source. Reposts, quotes,
articles, and summaries derived from that root do not create additional independent
votes. Evidence relations include `independent`, `quotes`, `repost`, `summarizes`,
and `unknown`.

## Outcome grades

- `gold`: direct quota/UI/test-account observation or explicit official completion.
- `silver`: multiple genuinely independent observations with adequate scope and
  timing agreement.
- `rumor`: unverified information. It remains an input signal and cannot create a
  confirmed outcome.

If the outcome time is known only within an interval, retain that interval for
interval-censored training. If monitoring coverage is insufficient, do not create a
negative outcome.

## Provider separation

`ingest_provider` describes how the record was collected. `subject.vendor` and
`subject.product` describe what it is about. A record collected through an X
provider about Anthropic is not an OpenAI label. Cross-vendor learning uses partial
pooling while preserving vendor-specific outcomes and baselines.
