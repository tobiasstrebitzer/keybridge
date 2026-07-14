# keybridge

A safe WebAuthn bridge for publishing npm packages from agents (Claude Code
first). The agent initiates the publish; **you** approve it with your security
key or Touch ID. The human touch is the point — keybridge automates everything
around the ceremony, never the ceremony itself.

> Status: spike / proof of concept. Working name.
>
> **Validated end-to-end (2026-07-14):** enroll + `npm login` + `npm publish`
> all completed against npm's production registry using a purely-software
> Secure Enclave authenticator (no physical key), Touch ID as the only human
> step. The **Tier A** invisible-Chrome presenter is built and verified live
> (launch → load extension → ceremony page → teardown); the only unproven leg
> is the final Touch ID tap through Tier A. See `_docs/NPM_WEBAUTHN_FLOW.md`
> (full flow + edge cases) and `_docs/HEADLESS_UX_RESEARCH.md` (invisible-UX
> design) and `_docs/NEXT_SESSION.md` (the live-test runbook).

## Why

npm now requires web-based WebAuthn verification for local publishing
(classic tokens revoked Dec 2025, TOTP enrollment gone, bypass-2FA granular
tokens lose direct publish ~Jan 2027). Run non-interactively — e.g. by
Claude Code's Bash tool — `npm publish` just fails with `EOTP`.

Since npm CLI ≥ 11.6, that failure carries a machine-readable contract
(`npm/cli#8952`), designed for wrappers exactly like this one:

```
npm publish --json   (non-TTY, hits the 2FA wall)
└─ stdout: {"error": {"code": "EOTP", "authUrl": "...", "doneUrl": "..."}}

keybridge:
  1. drives authUrl for the human  → invisible off-screen Chrome (Tier A)
  2. human touches key / Touch ID  → the non-bypassable gate
  3. polls doneUrl                 → 202+retry-after … then 200 {token}
  4. re-runs npm publish --otp=<token>
```

No reverse engineering: the ceremony happens on npm's real web page; the
CLI-side contract (`authUrl`/`doneUrl`/`--otp`) is npm's own.

## Usage

### CLI (human)

```sh
npx keybridge publish                # macOS: invisible Chrome → Touch ID → done
npx keybridge publish -- --tag beta  # everything after -- goes to npm publish
npx keybridge login                  # just the web-login ceremony (12h session token)
npx keybridge publish --presenter browser   # force the default-browser fallback
```

### Sessions and expiry

`npm login` yields a ~12 hour session token (npm policy since Dec 2025).
keybridge handles expiry automatically: when a publish fails with
`E401`/`ENEEDAUTH`, it runs the web-login ceremony (one extra touch),
persists the fresh token to your npmrc exactly like `npm login` would, and
continues with the publish ceremony.

To avoid the 12-hour cycle entirely, use a **granular access token without
"bypass 2FA"** (Settings → Access Tokens on npmjs.com, or `npm token create`):
up to 90-day lifetime, scoped to selected packages, and every publish still
requires your WebAuthn touch — same security, no re-login. Drop it in
`~/.npmrc` as `//registry.npmjs.org/:_authToken=npm_…`. Avoid "bypass 2FA"
tokens: they remove the human gate and lose direct-publish rights ~Jan 2027.

### Claude Code — as a project MCP server

`.mcp.json` in your project:

```json
{
  "mcpServers": {
    "keybridge": { "command": "npx", "args": ["keybridge-mcp"] }
  }
}
```

Claude gets two tools, `NpmPublish` and `NpmLogin`, with typed inputs only
(`tag`, `access`, `dryRun`, `cwd`) — no free-form flag injection
(`--registry`, `--otp` etc. are unreachable).

### Claude Code — as a plugin

This repo is also a Claude Code plugin (`.claude-plugin/plugin.json`). It
bundles:

- the MCP server (`.mcp.json`, plugin-scoped)
- a `PreToolUse` hook that **denies raw `npm publish` / `pnpm publish` /
  `yarn publish` in Bash**, steering Claude to the gated tool
- an `npm-publish` skill teaching Claude the flow

Install from a local checkout for now: `claude --plugin-dir /path/to/keybridge`.

## Security model

Two independent gates:

1. **Claude Code permission gate** — `NpmPublish` is a normal MCP tool, so
   per-project whitelisting (`mcp__keybridge__NpmPublish` in
   `.claude/settings.json` `permissions.allow`) controls whether Claude may
   *attempt* a publish. Tool inputs are typed (no flag injection) and `cwd`
   may not escape the project root.
2. **WebAuthn user presence** — npm's server demands a fresh assertion from
   your enrolled authenticator. No touch, no publish. This gate cannot be
   whitelisted, delegated, or scripted away — it is the real security
   boundary. Even the invisible-Chrome presenter surfaces the Touch ID /
   security-key dialog, by design.

Plus: the Bash side-channel is closed by the hook.

## Presenter (Tier A — invisible Chrome)

