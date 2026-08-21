# Flect daily-driver implementation plans

These plans defined the first daily-driver milestone. All eight tracks are now
implemented; the documents remain the design and regression contract for
future revisions.

The post-milestone [multi-folder workspace plan](multi-folder-workspaces.md) is
also implemented and follows the same contracts and release gates.

## Non-negotiable design rules

- Every policy or presentation choice is a Cordis contribution that can be
  overridden and removed without restarting the process where practical.
- The SDK exposes narrow contracts; the default TUI and first-party plugins are
  consumers of those contracts, not privileged implementations.
- State is project-scoped by default, versioned, written atomically, and never
  stores API keys or inherited environment secrets.
- Headless operation remains supported. TUI-specific affordances cannot become
  requirements of the agent, model, tool, or permission services.
- ANSI control sequences from model or tool output are treated as untrusted
  input and cannot reach the terminal without sanitization.
- New registries use the existing priority/layer/disposal behavior so plugin
  overrides have predictable fallback semantics.

## Recommended implementation order

| Order | Plan | Why now | Depends on |
| --- | --- | --- | --- |
| 1 | [Conversation scrolling](conversation-scrolling.md) — implemented | Makes long output usable and establishes measurable transcript layout | Existing TUI |
| 2 | [Markdown and syntax highlighting](markdown-rendering.md) — implemented | Uses the viewport/layout foundation and makes assistant output readable | Scrolling layout contracts |
| 3 | [Streaming model output](streaming-output.md) — implemented | Makes model latency visible and exercises stable scrolling/rich rendering | Event-renderer contract |
| 4 | [Layered configuration](layered-configuration.md) — implemented | Establishes user/project roots before more durable state is introduced | Existing CLI loader |
| 5 | [Remembered permissions](remembered-permissions.md) — implemented | Adds safe, inspectable session/project grants | Project-path contract |
| 6 | [Search, patch, and subprocess tools](coding-tools.md) — implemented | Completes the minimum useful coding toolset; subprocess relies on scoped grants | Permission rules |
| 7 | [Durable conversations](durable-sessions.md) — implemented | Persists canonical model history after the event protocol settles | Streaming event schema, project paths |
| 8 | [Audit history](audit-history.md) — implemented | Records stable permission, tool, model, and session events | Permission receipts, session/run IDs |

Plans 1–3 can be implemented as one UX track. Search and patch work from plan 6
can begin in parallel with plans 4–5, but the subprocess plugin must wait for
remembered permission rules. Durable session storage must not persist the
current presentation-only `TuiState.events` array; it uses the canonical
conversation records defined in its plan.

## Cross-plan release gates

Before any new public contract is called stable:

1. Build and typecheck every workspace package.
2. Test Cordis mount, priority override, hot unload, and fallback behavior.
3. Test `NO_COLOR`, narrow terminals, non-TTY headless runs, and cancellation.
4. Run traversal/symlink tests for every project-state or workspace file path.
5. Document configuration, plugin examples, and the one-command installation
   path.
6. Add a migration note for every persisted schema or renamed SDK field.

## Definition of the milestone

The milestone is complete when a user can hold a long, streaming, formatted
conversation; safely approve recurring operations; search, patch, and execute
within a workspace; close and resume that conversation; and inspect what Flect
did—all while replacing each default through ordinary plugins.
