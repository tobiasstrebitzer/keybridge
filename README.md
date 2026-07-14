# keybridge

Publish to npm with nothing but a Touch ID tap — including from agents.

```
$ keybridge publish
· running npm publish ...
· npm requires human publish verification — presenting via webkit
  → touch your security key / Touch ID to approve      👆 (the only visible step)
✓ published my-package@1.2.3
```

npm requires web-based WebAuthn verification for every publish (classic tokens
revoked Dec 2025, TOTP gone, bypass-2FA tokens losing publish rights ~Jan 2027).
Run non-interactively — in CI-less local automation, or by an agent like Claude
Code — `npm publish` just dies with `EOTP`. keybridge picks up npm's own
machine-readable hand-off (`authUrl`/`doneUrl`/`--otp`, npm CLI ≥ 11.6), drives
the verification page in an **invisible, windowless WKWebView**, and answers the
WebAuthn ceremony from a **Secure Enclave key that only signs after Touch ID**.

The human touch is the point: keybridge automates everything *around* the
ceremony, never the ceremony itself. The agent initiates; **you** approve.

**macOS only** (Secure Enclave + WKWebView). On other platforms the ceremony
falls back to your default browser.

## Install

Requires macOS with Node ≥ 22.18 and the Xcode Command Line Tools
(`xcode-select --install`).

```sh
npm install -g keybridge     # or: git clone …/keybridge && cd keybridge && pnpm install
keybridge setup              # compiles the two tiny Swift helpers into ~/.keybridge
```

(From a source checkout, `node src/cli.ts` works in place of `keybridge` —
Node ≥ 22.18 runs the TypeScript directly.)

Then enroll and log in once:

1. **Enroll the keybridge passkey on your npm account** — run
   `keybridge login`: a window opens the first time so you can sign in to
   npmjs.com; go to *Settings → Two-Factor Authentication → Add security key*
   in that window, and approve with Touch ID. (keybridge registers its own
   Secure Enclave passkey — your existing security keys keep working.)
2. Every publish after that is invisible: `keybridge publish` → Touch ID → done.

> **Already have a security key / passkey on your npm account?** Right after
> the password step, npm will ask you to verify with it — but inside the
> keybridge window that key is unreachable (WebAuthn there is wired to
> keybridge's own signer; hardware keys and iCloud passkeys don't work in it).
> Use npm's fallback on that screen instead: **"Use a recovery code"**. Once
> you're in, add the keybridge security key under *Settings → Two-Factor
> Authentication* as in step 1. You do **not** need to remove your existing
> key — npm supports multiple keys, keybridge answers publish ceremonies with
> its own, and your other key keeps working in your normal browser.
>
> No recovery codes at hand? Then avoid the prompt entirely: in your normal
> browser, temporarily remove the old security key (*Settings → Two-Factor
> Authentication*), run `keybridge login` (password only now), enroll the
> keybridge key, and re-add your old key afterwards.

## Usage

```sh
keybridge publish                    # npm publish + Touch ID ceremony
keybridge publish -- --tag beta      # everything after -- goes to npm publish
keybridge login                      # just the web-login ceremony (~12 h session)
keybridge publish --presenter browser  # force the default-browser fallback
```

Expired sessions are handled automatically: a publish that hits `E401` runs the
web-login ceremony first (one extra touch), persists the token to your npmrc,
then completes the publish.

**Tip — skip the 12-hour re-login cycle:** create a granular access token
*without* "bypass 2FA" (Settings → Access Tokens): up to 90 days, package-
scoped, and every publish still requires your touch. Put it in `~/.npmrc` as
`//registry.npmjs.org/:_authToken=npm_…`. Avoid bypass-2FA tokens — they remove
the human gate.

### Claude Code — MCP server

`.mcp.json` in your project:

```json
{
  "mcpServers": {
    "keybridge": { "command": "npx", "args": ["keybridge-mcp"] }
  }
}
```

