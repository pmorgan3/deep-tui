# @deep-tui/plugin-session-title

Generates a concise title for a newly started Deep TUI conversation with a
separate model request. By default it uses DeepSeek Flash. Explicit titles set
with `/new <title>` or `/rename` are preserved.

```json
{
  "use": "@deep-tui/plugin-session-title",
  "config": { "provider": "deepseek", "model": "flash", "maxLength": 60 }
}
```
