# @deep-tui/plugin-audit-jsonl

Writes redacted audit events to daily `.deep-tui/audit/YYYY-MM-DD.jsonl` files and
adds `/audit` plus the headless `audit` command.

Files rotate by size, can carry a SHA-256 hash chain for truncation/reordering
detection, tolerate only an incomplete crash tail, and support explicit
retention pruning. The chain is tamper-evidence, not a security boundary.
