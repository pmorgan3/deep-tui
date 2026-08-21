# @deep-tui/plugin-agent

Deep TUI's default tool-calling agent loop. It assembles prompts, model
requests, registered tools, permissions, usage, checkpoints, and conversation
records behind the public contracts in `@deep-tui/sdk`.

```json
{
  "use": "@deep-tui/plugin-agent",
  "config": { "provider": "deepseek", "model": "flash" }
}
```

Optional configuration includes `provider`, `model`, `maxSteps`, and an
explicit `toolOrder` containing one `<unlisted-tools>` placeholder.
