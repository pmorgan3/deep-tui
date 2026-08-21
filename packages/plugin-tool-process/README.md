# @deep-tui/plugin-tool-process

Adds `run_command` with an argv array, workspace cwd, timeout, cancellation,
bounded stdout/stderr, and no shell interpretation.

Environment inheritance is allowlisted, secret-looking overrides are rejected,
and timeout/abort escalates from graceful termination to a forced process-group
kill. POSIX process groups are implemented; Windows process-tree parity remains
part of the cross-platform PTY/process hardening milestone.
