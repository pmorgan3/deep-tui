# @flect/plugin-render-diff

Renders successful file changes inline as theme-aware unified diffs. Added
lines use the active theme's success color, removed lines use danger, and hunk
headers use accent. The renderer composes with the generic tool-presentation
contract and replaces only matching `diff` tool-result events.

The bundled `apply_patch` and `write_file` tools emit presentation metadata
separately from their model-facing output. Diffs therefore remain visible after
resuming a durable conversation without being duplicated into model context.

Configuration:

- `maxLines` limits visible diff lines (default 400);
- `maxLineLength` is deprecated; complete lines are preserved and wrapped by the TUI;
- `showToolName: false` hides the tool name in the completion line.
