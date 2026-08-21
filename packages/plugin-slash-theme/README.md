# @deep-tui/plugin-slash-theme

Adds a discoverable `/theme` command and, by default, mounts the first-party
Gruvbox, Catppuccin, Kanagawa, Nord, and Monokai Pro theme plugins. Theme
plugins remain ordinary Cordis children: unloading this plugin unloads its
bundled palettes, and Deep TUI falls back to the next available theme.

```text
/theme
/theme gruvbox-dark-hard
/theme catppuccin-mocha
/theme kanagawa-wave
/theme nord
/theme monokai-pro
```

Running `/theme` with no ID opens an interactive picker. Up/Down previews each
palette immediately, Enter accepts it, and Escape restores the previous theme.
Accepted themes are saved per project in `.deep-tui/theme.json` and restored before
the next TUI session draws its first frame.

Set `loadBuiltins: false` when the palette plugins are mounted separately. Any
third-party plugin that calls `ctx.themes.register(theme)` appears in `/theme`
autocomplete and the picker automatically. Set `persist: false` to keep theme
selection session-only, or set `stateFile` to override the preference path.
