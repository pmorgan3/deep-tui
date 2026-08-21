# Flect

Flect is a plugin-first coding-agent harness built on
[Cordis](https://github.com/cordiverse/cordis). Providers, tools, prompts,
permissions, storage, themes, commands, renderers, and the agent loop are all
replaceable plugins. The CLI only discovers configuration, loads plugins, and
dispatches commands.

Flect is pre-alpha. Its contracts and configuration may change.

## Quick start

Requirements: Node.js 22+ and pnpm 10.

```sh
pnpm install
pnpm build
export DEEPSEEK_API_KEY=your-key
pnpm dev
```

`pnpm dev` opens the default TUI using [flect.config.json](flect.config.json).
Type a prompt and press Enter. Type `/` to browse commands.

Run without the TUI:

```sh
pnpm dev run --model flash "Summarize this repository"
pnpm dev run --model pro --new-session "Implement the next task"
pnpm dev sessions list
pnpm dev config validate
```

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
pnpm --filter @flect/plugin-ui-tui run typecheck
pnpm exec vitest run packages/plugin-ui-tui/tests/tui.spec.ts
```

Add behavior as a plugin unless it is required to locate, load, or repair
plugins. Public contracts belong in `@flect/sdk`; implementations belong in
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

The active product is the plugin list in `flect.config.json`:

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
    { "use": "@flect/plugin-provider-deepseek" },
    { "use": "@flect/plugin-tool-workspace" },
    { "use": "@flect/plugin-ui-tui" }
  ]
}
```

This abbreviated example shows the shape, not the full default composition.
See [flect.config.json](flect.config.json) for the runnable configuration.

A plugin declares required services through `inject`. Cordis mounts it when
those services exist and disposes its registrations when it unloads. Plugin
array order does not resolve dependencies; contribution-specific `priority`
and `order` fields control selection and presentation.

Configuration can layer user, extended, project, and explicit files. Inspect
the resolved result before starting the UI:

```sh
pnpm dev config paths
pnpm dev config show
pnpm dev config explain @flect/plugin-agent
pnpm dev config validate
```

Use `--isolated-config` when a command should load only the selected file.

## Create a plugin

Scaffold and activate a local plugin:

```sh
pnpm dev plugin create concise-prompt
pnpm dev plugin create my-command --template slash
```

Local plugins are created under `.flect/plugins/` and added to the active
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
pnpm dev plugin add ./examples/slash-greeting.mjs
pnpm dev plugin add https://github.com/example/flect-plugin#v1.0.0 --scope user
pnpm dev plugin sync --scope user
```

Plugins execute with the same operating-system privileges as Flect. Install
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

Project state is stored under `.flect/`:

- `.flect/sessions/` contains append-only conversation records;
- `.flect/audit/` contains redacted audit events;
- `.flect/permissions.json` contains remembered project grants;
- `.flect/folders.json` contains additional workspace roots;
- `.flect/theme.json` contains the selected project theme.

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
