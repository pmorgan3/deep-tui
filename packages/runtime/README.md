# @deep-tui/runtime

Installs Deep TUI's default replaceable service registries on a Cordis context.
It provides the public SDK services needed by agent, provider, tool, storage,
permission, theme, command, and UI plugins without selecting implementations.

```json
{ "use": "@deep-tui/runtime" }
```

Load it before feature plugins that consume services from `@deep-tui/sdk`.
