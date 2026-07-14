# keybridge

Safe WebAuthn bridge for `npm publish` from agents: the agent initiates, the
human approves with Touch ID. keybridge automates everything around the
ceremony, never the ceremony itself. **Validated end-to-end 2026-07-14**
against npm production (enroll + login + publish, real Touch ID, fully
invisible ceremony). `README.md` is the product doc; this file is the dev map.

## Layout

One TS package (TS7 / oxlint / pnpm; dev runs native `.ts` under Node ≥ 22.18;
`pnpm build` / tsdown emits `dist/` unbundled so `../../native` path math
survives) using **silkweave** (`@silkweave/core` + `@silkweave/mcp`).

- `src/engine.ts` - npm publish/login orchestration (`mintWebAuthSession`,
  `pollDoneUrl`, `publishWithWebAuth`, `loginWithWebAuth`).
- `src/presenters/` - `webkit.ts` (the macOS default: drives the windowless
  WKWebView shell over JSON-lines stdio, answers WebAuthn ceremonies
  in-process), `browser.ts` (open-default-browser fallback + `notifyHuman`),
  `select.ts` (webkit → browser), `shared.ts` (`STATUS_SCRIPT` that auto-clicks
  npm's "Use security key" button).
- `src/webauthn.ts` + `src/signer.ts` + `src/cbor.ts` - the authenticator:
  assembles clientDataJSON/authenticatorData/attestation, stores credentials in
  `~/.keybridge/credentials.json`, signs via Secure Enclave helper (Touch ID)
  or a software P-256 key (tests / non-macOS).
- `src/setup.ts` - `keybridge setup`: compiles both Swift helpers into
  `~/.keybridge/`, probes the Enclave, writes `config.json`.
- `src/cli.ts` (`keybridge setup|publish|login`), `src/server.ts` (MCP stdio),
  `src/actions/` (`NpmPublish` + `NpmLogin` silkweave actions).
- `native/` - `WebShell.swift` (windowless WKWebView ceremony shell),
  `inject.js` (page-world `navigator.credentials` override over
  `webkit.messageHandlers`, Bitwarden-style `ENOCRED` fallback to the real
  authenticator), `SecureEnclaveSigner.swift`.
- `hooks/`, `skills/`, `.claude-plugin/`, `.mcp.json` - the Claude plugin
  (deny raw `npm publish` in Bash; `.mcp.json` points at `src/server.ts`
  native-TS for local use and is not shipped).
- `tests/` - `node --test`, all TS. `mock-registry.ts` reproduces npmjs.com's
  CLI contract; `helpers/fake-shell.mjs` mimics the WKWebView shell's stdio
  protocol; `inject.test.ts` runs `native/inject.js` against throwing stub
  prototypes + real crypto.
- `_docs/` - **gitignored** dev/session notes (flow captures, UX research,
  runbooks). `keybridge-test/` - gitignored local publish-test package.

## Key facts / gotchas

- npm accepts a `none`-attestation software/SE passkey (enroll + assert).
- **A windowless WKWebView passes Cloudflare on `www.npmjs.com` with NO
  challenge, even cold** (probed 2026-07-14) - that's why WKWebView instead of
  a pure HTTP client (403 `cf-mitigated`) or Chrome (window flicker). While
  hidden, page timers throttle to ~1 Hz and rAF stops, but `evaluateJavaScript`
  + network are unthrottled - all the ceremony needs.
- Shell cookies persist in `WKWebsiteDataStore(forIdentifier:)` (fixed UUID in
  `WebShell.swift`), not in any browser profile. First run needs one manual
  npmjs.com login - the presenter auto-surfaces a window when it detects a
  password page, then never again.
- **WKWebView has no real platform authenticator**, so the inject script's
  `ENOCRED` fallback to the native `navigator.credentials` effectively fails
  inside the shell. Consequence: an account with a pre-existing security key
  can't pass the first-login 2FA check with that key in the keybridge window -
  the user must pick npm's "use a recovery code" fallback (or temporarily
  remove the old key first). Documented in README's install section.
- npm 11.x redacts publish `authUrl`/`doneUrl` (`…/***`; fixed in npm 12) →
  `engine.mintWebAuthSession` recovers unredacted URLs via a metadata-only
  `PUT` with `npm-auth-type: web`.
- The SE signer shells out synchronously - the event loop stalls during the
  human's Touch ID think-time; engine polling resumes after. Fine by design.
- The CryptoKit SecureEnclave API stores on-disk key blobs (no keychain
  entitlement needed) - ad-hoc-signed helper binaries work.
- History: the earlier architecture (MV3 extension → native-messaging host →
  CDP-driven off-screen Chrome, "Tier A") was removed 2026-07-14 in favor of
  the WKWebView shell; `git log` has it if ever needed.

## Commands

```sh
pnpm check              # tsc --noEmit + oxlint + node --test (native TS)
pnpm build              # tsdown: src/ → dist/ (ESM; what the package ships)
node src/cli.ts setup   # (re)build both Swift helpers into ~/.keybridge
```

## Wrapup Config

- check: `pnpm check`
- test: `pnpm test`
- push: no (repo not on a remote yet - user publishes to GitHub manually)
- version_bump: no (pre-release; still `private: true`)
- publish: no (flip `private` + pick a final name when ready; prepack rebuilds
  `dist/`)
- docs: `README.md` (product) + this file (dev map); `_docs/` is gitignored
  session notes
- notes: npm tarball ships `dist/` + `native/` only (`files` whitelist);
  `dist/` must exist for `npm pack` (prepack rebuilds it)
- commits: do NOT add AI co-author or session trailers (`Co-Authored-By:
  Claude…`, `Claude-Session:…`) - attribution lives in README's AI-disclosure
  note instead (user preference; history was rewritten once to enforce this)
