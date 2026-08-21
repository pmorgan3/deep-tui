# @deep-tui/plugin-git

Adds bounded, read-only `git_status`, `git_diff`, `git_log`, and `git_show`
tools. Commands are spawned with an argument array, never a shell, with pagers,
colors, external diffs, and interactive prompting disabled.

Each tool accepts an optional workspace-relative `cwd`, so repositories mounted
through the multi-root workspace plugin can be inspected without escaping the
configured workspace. Diff and show output is size- and time-bounded.

```json
{
  "use": "@deep-tui/plugin-git",
  "config": { "timeoutMs": 10000, "maxOutputBytes": 2000000 }
}
```

The plugin deliberately does not add commit, checkout, reset, clean, or push
operations. Those have materially different permission and confirmation needs.