On macOS, the ceremony runs in a **real but invisible** Chrome: keybridge
launches Google Chrome minimized/off-screen with a persistent profile, loads
the keybridge extension over CDP, navigates to `authUrl`, and auto-triggers the
"Use security key" step. The extension answers `navigator.credentials.get()`
from a local Secure Enclave key → **Touch ID is the only thing you see**. Chrome
is kept warm across publishes so repeat publishes skip the ~1–2 s cold start.

A browser is required (not merely convenient): `www.npmjs.com` is behind
Cloudflare bot-management, so a pure-HTTP client is blocked (`cf-mitigated:
challenge`) — a real browser passes naturally and its profile holds the
`cf_clearance` + `wub` cookies. A minimized window (rather than off-screen
coordinates, which macOS clamps to the display) is what makes it invisible;
page JS + network keep running while minimized. See
`_docs/HEADLESS_UX_RESEARCH.md`.

**Fallback** (`--presenter browser`, or automatically on non-macOS): open the
system default browser (`open` / `xdg-open` / `start`) on the ceremony URL.

## Layout

- `src/` — the TypeScript sources (run as native `.ts` under Node ≥ 22.18 in
  dev; built to `dist/` with tsdown for the published package):
  `engine.ts` (publish/login orchestration), `cdp.ts` (minimal CDP client),
  `presenters/chrome.ts` (Tier A) + `presenters/browser.ts` (fallback),
  `actions/*` (silkweave `NpmPublish`/`NpmLogin`), `server.ts` (MCP stdio),
  `cli.ts`. The published npm package ships only `dist/` + the v2 runtime.
- `v2/` — the general-purpose Claude↔WebAuthn bridge the presenter drives: MV3
  extension (`v2/extension/`), native host (`v2/host/`), Secure Enclave signer
  (`v2/helper/`). Installer: `node v2/install.mjs`.
- `hooks/`, `skills/`, `.claude-plugin/`, `.mcp.json` — the Claude plugin.

## Development

Requires **Node ≥ 22.18** (native TS type-stripping) and **pnpm 11**. The Tier A
presenter needs real Google Chrome and the keybridge native host installed
(`node v2/install.mjs`).

```sh
pnpm install
pnpm check                       # tsc --noEmit + oxlint + tests
pnpm build                       # tsdown: src/ → dist/ (ESM, what the package ships)
node --test v2/test/*.test.mjs   # v2 extension/host tests (plain JS)
```

The mock registry (`tests/mock-registry.ts`) reproduces npmjs.com's exact
behavior as implemented by npm-registry-fetch/npm-profile: `401` +
`www-authenticate: OTP` + `{authUrl, doneUrl}`, `202`/`retry-after` polling,
`200 {token}`, and the `npm-otp` header on retry.

### Environment

- `KEYBRIDGE_PRESENTER=chrome|browser` — force a presenter.
- `KEYBRIDGE_CHROME` — path to the Chrome binary.
- `KEYBRIDGE_CHROME_PROFILE` — persistent profile dir (default
  `~/.keybridge/chrome-profile`).
- `KEYBRIDGE_EXTENSION` — unpacked extension dir (default `v2/extension`).

## npm < 12 caveat (important)

npm 11.x redacts the session ids in its `--json` error output — `authUrl`
and `doneUrl` arrive as `…/auth/cli/***` (`@npmcli/redact` runs over the
JSON payload; fixed in npm 12). keybridge detects the `***` and transparently
recovers by minting its own web-auth session: a metadata-only `PUT` to the
package route with `npm-auth-type: web` makes the registry create a fresh,
live session and return unredacted URLs (verified against registry.npmjs.org).
The ceremony then proceeds normally and the resulting OTP is used for the
real publish retry.

## Known gaps / next steps

- **Live loop**: ✅ verified end-to-end against the real registry incl. a real
  `npm publish` (minted-session OTP accepted on retry). See
  `_docs/NPM_WEBAUTHN_FLOW.md`.
- **Tier A (invisible UX)**: ✅ built + verified live except the final Touch ID
  tap through Tier A. `_docs/NEXT_SESSION.md` is the runbook to close that.
- **`inject.js` fallback**: ✅ Bitwarden-style `ENOCRED` fallback — the extension
  calls the real `navigator.credentials` when it has no keybridge credential for
  the rpId, so it coexists with other authenticators.
- **Packaging**: the package is `private: true` (spike) but publish-ready in
  shape — `pnpm build` (tsdown) emits `dist/`, the `bin`s point at the compiled
  `dist/*.mjs` (so consumers don't need the native-TS toolchain), and `files`
  ships only `dist/` + the v2 runtime (`extension`/`host`/`helper`/`install.mjs`).
  Flip `private` off when ready to publish.
- **MCP timeout**: a slow human may exceed the client's tool timeout; the
  server emits `notifications/progress` to keep the call alive, but verify
  against your Claude Code version (`MCP_TOOL_TIMEOUT`).
- **npm staged publishing** (`npm stage publish`, GA May 2026): same
  hand-off should cover stage-approval flows; not yet wired.
- Rename before publishing (npm name availability unchecked).
