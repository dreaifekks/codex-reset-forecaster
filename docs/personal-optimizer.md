# Personal quota and reset-voucher optimizer

## Boundary

This is a downstream consumer planned for a later phase. The platform forecaster
does not need retraining when personal inputs become available.

## Inputs

- platform weekly hourly hazard/probability list;
- current personal quota and estimated consumption;
- regular personal reset time or interval;
- predicted work demand and value by time;
- reset vouchers, effect size, expiration, cooldown, and stacking rules;
- risk preference and the cost of quota exhaustion.

## Problem class

A static one-shot assignment of vouchers to time slots resembles a time-windowed,
multiple-choice knapsack or assignment problem. The realistic problem is a
finite-horizon stochastic inventory/control problem because waiting preserves an
option, platform resets are uncertain, and using one voucher changes later value.

The personal layer should begin with rolling scenario optimization rather than
reinforcement learning:

```text
weekly platform hazard
  -> sample plausible reset scenarios
  -> simulate use-now / wait / exhaustion / expiry policies
  -> choose the highest expected utility under risk constraints
  -> recompute when the hourly platform forecast changes
```

## State and actions

State includes remaining quota, next personal reset, unexpired vouchers, cooldowns,
forecast demand, and the current platform-reset belief. Actions are wait or use a
specific voucher.

The reward should reflect completed-work value, blocked-work cost, voucher expiry,
and quota wasted by using a voucher shortly before a free reset.

## Output interface

The optimizer should return an action recommendation plus its decision window:

```json
{
  "action": "wait",
  "recommended_at": "2026-07-23T08:00:00Z",
  "reconsider_at": "2026-07-23T09:00:00Z",
  "latest_safe_voucher_use": "2026-07-23T16:00:00Z",
  "expected_utility": 0.74,
  "risk": {
    "quota_exhaustion_before_reset": 0.18,
    "voucher_expiry_unused": 0.07
  },
  "platform_forecast_ref": "pred_01J..."
}
```

This output is a personal decision score, not a platform reset probability.
