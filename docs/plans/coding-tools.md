# Plan: search, patch, and subprocess tool plugins

## Outcome

Flect gains the minimum credible coding toolset: fast bounded file discovery
and text search, safe multi-file patch application, and cancellable argv-based
subprocess execution. Each capability is an independently installable plugin
with narrow permissions.

## Shared workspace service

First extract the path and traversal protections currently private to
`@flect/plugin-tool-workspace` into a public `WorkspaceService` contribution:

```ts
interface WorkspaceService {
  root(context: ToolExecutionContext): Promise<string>
  resolveRead(relative: string, context: ToolExecutionContext): Promise<string>
  resolveWrite(relative: string, context: ToolExecutionContext): Promise<string>
  walk(options: WorkspaceWalkOptions, context: ToolExecutionContext): AsyncIterable<WorkspaceEntry>
}
```

It centralizes lexical containment, realpath/symlink checks, ignored
directories, byte/entry limits, and normalized relative paths. Existing
read/list/write tools migrate without behavior changes. Tool plugins inject
`workspace`; replacing the workspace provider changes all of them coherently.

## Search plugin

Create `@flect/plugin-tool-search` with two tools:

- `find_files`: include/exclude globs, type filter, result limit.
- `search_text`: fixed-string or regular-expression query, globs, case mode,
  context lines, per-file and global match limits.

The default implementation is in-process and portable. It skips binary files,
does not follow symlinks, honors workspace ignores plus plugin config, streams
the tree rather than loading it fully, and returns structured matches with
relative path, line, column, preview, and truncation metadata. A separate
higher-priority ripgrep-backed plugin can be added later.

Search permission is `fs.read`, which the default policy auto-allows. Requests
still include normalized query/path metadata for auditing. Reject pathological
regexes through input length limits and cancellation/time budgets; consider a
safe regex engine only after measuring real need.

## Patch plugin

Create `@flect/plugin-tool-patch` with `apply_patch` accepting a documented
unified-diff subset. Parse first, then validate every target before writing.

Required behavior:

- create and modify files initially; deletion and rename are opt-in config;
- reject absolute paths, traversal, symlink escapes, binary patches, duplicate
  targets, ambiguous hunks, and unsupported diff headers;
- require every context/removal line to match exactly unless an explicit fuzz
  setting is enabled (default zero);
- cap patch bytes, files, hunks, and resulting file sizes;
- stage every resulting file in its target directory, then rename only after
  all hunks validate so a failed multi-file patch changes nothing;
- preserve newline-at-EOF semantics and existing mode where possible;
- return structured changed-file/hunk/line counts, not whole file contents.

Patch and full-file writes share the broad `workspace.write` permission. The
prompt asks about write access rather than exposing a separate choice for every
affected path. Keep a pure patch parser/applicator module with fixture tests
independent of Cordis.

## Subprocess plugin

Create `@flect/plugin-tool-process` with `run_command`:

```json
{
  "argv": ["git", "status", "--short"],
  "cwd": ".",
  "timeoutMs": 30000,
  "stdin": "optional text"
}
```

Security and lifecycle rules:

- `argv` is required and non-empty; no shell parsing, interpolation, pipes, or
  redirects in the default tool.
- Resolve `cwd` through `WorkspaceService` and require a directory.
- Inherit only a configured environment allowlist plus explicit non-secret
  overrides. Reject NULs and dangerous invalid names.
- Capture stdout/stderr separately with byte limits, truncation flags, exit
  code, signal, and elapsed time.
- On timeout or abort, terminate the process group gracefully, then force it
  after a short configurable grace period; always reap the child.
- Default network and filesystem effects remain the executable's
  responsibility and are communicated in the execute-risk prompt.
- Windows process-tree handling gets a documented implementation and tests;
  do not claim cross-platform completion until it works.

Permission candidates are generated from normalized argv, such as exact
`process.exec:git:status`. Broader executable grants may be exposed only when
the permission-rules plugin can display and revoke them. Never remember a raw
shell command string.

## Streaming tool output

Extend tool execution compatibly with an optional event callback or
`AsyncIterable<ToolExecutionEvent>` so subprocess output can appear while a
command runs. The first implementation may return only the bounded final
result, but its result schema and agent events must not preclude streaming.
Reuse run ID/tool-call ID from the streaming and audit plans.

## File/package changes

- SDK workspace and optional tool-event contracts; runtime service mount.
- Refactor `packages/plugin-tool-workspace` to provide/use workspace service.
- New `packages/plugin-tool-search`, `plugin-tool-patch`, and
  `plugin-tool-process` packages with isolated tests and READMEs.
- Agent tool-event forwarding and TUI/terminal renderers where streaming is
  included.
- Permission candidates in all write/execute tools.
- Starter config, monorepo references, lockfile, docs, roadmap.

## Verification

Search tests cover ignores, binary files, Unicode, CRLF, huge lines, match
limits, cancellation, invalid regex, and symlink loops. Patch fixtures cover
creation/modification, multi-hunk/multi-file atomicity, CRLF, EOF newline,
context mismatch, malformed headers, traversal, symlinks, and limit failures.
Process tests cover argv fidelity, spaces/metacharacters without a shell,
cwd/env, output interleaving, truncation, exit codes, signals, timeout, abort,
and child cleanup.

Run adversarial workspace tests on every supported OS before marking the
subprocess plugin stable.

## Acceptance criteria

- Agents can locate code and references without reading the whole repository.
- Patches either apply exactly and atomically or make no changes.
- Commands cannot acquire shell syntax through a string field.
- Every write/execute action has a precise permission description and safe
  remember candidate.
- Cancellation and limits prevent runaway search/process work.
- Each tool family can be installed, disabled, or replaced independently.
