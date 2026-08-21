# Packaging and releases

Flect's first distribution target is npm. `@flect/cli` owns the `flect`
executable, while the SDK, runtime, and first-party features remain ordinary
`@flect/*` packages so users can compose only the pieces they want.

## Release shape

- Node.js 22 or newer is the supported runtime.
- Public packages use ESM and publish compiled `dist` output.
- Internal `workspace:*` relationships are rewritten by pnpm to released
  package versions when tarballs are built.
- The first release should version the workspace packages together. Independent
  package versioning can wait until the SDK compatibility policy is stable.
- A source release must pass `pnpm check` and `pnpm pack:check` before publish.

The repository intentionally remains at version `0.0.0` until the `@flect` npm
scope, GitHub organization, and name clearance called out in
[`naming.md`](naming.md) are secured. Do not publish placeholder `0.0.0`
artifacts to the public registry.

## Initial release checklist

1. Secure the npm scope and repository identity.
2. Choose the first pre-1.0 version and apply it consistently to every public
   workspace package.
3. Confirm every tarball contains its compiled entry, declarations, README,
   and MIT license.
4. Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm pack:check` on
   Node.js 22.
5. Inspect the CLI tarball and test installing it into an empty temporary
   project before publishing dependencies in topological order.
6. Tag the exact commit only after the registry publish succeeds.

Binary releases and a searchable plugin index are later milestones. GitHub URL
plugins deliberately do not depend on that index: a URL in user configuration
is enough to bootstrap a plugin today.
