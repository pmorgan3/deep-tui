# @deep-tui/plugin-workspace-multi-root

Mount additional local folders into one Deep TUI workspace. Primary paths remain
unchanged; extra roots use `@alias/path` consistently in file, search, patch,
and process tools.

```json
{
  "use": "@deep-tui/plugin-workspace-multi-root",
  "config": {
    "folders": [
      { "alias": "api", "path": "../api" },
      { "alias": "docs", "path": "../docs", "access": "read-only" }
    ]
  }
}
```

Manage runtime mounts with one command:

```sh
deep-tui folders add ../web web
deep-tui folders add ../reference docs --read-only
deep-tui folders list
deep-tui folders remove web
```

The TUI equivalents are `/folders add`, `/folders status`, and `/folders
remove`. Runtime additions persist per primary project in
`.deep-tui/folders.json`; configured folders cannot be removed at runtime. Missing
folders remain registered as unavailable. Nested/overlapping roots, traversal,
absolute tool paths, and symlink escapes are rejected.

Options are `folders`, `persist` (default `true`), `stateFile`, `maxEntries`,
and `ignoredDirectories`. This package deliberately exposes no model-callable
tool for changing the set of trusted roots.
