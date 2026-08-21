# @flect/plugin-render-run-command

Renders `run_command` activity in Flect's TUI as a compact Claude-style block.
The command is shell-highlighted and wrapped, while output keeps a short
head/tail preview, omitted-line count, failure status, and elapsed time:

```text
  • Ran pnpm test
  │ > test output
  │ checking packages...
  │ [12 lines omitted]
  │ Tests passed
  └ 1.2s
```

Non-zero exits and signals render with the danger tone, timeouts use the
warning tone, and tool failures (`{ error: "..." }`) are displayed inline.
Durable conversations store tool output as JSON text; this renderer parses
that JSON back into the structured form, so resumed sessions render the same
way as live runs.

The plugin is a pure TUI event renderer. It replaces only `run_command`
tool-call and tool-result events whose output matches the process-tool result
shape. Other tools and unstructured `run_command` results fall through to the
default renderer.

## Configuration

- `compact: false` restores the detailed output box (default `true`);
- `previewLines` controls compact head/tail output lines (default 3);
- `maxStdoutLines` limits visible stdout lines (default 80);
- `maxStderrLines` limits visible stderr lines (default 40);
- `maxTotalLines` caps the complete rendered body before the footer (default 240);
- `maxLineLength` is the command syntax-highlighting safety threshold; longer commands remain complete, render plain, and wrap (default 4000);
- `showToolName: false` hides the tool name in the completion footer.
