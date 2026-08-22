# Deep TUI

Deep TUI is a plugin-first coding-agent harness built on
[Cordis](https://github.com/cordiverse/cordis). Providers, tools, prompts,
permissions, storage, themes, commands, renderers, and the agent loop are all
replaceable plugins. The CLI only discovers configuration, loads plugins, and
dispatches commands.

Deep TUI is pre-alpha. Its contracts and configuration may change.

## Quick start

Requirement: Node.js 22 or newer.

```sh
npm install --global @deep-tui/cli
cd path/to/your/project
deep-tui init
export DEEPSEEK_API_KEY=your-key
deep-tui
```

`deep-tui init` creates the default composition in `deep-tui.config.json`, and
`deep-tui` opens the TUI. Type a prompt and press Enter. Type `/` to browse
commands. To use one default composition across all projects, run
`deep-tui config init --scope user` instead of `deep-tui init`; a project
configuration takes precedence when present.

Run without the TUI:

```sh
deep-tui run --model flash "Summarize this repository"
deep-tui run --model pro --new-session "Implement the next task"
deep-tui sessions list
deep-tui config validate
```

Upgrade later with `npm install --global @deep-tui/cli@latest`. pnpm is needed
only when developing Deep TUI itself.

## Development

```sh
pnpm install        # install workspace dependencies
pnpm build          # build every package
pnpm test           # run Vitest
pnpm typecheck      # type-check without emitting
pnpm check          # build, test, and type-check
pnpm pack:check     # verify publishable package contents
```

Run one package or test while iterating:

```sh
pnpm --filter @deep-tui/plugin-ui-tui run typecheck
pnpm exec vitest run packages/plugin-ui-tui/tests/tui.spec.ts
```

Add behavior as a plugin unless it is required to locate, load, or repair
plugins. Public contracts belong in `@deep-tui/sdk`; implementations belong in
`packages/plugin-*`.

### Repository layout

| Path | Purpose |
| --- | --- |
| `packages/cli` | Configuration loader, bootstrap commands, and executable |
| `packages/sdk` | Public contracts and service registries |
| `packages/runtime` | Default service implementations |
| `packages/plugin-*` | Independently loadable features |
| `examples` | Small local plugin examples |
| `schemas` | Configuration schemas |
| `docs` | Architecture, packaging, roadmap, and design plans |

## Composition

The active product is the plugin list in `deep-tui.config.json`:

```json
{
  "$schema": "./schemas/config.schema.json",
  "version": 2,
  "plugins": [
    { "use": "@deep-tui/runtime" },
    {
      "use": "@deep-tui/plugin-agent",
      "config": { "provider": "deepseek", "model": "flash" }
    },
    { "use": "@deep-tui/plugin-provider-deepseek" },
    { "use": "@deep-tui/plugin-tool-workspace" },
    { "use": "@deep-tui/plugin-ui-tui" }
  ]
}
```

This abbreviated example shows the shape, not the full default composition.
See [deep-tui.config.json](deep-tui.config.json) for the runnable configuration.

A plugin declares required services through `inject`. Cordis mounts it when
those services exist and disposes its registrations when it unloads. Plugin
array order does not resolve dependencies; contribution-specific `priority`
and `order` fields control selection and presentation.

Configuration can layer user, extended, project, and explicit files. Inspect
the resolved result before starting the UI:

```sh
deep-tui config paths
deep-tui config show
deep-tui config explain @deep-tui/plugin-agent
deep-tui config validate
```

Use `--isolated-config` when a command should load only the selected file.

## Create a plugin

Scaffold and activate a local plugin:

```sh
deep-tui plugin create concise-prompt
deep-tui plugin create my-command --template slash
```

Local plugins are created under `.deep-tui/plugins/` and added to the active
composition. A minimal plugin looks like this:

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

Registrations are Cordis effects, so unloading the plugin removes them. The
same lifecycle applies to tools, providers, commands, TUI components,
keybindings, renderers, themes, and permission handlers.

Plugins can be loaded from npm, a local path, or a pinned GitHub URL:

```sh
deep-tui plugin add ./examples/slash-greeting.mjs
deep-tui plugin add https://github.com/example/deep-tui-plugin#v1.0.0 --scope user
deep-tui plugin sync --scope user
```

Plugins execute with the same operating-system privileges as Deep TUI. Install
only code you trust. Model tool permissions do not sandbox plugin code. GitHub
plugins must commit a runnable ESM entry; dependency lifecycle scripts are
disabled during installation.

## Included capabilities

The default composition provides:

- DeepSeek Flash and Pro through a reusable OpenAI-compatible transport;
- workspace read, search, patch, process, and read-only Git tools;
- single-root and virtual `@alias/path` multi-root workspaces;
- streamed Markdown, syntax highlighting, structured tool output, and diffs;
- a composable full-screen TUI and a headless terminal interface;
- durable sessions, compaction, budgets, usage and cost reporting;
- remembered permissions, session-only auto approval, and read-only plan mode;
- filesystem audit history with redaction and hash verification.

Most features have a package README under `packages/` with their configuration
and public extension points.

## TUI reference

| Input | Action |
| --- | --- |
| `Ctrl+P` | Switch model |
| `Ctrl+T` | Toggle the latest reasoning block |
| `Ctrl+B` | Show or hide the sidebar |
| `Tab` | Complete commands or focus the sidebar |
| `Page Up` / `Page Down` | Scroll the transcript |
| `Home` / `End` | Jump to the start or resume following output |
| `Ctrl+C` | Cancel active work; press again to exit |
| `Ctrl+L` | Clear the transcript view |

Useful command groups include sessions (`/new`, `/resume`, `/fork`), models and
themes (`/model`, `/theme`), policy (`/plan`, `/auto`, `/permissions`), context
management (`/compact`, `/autocompact`, `/budget`), and project tooling
(`/folders`, `/plugins`, `/audit`). Use `/help` for the active composition.

## State and safety

Project state is stored under `.deep-tui/`:

- `.deep-tui/sessions/` contains append-only conversation records;
- `.deep-tui/audit/` contains redacted audit events;
- `.deep-tui/permissions.json` contains remembered project grants;
- `.deep-tui/folders.json` contains additional workspace roots;
- `.deep-tui/theme.json` contains the selected project theme.

Workspace reads are allowed by default. Writes and processes pass through the
permission service. `/auto` is session-only and `/plan` denies writes,
execution, and network access while active. These controls constrain model
tool calls, not installed plugin code.

## Documentation

- [Architecture](docs/architecture.md): host boundary and public services
- [SDK](packages/sdk/README.md): plugin contracts and service registries
- [CLI](packages/cli/README.md): executable and bootstrap behavior
- [Packaging](docs/packaging.md): npm and GitHub distribution requirements
- [Roadmap](docs/roadmap.md): planned work and pre-release status
- [Design plans](docs/plans/README.md): implemented acceptance decisions
- [Contributing](CONTRIBUTING.md): development and review expectations

MIT licensed. See [LICENSE](LICENSE).
