# @flect/plugin-session-files

Persists canonical conversations beneath `.flect/sessions` and contributes
`/new`, `/sessions`, `/resume`, `/fork`, `/rename`, and `/session`.

The store uses versioned JSONL, optimistic sequence checks, atomic indexes, and
cross-process lock diagnostics. `flect sessions` supports list, show, export,
confirmed delete, and explicit index repair. `/sessions` is an arrow-key picker.
Optional per-assistant usage is stored beside each response, allowing display
plugins to reconstruct inline token/cache/cost annotations after resume.
Envelope fingerprints, runtime-context snapshots, tool-result pruning, and
compaction checkpoints are additive JSONL records; the original conversation
records are never rewritten by those model-surface operations.
