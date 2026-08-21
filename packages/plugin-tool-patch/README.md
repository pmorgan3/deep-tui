# @flect/plugin-tool-patch

Adds an exact-context, workspace-contained `apply_patch` unified-diff tool.

All targets and hunks validate before commit. Staged writes roll back on
failure; binary, traversal, symlink, duplicate-target, ambiguous, and oversized
patches are rejected. Delete and rename support are opt-in.

After a successful commit the tool emits the accepted unified diff through the
UI-only tool-presentation channel. This lets a renderer show exact changes
without duplicating the patch in model-facing tool output.
