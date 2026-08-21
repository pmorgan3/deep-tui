# @flect/plugin-provider-openai-compatible

Reusable OpenAI-compatible chat-completions transport for Flect. It supports
incremental SSE text, reasoning, parallel tool calls, final usage, aborts, and
a non-streaming compatibility path.

Configure `id`, `baseUrl`, `apiKeyEnv`, optional headers, `streaming`, and
`streamUsage`. Streams require a terminal `data: [DONE]` by default; providers
with documented EOF termination may opt in with `allowEofTermination`.
Provider-specific chat-completion fields can be supplied with `extraBody`;
Flect's core `model`, `messages`, streaming, and tool fields take precedence.
