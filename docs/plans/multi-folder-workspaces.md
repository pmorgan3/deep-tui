# Multi-folder workspaces — implemented

## Outcome

One Flect process can work across a primary project and multiple explicitly
trusted local folders without teaching individual tools about filesystem
mounts. The feature remains optional and decomposes into ordinary plugins.

## Addressing and ownership

- The project containing `flect.config.json` remains the primary root, session
  anchor, and `.flect` state owner.
- Existing unprefixed paths keep their meaning in the primary root.
- Every additional root has a case-insensitively unique alias and is addressed
  as `@alias/path`.
- Roots may be `read-write` or `read-only`, available or temporarily
  unavailable. Nested and overlapping roots are rejected.
- Models may use configured roots but cannot change the trusted root set;
  management is exposed only through user-facing slash and CLI commands.

## Plugin split

| Package | Responsibility |
| --- | --- |
| `@flect/plugin-workspace-local` | Single-root fallback and reusable local containment/walk primitives |
| `@flect/plugin-workspace-multi-root` | Alias routing, root metadata, access policy, persistence, prompt context, `/folders`, and `flect folders` |
| `@flect/plugin-sidebar-folders` | Optional live TUI presentation of root state |
| Tool plugins | Consume only `WorkspaceService`; no mount-specific branches |

The multi-root provider has higher priority than the local provider. Cordis
disposal therefore restores single-root behavior automatically.

## State and lifecycle

`/folders add <path> [alias] [--read-only]` and `flect folders add` persist
runtime additions in the primary project's `.flect/folders.json`. Writes use a
temporary file and atomic rename. Configuration-defined roots are immutable at
runtime, while persisted roots can be removed. Missing roots stay in metadata
as unavailable and are refreshed by status operations.

Workspace invalidations update consumers such as the folders sidebar. Prompt
rendering reads current roots each turn, so newly added or restored folders are
immediately described to the model.

## Security invariants

- Reject absolute tool paths and lexical `..` escapes.
- Resolve existing paths and parents through `realpath` to reject symlink
  escapes; directory walks never follow symlinks.
- Enforce read-only policy for writes, patches, and process working-directory
  selection.
- Validate aliases, canonicalize available roots, reject duplicates and root
  overlap, and bound directory walks.
- Treat plugins and approved subprocesses as trusted host code; workspace
  routing is not an operating-system sandbox.

## Verification contract

Integration coverage exercises primary and aliased read/list/search/write,
cross-root patches, process working directories, display paths, prompt context,
sidebar rows, configured-root immutability, read-only policy, traversal and
symlink rejection, unavailable-root refresh, CLI/slash management, persistence,
busy-session guards, overlap rejection, and provider fallback assumptions.
