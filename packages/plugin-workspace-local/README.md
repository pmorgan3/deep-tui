# @deep-tui/plugin-workspace-local

Safe single-root local filesystem provider for Deep TUI's generic workspace
service. It enforces lexical and realpath containment, refuses absolute and
traversal paths, and never follows directory symlinks.

```json
{ "use": "@deep-tui/plugin-workspace-local" }
```

It is the default low-priority fallback. A higher-priority provider such as
`@deep-tui/plugin-workspace-multi-root` can take over every workspace-aware tool
and fall back to this provider cleanly when unloaded.
