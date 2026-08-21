# @deep-tui/sdk

Public contracts and default service-registry implementations for harness
plugins. Importing the SDK does not start any service; a composition must mount
`@deep-tui/runtime` or another plugin that provides compatible services.

The `tui` service exposes reversible registries for shells, visual components,
keybindings, slash commands, event decorators, and status items. Register a `TuiSlashCommand` with
`ctx.tui.registerSlashCommand()`; command discovery, aliases, argument
completion, priority overrides, and Cordis cleanup are handled by the service.
Plugins can also register a `TuiSessionHook` to restore state before the first
frame or clean up when a compatible shell closes.

The runtime additionally mounts replaceable project, workspace, permission-rule,
conversation, and audit services. Model providers may stream typed deltas or
implement only `complete()` and use the compatibility adapter. TUI plugins may
layer viewport components, rich event renderers, prepend/append event
decorations, status-line items, and code highlighters without depending on the
default shell. Assistant events and durable assistant records may carry their
own provider usage in addition to aggregate run usage.

Prompt sections may opt into `placement: 'context'`. The agent snapshots those
sections as sourced user-role runtime context at the conversation tail, keeping
the system prompt stable. Durable conversations also use append-only envelope,
tool-prune, and checkpoint records. `conversationSurface()` folds those records
into the exact model-facing history without deleting the underlying audit log.
Tool schemas and JSON passback are recursively canonicalized, while a
provider-emitted `ToolCall.rawArguments` is retained when available.

Workspace providers resolve reads and writes, stream directory entries, and
may publish structured roots plus display-path mapping. `WorkspaceRoot`
describes its virtual prefix, access mode, availability, and whether it is the
primary project. Consumers subscribe to `WorkspaceService` invalidations rather
than capturing a root list, which lets provider plugins add, remove, refresh,
or hot-swap roots without changing tool implementations.

Tools can call `execution.present()` with structured UI-only metadata. The
agent carries that metadata on the tool-result event and durable tool record,
but keeps it out of model-facing tool output. Diff rendering is one consumer;
other plugins can define additional presentation types and renderers.
