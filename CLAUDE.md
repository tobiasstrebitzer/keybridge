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
  `spec` names what npm publishes (`npm publish <spec>`); `cwd` still decides
  registry / token / package name.
- `src/pm.ts` - the package-manager strategy: `detectPackageManager` (nearest
  `packageManager` field → pnpm-workspace/lock → npm lockfiles → npm) and
  `resolvePublishTarget`, which packs pnpm projects with `pnpm pack` and hands
  the tarball back as the engine's `spec`. Callers own `cleanup()`. See the
  pnpm gotcha below for why pnpm packs but never publishes.
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
  `shellSigner` routes Secure Enclave signatures through the LIVE shell
  (`sign` command) so Touch ID renders in keybridge's own HUD sheet instead of
  the system dialog - see "Ceremony HUD" below. `KEYBRIDGE_HUD=0` restores the
  old invisible flow.
- `src/webauthn.ts` + `src/signer.ts` + `src/cbor.ts` - the authenticator:
  assembles clientDataJSON/authenticatorData/attestation, stores credentials in
  `~/.keybridge/credentials.json`, signs via Secure Enclave helper (Touch ID)
  or a software P-256 key (tests / non-macOS).
- `src/log.ts` - persistent ceremony diagnostics (`~/.keybridge/logs/
  keybridge-<day>.jsonl`, 14-day retention, `KEYBRIDGE_LOG_DIR` override for
  tests). `kblog()` is fire-and-forget and wired through engine (presenter
  failures), webkit presenter (ceremony lifecycle + all `o.log` lines),
  webauthn responder, SE signer (helper timing = Touch ID think-time), and
  both MCP actions. `keybridge logs [n]` tails it.
- `src/setup.ts` - `keybridge setup`: compiles both Swift helpers into
  `~/.keybridge/`, probes the Enclave, writes `config.json`.
- `src/cli.ts` (`keybridge setup|status|enroll|login|switch|logout|open|
  token|publish [--user] [--pm]`), `src/server.ts` (MCP stdio), `src/actions/`
  (`NpmPublish` + `NpmLogin` + `NpmStatus` + `NpmSwitchAccount`). Agent flow:
  NpmStatus → (NpmSwitchAccount) → NpmPublish `{ user }`.
- `native/` - `WebShell.swift` (windowless WKWebView ceremony shell **plus the
  Ceremony HUD**: the bottom sheet that hosts Touch ID in-process via
  `LAAuthenticationView` and performs the SE signature itself),
  `inject.js` (page-world `navigator.credentials` override over
  `webkit.messageHandlers`, Bitwarden-style `ENOCRED` fallback to the real
  authenticator), `SecureEnclaveSigner.swift` (still the standalone signer:
  `create`/`probe`, and the fallback when the HUD is off or unusable),
  `EmbeddedTouchIDProbe.swift` (the M0 spike behind the HUD; run it with
  `scripts/debug-touchid-embedded.sh [count] [policy]`, which prints its own
  GO/NO-GO verdict from the probe events + the LocalAuthentication log).
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
  the setup skill. `scripts/sync-plugin-version.mjs` pins
  `.claude-plugin/plugin.json` to the package.json version (stale-cache gotcha
  below): `--check` runs inside `pnpm check`, and the npm `version` lifecycle
  hook syncs + stages it on every bump.
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
  counter snapshots race (was a real flaky-hang bug). A click can also land
  in npm's HYDRATION GAP (button rendered, React handler not attached): it
  does nothing and the one-shot flag would block every retry - the
  2026-08-04 silent hangs ("clicked", then no webauthn get, no Touch ID, no
  error, 5-min timeout). The presenter therefore supervises clicks: a click
  cycle with no WebAuthn request after `reclickAfterMs` (4s) is re-armed via
  REARM_SCRIPT, max 3 times per page epoch (`WebShell.navCount`), and never
  while a ceremony is pending or after the page already produced one (no
  prompt spam after a human cancel).
