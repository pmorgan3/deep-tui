# Flect

> Bend the harness, not your workflow.

An open-source, plugin-first coding agent built on
[Cordis](https://github.com/cordiverse/cordis). The host is deliberately tiny:
it locates a composition, mounts Cordis plugins, and dispatches a command.
Every user-visible capability comes from that composition.

## The contract

1. **Everything is a plugin.** Models, tools, prompts, agent loops, commands,
   permissions, themes, and interfaces use the same Cordis lifecycle.
2. **Open by default.** The project and SDK use the MIT license, public
   contracts, and ordinary npm packages—no privileged private plugin API.
3. **Declarative extensibility.** Put an npm package, local path, or GitHub URL
   in configuration, or scaffold a local plugin with
   `flect plugin create <name>`.
4. **No sacred UX.** A plugin may replace the terminal renderer, colors,
   typography tokens, commands, prompt assembly, permission policy, or the
   entire agent loop.

The only non-plugin code is the microkernel needed to find and start plugins,
plus the bootstrap commands needed to repair that composition. See
[architecture](docs/architecture.md) for the boundary.

## Current daily-driver slice

- a Cordis-backed service and lifecycle SDK;
- replaceable model, tool, prompt, permission, theme, UI, command, and agent
  services;
- a tool-calling agent loop;
- a DeepSeek provider with `pro`/`flash` aliases and a reusable
  OpenAI-compatible transport;
- bounded multi-folder workspace read/search, exact patch, argv-only process,
  and structured read-only Git plugins;
- nested `.gitignore`/`.ignore` filtering shared by list, find, and text search;
- threshold-based automatic compaction and per-run step/time/token/cost budgets;
- a full-screen, composable TUI plus a headless terminal renderer;
- incremental streaming, safe GFM Markdown, and theme-aware Shiki highlighting;
- prettified `read_file` results with line numbers and syntax highlighting;
- prettified `run_command` stdout/stderr with exit status and bounded output;
- inline, theme-aware unified diffs for successful file changes;
- scrollable transcripts that retain position while live output arrives;
- revocable session/project permission grants;
- explicit, session-only auto approval with a persistent on-screen warning;
- read-only `/plan` mode with prompt and permission enforcement;
- per-response token/cache/cost annotations and a running session-cost footer;
- a responsive, keyboard-navigable sidebar assembled from independently
  removable plan, changes, context/cost/cache-efficiency, activity, verification, session,
  folders, modes, and permission plugins;
- durable, resumable, forkable filesystem conversations;
- redacted, correlated, hash-verifiable JSONL audit history;
- layered user/project/explicit composition with provenance;
- live theme switching with independently unloadable palette plugins;
- JSON composition loading and dependency diagnostics;
- one-command local plugin creation and npm plugin installation.

The corresponding contracts and acceptance decisions remain documented in the
[daily-driver plans](docs/plans/README.md).

## Try it

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm dev init
export DEEPSEEK_API_KEY=your-key
pnpm dev
```

Running `flect` with no command opens the TUI. Type a prompt and press Enter;
use `Ctrl+P` to switch between DeepSeek Flash and Pro and `Ctrl+L` to clear.
Active work shows an animated phase/tool indicator with elapsed time. Model
reasoning appears in a collapsed `Thinking` disclosure. Its header highlights
on hover; click it to expand or collapse that response. `Ctrl+T` or `/thinking`
toggles the latest one.
The sidebar appears at 96 columns, switches to a compact layout below 120,
and hides empty sections. Drag its vertical divider with the mouse to resize
it, or use `/sidebar reset` to restore automatic sizing. Ctrl+B shows or hides it; Tab focuses it, then
Up/Down selects, Enter opens the relevant transcript item or manager, and
Escape returns focus to the prompt.
Mouse wheel, Page Up/Down, Ctrl+U/Ctrl+D, Home, and End navigate long output
without losing a detached reading position. During a request, Ctrl+C cancels
the request; press it again after cancellation to leave.

Type `/` to discover commands contributed by active plugins. The defaults are
`/thinking`, `/context`, `/cost`, `/model`, `/theme`, `/sessions`, `/session`, `/new`,
`/resume`, `/fork`, `/rename`, `/auto`, `/compact`, `/autocompact`, `/budget`, `/plan`, `/folders`, `/sidebar`, `/permissions`, `/audit`, `/plugins`, `/help`,
`/clear`, and `/exit`.
Use the arrow keys and Tab to select or complete a command.

```sh
pnpm dev run --model flash "Summarize this repository"
pnpm dev run --new-session "Start a durable task"
pnpm dev run --session <id> "Continue it"
pnpm dev sessions list
pnpm dev audit list
pnpm dev folders add ../backend backend
```

The generated `flect.config.json` is the product. Remove the terminal
plugin and there is no terminal UI. Swap the provider and the agent follows it.
Change the theme plugin to change UI tokens. Replace the agent plugin to change
the loop.

Create a live local plugin in one command:

```sh
pnpm dev plugin create concise-prompt
```

The command creates `.flect/plugins/concise-prompt.mjs` and adds it to
the active composition. Edit the file, then run the harness again.

## Configuration

```json
{
  "$schema": "./schemas/config.schema.json",
  "version": 2,
  "plugins": [
    { "use": "@flect/runtime" },
    {
      "use": "@flect/plugin-agent",
      "config": { "provider": "deepseek", "model": "flash" }
    },
    { "use": "@flect/plugin-budget" },
    { "use": "@flect/plugin-provider-deepseek" },
    { "use": "@flect/plugin-session-title" },
    { "use": "@flect/plugin-prompt-coding" },
    { "use": "@flect/plugin-theme-default" },
    { "use": "@flect/plugin-slash-theme" },
    { "use": "@flect/plugin-permission-rules" },
    { "use": "@flect/plugin-permission-auto" },
    { "use": "@flect/plugin-mode-plan" },
    { "use": "@flect/plugin-compact" },
    { "use": "@flect/plugin-auto-compact" },
    { "use": "@flect/plugin-workspace-local" },
    {
      "use": "@flect/plugin-workspace-multi-root",
      "config": {
        "folders": [
          { "alias": "docs", "path": "../docs", "access": "read-only" }
        ]
      }
    },
    { "use": "@flect/plugin-workspace-ignore" },
    { "use": "@flect/plugin-tool-workspace" },
    { "use": "@flect/plugin-tool-search" },
    { "use": "@flect/plugin-tool-patch" },
    { "use": "@flect/plugin-tool-process" },
    { "use": "@flect/plugin-git" },
    { "use": "@flect/plugin-session-files" },
    { "use": "@flect/plugin-audit-redact-default" },
    { "use": "@flect/plugin-audit-jsonl" },
    { "use": "@flect/plugin-highlight-shiki" },
    { "use": "@flect/plugin-render-markdown" },
    { "use": "@flect/plugin-render-read-file" },
    { "use": "@flect/plugin-render-files" },
    { "use": "@flect/plugin-render-search-text" },
    { "use": "@flect/plugin-render-run-command" },
    { "use": "@flect/plugin-render-diff" },
    { "use": "@flect/plugin-render-diff-pretty" },
    { "use": "@flect/plugin-usage-inline" },
    { "use": "@flect/plugin-sidebar" },
    { "use": "@flect/plugin-sidebar-plan" },
    { "use": "@flect/plugin-sidebar-changes" },
    { "use": "@flect/plugin-sidebar-context" },
    { "use": "@flect/plugin-sidebar-activity" },
    { "use": "@flect/plugin-sidebar-verification" },
    { "use": "@flect/plugin-sidebar-session" },
    { "use": "@flect/plugin-sidebar-folders" },
    { "use": "@flect/plugin-sidebar-modes" },
    { "use": "@flect/plugin-sidebar-permissions" },
    { "use": "@flect/plugin-zellij-title" },
    { "use": "@flect/plugin-ui-terminal" },
    { "use": "@flect/plugin-welcome-brand" },
    { "use": "@flect/plugin-welcome-prompt" },
    {
      "use": "@flect/plugin-ui-tui",
      "config": {
        "provider": "deepseek",
        "model": "flash",
        "models": ["flash", "pro"]
      }
    }
  ]
}
```

Plugin order is not a dependency mechanism. Cordis activates a plugin when
the services named in its `inject` declaration exist and unloads it if those
services disappear.

The default agent runs until the model completes the task or the user cancels
it. There is no implicit model-turn ceiling. To opt into a safety budget, set a
positive `maxSteps` in the agent plugin configuration; reaching that budget is
recorded as `limit-reached`, not as successful completion, so the conversation
remains resumable.

Model-facing tools are sorted lexicographically by default so plugin load order
cannot reshape the prompt cache. An explicit order can be configured with one
`<unlisted-tools>` insertion point:

```json
{
  "use": "@flect/plugin-agent",
  "config": {
    "provider": "deepseek",
    "model": "flash",
    "toolOrder": ["read_file", "search_text", "<unlisted-tools>"]
  }
}
```

The agent stores an envelope fingerprint when the provider, model, stable
system prompt, or tool schemas change. Runtime context is appended as a sourced
snapshot instead of rewriting that envelope. The context sidebar and
`/context` distinguish latest-request cache performance from the cumulative
session rate and report whether the reusable prompt prefix stayed stable.

Version 2 also supports `extends`. Effective priority is user config, extended
project files, project config, then an explicit `--config`/`FLECT_CONFIG` file.
Use `--isolated-config` to load only one file, and inspect decisions without
starting the UI:

```sh
pnpm dev config paths
pnpm dev config show
pnpm dev config explain @flect/plugin-agent
pnpm dev config validate
```

### Load plugins from GitHub

The user configuration follows the platform config convention:

- Unix: `$XDG_CONFIG_HOME/flect/config.json`, or
  `~/.config/flect/config.json` when `XDG_CONFIG_HOME` is unset;
- Windows: `%APPDATA%\flect\config.json`.

Create it with `flect config init --scope user`, then add a GitHub URL to its
ordinary plugin list:

```json
{
  "version": 2,
  "plugins": [
    {
      "use": "https://github.com/example/flect-concise#v1.0.0"
    }
  ]
}
```

A user configuration is sufficient to run `flect` from any directory; a
project-local `flect.config.json` is optional and, when present, layers project
overrides on top. In the user-only case, the invocation directory remains the
workspace root.

`github:example/flect-concise#v1.0.0` is an equivalent shorthand. The `#ref`
may be a branch, tag, or commit; pinning an immutable tag or commit is strongly
recommended. A missing repository is cloned on first use into
`$XDG_DATA_HOME/flect/plugins/github` (normally
`~/.local/share/flect/plugins/github`). Windows uses the local application-data
directory. Existing checkouts are used offline and are not silently updated.

The same flow is available without hand-editing JSON:

```sh
flect plugin add https://github.com/example/flect-concise#v1.0.0 --scope user
flect plugin sync --scope user
flect plugin update --scope user
```

`sync` installs missing configured repositories. `update` atomically replaces
their managed checkouts from the configured refs. A GitHub plugin must ship
runnable ESM; Flect resolves a package.json `flect`, `exports`, `module`, or
`main` entry, then falls back to `index.mjs` or `index.js`. Production npm
dependencies are installed on first use with lifecycle scripts disabled, so a
repository must commit its built entry instead of relying on `prepare`.

Plugins execute with Flect's full operating-system privileges. A URL in config
is an explicit decision to trust that repository and ref; model tool
permissions do not sandbox plugin code.

Switch DeepSeek models per run without editing the composition:

```sh
pnpm dev run --model flash "Handle this quick task"
pnpm dev run --model pro "Work through this difficult task"
```

The aliases resolve to `deepseek-v4-flash` and `deepseek-v4-pro`. The provider
reads `DEEPSEEK_API_KEY` when a model request starts; the key is never stored in
Flect configuration.

`/cost` uses actual token, cache-hit, and cache-miss counts returned by the API,
applies the configured tariff, and fetches the authoritative current account
balance from DeepSeek. DeepSeek does not expose a per-request billed-dollar API,
so Flect labels the session number as tariff-calculated rather than an invoice.
The independent `@flect/plugin-usage-inline` plugin appends the same cost plus
input, output, and cache-hit tokens to each completed
assistant response. Its footer item keeps the running conversation total
visible, including after resume or transcript clearing.

## Work across multiple folders

The default composition keeps the directory containing `flect.config.json` as
the primary project and session anchor, while
`@flect/plugin-workspace-multi-root` mounts extra folders into a virtual path
namespace. Primary paths stay familiar (`src/index.ts`); an additional folder
uses `@alias/path` (`@backend/src/server.ts`). The same addressing works in
read, list, search, write, patch, and command-working-directory tools.

Add or remove project-persistent folders from either interface:

```sh
pnpm dev folders add ../backend backend
pnpm dev folders add ../reference docs --read-only
pnpm dev folders list
pnpm dev folders remove backend
```

```text
/folders add ../backend backend
/folders add ../reference docs --read-only
/folders status
/folders remove backend
```

Runtime additions are written atomically to `.flect/folders.json` and restored
next session. A missing folder remains visible as unavailable and is retried by
`/folders status`; aliases are case-insensitively unique, and nested or
overlapping roots are rejected. Read-only mounts support reads and searches but
reject writes, patches, and use as a process working directory.

Only user-facing `/folders` and `flect folders` commands mutate the root list;
the plugin intentionally contributes no model-callable add/remove tool. The
separate `@flect/plugin-sidebar-folders` package shows availability and access
without coupling workspace behavior to the default TUI. Remove the multi-root
plugin and the lower-priority local provider resumes ordinary single-folder
behavior.

`@flect/plugin-workspace-ignore` wraps whichever workspace provider is active.
Nested `.gitignore` and `.ignore` rules—including negation—filter `list_files`,
`find_files`, and `search_text` consistently without blocking an explicit
`read_file`. `@flect/plugin-git` adds bounded, shell-free `git_status`,
`git_diff`, `git_log`, and `git_show`; it intentionally provides no repository
mutation operations.

## Switch themes live

The standalone `@flect/plugin-slash-theme` plugin mounts the palette plugins and
contributes `/theme`. Type `/theme` to list them or complete an ID with Tab:

```text
/theme gruvbox-dark-hard
/theme gruvbox-light-medium
/theme catppuccin-mocha
/theme kanagawa-wave
/theme nord
/theme monokai-pro
```

Included variants are Gruvbox light/dark × medium/hard, all four Catppuccin
flavors, Kanagawa Wave/Dragon/Lotus, Nord, and Monokai Pro. Switching updates
the foreground and terminal background without restarting Flect. Any external
theme plugin registered through `ctx.themes.register()` joins `/theme`
autocomplete and the picker automatically.

Run `/theme` without an ID for a live picker: Up/Down previews, Escape cancels,
and Enter accepts. Accepted selections persist per project in
`.flect/theme.json` and are restored before the first frame of the next session.
Configure the slash-theme plugin with `persist: false` for session-only choices,
or `stateFile` to store the preference elsewhere.

## Compose the TUI

The TUI is not a monolith. Its shell, `header`, `transcript`, `sidebar`,
`composer`, `status`, and `modal` slots, and every keybinding are prioritized
Cordis contributions. Add a higher-priority contribution to replace one
default. If that plugin unloads, its registration disappears and the prior
component becomes visible again without rebuilding the shell.

```js
export const name = 'compact-header'
export const inject = ['tui']

export function apply(ctx) {
  ctx.tui.registerComponent({
    id: 'my.header',
    slot: 'header',
    priority: 10,
    render: ({ state, style }) => [
      `${style('flect', 'accent', true)} · ${state.model} · ${state.cwd}`,
    ],
  })
}
```

See [the complete local override](examples/compact-tui.mjs). Theme plugins own
the colors, spacing, and font tokens. A terminal emulator still owns the
physical terminal font; web and desktop UI plugins can apply `fontFamily` and
`fontSize` directly.

The empty transcript is composed the same way. The built-in welcome screen is
split into `@flect/plugin-welcome-brand` and `@flect/plugin-welcome-prompt`,
which stack `registerEmptyStateSection()` contributions. Remove either plugin
to drop just that block, or register a higher-priority section with the same ID
to replace it:

```js
ctx.tui.registerEmptyStateSection({
  id: 'flect.empty.brand',
  priority: 100,
  render: ({ style }) => ['', style('my brand', 'accent', true)],
})
```

Sidebar data is a second public composition surface. `@flect/plugin-sidebar`
only arranges rows and owns keyboard focus; the default sections are separate
packages. A plugin can add or replace a section by registering the same ID at a
higher priority:

```js
ctx.tui.registerSidebarSection({
  id: 'flect.sidebar.activity',
  title: 'Deploy',
  order: 30,
  priority: 100,
  render: ({ state }) => state.busy
    ? { rows: [{ text: 'deployment running' }] }
    : undefined,
})
```

Sections may return `compactRows` for narrower terminals and omit themselves by
returning `undefined`. Rows can provide an `activate(actions)` callback, which
is why changed files, verification results, and plan items can jump directly
to their inline transcript event. `/sidebar show|hide|focus|status|reset` exposes the
same behavior without relying on keybindings.

Successful `apply_patch` and `write_file` results carry UI-only diff metadata.
The standalone `@flect/plugin-render-diff` plugin replaces raw mutation
arguments with compact file labels and renders the completed change as a
colored unified diff. Remove it to reveal the ordinary tool-event fallback;
replace it with a higher-priority renderer to choose another diff experience.

`@flect/plugin-render-files` turns `list_files` and `find_files` results into
bounded file boxes, while `@flect/plugin-render-search-text` groups text-search
matches by file with compact line-and-column locations. Both understand live
tool values and the JSON restored from durable conversations.

### Add slash commands from plugins

Slash commands use the same prioritized Cordis lifecycle as visual slots and
keybindings. They appear in autocomplete as soon as the plugin mounts and
disappear when it unloads. A higher-priority plugin can intentionally replace
a default command name.

```js
export const name = 'greeting-command'
export const inject = ['tui']

export function apply(ctx) {
  ctx.tui.registerSlashCommand({
    id: 'example.greeting',
    name: 'greet',
    aliases: ['hello'],
    description: 'Open a greeting.',
    usage: '/greet [name]',
    run(args, actions) {
      actions.showOverlay({
        id: 'greeting',
        title: 'Hello',
        lines: [`Hello, ${args.join(' ') || 'world'}!`],
      })
    },
  })
}
```

Scaffold and activate one in a single command:

```sh
pnpm dev plugin create my-command --template slash
```

Or install the complete example with
`pnpm dev plugin add ./examples/slash-greeting.mjs`.

## Permissions, sessions, and audit history

A workspace read is allowed automatically. A guarded write or process displays
`[y] once`, `[s] session`, `[p] project`, and `[n] deny`. Read and write grants
are capability-wide (`workspace.read` or `workspace.write`), so the dialog does
not ask for per-file approval. When a capability such as process execution
offers several safe scopes, Tab/Shift+Tab chooses the future match. Project
grants are written atomically to
`.flect/permissions.json`; `/permissions` lists them and
`/permissions revoke <id>` removes one immediately.

`/auto` explicitly enables session-only automatic approval for reads, writes,
and command execution. The footer shows `AUTO` for as long as it is active;
`/auto off` restores prompts. Auto mode starts off, does not persist across
Flect processes, and does not include network permissions by default. It skips
the modal, not workspace containment, patch validation, or process safeguards.

`/plan` enters a read-only planning mode contributed by
`@flect/plugin-mode-plan`; `/plan off` leaves it and `/plan status` explains the
policy. While active, a planning-only system-prompt section is added, workspace
reads/searches remain available, and write, execute, and network permissions
are denied—even when auto mode or a remembered grant would otherwise allow
them. The footer shows `PLAN`; the choice is session-only.

`/compact` summarizes the old model-facing prefix into an append-only
checkpoint while preserving the raw session records. `@flect/plugin-auto-compact`
does the same in agent preflight after the configured context threshold; use
`/autocompact status|on|off` to inspect or toggle it. `/budget` shows the
independent per-run step, time, token, and calculated-cost limits. Reaching one
stops cleanly before the next model request with a `limit-reached` run record.

Conversations live under `.flect/sessions/`. `/sessions` opens an arrow-key
picker, and `/new`, `/resume`, `/fork`, `/rename`, `/compact`, and `/session`
manage the active history. Headless maintenance supports `sessions show`, `export`,
`delete <id> --yes`, and `repair`.

Redacted events live under `.flect/audit/`. `/audit`, `/audit tools`,
`/audit permissions`, and `/audit show <id>` explain correlated actions.
Headless `audit list|show|export|prune` exposes the same safe records.

## Project status

Pre-alpha. Cordis itself currently warns that its API is not stable, so this
project pins compatible release-candidate ranges and keeps the microkernel
small. Cross-platform PTY hardening, plugin integrity metadata, MCP, and a
plugin-provided web interface remain on the [roadmap](docs/roadmap.md).
The staged npm distribution model and pre-release gates are in the
[packaging guide](docs/packaging.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports, design proposals, and
plugins are welcome.
