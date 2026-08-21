# @deep-tui/plugin-tool-workspace

Provides workspace-contained `read_file`, `list_files`, and `write_file` tools
plus safe path resolution/walking for other plugins. Paths cannot escape the
workspace through traversal or symlinks; reads are bounded and listings skip
configured directories.

Successful text writes emit a bounded-context unified diff through Deep TUI's
UI-only tool-presentation channel. The model receives the compact write result,
while compatible TUI plugins can display the change inline and restore it from
durable sessions.
