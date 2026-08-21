# @deep-tui/plugin-compact

Adds `/compact` (alias `/summarize`) to Deep TUI.

`/compact` asks the configured model for a checkpoint and appends that
checkpoint to the active conversation. The summarizer replays the selected
conversation prefix with the same system prompt and tool schemas, then appends
the compaction instruction as the final user message. This keeps DeepSeek's
warm prefix eligible for reuse.

The session log remains append-only: original records are retained for audit
and recovery, while the checkpoint shadows them on the model-facing surface.
Recent records stay verbatim. Oversized tool results are first replaced on the
surface by bounded head/omission/tail records; their originals also remain in
the log.

Use `/compact [focus]` to tell the summarizer what the next conversation
should care about:

```text
/compact
/compact focus on the parser edge cases we still need to fix
```

The generated summary is stored in `<compacted-summary>` framing at the
position of the replaced prefix. `/compact` stays in the current conversation.

Configure the summarizer model separately from the main agent:

```json
{
  "use": "@deep-tui/plugin-compact",
  "config": {
    "provider": "deepseek",
    "model": "pro",
    "maxTranscriptChars": 40000,
    "maxRecordChars": 8000,
    "maxSummaryChars": 12000,
    "retainRecentRecords": 8
  }
}
```

`provider` and `model` default to the latest persisted request route, then the
active conversation route. Keeping that route unchanged is required for cache
reuse. `maxTranscriptChars` selects a whole-record prefix rather than
truncating its contents; `maxRecordChars` controls model-free tool-result
pruning.
