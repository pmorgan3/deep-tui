# @flect/plugin-workspace-ignore

Filters `workspace.walk()` results with nested ignore files, so `list_files`,
`find_files`, and `search_text` share the same view of the workspace. It wraps
the active workspace provider and leaves path resolution unchanged.

By default it reads `.gitignore`, `.ignore`, and the primary repository's
`.git/info/exclude`. Rules are evaluated in file order, nested files override
parent files, negation is supported, and traversal remains bounded even when
most scanned entries are ignored.

```json
{
  "use": "@flect/plugin-workspace-ignore",
  "config": {
    "files": [".gitignore", ".ignore", ".flectignore"],
    "includeGitInfoExclude": true,
    "scanFactor": 20
  }
}
```

This plugin filters discovery; it does not deny direct `read_file` access to an
ignored path. Workspace containment and permissions remain the security
boundary.