- **Ceremony HUD (embedded Touch ID).** Touch ID renders INSIDE keybridge's
  own bottom sheet (`LAAuthenticationView`), and the SE signature is made in
  the shell on that same `LAContext` - so one touch, no system dialog, and no
  frontmost-process lottery. Protocol: `hud-show`/`hud-status`/`hud-close`/
  `sign` down, `sign-result`/`hud`/`hud-focus`/`hud-dismissed` up. Measured
  facts that constrain any change here (full write-up in the PRD, `_docs/`):
  - **The panel MUST become the key window** or LocalAuthentication silently
    PAUSES the prompt (`"LAAuthenticationView is not visible to user because
    NSApplication is not active"`), resuming only on
    `NSWindowDidBecomeKeyNotification` - i.e. after the human clicks it.
    `orderFrontRegardless()` alone is not enough; `makeKeyAndOrderFront` is.
    On a `.nonactivatingPanel` key ≠ active, so this costs no activation
    (verified: the user's app stays frontmost throughout). The sheet is
    `.borderless`, which returns false from `canBecomeKey` by default - hence
    the `HudPanel` subclass overriding it.
  - Focus lost mid-prompt is clawed back (max 8 times/prompt, then it stops
    fighting and shows "click this sheet"). `NSApp.isActive` is NOT a
    focus-theft metric - it reads true for a key non-activating panel; only
    `NSWorkspace.frontmostApplication` answers that.
  - The view is **non-textual** (icon only), so the reason line we draw is the
    only thing naming what is being approved - not decoration.
  - Embedded policies are biometry/companion ONLY (no password fallback in
    view). `EEMBEDUNAVAIL`/`ENOKEY` fall back to the standalone signer; a
    `userCancel` deliberately does NOT (re-asking = a prompt nobody wanted).
  - One `LAAuthenticationView` per ceremony (it is permanently paired with one
    single-use `LAContext`), but the PANEL persists - so chained ceremonies
    read as one continuous sheet.
  - Sheet geometry: the window hangs 28pt BELOW the screen edge, because the
    window shadow wraps all four sides and a bottom edge on the screen edge
    renders as a border plus radial corner dimming. Height is content-driven
    (`stack.bottom == content.bottom - bleed`, sized to `fittingSize`); a `<=`
    there lets content overflow into the off-screen bleed and the status line
    vanishes.
  - The ✕ cancels the ACTION, not the sheet: invalidates the context and emits
    `hud-dismissed` → fatal `ECANCEL`, or the engine would poll doneUrl for
    five more minutes after the human gave up.
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
- **pnpm packs, npm publishes** (`src/pm.ts`). pnpm workspaces write
  `workspace:*` / `catalog:` deps that only a pnpm pack rewrites to real
  versions - `npm publish` ships them verbatim and breaks consumers. But
  `pnpm publish` cannot be driven either (measured 2026-08-04 vs pnpm 11.8.0
  through `tests/mock-registry.ts`): spawned non-interactively it aborts with
  `{"error":{"code":"ERR_PNPM_OTP_NON_INTERACTIVE"}}` the moment the registry
  asks for an OTP, dropping the 401's authUrl/doneUrl, and `--otp=X`,
  `--otp X` and `npm_config_otp` ALL fail to reach the request (its
  `publishWithOtpHandling` does `{ ...publishOptions, otp }` with
  `otp === undefined` on the first attempt, clobbering the CLI value; the
  non-interactive guard then throws before the retry that would pass one). So
  there is no OTP to hand pnpm even after a successful ceremony. Hence:
  `pnpm pack --json --pack-destination <tmp>` → `npm publish <tarball>`, which
  takes `--otp` fine and keeps the whole EOTP/mint/ceremony path untouched.
  Corollaries: `pnpm pack` needs a completed `pnpm install` or it fails with
  `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`; it runs `prepack` but NOT
  `prepublishOnly`; it strips `packageManager` + publish lifecycle scripts
  from the packed manifest (pnpm's manifest obfuscation - same as
  `pnpm publish`); a missing `pnpm` is a hard `EPACKMGR` failure, never a
  silent fallback to npm. Yarn is deliberately not detected. Trust the
  destination-directory listing over `--json`'s `filename`: a `prepack` script
  writing to stdout corrupts pnpm's JSON payload.
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
  throwaway key while tailing the LocalAuthentication system log. The
  recurring "macOS won't show Touch ID for a Claude-spawned process" theory
  is REFUTED (2026-08-04, direct experiment: debug-touchid.sh run from a
  Claude Code Bash tool presented the sheet fine while another app was
  frontmost, and a terminal-direct ceremony failed the same day) - an
  SE-helper `userCancel` means the sheet/notification was dismissed during
  that attempt, not that macOS refused to present.
- npm's publish 2FA page offers a 5-minute "cooldown" (remember me), keyed on
  IP + access token: once ticked (STATUS_SCRIPT does it automatically),
  follow-up publishes inside the window don't even hit EOTP - the first
  `npm publish` succeeds, so bulk chains need one touch per 5 minutes.
  Confirmed E2E 2026-07-22 (3-version publish chain; v3 took 3.5s, no touch).
  The checkbox on /escalate/webauthn has an EMPTY <label>; match on the
  input's aria-label ("Do not challenge npm publish ... for the next 5
  minutes") or name/id (`didOptForCooldown`), never on label text.
  Two corollaries (proven live): the cooldown does NOT cover `npm unpublish`
  (always challenged), and while it is active `mintWebAuthSession` gets a 422
  (challenge suppressed → the metadata-only PUT hits real body validation) -
  wait out the window before minting. A publish-minted OTP IS accepted by
  `npm unpublish --otp` (how the smoke-test package was cleaned up).
- Ceremony context (pkg name@version + account) threads engine →
  presenter (`purpose` on the Presenter call) → `ceremonyContext` webkit
  option → webauthn responder → `handleGet` → signer, so the Touch ID sheet
  reads e.g. “"KeyBridge" is trying to publish keybridge@0.5.1 to npm as
  tstrebitzer” - concurrent multi-project publishes can't be confused.
- **Plugin version drives the consumer cache.** Claude Code installs a plugin
  into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and only
  re-clones when `.claude-plugin/plugin.json`'s `version` changes. Shipping a
  new npm version without bumping the plugin manifest leaves every consumer
  repo on the old checkout - old skills, old bootstrap, and a
  `keybridge@<old>` install inside the cached clone. That happened for real
  (plugin sat at 0.3.3 while the package was at 0.6.0), hence the
  version-parity gate. `marketplace.json` carries no version of its own; the
  plugin manifest is the only lever.
- **MCP hosts drop the server's stderr after startup** (verified against
  Claude Code 2026-07-30: its `~/Library/Caches/claude-cli-nodejs/<proj>/
  mcp-logs-*keybridge*/*.jsonl` files record tool calls/results and
  startup-phase stderr only - zero presenter output even during a successful
  ceremony). So stderr diagnostics are invisible exactly where ceremonies
  fail; `~/.keybridge/logs/` (src/log.ts) is the always-on channel. Those
  host-side jsonl files are still the place to reconstruct WHAT tools were
  called when.
- A presenter failure is non-fatal by design (browser fallback: the human can
  still open authUrl) - but for the WINDOWLESS webkit presenter that turned
  real failures into silent 5-minute hangs ("no Touch ID, no error"; the
  2026-07-30 claude-worker incident: NpmLogin sat 156s with no prompt).
  Since then: shell-won't-start and shell-died-mid-ceremony throw FATAL
  `ESHELL` (poll aborts immediately), and any presenter failure emits a
  `presenter-failed` status event + log line.
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
- version_bump: yes (single package; infer patch/minor from changes). ALWAYS
  bump `.claude-plugin/plugin.json` to the same version in the same commit -
  run `pnpm sync:plugin` (or let `npm version` do it) and verify with
  `node scripts/sync-plugin-version.mjs --check`. Consumers stay on a stale
  plugin cache otherwise.
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
