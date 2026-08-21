# @flect/plugin-permission-auto

Adds explicit, session-only auto approval through `/auto`.

Auto mode starts off. `/auto` toggles it; `/auto on`, `/auto off`, and
`/auto status` are also available. While on, read, write, and execute requests
are approved without a modal and an `AUTO` badge remains visible in the TUI
footer. Network requests continue to ask by default.

Tool containment and validation still apply: auto mode skips the approval
dialog, not workspace path checks, patch validation, or process safeguards.
The choice is intentionally not persisted between Flect processes. Configure
`enabled: true` only when a composition should opt into auto mode at startup,
and set `risks` to change the approved risk classes.
