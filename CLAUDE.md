# keybridge

Safe WebAuthn bridge for `npm publish` from agents: the agent initiates, the
human approves with a security key / Touch ID. keybridge automates everything
around the ceremony, never the ceremony itself.

**Validated end-to-end 2026-07-14** against npm production (enroll + login +
publish) with a purely-software Secure Enclave authenticator.

## Two codebases (converging)

- **Root (`bin/`, `src/`, `hooks/`, `skills/`)** — the shipped `keybridge`
  package + Claude plugin: `src/engine.js` (npm publish/login orchestration:
  `mintWebAuthSession`, `pollDoneUrl`, `publishWithWebAuth`, `loginWithWebAuth`),
  `src/presenters.js` (browser presenter), `src/mcp-server.js` (`npm_publish`
  MCP tool), `bin/keybridge.js` (CLI). Tests: `test/` (mock registry).
- **`v2/`** — the general-purpose Claude↔WebAuthn bridge: MV3 extension
  (`v2/extension/` — MAIN-world `navigator.credentials` override) → native host
  (`v2/host/`) → Secure Enclave signer (`v2/helper/SecureEnclaveSigner.swift`).
  Installer: `node v2/install.mjs`. Tests: `v2/test/`.

The next step (Tier A) wires the root **presenter** to drive the **v2 extension**
in an off-screen Chrome.

## Docs

- `_docs/NPM_WEBAUTHN_FLOW.md` — the proven end-to-end flow + every edge case.
- `_docs/HEADLESS_UX_RESEARCH.md` — invisible-UX research (Tier A design;
  browserless is blocked by Cloudflare).
- `_docs/NEXT_SESSION.md` — plan for the next session.

## Key facts / gotchas (see docs for detail)

- npm accepts a `none`-attestation software/SE passkey (enroll + assert).
- Native-messaging host must launch via a `/bin/sh` wrapper with an **absolute**
  node path (Chrome strips PATH); manifest must also live in
  `<user-data-dir>/NativeMessagingHosts/` for custom profiles.
- npm 11.x redacts publish `authUrl`/`doneUrl` → `engine.mintWebAuthSession`
  recovers unredacted URLs.
- Chrome 150 ignores `--load-extension`; load via CDP `Extensions.loadUnpacked`
  (chrome-devtools-mcp `install_extension`, needs `--categoryExtensions`).
- `www.npmjs.com` is behind Cloudflare — no pure-HTTP browserless client.

## Commands

```sh
npm test                        # root engine tests (mock registry)
node --test v2/test/*.test.mjs  # v2 extension/host tests
node v2/install.mjs             # (re)install SE helper, launcher, NM manifests
```

## Wrapup Config

- check: skip (plain JS, no linter/typechecker yet — the *next* project uses oxlint + TS 7)
- test: `npm test` + `node --test v2/test/*.test.mjs`
- push: no
- version_bump: no (spike)
- publish: no (spike)
- docs: `_docs/` folder + this file as index
- notes: `.mcp.json` mixes the dev-only chrome-devtools server (absolute path)
  into the plugin's shipped config — separate before any publish.
