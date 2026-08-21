# @deep-tui/plugin-ui-tui

Deep TUI's full-screen terminal interface. Running `deep-tui` launches it when this
plugin is active. `Ctrl+P` cycles the configured models (DeepSeek `flash` and
`pro` by default). While a run is active, the composer and status line animate
with the current phase, tool name, and elapsed time.

Provider reasoning streams into a collapsed `Thinking` disclosure above the
answer. A `Thinking` header highlights when hovered; click it to expand or
collapse that response. Press `Ctrl+T` or run `/thinking` (also `/reasoning`
and `/thoughts`) to toggle the latest available reasoning. The disclosure is
restored when a persisted conversation is resumed.

The default transcript measures history without syntax tokenization and fully
renders only events intersecting the viewport. Pointer hit regions are reused
from the displayed frame, motion bursts are coalesced, and subsequent terminal
updates rewrite only changed rows.

Mouse wheel, Page Up/Down, Ctrl+U/Ctrl+D, Home, and End navigate the generic
transcript viewport. Output arriving while detached increments an unseen
indicator without moving the reading position. Ctrl+C cancels active model
work before it becomes the exit key.

The shell, named visual slots, keybindings, and slash commands are prioritized Cordis
contributions. A plugin can replace a default without copying this package:

```js
export const name = 'compact-deep-tui-header'
export const inject = ['tui']

export function apply(ctx) {
  ctx.tui.registerComponent({
    id: 'my.header',
    slot: 'header',
    priority: 10,
    render({ state, style }) {
      return [`${style('deep-tui', 'accent', true)} · ${state.model} · ${state.cwd}`]
    },
  })
}
```

When that plugin unloads, Cordis removes the contribution and the built-in
header becomes active again on the next frame.

Type `/` to open live command discovery. Built-ins include `/thinking`,
`/context`, `/cost`, `/model`, `/plugins`, `/help`, `/clear`, and `/exit`; `/theme` is added by
`@deep-tui/plugin-slash-theme`, and `/auto` by
`@deep-tui/plugin-permission-auto`. Third-party commands use
the exact same registry:

```js
ctx.tui.registerSlashCommand({
  id: 'acme.deploy',
  name: 'deploy',
  description: 'Deploy the current workspace.',
  complete: ({ query }) => ['staging', 'production']
    .filter(value => value.startsWith(query))
    .map(value => ({ value, description: `Deploy to ${value}` })),
  run(args, actions) {
    actions.showOverlay({ id: 'deploy', title: 'Deploy', lines: [args[0] ?? 'Choose an environment'] })
  },
})
```

Commands may provide aliases, argument completions, usage text, and a priority.
The TUI automatically adds them to autocomplete and `/help`.

Assistant-event renderers and fenced-code highlighters are also prioritized
contributions. The default composition layers safe Markdown and Shiki over the
plain fallback, so unloading either plugin reveals the next renderer live.
Renderers may instead use `mode: 'prepend'` or `mode: 'append'` to decorate the
winning renderer. Status items similarly add footer information without
replacing the default status component; `@deep-tui/plugin-usage-inline` uses both
contracts.

The default sidebar is deliberately not built into this shell. The standalone
`@deep-tui/plugin-sidebar` package composes structured `registerSidebarSection()`
contributions and owns Ctrl+B, focus, selection, responsive compact/full rows,
mouse-drag resizing, and empty-section hiding. First-party sidebar data sources are separate
packages, so any section can be removed or replaced without replacing the TUI.
