# Architecture

## The invariant

The host may know how to load a plugin, but it may not know what an agent, a
model, a tool, or a UI is. Those concepts enter the process through plugins.

```text
CLI microkernel
  └─ Cordis Context
       ├─ runtime plugin → replaceable service registries
       ├─ agent plugin → tool-calling behavior
       ├─ lifecycle plugins → compaction and run-budget policies
       ├─ provider plugin → model transport
       ├─ tool plugins → capabilities + permission requests
       ├─ prompt plugins → system context
       ├─ workspace/permission plugins → scoped effects and remembered grants
       ├─ conversation/audit plugins → durable history and safe traces
       ├─ theme plugins → color and typography tokens
       └─ interface plugins → commands, rendering, TUI slots, keys, shells
```

This leaves three irreducible host responsibilities:

1. discover and parse `flect.config.json`;
2. resolve modules and mount them into a Cordis `Context`;
3. provide bootstrap operations (`init` and `plugin ...`) that can repair a
   composition even when its command/UI plugins do not load.

Everything else is replaceable.

## Why Cordis

Cordis contexts resolve services by stable names rather than concrete imports.
A plugin declares required service names through `inject`; Cordis activates it
only when those services are present. Registrations use lifecycle effects, so
unloading a plugin removes its commands, tools, prompts, providers, themes, and
handlers without stale references.

That model makes customization structural instead of a growing list of host
callbacks. A different agent loop can provide `agent`; a different permission
system can provide `permissions`; isolated contexts can eventually host
different tool or provider sets in the same process.

## Public service surface

| Service | Contribution | Replaceable behavior |
| --- | --- | --- |
| `commands` | CLI commands | Entire command surface |
| `models` | Model providers | Vendor, transport, routing |
| `agentHooks` | Ordered run/step lifecycle policies | Preflight, budgets, accounting, cleanup |
| `billing` | Balance providers | Live vendor account balances |
| `tools` | Tool definitions | Agent capabilities |
| `prompts` | Ordered prompt sections | Persona and policy |
| `permissions` | Authorization handlers | Allow/ask/deny policy |
| `permissionRules` | Grant stores and matchers | Remembered policy scopes |
| `project` | Composition metadata | Root and project-local state paths |
| `workspace` | Safe path/walk/root providers | Single, multi-root, or remote workspaces |
| `conversations` | Conversation stores | Ephemeral, filesystem, database, cloud history |
| `audit` | Sinks and redactors | Local JSONL, telemetry, regulated traces |
| `themes` | Design tokens | Color, spacing, typography |
| `ui` | Renderers | TUI, plain text, web, desktop |
| `tui` | Shells, slots, empty-state sections, sidebar sections, keys, event renderers/decorators, status items, code highlighters, slash commands, session hooks | Layout, rich output, commands, input and session behavior |
| `agent` | Runs | Loop, planning, middleware |

TUI contributions are layered rather than uniquely owned. Priority selects the
active component for each slot, key handler, or shell. Cordis disposal removes
only that layer, so the next contribution becomes active and the running TUI
redraws through its subscription. This makes a replacement reversible instead
of a mutation of the default package.

Slash commands use the same layered registry. Their handlers receive a narrow
`TuiActions` interface rather than the concrete default shell, so the same
command plugin can work with another compatible TUI shell. Name discovery and
argument completion are derived from currently active contributions.

Session hooks let plugins restore state before the first frame and clean up
before a session closes. The theme command uses this hook instead of embedding
preference storage in the default shell.

Event decorators append or prepend lines around the winning message renderer,
so telemetry does not need to copy or replace Markdown rendering. Status items
compose compact footer state such as auto-mode warnings and running cost totals.

Tool execution has a separate presentation channel. A tool may attach typed,
JSON-safe metadata to its result event without changing the output returned to
the model. Durable stores preserve it beside the tool record, and renderer
plugins decide how to display it. First-party file tools use `type: "diff"`;
the default diff plugin renders unified hunks and suppresses raw write payloads.

Modes need not be privileged host state. The first-party plan-mode plugin is a
composition of an optional prompt section, a high-priority permission policy,
a slash command, and a status item. Removing it removes the mode; another
plugin can replace any one of those contributions independently.

Agent policies use the same pattern. The default loop calls ordered
`agentHooks` before history is loaded, before each model step, after reported
usage, and at terminal cleanup. Automatic compaction and run budgets therefore
remain independently unloadable policies instead of configuration branches in
the agent implementation.

Workspace behavior is split the same way. File, search, patch, and process
plugins consume only the public `workspace` service. The default local provider
owns containment primitives; the multi-root provider layers virtual
`@alias/path` addressing, access modes, persistence, prompts, and management
commands over them. Root state is separate from the folders sidebar section.
Unloading the multi-root provider exposes the lower-priority single-root
provider without rewriting any tool.

The theme service has a selected contribution and a change subscription.
Interface plugins render from `themes.current()` rather than capturing a theme
at startup. If the selected theme plugin unloads, selection falls back to the
next registered theme and subscribers redraw.

The SDK supplies default service implementations as classes. The runtime
plugin chooses to mount them. They are conveniences, not privileged host
objects.

## Plugin shape

Any Cordis plugin works. A package may default-export a function, a `Service`
subclass, or an object with `apply`:

```js
export const name = 'concise-prompt'
export const inject = ['prompts']

export function apply(ctx) {
  ctx.prompts.register({
    id: 'example.concise',
    order: 50,
    render: () => 'Be concise and concrete.',
  })
}
```

`register()` is a Cordis effect. When this plugin unloads, its section vanishes.

GitHub plugin repositories are declarative sources for the same module shape,
not a second plugin API. The CLI clones them into the platform user-data
directory and resolves a package.json `flect`, `exports`, `module`, or `main`
entry, with `index.mjs` and `index.js` fallbacks. Repositories must contain
runnable ESM; dependency installation omits development packages and disables
lifecycle scripts.

## Security boundary

Plugins are code, not data. Installing one—or naming a GitHub repository in
configuration—grants it the same operating-system access as the harness
process. The installer therefore prints what it will install and does not
pretend packages are sandboxed.

Tool calls have a separate permission service. This protects the user from
model-initiated actions, but it does not sandbox a malicious plugin. A future
isolated-plugin runner should be an optional host plugin with an explicit
capability manifest.
