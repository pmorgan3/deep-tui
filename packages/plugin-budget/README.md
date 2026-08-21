# @deep-tui/plugin-budget

Adds per-run step, elapsed-time, token, and calculated-cost limits through the
agent lifecycle extension. A reached limit stops before the next model request
with the normal `limit-reached` run status, preserving the conversation and
usage accumulated so far.

```json
{
  "use": "@deep-tui/plugin-budget",
  "config": {
    "maxSteps": 64,
    "maxDurationMs": 1800000,
    "maxTotalTokens": 1000000,
    "maxCostUsd": 2
  }
}
```

`maxSteps` defaults to 64 and `maxDurationMs` defaults to 30 minutes. Token and
cost limits are opt-in because not every provider reports them. Usage limits
are necessarily soft by one model response: the plugin can account for a
response only after the provider reports its usage. Time is checked between
model steps; provider-level request timeouts remain a separate concern.

Cost limits consume the provider's calculated charge, so DeepSeek requests use
the peak or off-peak tariff active when each request starts. During DeepSeek's
01:00–04:00 and 06:00–10:00 UTC peak windows, the budget status displays
`DEEPSEEK PEAK` and `/budget status` notes that the active rates are twice the
off-peak rates.

Use `/budget`, `/budget status`, `/budget on`, or `/budget off` to inspect or
temporarily disable the policy for the current Deep TUI process.
