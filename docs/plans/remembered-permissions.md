# Plan: remembered permissions

## Outcome

Permission prompts support allow once, allow for this session, allow for this
project, and deny. Remembered grants are narrow, inspectable, revocable, and
implemented by a permission-policy plugin rather than special cases in tools or
the default TUI.

## Safety model

“Command type” must be a stable key proposed by the tool plugin, not a guess
made by parsing human-readable descriptions. A grant for `git status` must not
implicitly authorize arbitrary `git`, a grant for one output path must not
authorize all workspace writes, and a project rule never applies to another
project.

Only explicit allow decisions are remembered in the first release. Denials are
per-request to avoid persistent lockouts; remembered deny rules can be added
after rule management has proven usable.

## SDK changes

Add contextual and rule-candidate data:

```ts
interface PermissionRuleCandidate {
  key: string
  label: string
  description?: string
}

interface PermissionContext {
  cwd: string
  sessionId?: string
  runId?: string
  toolCallId?: string
}

interface PermissionRequest {
  capability: string
  description: string
  risk: 'read' | 'write' | 'execute' | 'network'
  metadata?: JsonObject
  remember?: readonly PermissionRuleCandidate[]
}

interface PermissionReceipt {
  decision: 'allow' | 'deny'
  policyId?: string
  ruleId?: string
}
```

Change `PermissionPolicy.decide(request, context)` to accept context while
remaining source-compatible with one-argument functions. Change
`PermissionService.authorize(request, context)` to return a receipt and retain
the current throw-on-denial behavior for callers.

Add a `PermissionRuleService` with plugin-facing methods to list, add, remove,
match, and subscribe to rules. The runtime mounts registry plumbing; the
first-party rules plugin supplies storage and the high-priority policy.

The TUI response becomes structured:

```ts
interface PermissionResponse {
  decision: 'allow' | 'deny'
  remember?: 'session' | 'project'
  ruleKey?: string
}
```

Update `TuiActions.answerPermission()` and the shell waiter accordingly. A
policy converts the response into a stored rule before returning `allow`.

## First-party plugin

Create `@flect/plugin-permission-rules` with:

- an in-memory session-rule store keyed by TUI/headless session ID;
- a project store at `.flect/permissions.json` by default;
- a priority-1000 permission policy that checks the narrowest matching active
  rule before interactive policies;
- default approval for built-in `fs.read` requests, configurable with
  `allowRead: false`;
- atomic project writes, schema versioning, restrictive file mode where the
  platform supports it, and corrupt-file diagnostics without silently
  authorizing anything;
- `/permissions` and `/permissions revoke <rule-id>` commands, autocomplete,
  and an interactive revoke picker;
- configuration for `persist`, `stateFile`, and maximum rule count.

Schema version 1:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "generated-id",
      "key": "workspace.write",
      "label": "write files in this workspace",
      "decision": "allow",
      "createdAt": "ISO-8601 timestamp"
    }
  ]
}
```

The project root comes from the layered-configuration/project-path contract,
not `process.cwd()`. No API keys, file contents, full environment, or command
output are stored.

## Rule keys

Document a namespaced convention:

- `workspace.read`
- `workspace.write`
- `process.exec:<executable>:<subcommand>`
- `network.host:<lowercase-host>:<port>`

Workspace file tools deliberately use capability-wide keys: reads are allowed
by default, and one remembered write grant covers both patches and complete-file
writes. Capabilities with meaningfully different safe scopes can still order
candidates from narrowest to broadest. Keys use normalized structured input;
shell strings and human descriptions are never keys.

Workspace/symlink containment is still enforced independently at execution
time. The subprocess plan adds executable/subcommand candidates only for
argv-array execution.

## TUI interaction

The permission modal shows:

```text
[y] allow once   [s] allow for session
[p] allow in this project   [n] deny
```

If multiple rule candidates exist, Tab/Shift+Tab changes the proposed scope
and the modal displays exactly what future operations would match. `s` and `p`
are unavailable when a request provides no safe candidate. Escape is deny.

Project persistence must finish successfully before the pending tool is
allowed. On write failure, keep the approval open and show the error; never
downgrade silently to allow-once.

The headless terminal asks the same choices when interactive. Non-TTY input
continues to deny unless an existing rule or explicit allow policy decides
first.

## File changes

- `packages/sdk/src/types.ts`: contexts, candidates, responses, receipts,
  rules.
- `packages/sdk/src/services.ts`: contextual authorization and rule service.
- `packages/runtime/src/index.ts`: mount rule-service plumbing.
- `packages/plugin-agent/src/index.ts`: pass cwd/run/tool-call context.
- `packages/plugin-tool-workspace/src/index.ts`: stable path candidates.
- `packages/plugin-ui-tui/src/shell.ts`, `frame.ts`, and `index.ts`: structured
  prompt, keys, and failure handling.
- `packages/plugin-ui-terminal/src/index.ts`: equivalent terminal choices.
- New `packages/plugin-permission-rules` package, tests, and README.
- CLI starter config, schema documentation, root README, roadmap.

## Verification

Test matching as a pure function with path separators, case behavior by
platform, Unicode, candidate ordering, malformed keys, and project isolation.
Integration tests prove:

1. Allow-once prompts again for the same request.
2. Session allow skips the next prompt but disappears after session stop.
3. Project allow survives a fresh composition in the same project.
4. The same rule does not authorize another project or a broader operation.
5. Revocation takes effect immediately in a running composition.
6. Corrupt or unwritable state fails closed.
7. Plugin unload removes the remembered policy and slash command cleanly.

## Acceptance criteria

- The four permission choices work in TUI and interactive terminal modes.
- Every remembered grant displays its exact future match scope.
- Rules can be listed and revoked without editing JSON.
- Project grants persist atomically and session grants do not leak.
- Missing/corrupt rule storage never turns into an allow decision.
- Third-party tools can provide safe rule candidates without depending on the
  default UI or storage plugin.
