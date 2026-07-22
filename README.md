# Codex Reset Forecaster

Design baseline for a provider-neutral system that estimates when a platform-level
Codex quota reset or refill will actually occur.

The repository currently defines contracts and modeling constraints. It does not
yet contain a production collector, trained model, or personal quota integration.

## Current decisions

- The primary target is the time of an actual platform-level reset/refill, not the
  time of a post announcing one.
- The internal time base is 168 hourly anchors per week.
- At each hourly anchor, the product-facing forecast is the probability of a reset
  during the next four hours.
- Provider adapters only collect and normalize observations. Watchdogs, X feeds,
  official status pages, community sources, and other vendors are interchangeable
  providers rather than the core model.
- Text models extract stable claims. A statistical hazard model produces the final
  probability.
- New intelligence may change the current forecast immediately. Model parameters
  change only after an outcome is confirmed and the prediction can be settled.
- Personal quota windows and expiring reset vouchers are a downstream optimization
  layer and do not redefine the platform forecast.

## Core flow

```text
providers
  -> append-only raw observations
  -> normalized claims
  -> event candidates and evidence-dependency graph
  -> as-of feature snapshots
  -> hourly hazard and rolling four-hour forecast
  -> confirmed outcomes
  -> settlement, calibration, and controlled model updates
```

## Repository layout

```text
AGENTS.md                    Repository boundaries and working rules
docs/architecture.md        System components and lifecycle
docs/data-contract.md       Canonical records, timestamps, and provenance
docs/model-contract.md      Forecast target, model, training, and evaluation
docs/personal-optimizer.md  Later personal quota/voucher optimization interface
schemas/reset-intel.schema.json
                             JSON Schema for the canonical record envelope
examples/                   Provider-neutral example records
scripts/validate.mjs        Zero-dependency contract checks
```

## Validate

```bash
node scripts/validate.mjs
```

## Status

Version `0.1.0` is a design and contract checkpoint. Implementation should preserve
the invariants in `AGENTS.md` and the versioned contracts under `docs/` and
`schemas/`.
