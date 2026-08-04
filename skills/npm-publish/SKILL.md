---
name: npm-publish
description: Publish the current package to the npm registry through the keybridge WebAuthn bridge, and configure npm trusted publishing (GitHub Actions OIDC) for packages that already exist. Use whenever the user asks to publish, release, or ship a new version to npm, or to let CI publish a package.
---

# Publishing to npm via keybridge

npm requires human WebAuthn verification (security key or Touch ID) for
publishing. This project routes publishes through the gated `keybridge`
bridge - never run `npm publish` directly in Bash (a hook will deny it).

## Steps

1. If the user asked for a version bump, update the version first
   (`npm version <major|minor|patch|x.y.z> --no-git-tag-version`, or edit
   package.json), and confirm the changelog/state is what they want shipped.
2. **When it matters which npm account publishes** (the user named one, or
   the package belongs to a specific owner/org): call `NpmStatus` (server:
   `keybridge`) - it is read-only and instant. If the current user is wrong,
   call `NpmSwitchAccount` with the target username (the user approves via
   Touch ID; a first-time account opens a window for its password once).
   Then pass `user: "<username>"` to `NpmPublish` so the publish fails fast
   rather than shipping under the wrong account.
3. Optionally validate with the `NpmPublish` tool using `dryRun: true`.
4. Call the `NpmPublish` MCP tool (server: `keybridge`). Pass `tag` /
   `access` only when the user asked for non-defaults.
5. Tell the user what to expect: on macOS the ceremony runs in an invisible
   windowless WKWebView, so the **only** visible step is the Touch ID prompt
   (on other platforms a browser tab opens instead). The tool blocks until
   they approve (5 minute timeout). If keybridge was never set up on this
   machine, run `/keybridge:setup` first.
6. Report the result: package id, version, and the account it ran as
   (`user` in the tool output) on success; on failure, relay the npm error
   summary.

## Monorepos and pnpm workspaces

keybridge detects the project's package manager per package. A pnpm project is
packed with `pnpm pack` first - so `workspace:*` and `catalog:` dependencies
become real versions - and npm publishes that tarball; the tool reports which
packer ran as `packedWith`. Nothing to configure, but:

- **`pnpm install` must have run**, or the pack fails with
  `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`.
- `packageManager: "npm"` forces the plain path. Only do that when the package
  provably has no `workspace:`/`catalog:` dependencies - otherwise those
  strings are published verbatim and every consumer breaks.
- Publish **in dependency order** (leaf packages first), so each package's
  deps already exist on the registry when it lands.
- Only the first publish of a chain needs a touch: the ceremony opts into
  npm's 5-minute cooldown, so the rest go through untouched while it lasts.
  Keep going package by package rather than batching, and re-check
  `usedWebAuth` in the output if you want to know whether a touch happened.

## Trusted publishing (moving releases into CI)

After the **first** publish of a new package name, offer to configure npm
trusted publishing so future releases can come from GitHub Actions without a
token. That first publish is the natural moment: npm only lets a package that
already exists on the registry be configured, so it cannot happen earlier -
and after the second release nobody thinks of it again.

Use the `NpmTrust` MCP tool (server: `keybridge`):

- Pass **every** package in one call. npm grants a 5-minute 2FA amnesty after
  the first approval, so a whole repo costs one or two touches; one call per
  package costs one touch each.
- `repository` is `owner/repo` of the repo whose workflow publishes, and
  `workflow` is the bare filename (`publish.yml`), never a path. Add
  `environment` only if the workflow job actually declares one - a mismatch
  makes OIDC fail later, at publish time, where it is much harder to diagnose.
- Read the result: `configured` / `failed` / `skipped` are separate. A
  `skipped` package is usually one that was never published; `failed` carries
  the registry's own message.
- Re-running **appends** a second config rather than updating the first, so do
  not retry blindly on a partial result - the outcome reports exactly which
  packages already landed.
- Confirm with the user before configuring: this hands standing publish rights
  to anyone who can write to that repo.

## Notes

- The tool shows an approval card in Claude Code on every call - that is
  intentional (hardened by default). The user's WebAuthn touch is a second,
  non-bypassable gate.
- Publishes only work from the project root (or a subdirectory passed as
  `cwd`); the registry and auth come from the project's npm configuration.
- `npm whoami` is the identity source of truth; keybridge keeps a separate
  browser profile per npm account, so switching accounts never destroys the
  other account's session. If `NpmPublish` fails with `ENOKEY`, the current
  account has no keybridge security key - the user needs to run
  `keybridge enroll` (see `/keybridge:setup`).
