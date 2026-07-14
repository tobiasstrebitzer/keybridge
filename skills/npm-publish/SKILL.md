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
2. Optionally validate with the `NpmPublish` tool using `dryRun: true`.
3. Call the `NpmPublish` MCP tool (server: `keybridge`). Pass `tag` /
   `access` only when the user asked for non-defaults.
4. Tell the user what to expect: on macOS the ceremony runs in an invisible
   off-screen Chrome, so the **only** visible step is the Touch ID / security
   key prompt (on other platforms a browser tab opens instead). The tool
   blocks until they approve (5 minute timeout).
5. Report the result: package id and version on success; on failure, relay
   the npm error summary.

## Notes

- The tool shows an approval card in Claude Code on every call - that is
  intentional (hardened by default). The user's WebAuthn touch is a second,
  non-bypassable gate.
- Publishes only work from the project root (or a subdirectory passed as
  `cwd`); the registry and auth come from the project's npm configuration.
