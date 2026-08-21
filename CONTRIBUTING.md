# Contributing

Thanks for helping build a genuinely composable agent harness.

## Development

```sh
pnpm install
pnpm check
```

Use Node.js 22 or newer. Add behavior as a plugin unless it is required to
locate, load, or repair plugins. If a host change introduces a model, tool,
prompt, permission, or UI concept directly into the CLI microkernel, explain
why it cannot live behind a service.

Pull requests should include tests for lifecycle cleanup and replacement where
relevant. Public contracts belong in `@flect/sdk`; implementations
belong in plugins.

## Design proposals

Open an issue before making a broad contract change. Include the user problem,
the smallest service/event surface that solves it, unload/reload behavior, and
how a third-party implementation replaces the default.
