# Next session — plan

## Where we are (updated 2026-07-14, session 2)

The TS7 rebuild and Tier A both landed in **`v3/`**. Done this session:

- **`v3/` scaffolded** — pnpm, TS 7 (`tsgo`, `noEmit`, `erasableSyntaxOnly` →
  native `.ts` under Node), oxlint, `node --test` over `tests/**/*.test.ts`.
  Mirrors the claude-plugins stack. Deps: `@silkweave/core` + `@silkweave/mcp`
  (v4.0.0) + `zod`.
- **Engine ported** to `v3/src/engine.ts` (typed; same contract as the root
  `engine.js`). Mock-registry tests ported → all 5 pass.
- **Tier A presenter** — `v3/src/presenters/chrome.ts` + a hand-rolled CDP
  client `v3/src/cdp.ts` (no puppeteer). Launches an invisible off-screen Chrome
  (minimized — see gotcha below), `Extensions.loadUnpacked` of `v2/extension`,
  navigates to `authUrl`, auto-clicks "Use security key", tears the tab down on
  the engine's `signal` abort, keeps Chrome **warm** across publishes via the
  profile `DevToolsActivePort`. **Verified live** against real Chrome + real
  extension on webauthn.io (launch → loadUnpacked → inject.js override → UVPAA
  polyfill → minimized/hidden → teardown → 1.5 s warm reuse). The only untested
  live leg is the actual npm ceremony + Touch ID (needs a human touch).
- **MCP server + CLI on silkweave** — `v3/src/server.ts` exposes `NpmPublish` +
  `NpmLogin` as silkweave actions over stdio (`disposition: 'structured'`, so
  they ship `outputSchema` + `structuredContent`); `v3/src/cli.ts` is
  `keybridge publish|login`. Tier A is the default presenter on macOS;
  `--presenter browser` / `KEYBRIDGE_PRESENTER=browser` falls back.
- **`inject.js` `ENOCRED` fallback** — Task 2 done. `signer.selectForAssertion`
  throws `code:'ENOCRED'` when it has no credential for the rpId; the host
  forwards `code`; `inject.js` calls the real `navigator.credentials.{get,create}`
  on ENOCRED instead of throwing. keybridge can now stay installed alongside
  other authenticators. New tests in `v2/test/inject.test.mjs` cover it.

All suites green: `npm test` (6), `node --test v2/test/*.test.mjs` (8),
`cd v3 && pnpm check` (13).

---

## Remaining work

### 1. Live end-to-end through v3 Tier A (needs a human)
Drive a real `npm publish` of `keybridge-test` through `v3` (CLI **and** MCP
tool) so the full chain runs once: mint → off-screen Chrome ceremony → **Touch
ID** → doneUrl → `--otp` publish. The mechanics are proven; this just confirms
the npm escalate page's real "Use security key" button matches `STATUS_SCRIPT`'s
selector (`/use security key|security key/i` over button/a/[role=button]/submit).
If npm's markup differs, tighten the selector. Also confirm the persistent
`~/.keybridge/chrome-profile` passes Cloudflare on a cold profile (may need one
visible login first to seed `cf_clearance` + `wub`).

### 2. Promote v3 → root (packaging)
Once the live run passes, decide whether `v3/` becomes the shipped package:
- Node's native-TS type-stripping needs **Node ≥ 22.18**; the `bin` entries
  point at `.ts` files (`src/cli.ts`, `src/server.ts`) with `#!/usr/bin/env
  node`. Confirm that works for consumers, or add a tiny JS shim / build step.
- Move `hooks/` + `skills/` + `.claude-plugin/` alongside v3, and reconcile
  `.mcp.json` (root note: it mixes the dev-only chrome-devtools server with the
  shipped plugin config — **separate before any publish**).
- Port the hook-guard test (`test/e2e.test.mjs` tail) into `v3/tests`.

### 3. Nice-to-haves
- `install.mjs` should also provision the native manifest into
  `~/.keybridge/chrome-profile/NativeMessagingHosts` (the v3 presenter does this
  itself via `ensureNativeManifest`, but a first `keybridge login` before any
  publish would want it too — currently handled on launch, so probably fine).
- Warm-Chrome lifecycle: today the CLI leaves Chrome running (warm) and only
  drops the CDP socket. Consider an idle-timeout auto-close, or a
  `keybridge stop` to tear the warm browser down.

---

## Reference — the silkweave API (resolved this session)

`@silkweave/core` + `@silkweave/mcp` v4.0.0. An **Action** (`createAction`) has
Zod `input`/`output`, a `run(input, context)`, and MCP knobs (`disposition`,
`annotations`, `tags`). `silkweave({name,description,version}).adapter(stdio())
.action(A).start()` boots the server. `context.getOptional('logger').progress()`
emits `notifications/progress`. `disposition:'structured'` declares `output` as
the tool's MCP `outputSchema` (parsed → `structuredContent`). Custom tool `_meta`
(e.g. the old `anthropic/requiresUserInteraction`) is **not** forwarded by
silkweave's registrar — dropped in v3; the Touch ID gate still stands. READMEs
have no `npm view readme`; `npm pack` the tarball and read `build/*.d.mts`.

## Reference — the TS7 / oxlint / pnpm stack (verified, in v3/)

pnpm `packageManager: pnpm@11.8.0`. TS `^7.0.2` (native `tsgo`; `tsconfig`:
`erasableSyntaxOnly`, `noEmit`, `NodeNext`, `allowImportingTsExtensions`,
`target ES2022`, `lib ES2022`). oxlint `^1.73.0` (`.oxlintrc.json` — note we
added `no-underscore-dangle: off` for npm's `_attachments`/`_id` fields, and
`preserve-caught-error` wants `{ cause }` on re-throws). `@types/node ^26`.
Tests are `node --test tests/**/*.test.ts`. No semicolons, single quotes.
Imports use explicit `.ts` extensions.
