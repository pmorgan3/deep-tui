# @flect/plugin-render-search-text

Renders `search_text` activity in Flect's compact exploration log:

```text
  • Explored
    └ Search registerPlugin in src
```

Set `showResults: true` to group match previews by file with compact
`line:column` locations:

```text
  ┌ "registerPlugin" · 2 matches · 1 file
  │ src/plugins.ts · 2 matches
  │   18:4 │ registerPlugin(plugin)
  │   42:7 │ return registerPlugin(next)
  └ ✓ search_text
```

Live structured output and durable-session JSON are supported. Renderer and
tool truncation are reported separately, and malformed events defer to the
next registered renderer.

Configuration:

- `showResults` — show match previews (default `false`);
- `maxMatches` — maximum visible matches (default 80);
- `maxFiles` — maximum visible file groups (default 20);
- `maxLineLength` — deprecated; complete paths and previews are preserved and wrapped by the TUI;
- `showToolName` — show the tool name in the footer (default `true`).
