# keybridge

Safe WebAuthn bridge for `npm publish` from agents: the agent initiates, the
human approves with a security key / Touch ID. keybridge automates everything
around the ceremony, never the ceremony itself.

**Validated end-to-end 2026-07-14** against npm production (enroll + login +
publish) with a purely-software Secure Enclave authenticator.

## Two parts

- **Root package (`src/`, `tests/`, `hooks/`, `skills/`, `.claude-plugin/`)** —
  the shipped `keybridge` package + Claude plugin, on the **TS7 / oxlint / pnpm**
  stack (dev runs native `.ts` under Node ≥ 22.18; `pnpm build` / tsdown emits
  `dist/` for the published package) using **silkweave** (`@silkweave/core` +
  `@silkweave/mcp`). Ships **Tier A**:
  `src/presenters/chrome.ts` drives the v2 extension in an invisible (minimized)
  off-screen Chrome over a hand-rolled CDP client (`src/cdp.ts`), so only Touch
  ID is visible; `src/presenters/browser.ts` is the fallback;
  `src/presenters/select.ts` picks Tier A on macOS. `src/engine.ts` (npm
  publish/login orchestration: `mintWebAuthSession`, `pollDoneUrl`,
  `publishWithWebAuth`, `loginWithWebAuth`), `src/actions/*` (`NpmPublish` +
  `NpmLogin` silkweave actions), `src/server.ts` (MCP stdio), `src/cli.ts`
  (`keybridge publish|login`). Tests: `tests/**/*.test.ts` under `node --test`.
  (The original plain-JS `bin/`+`src/`+`test/` package was collapsed into this
  TS package on 2026-07-14; `git log` has it if needed.)
- **`v2/`** — the general-purpose Claude↔WebAuthn bridge the presenter drives:
  MV3 extension (`v2/extension/` — MAIN-world `navigator.credentials` override) →
  native host (`v2/host/`) → Secure Enclave signer
  (`v2/helper/SecureEnclaveSigner.swift`). Installer: `node v2/install.mjs`.
  Tests: `v2/test/` (plain JS). `inject.js` has the **Bitwarden-style `ENOCRED`
  fallback**: when the daemon has no keybridge credential for the rpId it calls
  the *real* `navigator.credentials`, so keybridge can stay installed in a
  profile the user also logs into normally.

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
- Chrome 150 ignores `--load-extension`; load via CDP `Extensions.loadUnpacked`.
  The presenter's own CDP client drives Chrome over a raw ws port, so Chrome is
  launched with `--enable-unsafe-extension-debugging`.
- `www.npmjs.com` is behind Cloudflare — no pure-HTTP browserless client.
- **macOS clamps off-screen window coordinates to the display** — `--window-
  position=-32000,-32000` only nudges the window to the screen edge. The Tier A
  presenter hides the window by **minimizing** it (`Browser.setWindowBounds
  {windowState:'minimized'}`); probed live, the page's JS + network keep running
  while minimized, so the ceremony completes with only Touch ID visible.
- The Tier A Chrome is kept **warm** across publishes via the profile's
  `DevToolsActivePort` file (a later CLI/MCP invocation reattaches instead of
  cold-starting ~8 s). Its persistent profile lives at
  `~/.keybridge/chrome-profile` (holds `cf_clearance` + `wub` + the extension).

## Commands

```sh
pnpm check                      # tsc --noEmit + oxlint + node --test (native TS)
pnpm test                       # just the root TS tests (engine, cdp, presenter, hook)
pnpm build                      # tsdown: src/ → dist/ (ESM; what the package ships)
node --test v2/test/*.test.mjs  # v2 extension/host tests (plain JS)
node v2/install.mjs             # (re)install SE helper, launcher, NM manifests
```

## Wrapup Config

- check: `pnpm check` (root is TS7 + oxlint; v2 stays plain JS, linted out via
  `.oxlintrc.json` ignorePatterns and outside `tsconfig` include)
- test: `pnpm test` + `node --test v2/test/*.test.mjs`
- push: no
- version_bump: no (spike)
- publish: no (spike — package is `private: true`, but publish-ready in shape)
- docs: `_docs/` folder + this file as index; `README.md` is the product doc
- notes: `pnpm build` (tsdown) emits `dist/` (gitignored); `bin` + the npm
  tarball ship compiled `dist/*.mjs` + the v2 runtime only (`files` whitelist).
  `.mcp.json` points at `src/server.ts` (native TS) for local/plugin use and is
  not shipped. `dist/` must exist on disk for `npm pack` (prepack rebuilds it).
