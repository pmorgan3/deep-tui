# Roadmap

## Milestone 0 — executable architecture

- [x] Cordis microkernel and composition loader
- [x] Public service contracts and reversible registries
- [x] Tool-calling agent loop
- [x] DeepSeek Pro/Flash provider and reusable OpenAI-compatible transport
- [x] Workspace tools with permission gates
- [x] Headless terminal interface and theme tokens
- [x] Full-screen TUI with replaceable shells, slots, and keybindings
- [x] Plugin-provided slash commands with aliases and autocomplete
- [x] Live theme selection and first-party palette plugins
- [x] Per-project theme persistence and live preview picker
- [x] Provider billing balance service and cache-aware cost accounting
- [x] One-command plugin add/create/remove
- [x] Declarative GitHub plugin sources with managed XDG cache
- [x] Open-source community baseline

## Milestone 1 — credible daily driver

- [x] [Scrollable conversation viewport](plans/conversation-scrolling.md)
- [x] [Markdown rendering and syntax highlighting](plans/markdown-rendering.md)
- [x] [Remembered, revocable permissions](plans/remembered-permissions.md)
- [x] Explicit session-only auto-approval mode
- [x] [Streaming model and UI events](plans/streaming-output.md)
- [x] Per-message usage decorations and running session cost
- [x] Inline unified file-change diffs
- [x] Plugin-composed read-only plan mode
- [x] Responsive plugin-composed sidebar with interactive, hot-swappable sections
- [x] Persistent plugin-composed multi-folder workspaces with `@alias/path` addressing
- [x] [Durable, forkable sessions](plans/durable-sessions.md)
- [x] [Patch, search, and subprocess plugins](plans/coding-tools.md)
- [x] Nested gitignore-style workspace discovery filtering
- [x] Bounded structured Git inspection tools
- [x] Threshold-based automatic conversation compaction
- [x] Per-run step, time, token, and cost budgets
- [ ] Cross-platform PTY support
- [x] [Layered user/project configuration](plans/layered-configuration.md)
- [ ] Plugin lockfile and integrity metadata
- [ ] MCP client plugin
- [x] [Approval history and auditable tool traces](plans/audit-history.md)

## Milestone 2 — composable experiences

- [ ] Plugin-provided web UI with CSS typography tokens
- [x] TUI component/slot API with live Cordis lifecycle updates
- [x] Structured sidebar-section API with compact/full responsive views
- [ ] Filesystem watcher for local plugin and composition changes
- [ ] Isolated Cordis scopes for per-agent capability sets
- [ ] Agent, workflow, and subagent registry plugins
- [ ] Plugin compatibility and capability declarations

## Milestone 3 — ecosystem

- [ ] Searchable public plugin index backed by npm metadata
- [ ] `plugin doctor`, signature/integrity checks, and advisories
- [ ] Official plugin template repository and conformance suite
- [ ] Stable SDK compatibility policy
- [ ] Reproducible binary releases for major platforms

Success is not the number of built-in features. Success is whether a third
party can replace one without forking the host.
