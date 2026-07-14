---
name: npm-publish
description: Publish the current package to the npm registry through the keybridge WebAuthn bridge. Use whenever the user asks to publish, release, or ship a new version to npm.
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
