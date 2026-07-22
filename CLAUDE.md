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
  `pollDoneUrl`, `publishWithWebAuth`, `loginWithWebAuth`). Presenters can
  throw a `PublishError` with `fatal = true` to abort doneUrl polling early.
- `src/accounts.ts` - the identity layer. **`npm whoami` is the source of
  truth**; `~/.keybridge/accounts.json` maps npm usernames to per-account
  `WKWebsiteDataStore` UUIDs (browser profiles) + tracks the active account.
  `loginAs` (login/switch; instant via vault token when one works),
  `resolvePublishIdentity`, `resolveMediation` (publish as X without
  switching - X's token as npm env override + X's profile; `autoLogin: false`
  there, or a wrong-account token would land in npmrc), `assertSecurityKeyFor`
  (ENOKEY fail-fast), `accountsStatus`, `bindAfterLogin` (post-login
  self-healing, incl. stamping `username` onto the credential that asserted).
- `src/tokens.ts` - per-account token vault (`~/.keybridge/tokens.json`,
  0600): every login stores its ~12h web token; `keybridge token set` parks
  long-lived granular tokens. Tokens are whoami-validated before every use
  and evicted when dead.
- `src/presenters/` - `webkit.ts` (the macOS default: drives the windowless
  WKWebView shell over JSON-lines stdio, answers WebAuthn ceremonies
  in-process), `browser.ts` (open-default-browser fallback), `select.ts`
  (webkit → browser), `shared.ts` (`STATUS_SCRIPT` that ticks npm's
  "remember me for 5 minutes" checkbox when present - reported as a
  `+remember` status suffix - then auto-clicks "Use security key"; also the
  login-form prefill script and `CAPTURE_SCRIPT`). `KEYBRIDGE_CAPTURE_DOM=1`
  makes the presenter (and `keybridge open`) write a JSON snapshot of every
  distinct page state to `~/.keybridge/captures/<ts>/` - the way to learn
  npm's auth-page DOM from a real ceremony. No desktop notifications
  anywhere - deliberately removed; the sheet is the signal.
- `src/webauthn.ts` + `src/signer.ts` + `src/cbor.ts` - the authenticator:
  assembles clientDataJSON/authenticatorData/attestation, stores credentials in
  `~/.keybridge/credentials.json`, signs via Secure Enclave helper (Touch ID)
  or a software P-256 key (tests / non-macOS).
- `src/setup.ts` - `keybridge setup`: compiles both Swift helpers into
  `~/.keybridge/`, probes the Enclave, writes `config.json`.
- `src/cli.ts` (`keybridge setup|status|enroll|login|switch|logout|open|
  token|publish [--user]`), `src/server.ts` (MCP stdio), `src/actions/`
  (`NpmPublish` + `NpmLogin` + `NpmStatus` + `NpmSwitchAccount`). Agent flow:
  NpmStatus → (NpmSwitchAccount) → NpmPublish `{ user }`.
- `native/` - `WebShell.swift` (windowless WKWebView ceremony shell),
  `inject.js` (page-world `navigator.credentials` override over
  `webkit.messageHandlers`, Bitwarden-style `ENOCRED` fallback to the real
  authenticator), `SecureEnclaveSigner.swift`.
- `hooks/`, `skills/`, `.claude-plugin/`, `scripts/`, `.mcp.json` - the Claude
  plugin; the repo is its own marketplace (`claude plugin marketplace add
  tobiasstrebitzer/keybridge` → `claude plugin install keybridge@keybridge`).
  Skills: `/keybridge:setup` (guided install) + `/keybridge:npm-publish`; hook
  denies raw `npm publish` in Bash. **Two MCP configs on purpose**: root
  `.mcp.json` (project/dev context, runs `src/server.ts` from the checkout)
  vs `.claude-plugin/mcp.json` (plugin context, referenced by plugin.json's
  `mcpServers`) → `scripts/keybridge-mcp.sh`, which self-bootstraps in the
  plugin cache (a bare clone: `npm install --omit=dev` once, then native-TS
  `src/server.ts`; install output must go to stderr - stdout is the MCP
  channel). `scripts/keybridge.sh` is the same bootstrap for the CLI, used by
  the setup skill.
- `tests/` - `node --test`, all TS. `mock-registry.ts` reproduces npmjs.com's
  CLI contract; `helpers/fake-shell.mjs` mimics the WKWebView shell's stdio
  protocol; `inject.test.ts` runs `native/inject.js` against throwing stub
  prototypes + real crypto.
- `_docs/` - **gitignored** dev/session notes (flow captures, UX research,
  runbooks).

## Key facts / gotchas

- npm accepts a `none`-attestation software/SE passkey (enroll + assert).
- **A windowless WKWebView passes Cloudflare on `www.npmjs.com` with NO
  challenge, even cold** (probed 2026-07-14) - that's why WKWebView instead of
  a pure HTTP client (403 `cf-mitigated`) or Chrome (window flicker). While
  hidden, page timers throttle to ~1 Hz and rAF stops, but `evaluateJavaScript`
  + network are unthrottled - all the ceremony needs.
