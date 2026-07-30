<div align="center">

<img src="https://raw.githubusercontent.com/tobiasstrebitzer/keybridge/master/docs/teaser.svg" alt="keybridge: the agent runs npm publish, you approve with Touch ID" width="820">

# keybridge

**Publish to npm with nothing but a Touch ID tap - including from agents.**

The agent initiates. **You** approve. Nothing else is ever on screen.

![macOS](https://img.shields.io/badge/macOS-Secure_Enclave-black?logo=apple)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-5FA04E?logo=nodedotjs&logoColor=white)
![WebAuthn](https://img.shields.io/badge/WebAuthn-passkey-3423A6)
![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

```
$ npx keybridge publish
· publishing as tstrebitzer
· running npm publish ...
· npm requires human publish verification - presenting via webkit
  → touch your security key / Touch ID to approve      👆 (the only visible step)
✓ published my-package@1.2.3
```

## Quickstart

Requires macOS with Node ≥ 22.18 and the Xcode Command Line Tools
(`xcode-select --install`). The first two commands are one-time; the native
helpers compile automatically on first use (`npx keybridge setup` runs it
explicitly, and `npm install -g keybridge` works if you prefer a global bin).

```sh
npx keybridge login      # sign in to npmjs.com once, in the keybridge sheet
npx keybridge enroll     # add the keybridge security key to your account (Touch ID)

npx keybridge publish    # from now on, every publish is just this 👆
```

### Set up with Claude

Using Claude Code? Two steps:

```sh
claude plugin marketplace add tobiasstrebitzer/keybridge
claude plugin install keybridge@keybridge
```

Then run **`/keybridge:setup`** inside Claude Code - it checks the
prerequisites, compiles the native helpers, and walks you through the
one-time npm login + passkey enrollment. From then on, asking Claude to
"publish this package" is: approval card → Touch ID → published.

The plugin bundles the [MCP tools](#mcp-tools-claude-code) below, a
`PreToolUse` hook that blocks raw `npm/pnpm/yarn publish` in Bash, and the
`/keybridge:setup` + `/keybridge:npm-publish` skills.

> [!IMPORTANT]
> **Already have a security key / passkey on your npm account?** Right after
> the password step, npm will ask you to verify with it - but inside the
> keybridge window that key is unreachable (WebAuthn there is wired to
> keybridge's own signer; hardware keys and iCloud passkeys don't work in it).
> Use npm's fallback on that screen instead: **"Use a recovery code"**, then
> continue with `keybridge enroll`. You do **not** need to remove your
> existing key - npm supports multiple keys, keybridge answers publish
> ceremonies with its own, and your other key keeps working in your normal
> browser.
>
> No recovery codes at hand? Then avoid the prompt entirely: in your normal
> browser, temporarily remove the old security key (*Settings → Two-Factor
> Authentication*), run `keybridge login` (password only now) and
> `keybridge enroll`, and re-add your old key afterwards.

## Why

npm requires a web-based WebAuthn ceremony for interactive publishes on a
2FA-protected account (classic tokens revoked Dec 2025, new TOTP setups
disabled and existing ones being phased out, bypass-2FA tokens losing direct
publish rights ~Jan 2027).
Run non-interactively - in CI-less local automation, or by an agent like Claude
Code - `npm publish` just dies with `EOTP`. keybridge picks up npm's own
machine-readable hand-off (`authUrl`/`doneUrl`/`--otp`, npm CLI ≥ 11.9), drives
the verification page in an **invisible, windowless WKWebView**, and answers the
WebAuthn ceremony from a **Secure Enclave key that only signs after Touch ID**.

The human touch is the point: keybridge automates everything *around* the
ceremony, never the ceremony itself.

**macOS only** (Secure Enclave + WKWebView). On other platforms the ceremony
falls back to your default browser.

## Highlights

- **Invisible ceremony** - no browser window, no focus steal; the Touch ID
  prompt is the only visible step. Password logins (once per account) appear
  in a compact bottom-center sheet, username prefilled, password focused.
- **Hardware-gated** - the passkey lives in the Secure Enclave,
  non-extractable; every signature requires your touch. No touch, no publish.
- **Self-describing approvals** - the Touch ID dialog names exactly what it
  authorizes ("KeyBridge" is trying to **publish mypkg@1.2.3 to npm as
  youruser**), so concurrent publishes from multi-agent sessions can never be
  confused.
- **One touch per 5 minutes for bulk publishes** - keybridge ticks npm's
  "don't challenge again for 5 minutes" option during the ceremony; a chain
  of related packages published back-to-back needs a single approval.
- **Identity-aware** - `npm whoami` drives everything. Per-account browser
  profiles, instant account switching via a token vault, and publishes that
  can be pinned to (or mediated as) a specific account.
- **Agent-safe** - typed MCP tools with no flag injection, a hook that blocks
  raw `npm publish` in Bash, and fail-fast errors instead of silent hangs
  when something can't work.

## Usage

```sh
keybridge publish                    # npm publish + Touch ID ceremony
keybridge publish -- --tag beta      # everything after -- goes to npm publish
keybridge publish --user tstrebitzer # this account, or fail fast / mediate
keybridge login                      # just the web-login ceremony (~12 h session)
keybridge status                     # who am I, which accounts/keys/tokens exist
keybridge publish --presenter browser  # force the default-browser fallback
keybridge logs                       # tail the persistent ceremony diagnostics
```

Expired sessions are handled automatically: a publish that hits `E401` runs the
web-login ceremony first (one extra touch), persists the token to your npmrc,
then completes the publish.

Publishing several packages in sequence needs only the first touch: the
ceremony opts into npm's 5-minute cooldown, so follow-up publishes inside the
window complete with no ceremony at all.

Every ceremony stage (shell, page status, WebAuthn, Touch ID helper) appends
structured diagnostics to `~/.keybridge/logs/` - `keybridge logs` tails them.
That is the place to look when a ceremony seems to hang or Touch ID never
appears, especially through the MCP tools (MCP hosts silently drop the
server's stderr). For deeper debugging there are `KEYBRIDGE_SE_DEBUG=1`
(traces the Touch ID helper to stderr), `KEYBRIDGE_CAPTURE_DOM=1` (snapshots
every auth-page state to `~/.keybridge/captures/`), and
`scripts/debug-touchid.sh` (reproduces a chain of Touch ID prompts without
npm).

## Accounts

`npm whoami` is keybridge's source of truth: every publish and login is keyed
to whatever account the npm CLI is authenticated as, and keybridge's local
state (browser profiles, enrolled keys, active account) re-syncs to it after
every login. Each npm account gets its **own browser profile** (a dedicated
`WKWebsiteDataStore`), so switching accounts never destroys another account's
web session - and each account needs its own `keybridge enroll` once.

```sh
keybridge status               # identity overview + divergence warnings (alias: whoami)
keybridge switch <username>    # change accounts: stored token -> instant, zero touch;
                               # live web session -> just Touch ID;
                               # first time -> the sheet asks for that password once
keybridge token ls             # per-account token vault (see below)
keybridge token set <username> # park a granular access token for an account
keybridge logout               # revoke the npm session token (profile survives,
                               # so logging back in stays silent)
keybridge logout --web         # ...and delete the account's browser profile too
keybridge open [url]           # surfaced keybridge window on the current account's
                               # profile (manage npm settings, recovery codes, ...)
```

**All accounts stay signed in.** Every login stores its token in a
per-account vault (`~/.keybridge/tokens.json`, mode 0600 - the same
protection as `~/.npmrc`, where npm keeps the live token in plaintext
anyway). While a stored token works, `keybridge switch` is instant and
`keybridge publish --user <name>` doesn't even switch: the publish runs with
that account's token injected per-invocation (npm env override) and its own
browser profile, leaving your CLI session untouched. Web-login tokens expire
after ~12h; for months-long instant switching, park a **granular access
token** per account with `keybridge token set <username>` (create it
*without* "bypass 2FA" - every publish still requires your touch). Dead
tokens are validated before use and evicted automatically, falling back to
the normal ceremony.

Things keybridge protects you from:

- **Publishing as the wrong account**: `keybridge publish --user <name>` (or
  the `user` input on the `NpmPublish` tool) aborts before anything is
  published if `npm whoami` disagrees and no stored token can mediate.
- **A ceremony that can never complete**: if the current account has no
  keybridge security key (e.g. freshly switched, never enrolled), the publish
  fails immediately with `ENOKEY`/`ENOCRED` and tells you to run
  `keybridge enroll` - instead of hanging until the 5-minute timeout.
- **Session confusion after switching**: the account you actually logged in
  as (per `npm whoami`) always wins - even if you signed in as someone
  unexpected in the window, the local bindings follow reality and you get a
  clear error, not silently corrupted state.

Note the keybridge passkey exists **only inside keybridge**: it is not in
iCloud Keychain or any browser, so npmjs.com in your normal browser will
never "detect" it. That's by design - use `keybridge open` for account
chores, or keep a recovery code / second passkey for regular-browser access.

## MCP tools (Claude Code)

`.mcp.json` in your project (the plugin configures this for you):

```json
{
  "mcpServers": {
    "keybridge": { "command": "npx", "args": ["-y", "-p", "keybridge", "keybridge-mcp"] }
  }
}
```

All tools take typed inputs only - no free-form flag injection; the model
sees small structured results, never a browser.

| Tool | What it does |
| --- | --- |
| `NpmStatus` | Read-only identity report: current user, known accounts, keys, tokens, warnings. Agents call this first. |
| `NpmSwitchAccount` | Change npm accounts (whoami-verified; instant when a stored token works; no-op when already correct). |
| `NpmLogin` | Pre-authenticate the current/last-active account (~12 h session token). |
| `NpmPublish` | The publish: `tag`, `access`, `dryRun`, `cwd`, and optional `user` to pin the account - mediated via that account's stored token when the CLI is someone else, failing fast otherwise. |

The agent flow when the target account matters:
`NpmStatus` → (wrong user? `NpmSwitchAccount`) → `NpmPublish { user }`.

## How it works

```
npm publish --json        fails with {"error":{"code":"EOTP","authUrl":…,"doneUrl":…}}
  └─ keybridge:
     1. opens authUrl in a windowless WKWebView   (nothing on screen)
     2. auto-clicks "Use security key"            (npm's real page JS)
     3. the page's navigator.credentials.get() is intercepted by an injected
        script and answered by keybridge's Secure Enclave signer → Touch ID 👆
     4. polls doneUrl until it returns the one-time token
     5. re-runs npm publish --otp=<token>
```

Why a browser engine at all? `www.npmjs.com` sits behind Cloudflare bot
management - a pure HTTP client is blocked before npm's auth layer is even
reached. A real WebKit view passes cleanly (no challenge, even on a cold
profile) and drives npm's real page JS, so nothing private is reverse-
engineered. The WKWebView is never attached to a window: there is nothing to
see, animate, or focus-steal. A window is created only if npm needs a password
login (first run per account / expired website session) - a compact,
non-activating bottom sheet that follows the system light/dark mode, prefills
the username, and never steals your app focus - then never again; cookies
persist in a per-account `WKWebsiteDataStore`.

The signing key is generated **in the Secure Enclave**, is non-extractable, and
every signature requires Touch ID via LocalAuthentication. The injected script
uses the same `navigator.credentials` interception technique as password
managers (Bitwarden, 1Password), including their fallback: if keybridge has no
credential for a site, the ceremony is handed to the real authenticator.

## Security model

Two independent gates:

1. **Agent permission gate** - `NpmPublish` is a normal MCP tool, so Claude
   Code's per-project permissions control whether the agent may *attempt* a
   publish. Tool inputs are typed; `cwd` cannot escape the project root. The
   Bash side-channel (`npm publish`) is closed by the plugin hook.
2. **WebAuthn user presence** - npm's server demands a fresh assertion from
   your enrolled authenticator, and keybridge's authenticator only signs after
   Touch ID. No touch, no publish. This gate cannot be whitelisted, delegated,
   or scripted away - it is the real security boundary.

> [!WARNING]
> Gate 2 only exists when your npm account's 2FA level is
> **"auth-and-writes"** (require 2FA for writes). On **"auth-only"** accounts
> npm publishes with the session token alone - no touch, no ceremony, and
> nothing keybridge can do about it server-side. keybridge detects this and
> warns on `keybridge status`, `NpmStatus`, and every publish; switch the
> level under *npmjs.com → Settings → Two-Factor Authentication*
> (`keybridge open` takes you there).

Local state lives in `~/.keybridge/`: `credentials.json` (public key metadata;
private keys stay in the Secure Enclave), `accounts.json` (npm username →
browser-profile binding), `tokens.json` (per-account npm tokens, mode 0600 -
equivalent in sensitivity to `~/.npmrc`), the two compiled helpers, and
`config.json`.

## Development

```sh
pnpm install
pnpm check     # tsc --noEmit + oxlint + node --test (native TS, Node ≥ 22.18)
pnpm build     # tsdown: src/ → dist/ (what the published package ships)
```

From a source checkout, `node src/cli.ts` works in place of the installed
`keybridge` bin - Node ≥ 22.18 runs the TypeScript directly.

Layout: `src/engine.ts` (npm publish/login orchestration), `src/accounts.ts`
(the identity layer: whoami-driven account/profile/credential bindings) +
`src/tokens.ts` (per-account token vault), `src/presenters/webkit.ts` (drives
the shell) + `browser.ts` (fallback), `src/webauthn.ts` + `src/signer.ts` +
`src/cbor.ts` (the authenticator), `src/setup.ts`, `src/cli.ts`,
`src/server.ts` (MCP), `src/actions/` (silkweave tool definitions); `native/`
holds the two Swift helpers (`WebShell.swift` - windowless WKWebView shell,
`SecureEnclaveSigner.swift` - built as `KeyBridge`, which titles the
Touch ID dialog) and `inject.js` (the page-world `navigator.credentials`
override).

Tests run against a mock registry that reproduces npmjs.com's exact CLI
contract (401 + `www-authenticate: OTP`, `202`/`retry-after` polling,
`200 {token}`, `npm-otp` retry header), a fake ceremony shell, and the real
crypto (assertions are verified RP-style against the registered COSE key).

Environment overrides: `KEYBRIDGE_PRESENTER=webkit|browser`,
`KEYBRIDGE_BACKEND=secure-enclave|software`, `KEYBRIDGE_WEBSHELL=<binary>`,
`KEYBRIDGE_APPEARANCE=dark|light` (window + `prefers-color-scheme`; default:
follow the system).

<details>
<summary><b>npm 11.x caveat</b></summary>

npm 11.9.0 - 11.14.x redact the session ids in their `--json` error output
(`authUrl` arrives as `…/auth/cli/***`; fixed in 11.15.0; before 11.9 the URLs
are missing entirely). keybridge detects this and transparently
mints its own web-auth session (a metadata-only `PUT` with
`npm-auth-type: web`), which returns unredacted URLs - verified against
registry.npmjs.org.

</details>

## Status

Validated end-to-end against npm production (enroll, login, publish - real
Touch ID, invisible ceremony) on 2026-07-14. Not affiliated with npm/GitHub;
uses npm's public CLI hand-off contract, no private APIs.

**AI disclosure:** Claude Code (Anthropic) contributed substantially to this
repository. All code has been human-reviewed, and the security-relevant
behavior - key handling, WebAuthn assembly, the publish flow - has been
human-verified end-to-end against npm production.

MIT
