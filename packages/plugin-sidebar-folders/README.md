# @flect/plugin-sidebar-folders

Shows primary, additional, read-only, and unavailable workspace roots in
Flect's composable sidebar. Selecting the section opens `/folders status`.

```json
{ "use": "@flect/plugin-sidebar-folders" }
```

This package only presents data from the public workspace service. It neither
owns folder state nor depends on the default sidebar compositor, so another UI
or a higher-priority section can replace it independently.