- Shell cookies persist in `WKWebsiteDataStore(forIdentifier:)` - **one UUID
  per npm account** (accounts.json; `--store-id` shell arg), so switching
  accounts never clobbers another session. The legacy fixed UUID in
  `WebShell.swift` is grandfathered to the first account recorded. First
  login per account needs one manual password - the presenter auto-surfaces
  a window when it detects a password page, then never again.
- Identity self-heals toward `npm whoami` after every login (store binding,
  active account, credential `username` stamps via the store's
  `lastAsserted` marker). An ENOCRED ceremony in a HIDDEN shell is fatal
  (fast ENOKEY/ENOCRED error instead of a 5-min poll timeout); once
  surfaced, ENOCRED is tolerated so the human can use npm's recovery-code
  fallback. WebKit class-level data-store calls (purge) need a WebKit object
  created first or they segfault (see `--purge-store` in WebShell.swift).
- npm's login flow can CHAIN pages that each need their "Use security key"
  click (live session: /login → /escalate/webauthn) - the presenter polls
  nonstop and one-click/one-prefill-per-page is enforced by `window` flags
  INSIDE the page (they reset on navigation). Never track navigation counts
  presenter-side: eval-result and nav events can land in one pipe chunk, so
  counter snapshots race (was a real flaky-hang bug).
- Surfaced-window UX (WebShell.swift): the window is a bottom-center
  NON-ACTIVATING NSPanel (418×678 sheet - under npm's responsive breakpoint,
  so the page uses its compact layout; hidden titlebar + hidden traffic
  lights, slides up; keyboard works without stealing app focus -
  password-manager friendly). cmd+V/C/X/A need the main menu with standard
  edit actions (menubar-less apps drop key equivalents); macOS
  auto-capitalization is disabled via `UserDefaults.set` (`register` loses to
  the global domain). Appearance follows the system (`--appearance` /
  `KEYBRIDGE_APPEARANCE` forces it); npm's site theme is localStorage
  `npm-color-mode` (defaults to light!) - a documentStart user script seeds
  it to "system" once per profile.
- **WKWebView has no real platform authenticator**, so the inject script's
  `ENOCRED` fallback to the native `navigator.credentials` effectively fails
  inside the shell. Consequence: an account with a pre-existing security key
  can't pass the first-login 2FA check with that key in the keybridge window -
  the user must pick npm's "use a recovery code" fallback (or temporarily
  remove the old key first). Documented in README's install section.
- npm 11.9.0-11.14.x redact publish `authUrl`/`doneUrl` (`…/***`; fixed in
  11.15.0; pre-11.9 omits the URLs entirely) →
  `engine.mintWebAuthSession` recovers unredacted URLs via a metadata-only
  `PUT` with `npm-auth-type: web`.
- The SE signer shells out synchronously - the event loop stalls during the
  human's Touch ID think-time; engine polling resumes after. Fine by design.
- **macOS only shows the Touch ID sheet for the FRONTMOST process**; a
  background one gets a "KeyBridge wants to use Touch ID" notification
  instead (reads as "no dialog", the repeated-publish flake). The signer's
  `sign` therefore runs as an accessory NSApplication that activates itself
  before EXPLICITLY evaluating user presence (`LAContext.evaluatePolicy`,
  precise LAError codes in `{"error","code"}`, one retry on systemCancel/
  notInteractive). `KEYBRIDGE_SE_DEBUG=1` traces each step to stderr;
  `scripts/debug-touchid.sh [n]` reproduces an n-prompt chain with a
  throwaway key while tailing the LocalAuthentication system log.
- npm's publish 2FA page offers a 5-minute "cooldown" (remember me), keyed on
  IP + access token: once ticked (STATUS_SCRIPT does it automatically),
  follow-up publishes inside the window don't even hit EOTP - the first
  `npm publish` succeeds, so bulk chains need one touch per 5 minutes.
  Confirmed E2E 2026-07-22 (3-version publish chain; v3 took 3.5s, no touch).
  The checkbox on /escalate/webauthn has an EMPTY <label>; match on the
  input's aria-label ("Do not challenge npm publish ... for the next 5
  minutes") or name/id (`didOptForCooldown`), never on label text.
- Ceremony context (pkg name@version + account) threads engine →
  presenter (`purpose` on the Presenter call) → `ceremonyContext` webkit
  option → webauthn responder → `handleGet` → signer, so the Touch ID sheet
  reads e.g. “"KeyBridge" is trying to publish keybridge@0.5.1 to npm as
  tstrebitzer” - concurrent multi-project publishes can't be confused.
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
- push: yes (origin https://github.com/tobiasstrebitzer/keybridge)
- version_bump: yes (single package; infer patch/minor from changes)
- publish: yes - dogfood it: use the keybridge `NpmPublish` MCP tool with
  `user: "tstrebitzer"` (never raw `npm publish`; the hook blocks it anyway).
  First published as `keybridge@0.4.0` on 2026-07-14. prepack rebuilds `dist/`
- docs: `README.md` (product) + this file (dev map); `_docs/` is gitignored
  session notes
- co_authored_by: no - never add AI co-author or session trailers
  (`Co-Authored-By: Claude…`, `Claude-Session:…`); attribution lives in
  README's AI-disclosure note instead (history was rewritten once to enforce
  this)
- notes: npm tarball ships `dist/` + `native/` only (`files` whitelist);
  `dist/` must exist for `npm pack` (prepack rebuilds it)
