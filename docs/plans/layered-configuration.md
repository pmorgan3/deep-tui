# Plan: layered user and project configuration

## Outcome

Flect composes deterministic defaults, user preferences, project settings, and
an explicit CLI configuration. Users can see where every effective plugin
entry came from, while plugin-relative paths continue to resolve against the
file that declared them.

## Layer order

Lowest to highest priority:

1. CLI starter defaults used only by `flect init`.
2. User config.
3. Project config discovered by walking upward.
4. Explicit `--config` or `FLECT_CONFIG` file.
5. CLI flags for the invoked command, where that command supports overrides.

`--config` adds the explicit highest file rather than silently discarding user
configuration. Add `--isolated-config` when a user intentionally wants exactly
one file. Do not interpolate arbitrary environment variables inside JSON and
never place API keys in effective-config output.

User config follows platform conventions through a small tested resolver:

- Unix: `$XDG_CONFIG_HOME/flect/config.json`, falling back to
  `~/.config/flect/config.json`.
- Windows: `%APPDATA%\flect\config.json`.
- A test-only/configured path overrides discovery without mutating HOME.

When no project or explicit composition exists, the user configuration is a
complete composition by itself. Flect still treats the invocation directory as
the project/workspace root; the location of the user JSON file never becomes a
workspace accidentally.

## Schema version 2

Accept version 1 unchanged and normalize it internally. Version 2 adds:

```json
{
  "version": 2,
  "extends": ["./shared.flect.json"],
  "plugins": [
    {
      "id": "agent",
      "use": "@flect/plugin-agent",
      "enabled": true,
      "config": {}
    }
  ]
}
```

`extends` accepts local files and installed package specifiers only. Detect and
report cycles with the full source chain. Network URLs are out of scope.

## Merge semantics

Normalize each entry to an identity of `id` when present, otherwise `use`.
Merge layers from low to high:

- A new identity is appended.
- An existing identity keeps its relative position but higher layers replace
  `use`/`enabled` and deep-merge plain-object `config`.
- Arrays and primitives replace; they do not concatenate.
- `config: null` clears inherited config.
- `enabled: false` disables an inherited plugin without deleting provenance.
- Reusing an `id` with a different `use` is allowed but called out by
  `config explain`.
- Duplicate identities in one source are validation errors.

Every normalized entry retains internal provenance for each winning field and
its declaring directory. Relative plugin specifiers and plugin-owned relative
config paths resolve against that declaring source, not whichever config file
happened to be loaded last.

## Project context service

Introduce immutable plugin-facing composition metadata:

```ts
interface ProjectContext {
  root: string
  invocationCwd: string
  configFiles: readonly string[]
  statePath(...segments: string[]): string
}
```

Expose it as `ctx.project`. The CLI loader mounts the service before ordinary
composition plugins. `statePath()` always stays beneath `<root>/.flect` unless
a plugin has an explicit configured absolute path. Theme, permissions,
sessions, and audit plugins migrate from ad hoc `actions.state.cwd` resolution
to this service.

This is plumbing, not policy: a plugin can replace storage behavior through
its own config or service contribution.

## CLI commands

Add:

- `flect config paths`: ordered discovered files and project root.
- `flect config show [--json]`: effective redacted configuration.
- `flect config explain [plugin-id]`: field provenance and merge decisions.
- `flect config validate`: all sources, schema errors, unresolved plugins, and
  pending Cordis service dependencies without launching a UI.
- `flect config init --scope user|project`.

Update `plugin add/create/remove` with `--scope user|project`; default to
project. A local plugin created for user scope lives under the user Flect data
directory, never inside an unrelated current project.

## File changes

- `packages/cli/src/config.ts`: discovery, v1/v2 parsing, source graph, merge,
  provenance, platform paths.
- `packages/cli/src/composition.ts`: resolve each entry from its source and
  mount project context.
- `packages/cli/src/bin.ts`: config commands and scope flags.
- `packages/cli/src/plugins.ts`: scoped mutation.
- `packages/sdk/src/types.ts`/`services.ts`: project context service.
- `packages/runtime/src/index.ts`: declare/use the context dependency as
  appropriate without creating a second root.
- `schemas/config.schema.json`: v1/v2 schema.
- Theme, permission, session, and audit persistence plugins: use `ctx.project`.
- CLI unit/integration tests and documentation.

## Error handling and security

- Canonicalize source files before cycle detection.
- Reject malformed JSON, duplicate IDs, and invalid entry shapes before any
  plugin is imported.
- Never import a plugin merely for `config show`; resolution diagnostics may
  use package resolution without evaluation.
- Redact config fields whose keys match a conservative secret pattern and let
  plugins declare additional redacted paths.
- Preserve the current five-second activation diagnostic, but include source
  file and entry identity.
- Writes are atomic and target exactly one requested layer.

## Verification

Use temporary fake HOME/XDG/APPDATA directories. Cover absent layers, all merge
types, extends diamonds/cycles, same package with distinct IDs, disable and
replacement, explicit and isolated config, relative plugins from extended
files, provenance output, redaction, and Windows/Unix path rules.

Composition tests prove that merged plugin priority and Cordis disposal remain
unchanged. Migration tests load the current v1 `flect.config.json` with an
empty user layer and produce an equivalent composition.

## Acceptance criteria

- Effective configuration is deterministic and explainable field by field.
- User defaults apply across projects and project settings override them.
- Existing v1 projects launch unchanged.
- Relative plugin paths resolve from the source that declared them.
- Plugin mutation commands never edit the wrong layer.
- Durable-state plugins share one canonical project root.
