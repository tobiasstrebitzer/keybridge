---
name: setup
description: Set up the keybridge npm Touch ID bridge on this Mac - compile the native helpers, log in to npm, and enroll the keybridge passkey. Use when the user asks to set up or configure keybridge, or when NpmPublish/NpmLogin fail because setup hasn't been done yet.
---

# keybridge setup (guided)

Walk the user from a fresh plugin install to invisible Touch ID publishes.
Everything below runs locally; the only account interaction is one login to
npmjs.com and adding a security key there.

**The keybridge CLI:** this skill lives at `<plugin>/skills/setup/`, so the
plugin root is two directories up from this skill's base directory. Run the
CLI through the bundled launcher (it self-installs its dependencies on first
run):

```sh
<plugin-root>/scripts/keybridge.sh <setup|login|publish> [args...]
```

(In a source checkout of the keybridge repo, `node src/cli.ts` works too.)

## 1. Preflight

Check, and tell the user what's missing rather than failing cryptically:

- `uname` is `Darwin` - keybridge needs macOS (Secure Enclave + WKWebView).
- `node --version` is >= 22.18 (native TypeScript execution).
- `npm --version` is >= 12 - a hard requirement, keybridge refuses to run
  below it. Have the user run `npm install -g npm@latest`. (pnpm projects
  also need pnpm >= 11 for the pack path.)
- `xcode-select -p` succeeds - otherwise have the user run
  `xcode-select --install` and wait for it to finish.

## 2. Compile the native helpers

```sh
<plugin-root>/scripts/keybridge.sh setup
```

Builds two small Swift binaries into `~/.keybridge/` (Secure Enclave signer +
the windowless WKWebView ceremony shell) and probes the Enclave. Expect
`backend: secure-enclave` on Apple Silicon / T2 Macs. If it reports the
software fallback, tell the user - publishes would not be Touch ID-gated.

## 3. First login + passkey enrollment (one-time, interactive)

Explain to the user BEFORE starting what will happen, then start the login.

**Use the `NpmLogin` MCP tool (server: `keybridge`) - do NOT run the login
through the Bash tool.** The login waits minutes for a human and must open a
window; Bash-tool invocations run sandboxed with a short default timeout, and
a window surfaced from that context may never reach the user. The MCP server
is a regular process, so its ceremony window works. If the tool call isn't
possible, have the USER run this in their own terminal instead (in Claude
Code, prefixing with `!` works):

```sh
<plugin-root>/scripts/keybridge.sh login
```

- A **keybridge window opens** (first run only): the user logs in to
  npmjs.com with their password. On an account without 2FA the ceremony
  completes right after the password and the window closes - that's normal.
- **If npm asks them to verify with an existing security key or passkey**:
  that key cannot work inside the keybridge window - tell the user to click
  npm's **"Use a recovery code"** fallback on that screen instead. (No
  recovery codes? They can temporarily remove the old security key from their
  normal browser first, and re-add it after enrollment.)

## 4. Enroll the keybridge security key (one-time, interactive)

Skip this if `~/.keybridge/credentials.json` already has an `npmjs.com`
credential. Otherwise have the USER run this in their own terminal (it opens
a window on npm's 2FA settings and waits for the enrollment):

```sh
<plugin-root>/scripts/keybridge.sh enroll
```

In the window: *Add security key* → name it (e.g. "keybridge") → **Touch
ID**. The command exits with `✓ enrolled` once the credential lands.
Existing keys keep working; npm supports multiple.

## 5. Verify

- Call the `NpmStatus` MCP tool (or `<plugin-root>/scripts/keybridge.sh
  status`): it must show the logged-in user with at least one security key
  and no warnings.
- Call the `NpmPublish` MCP tool with `dryRun: true` in a publishable
  project - validates packaging with no ceremony.
- Optionally do a real publish (`NpmPublish`, or `/keybridge:npm-publish`):
  the only visible step must be the Touch ID dialog.

## Multiple npm accounts

Each npm account gets its own keybridge browser profile, keyed by `npm
whoami`. `keybridge switch <username>` (or the `NpmSwitchAccount` MCP tool)
changes accounts; a first-time account asks for its password once, after
that switching is just a Touch ID tap - or instant while a stored token for
the account is still valid (every login stores one; ~12h). For long-lived
instant switching the user can park a granular access token per account
(`keybridge token set <username>`; create it WITHOUT "bypass 2FA"). With a
stored token, `NpmPublish { user }` can even publish as another account
without switching the CLI session at all. Each account also needs its own
`keybridge enroll` (step 4) - `keybridge status` / `NpmStatus` shows which
accounts have keys and tokens.

## Troubleshooting

- **Notifications appear but no window shows up**: the ceremony ran in a
  context that can't display windows (e.g. a sandboxed shell). Have the user
  run `<plugin-root>/scripts/keybridge.sh login` in their own terminal, or
  retry via the `NpmLogin` MCP tool. If the helpers predate the current
  plugin version, re-run step 2 first (rebuilds the shell).
- **Ceremony stalls, Touch ID never appears**: have the user run
  `<plugin-root>/scripts/keybridge.sh login --presenter browser` in their
  terminal to do the ceremony in the default browser and confirm account
  state; also check that `~/.keybridge/keybridge-webshell` exists (re-run
  step 2).
- **`npm session expired`** mid-publish is normal after ~12 h: keybridge
  re-runs login automatically (one extra touch). To avoid it, the user can
  put a granular npm access token *without* "bypass 2FA" in `~/.npmrc`.
- **Publish fails with `ENOKEY` or `ENOCRED`**: the current npm account
  (`npm whoami`) has no keybridge security key - run step 4 for it. This
  happens after switching to an account that never enrolled.
- State lives in `~/.keybridge/` (helpers, `credentials.json`,
  `accounts.json`, `config.json`); deleting that directory and re-running
  this skill resets everything except the passkey on the npm account (remove
  that under *Settings → Two-Factor Authentication*).
