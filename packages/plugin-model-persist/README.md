# @deep-tui/plugin-model-persist

Remembers the active model for the current project. Switching models with
`/model <name>` or Ctrl+P writes the choice to `.deep-tui/model.json` (next to the
theme preference), and the next TUI session restores it before the first frame
draws.

Because `/new` inherits the shell's active model, restoring the remembered
model also means new conversations start on your last-used model instead of
falling back to the configured default (for example `flash`).

```text
/model pro          # switch now and remember it
/model              # show available models
Ctrl+P              # cycle to the next model and remember it
```

Set `persist: false` to keep model selection session-only, or `stateFile` to
override the preference path (absolute, or relative to the project root).
