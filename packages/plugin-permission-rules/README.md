# @deep-tui/plugin-permission-rules

Adds session/project “don't ask again” grants, `.deep-tui/permissions.json`
persistence, and `/permissions` inspection and revocation.

Workspace reads are allowed automatically by default. Set `allowRead: false`
to send them through the normal policy chain instead. File tools use broad
`workspace.read` and `workspace.write` rules, so remembered approval applies to
the capability rather than a single path.

Prompts offer allow once, session, project, and deny. Tab chooses among safe
tool-proposed candidates when a capability genuinely has multiple scopes (for
example, process execution). Only project grants persist; rules are atomic,
project-isolated, bounded, and fail closed on corrupt or unwritable state.
