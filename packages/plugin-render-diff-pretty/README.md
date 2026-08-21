# @deep-tui/plugin-render-diff-pretty

Prettified, per-file inline diff rendering for Deep TUI's TUI. `write_file`
results use an editor-style view with line numbers and full-width tinted
change rows:

```text
  • Edited src/a.ts (+1 -1)
  1   one
  2 - two
  2 + changed
  3   three
```

`apply_patch` keeps a compact multi-file box view:

```text
  ┌ src/a.ts · +1 -1
  │ @@ -1,3 +1,3 @@
  │  one
  │ -two
  │ +changed
  │  three
  └ ✓ apply_patch
```

Each file gets its own header (with `new file`, `deleted file`, or `renamed`
badges) and its own `+N -M` stats; redundant `---`/`+++` headers are hidden.
When a diff touches several files the footer summarizes them:

```text
  └ ✓ apply_patch · 2 files · +3 -2
```

It consumes the same `diff` tool-presentation contract emitted by
`apply_patch` and `write_file`, so it works with durable conversations and
never duplicates content into model context. The plugin registers its event
renderers at a higher priority than the built-in diff renderer; uninstalling it
restores the default rendering.

## Features

- **Word diffs** — the changed span inside adjacent `-`/`+` line pairs is
  bolded and underlined, so a one-token edit is visible at a glance.
- **Syntax highlighting** — code inside the diff is highlighted through the
  TUI code-highlighter contract (e.g. `@deep-tui/plugin-highlight-shiki`) using
  the file extension, with the add/remove marker kept in the diff tone and a
  subtle tone-tinted background. Falls back to plain tone styling when no
  highlighter is registered or the language is unknown.
- **Editor-style writes** — `write_file` results show the relevant old/new line
  number in one gutter, hide hunk metadata and completion chrome, and extend
  addition/deletion tints across the transcript width.
- **Bounded output** — per-file and global line caps with omission notes, so
  pathological patches cannot flood the transcript.
- **Graceful fallback** — if a diff cannot be parsed, it renders as a bounded,
  colored raw unified diff instead of failing.

## Configuration

- `maxLinesPerFile` — per-file cap on rendered lines (default 120);
- `maxTotalLines` — global cap before the completion footer (default 500);
- `maxLineLength` — syntax-highlighting safety threshold; longer lines remain complete, render plain, and wrap (default 4000);
- `showToolName` — set `false` to hide the tool name in the completion line;
- `wordDiff` — enable/disable word-level diffs (default `true`);
- `syntaxHighlight` — enable/disable syntax highlighting (default `true`);
- `tintBackground` — enable/disable the tone-tinted line background (default `true`);
- `showHunks` — set `false` to hide `@@` hunk headers.

## Contract

This plugin is a pure consumer of the existing `diff` presentation and the
`tui` event-renderer registry; it changes no SDK or tool behavior. Parsing is
display-oriented and intentionally lenient (git or plain headers, CRLF,
`\ No newline` markers, metadata lines) — authoritative patch validation stays
with `@deep-tui/plugin-tool-patch`.
