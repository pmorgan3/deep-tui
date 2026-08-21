# Packaging and releases

Deep TUI's first distribution target is npm. `@deep-tui/cli` owns the `deep-tui`
executable, while the SDK, runtime, and first-party features remain ordinary
`@deep-tui/*` packages so users can compose only the pieces they want.

## Release shape

- Node.js 22 or newer is the supported runtime.
- Public packages use ESM and publish compiled `dist` output.
- Internal `workspace:*` relationships are rewritten by pnpm to released
  package versions when tarballs are built.
- Workspace packages are versioned independently, so a release only republishes
  packages whose manifest version changed.
- A source release must pass `pnpm check` and `pnpm pack:check` before publish.

The `@deep-tui` npm scope and trusted-publishing configuration are secured.

## Release process

1. Bump the version only in each public package that should be released.
2. Confirm every changed tarball contains its compiled entry, declarations, README,
   and MIT license.
3. Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm pack:check` on
   Node.js 22.
4. Push the version changes to `main`. The npm workflow compares package
   manifests with the pre-push commit and publishes only packages whose version
   changed, in dependency order, with the `latest` distribution tag.
5. Use the manual workflow dispatch for a dry run or an alternate distribution
   tag. A real manual run still skips versions that already exist on npm.

Binary releases and a searchable plugin index are later milestones. GitHub URL
plugins deliberately do not depend on that index: a URL in user configuration
is enough to bootstrap a plugin today.
