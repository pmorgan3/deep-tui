# @flect/plugin-render-files

Renders `list_files` and `find_files` activity in Flect's compact exploration
log. Set `showResults: true` to show result boxes with directory/file glyphs,
counts, search context, and explicit renderer/tool truncation notices.

```text
  ┌ src · 3 entries
  │ ▸ src/components/
  │ • src/components/App.tsx
  │ • src/index.ts
  └ ✓ list_files
```

The renderer accepts both live structured values and JSON strings restored
from durable conversations. Malformed and unrelated events defer to the next
registered event renderer.

Configuration:

- `showResults` — show discovered entries (default `false`);
- `maxEntries` — maximum visible results (default 80);
- `maxLineLength` — deprecated; complete paths and labels are preserved and wrapped by the TUI;
- `showToolName` — show the tool name in the footer (default `true`).
