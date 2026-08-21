# Plan: approval history and auditable tool traces

## Outcome

Users can answer “what did Deep TUI do, why was it allowed, and what happened?”
for model runs, permission decisions, and tool executions. Audit capture,
redaction, storage, and presentation are independent plugins with safe
defaults.

## Separation from conversations

Conversation records exist to reconstruct provider history. Audit records
exist to explain actions. They share stable session/run/message/tool-call IDs
but are distinct schemas and stores. Deleting a conversation does not silently
delete its audit trail; retention policy controls audit deletion separately.

## SDK contracts

Add a normalized event union:

```ts
type AuditEvent =
  | { type: 'run.start' | 'run.finish'; runId: string; conversationId?: string; ... }
  | { type: 'model.start' | 'model.finish' | 'model.error'; runId: string; ... }
  | { type: 'permission.request' | 'permission.decision'; requestId: string;
      runId?: string; toolCallId?: string; ... }
  | { type: 'tool.start' | 'tool.finish' | 'tool.error'; toolCallId: string;
      runId: string; ... }
```

Every event has `id`, UTC timestamp, project ID/root fingerprint, and schema
version. Finish events include duration and bounded result metadata. Permission
decision events include policy ID, decision, remembered scope, and rule ID.

Add priority-ordered contributions:

```ts
interface AuditSink {
  id: string
  priority?: number
  record(event: AuditEvent): Awaitable<void>
  flush?(): Awaitable<void>
}

interface AuditRedactor {
  id: string
  priority?: number
  redact(event: AuditEvent): Awaitable<AuditEvent | undefined>
}
```

`AuditService.record()` runs redactors in order, validates the result, and
sends it to every active sink. Returning `undefined` drops an event. Sink
failures follow configurable policy: default `warn` for model telemetry but
`fail-closed` may be selected for permission/tool events in regulated use.
`flush()` runs from a TUI session hook and composition shutdown.

## Correlation and instrumentation

- Generate `runId` at the command/TUI boundary and `requestId` for every
  permission prompt.
- Reuse provider/tool-call message IDs where available; generate stable IDs
  otherwise.
- Instrument `DefaultAgentService` around model and tool lifecycle.
- Have `PermissionService` emit request and receipt after the deciding policy
  is known.
- Include provider/model, tool name, capability, status, token usage, cost, and
  timing.
- Do not record full prompts, assistant text, file content, command stdin,
  complete environment, API headers, or raw tool output by default.

The existing Cordis `harness/*` events can remain compatibility notifications,
but the typed audit service becomes the canonical structured stream.

## Redaction

Create `@deep-tui/plugin-audit-redact-default` with:

- recursive key-based removal for authorization, token, secret, password,
  cookie, and configured keys;
- maximum depth, string length, array length, and serialized event bytes;
- path normalization to project-relative form where possible;
- command argv retained, but stdin/env values removed and suspicious argv
  values replaced according to configurable patterns;
- tool-specific summaries: file path/byte count rather than contents, patch
  target/count rather than full patch, subprocess exit/truncation rather than
  full output;
- a final terminal-control sanitizer.

Redaction runs before persistent sinks. A debug sink that wants raw data must
require explicit configuration and display a warning; it is never in the
starter composition.

## Filesystem sink

Create `@deep-tui/plugin-audit-jsonl`:

```text
.deep-tui/audit/
  2026-08-17.jsonl
```

- append versioned JSONL with restrictive permissions;
- rotate by UTC day and configured maximum bytes;
- serialize writes and flush on shutdown;
- tolerate only an incomplete final line during reads;
- configurable retention days/bytes and explicit prune command;
- optional per-file hash chain (`previousHash`, `hash`) to reveal accidental
  truncation/reordering, clearly documented as tamper-evidence rather than a
  security boundary.

No network sink ships in the default composition. Third-party OpenTelemetry or
database sinks use the same redacted event contract.

## User interfaces

Add plugin-provided commands:

- `/audit`: recent actions for the current conversation.
- `/audit permissions`: recent requests/decisions and remembered rule IDs.
- `/audit tools`: tool name, status, duration, and result summary.
- `/audit show <event-id>`: redacted structured detail.
- `deep-tui audit list|show|export|prune [--json]` for headless use.

The TUI list is a scrollable picker using the generic viewport/overlay
contracts. It never displays raw secrets even if a custom sink retained them.
`/permissions` links rule IDs back to their decision records where available.

## File changes

- `packages/sdk/src/types.ts` and `services.ts`: audit types, registry, service.
- `packages/runtime/src/index.ts`: mount audit plumbing.
- Agent/model/permission/tool services: correlated record calls.
- New `packages/plugin-audit-redact-default` package.
- New `packages/plugin-audit-jsonl` package.
- New slash/headless audit command package or commands within the JSONL plugin.
- TUI audit picker component, starter config, docs, schemas, tests.

## Verification

Contract tests assert event ordering and shared IDs across run → model →
permission → tool → model → run. Redaction tests use nested, cyclic-looking,
oversized, and terminal-control input plus known secret field names. Storage
tests cover concurrent writes, rotation, truncated tails, retention, flush,
hash verification, and failed disks.

Security regression fixtures scan persisted bytes and assert seeded API keys,
authorization headers, file contents, stdin, and environment secrets do not
appear. Lifecycle tests hot-add/remove sinks and redactors and verify priority
and fallback semantics.

## Acceptance criteria

- Every permission and tool action has a correlated, time-ordered explanation.
- Default persisted events exclude secrets and bulk content.
- Users can inspect and export history from TUI and headless CLI.
- Retention and deletion are explicit and independently configurable from
  conversation retention.
- Sink failure behavior is visible and configurable.
- Third-party sinks/redactors can be added or removed through Cordis lifecycle.
