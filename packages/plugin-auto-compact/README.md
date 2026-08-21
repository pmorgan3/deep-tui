# @flect/plugin-auto-compact

Compacts a durable conversation before the next agent run when its model-facing
surface approaches the configured context window. It uses provider-reported
context usage when available and a conservative character estimate otherwise.

```json
{
  "use": "@flect/plugin-auto-compact",
  "config": {
    "threshold": 0.8,
    "contextWindows": {
      "default": 1000000,
      "flash": 1000000,
      "pro": 1000000
    },
    "minimumRecords": 12,
    "retainRecentRecords": 8,
    "failOpen": true
  }
}
```

The plugin runs in the agent preflight lifecycle, before conversation history is
loaded for the new request. Compaction remains append-only: raw records stay in
the session log while the model-facing surface switches to a checkpoint.

Use `/autocompact status`, `/autocompact on`, or `/autocompact off`. With the
default `failOpen`, a failed summarization is reported by the command but does
not prevent the user's original request from running.
