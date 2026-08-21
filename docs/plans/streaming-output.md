# Plan: streaming model and UI output

## Outcome

Assistant text appears incrementally, tool calls are assembled safely from
deltas, cancellation stops transport promptly, and final usage/cost remains
exact. Providers without streaming continue to work through a compatibility
path.

## Provider protocol

Keep `ModelProvider.complete()` for compatibility and add an optional stream:

```ts
type ModelStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'finish'; reason?: string }

interface ModelProvider {
  id: string
  complete(request: ModelRequest): Promise<ModelResponse>
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>
}
```

Add `ModelService.stream()`. If a provider has no stream method, it calls
`complete()` once and emits equivalent text/tool/usage/finish events. Add a
shared collector that turns any model stream into `ModelResponse`; provider
tests use it to guarantee streaming and non-streaming semantic equivalence.

Reasoning content is retained separately for provider protocol replay when a
model requires it across tool calls. It is not merged into the visible final
answer. A later opt-in event renderer may expose it, but the default avoids
presenting hidden reasoning as ordinary assistant text.

## OpenAI-compatible transport

Implement streaming in
`packages/plugin-provider-openai-compatible/src/index.ts`:

- send `stream: true` and `stream_options: { include_usage: true }`;
- parse `text/event-stream` incrementally across arbitrary byte boundaries;
- ignore blank lines and `: keep-alive` comments;
- process all `data:` fields, stop at `[DONE]`, and report malformed JSON with
  enough context to diagnose it without including authorization headers;
- use `TextDecoder` streaming mode for split UTF-8 code points;
- merge parallel tool-call deltas by choice index and tool-call index;
- preserve tool IDs, names, arguments, finish reason, reasoning deltas, and the
  final usage chunk;
- abort the reader and response body when `request.signal` aborts;
- reject a 2xx response that ends without `[DONE]` or a terminal finish event,
  unless the provider explicitly opts into EOF termination.

DeepSeek documents data-only SSE terminated by `[DONE]`, optional final usage,
and keep-alive comments. Put the generic parser in its own tested module so
another OpenAI-compatible provider can reuse it.

## Agent events

Give each response step a stable message ID and add incremental agent events:

```ts
type AgentEvent =
  | { type: 'assistant-start'; messageId: string }
  | { type: 'assistant-delta'; messageId: string; delta: string }
  | { type: 'assistant-finish'; messageId: string; text: string; usage?: ModelUsage }
  | /* existing start, tool-call, tool-result, finish events */
```

The default agent consumes `ctx.models.stream()`, emits deltas as received,
assembles the canonical assistant message, validates complete tool argument
JSON only after the stream finishes, and then executes tools. The final run
usage is still aggregated once from provider usage events. The final usage for
each provider response is also attached to `assistant-finish`, allowing a
separate renderer plugin to annotate messages without owning the agent loop.

Do not append one immutable TUI event per token. The shell maintains assistant
messages keyed by `messageId` and updates their text in place so memory and
render work are proportional to messages, not tokens. Preserve a compatibility
`assistant` event for external runtimes only during one documented transition
release, or provide an adapter helper in the SDK.

## Rendering and backpressure

- Coalesce redraws to at most one per animation interval (target 30–60 Hz),
  while never delaying the final frame.
- Append every delta to canonical text immediately; only display refreshes are
  throttled.
- The scrolling plan's follow mode tracks the growing tail. A detached
  viewport keeps its absolute top and increments unseen activity.
- Markdown rerenders the current message from its complete accumulated text.
  Cache by text revision and tolerate incomplete fences/lists.
- Ctrl+C aborts the active request first. A second Ctrl+C or `/exit` exits the
  shell according to documented behavior.
- Tool-call argument deltas are not rendered as trusted JSON until collection
  and parsing succeed.

## Configuration

Provider plugin:

```ts
interface OpenAiCompatibleConfig {
  streaming?: boolean
  streamUsage?: boolean
}
```

TUI plugin:

```ts
interface TuiPluginConfig {
  renderFps?: number
}
```

Streaming defaults on. Setting it off uses `complete()` without changing agent
or UI behavior other than latency.

## File changes

- `packages/sdk/src/types.ts`: model-stream and incremental agent events.
- `packages/sdk/src/services.ts`: stream dispatch and fallback collection.
- `packages/plugin-provider-openai-compatible/src/sse.ts`: incremental parser.
- `packages/plugin-provider-openai-compatible/src/index.ts`: streaming request
  and delta normalization.
- `packages/plugin-provider-deepseek/src/index.ts`: retain cost calculation on
  final usage and reasoning/tool-call fields.
- `packages/plugin-agent/src/index.ts`: stream consumption and message IDs.
- `packages/plugin-ui-terminal/src/index.ts`: print deltas without duplicates.
- `packages/plugin-ui-tui/src/shell.ts`: keyed updates and throttled redraws.
- Provider, agent, terminal, and TUI tests plus documentation.

## Verification

SSE fixtures split input at every byte boundary, including inside UTF-8,
`data:` prefixes, JSON strings, parallel tool calls, and `[DONE]`. Test
keep-alives, usage-only final chunks, HTTP errors, malformed events, truncated
streams, slow consumers, and aborts.

Agent tests prove that streamed and non-streamed providers produce identical
model history, tool calls, final text, and usage. TUI tests prove coalesced
renders, stable scrolling, no duplicate output, and a guaranteed final redraw.

## Acceptance criteria

- First visible text arrives before the full response completes.
- Parallel streamed tool calls assemble into the same calls as non-streaming.
- Usage and tariff-calculated cost remain exact.
- Cancellation closes network reading and leaves the TUI usable.
- Slow rendering does not drop text or create one event per token.
- Non-streaming third-party providers remain supported.

## Upstream references

- [DeepSeek streaming chat schema](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek keep-alive behavior](https://api-docs.deepseek.com/faq)
