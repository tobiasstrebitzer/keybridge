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
> step. See `_docs/NPM_WEBAUTHN_FLOW.md` (full flow + edge cases) and
> `_docs/HEADLESS_UX_RESEARCH.md` (invisible-UX design).

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
  1. opens authUrl for the human   → browser tab
  2. human touches key / Touch ID  → the non-bypassable gate
  3. polls doneUrl                 → 202+retry-after … then 200 {token}
  4. re-runs npm publish --otp=<token>
```

No reverse engineering: the ceremony happens on npm's real web page; the
CLI-side contract (`authUrl`/`doneUrl`/`--otp`) is npm's own.

## Usage

### CLI (human)

```sh
npx keybridge publish                 # opens your default browser for the touch
npx keybridge publish -- --tag beta  # everything after -- goes to npm publish
npx keybridge login                  # just the web-login ceremony (12h session token)
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

Claude gets one tool, `npm_publish`, with typed inputs only
(`tag`, `access`, `dryRun`, `cwd`) — no free-form flag
injection (`--registry`, `--otp` etc. are unreachable).

### Claude Code — as a plugin

This repo is also a Claude Code plugin (`.claude-plugin/plugin.json`). It
bundles:

- the MCP server (`.mcp.json`, plugin-scoped)
- a `PreToolUse` hook that **denies raw `npm publish` / `pnpm publish` /
  `yarn publish` in Bash**, steering Claude to the gated tool
- an `npm-publish` skill teaching Claude the flow

Install from a local checkout for now: `claude --plugin-dir /path/to/keybridge`.

## Security model

Two independent gates, in order:

1. **Claude Code permission gate** — the `npm_publish` tool declares
   `_meta["anthropic/requiresUserInteraction"]`, so Claude Code (≥ 2.1.199)
   shows an approval card on **every** call; it cannot be auto-approved.
   Per-project whitelisting of the tool (`mcp__keybridge__npm_publish` in
   `.claude/settings.json` `permissions.allow`) controls only the *attempt*.
2. **WebAuthn user presence** — npm's server demands a fresh assertion from
   your enrolled authenticator. No touch, no publish. This gate cannot be
   whitelisted, delegated, or scripted away.

Plus: the Bash side-channel is closed by the hook, tool inputs are typed
(no flag injection), and `cwd` may not escape the project root.

## Presenter

The ceremony opens in your **default browser** (`open` / `xdg-open` / `start`).
The tab stays open after auth (npm's page shows its own success state). If a
ceremony is cancelled, keybridge waits out the poll timeout (default 5 min;
Ctrl+C to abort sooner).

There is no Apple-sanctioned way for a third-party CLI to run the WebAuthn
ceremony outside a real browser context — WKWebView's WebAuthn is gated behind
a browsers-only entitlement, and `ASWebAuthenticationSession` just delegates to
the default browser on macOS 14+ (an earlier `--sheet` presenter was removed as
a dead end). The **invisible/headless** direction (an off-screen Chrome driving
the keybridge extension via CDP, so only Touch ID is visible) is designed in
`_docs/HEADLESS_UX_RESEARCH.md` — a pure browserless HTTP client is not viable
because Cloudflare fronts www.npmjs.com.

## Development

```sh
npm install
npm test        # e2e against an in-process mock of npm's EOTP/doneUrl protocol
```

The mock registry (`test/mock-registry.mjs`) reproduces npmjs.com's exact
behavior as implemented by npm-registry-fetch/npm-profile: `401` +
`www-authenticate: OTP` + `{authUrl, doneUrl}`, `202`/`retry-after` polling,
`200 {token}`, and the `npm-otp` header on retry.

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
- **Tier A (invisible UX)**: wire the presenter to an off-screen headed Chrome +
  the keybridge extension so publish is "run → Touch ID → done". Design in
  `_docs/HEADLESS_UX_RESEARCH.md`; next-session plan in `_docs/NEXT_SESSION.md`.
- **`inject.js` fallback**: the v2 extension currently intercepts *all* WebAuthn
  on its matched hosts; add Bitwarden-style `fallbackRequested` so it coexists
  with other authenticators.
- **MCP timeout**: a slow human may exceed the client's tool timeout; the
  server emits `notifications/progress` to keep the call alive, but verify
  against your Claude Code version (`MCP_TOOL_TIMEOUT`).
- **npm staged publishing** (`npm stage publish`, GA May 2026): same
  hand-off should cover stage-approval flows; not yet wired.
- Rename before publishing (npm name availability unchecked).
