# @deep-tui/plugin-provider-deepseek

First-party DeepSeek provider for Deep TUI. It reads `DEEPSEEK_API_KEY` from the
process environment when a request starts; secrets do not belong in
`deep-tui.config.json`.

The model aliases map to DeepSeek's official API identifiers:

| Deep TUI model | DeepSeek API model |
| --- | --- |
| `flash` | `deepseek-v4-flash` |
| `pro` | `deepseek-v4-pro` |

```sh
export DEEPSEEK_API_KEY="your-key"
deep-tui run --model flash "Quick task"
deep-tui run --model pro "Hard reasoning task"
```

The full API identifiers are also accepted.

Streaming is on by default, including split reasoning/text/tool-call deltas and
final usage. Set `streaming: false` in this plugin's config to use the canonical
non-streaming compatibility path.

Thinking mode is enabled with `reasoningEffort: "max"` by default. Set
`reasoningEffort: "high"` to reduce it, or `thinking: false` to disable thinking
and omit reasoning output.

Usage responses include prompt, cache-hit, cache-miss, output, and current
context token counts. Both DeepSeek's native cache fields and the standard
OpenAI-compatible cached-token detail field are recognized. The plugin
calculates session charges from those actual billable token classes using the
[public DeepSeek per-million-token prices](https://api-docs.deepseek.com/quick_start/pricing)
checked on 2026-08-21. Each request uses the tariff active when it starts:

| Period (UTC) | V4 Flash cache / input / output | V4 Pro cache / input / output |
| --- | --- | --- |
| Peak, 01:00–04:00 and 06:00–10:00 | $0.014 / $0.44 / $1.32 | $0.044 / $1.32 / $3.96 |
| Off-peak, all other times | $0.007 / $0.22 / $0.66 | $0.022 / $0.66 / $1.98 |

Prices are USD per million tokens. The provider also implements the billing
service using DeepSeek's live `/user/balance` endpoint. Override `pricing` when
proxy or vendor rates differ; supplied fields are treated as fixed rates in
both periods. The live account balance and provider invoice remain
authoritative.
