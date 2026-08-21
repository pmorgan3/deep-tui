# @flect/plugin-provider-deepseek

First-party DeepSeek provider for Flect. It reads `DEEPSEEK_API_KEY` from the
process environment when a request starts; secrets do not belong in
`flect.config.json`.

The model aliases map to DeepSeek's official API identifiers:

| Flect model | DeepSeek API model |
| --- | --- |
| `flash` | `deepseek-v4-flash` |
| `pro` | `deepseek-v4-pro` |

```sh
export DEEPSEEK_API_KEY="your-key"
flect run --model flash "Quick task"
flect run --model pro "Hard reasoning task"
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
OpenAI-compatible cached-token detail field are recognized. The plugin calculates session charges from those actual
billable token classes using the public DeepSeek per-million-token prices
checked on 2026-08-17. It also implements the billing service using DeepSeek's
live `/user/balance` endpoint. Override `pricing` when proxy or vendor rates
differ; the live account balance and provider invoice remain authoritative.
