# @flect/plugin-workspace-local

Safe single-root local filesystem provider for Flect's generic workspace
service. It enforces lexical and realpath containment, refuses absolute and
traversal paths, and never follows directory symlinks.

```json
{ "use": "@flect/plugin-workspace-local" }
```

It is the default low-priority fallback. A higher-priority provider such as
`@flect/plugin-workspace-multi-root` can take over every workspace-aware tool
and fall back to this provider cleanly when unloaded.
