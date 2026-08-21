# @deep-tui/plugin-zellij-title

Sets the active Zellij pane title through the standard OSC 0 terminal-title
sequence. The title contains the current Deep TUI conversation name and animates
while the agent is working. Outside Zellij the plugin is inactive by default.

```json
{
  "use": "@deep-tui/plugin-zellij-title",
  "config": { "label": "Deep TUI", "intervalMs": 120 }
}
```