Claude gets two tools, `NpmPublish` and `NpmLogin`, with typed inputs only
(`tag`, `access`, `dryRun`, `cwd`) — no free-form flag injection. The model
sees a small structured result, never a browser.

### Claude Code — plugin

This repo is also a Claude Code plugin (`claude --plugin-dir /path/to/keybridge`):
the MCP server, a `PreToolUse` hook that denies raw `npm/pnpm/yarn publish` in
Bash (steering Claude to the gated tool), and an `npm-publish` skill.

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
management — a pure HTTP client is blocked before npm's auth layer is even
reached. A real WebKit view passes cleanly (no challenge, even on a cold
profile) and drives npm's real page JS, so nothing private is reverse-
engineered. The WKWebView is never attached to a window: there is nothing to
see, animate, or focus-steal. A window is created only if npm needs a password
login (first run / expired website session), then never again — cookies persist
in a dedicated `WKWebsiteDataStore`.

The signing key is generated **in the Secure Enclave**, is non-extractable, and
every signature requires Touch ID via LocalAuthentication. The injected script
uses the same `navigator.credentials` interception technique as password
managers (Bitwarden, 1Password), including their fallback: if keybridge has no
credential for a site, the ceremony is handed to the real authenticator.

## Security model

Two independent gates:

1. **Agent permission gate** — `NpmPublish` is a normal MCP tool, so Claude
   Code's per-project permissions control whether the agent may *attempt* a
   publish. Tool inputs are typed; `cwd` cannot escape the project root. The
   Bash side-channel (`npm publish`) is closed by the plugin hook.
2. **WebAuthn user presence** — npm's server demands a fresh assertion from
   your enrolled authenticator, and keybridge's authenticator only signs after
   Touch ID. No touch, no publish. This gate cannot be whitelisted, delegated,
   or scripted away — it is the real security boundary.

Local state lives in `~/.keybridge/`: `credentials.json` (public key metadata;
private keys stay in the Secure Enclave), the two compiled helpers, and
`config.json`.

## Development

```sh
pnpm install
pnpm check     # tsc --noEmit + oxlint + node --test (native TS, Node ≥ 22.18)
pnpm build     # tsdown: src/ → dist/ (what the published package ships)
```

Layout: `src/engine.ts` (npm publish/login orchestration),
`src/presenters/webkit.ts` (drives the shell) + `browser.ts` (fallback),
`src/webauthn.ts` + `src/signer.ts` + `src/cbor.ts` (the authenticator),
`src/setup.ts`, `src/cli.ts`, `src/server.ts` (MCP), `src/actions/`
(silkweave tool definitions); `native/` holds the two Swift helpers
(`WebShell.swift` — windowless WKWebView shell, `SecureEnclaveSigner.swift`)
and `inject.js` (the page-world `navigator.credentials` override).

Tests run against a mock registry that reproduces npmjs.com's exact CLI
contract (401 + `www-authenticate: OTP`, `202`/`retry-after` polling,
`200 {token}`, `npm-otp` retry header), a fake ceremony shell, and the real
crypto (assertions are verified RP-style against the registered COSE key).

Environment overrides: `KEYBRIDGE_PRESENTER=webkit|browser`,
`KEYBRIDGE_BACKEND=secure-enclave|software`, `KEYBRIDGE_WEBSHELL=<binary>`.

### npm 11.x caveat

npm 11 redacts the session ids in its `--json` error output (`authUrl` arrives
as `…/auth/cli/***`; fixed in npm 12). keybridge detects this and transparently
mints its own web-auth session (a metadata-only `PUT` with
`npm-auth-type: web`), which returns unredacted URLs — verified against
registry.npmjs.org.

## Status

Validated end-to-end against npm production (enroll, login, publish — real
Touch ID, invisible ceremony) on 2026-07-14. Not affiliated with npm/GitHub;
uses npm's public CLI hand-off contract, no private APIs.

MIT
