# @deep-tui/plugin-render-read-file

Renders `read_file` activity in Deep TUI's TUI. By default, reads join the compact
Claude-style exploration log and file contents stay out of the transcript:

```text
  • Explored
    └ Read src/index.ts
      Read src/shell.ts
```

Set `showResults: true` to render successful file contents as a bounded box
with line numbers, language detection, and optional syntax highlighting:

```text
  ┌ src/index.ts · 120 lines · typescript
  │   1 │ import ...
  │   2 │ ...
  │ [100 lines omitted]
  └ ✓ read_file
```

The plugin is a pure TUI event renderer. It replaces only successful
`read_file` tool-result events whose output is a string. Read errors and other
tools fall through to the default renderer. Syntax highlighting is provided by
the existing TUI code-highlighter contract (for example
`@deep-tui/plugin-highlight-shiki`); without a registered highlighter, the file
renders as plain text with line numbers.

The bundled `read_file` tool also attaches `type: "read-file"` presentation
metadata carrying the requested path. The renderer uses that metadata first,
so resumed durable conversations keep the file label and language even though
tool arguments are not persisted.

## Configuration

- `showResults: true` shows successful file contents (default `false`);
- `maxLines` limits visible file lines (default 20);
- `maxLineLength` is the syntax-highlighting safety threshold; longer lines remain complete, render plain, and wrap (default 4000);
- `showLineNumbers: false` hides the line-number gutter;
- `syntaxHighlight: false` disables the code-highlighter hook;
- `showToolName: false` hides the tool name in the completion footer.
