# keybridge ↔ npm WebAuthn — the proven end-to-end flow

Status: **fully verified live on 2026-07-14** against npm's production registry with the
account `tstrebitzer`. Enrollment, `npm login`, and `npm publish` all completed with a
purely-software Secure Enclave authenticator (no physical key), driven through an
isolated Chrome + the keybridge extension, with Touch ID as the only human step.

This document records the exact working flow and every edge case, gotcha, and nuance we
hit getting there. Read it before touching any of the moving parts — several of these
cost a debugging session to find.

---

## 1. What keybridge is

npm now requires a human WebAuthn ceremony (security key / passkey) for local publish:
classic tokens were revoked Dec 2025, new TOTP enrollment is closed, and bypass-2FA
granular tokens lose direct publish ~Jan 2027. keybridge lets an agent *initiate*
`npm publish` while a human approves via Touch ID — automating **around** the ceremony,
never the human touch itself (the touch is the security boundary).

The insight that makes it work: a WebAuthn ceremony is just **HTTP + a signature**. The
browser only (a) hosts the page JS, (b) is the HTTP client to npm, and (c) dispatches
`navigator.credentials.*` to an authenticator. None of that is cryptographic. keybridge
substitutes its own authenticator (a Secure Enclave key) for a physical one via a
browser-extension override of `navigator.credentials`, exactly the technique Bitwarden
and 1Password use.

---

## 2. The moving parts

```
page JS (npmjs.com / webauthn.io)
   │  navigator.credentials.create/get(...)
   ▼
v2/extension/inject.js         MAIN world — overrides navigator.credentials, builds a
   │                            spec-correct PublicKeyCredential from the daemon's reply
   │  window.postMessage
   ▼
v2/extension/content.js        ISOLATED world — relays page ⇄ background
   │  chrome.runtime.sendMessage
   ▼
v2/extension/background.js     service worker — owns nativeMessaging
   │  chrome.runtime.sendNativeMessage("bi.atomic.keybridge.webauthn", …)
   ▼
~/.keybridge/keybridge-launch.sh   /bin/sh wrapper → absolute node → host
   ▼
v2/host/keybridge-webauthn-host.js   assembles clientDataJSON / authData / attestation
   │                                  (v2/host/webauthn.js) and calls the signer
   ▼
v2/host/signer.js  →  ~/.keybridge/keybridge-se-signer (Swift, CryptoKit SecureEnclave.P256)
                       create: silent · sign: Touch ID (LocalAuthentication)
```

For the CLI side, `src/engine.js` handles the npm publish/login orchestration
(`mintWebAuthSession`, `pollDoneUrl`, `publishWithWebAuth`, `loginWithWebAuth`).

The credential store is `~/.keybridge/credentials.json` (one record per rpId: credId,
keyTag, publicKey, signCount; software backend also stores a PEM). Keys live in the
Secure Enclave — the store holds only public material + the SE key tag.

---

## 3. The exact working flow

### 3a. Enroll a keybridge passkey on the npm account (one-time)

npm settings → Two-Factor Authentication (`/settings/<user>/tfa`). Only "Security key"
is offered (TOTP enrollment is dead). Name it → npm calls `navigator.credentials.create()`
→ keybridge intercepts → `signer.register()` creates a **Secure Enclave** P-256 key
(silent, no Touch ID for creation) → returns a `none`-attestation credential (all-zero
AAGUID) → **npm accepts it** ("2FA Successfully Enabled", issues recovery codes).

Key result: **npm accepts a purely-software / SE-backed `none`-attestation passkey.**
(webauthn.io does too.) This was the load-bearing unknown; it is now a definite yes.

### 3b. `npm login` (web auth)

```
npm_config_browser=false npm login --auth-type=web
# prints (UNREDACTED — plain login output is not redacted):
#   Login at:
#   https://www.npmjs.com/login?next=/login/cli/<uuid>
```

Open that URL in the keybridge browser. Already-logged-in session → redirects to
`/escalate/webauthn?next=/login/cli/<uuid>` → click "Use security key" →
`navigator.credentials.get()` → keybridge → **Touch ID** → npm "Authentication
Successful" → the CLI's `doneUrl` poll returns a session token → written to `~/.npmrc`
(`//registry.npmjs.org/:_authToken=`), ~12h lifetime. `npm whoami` now works.

### 3c. `npm publish` (the real product flow)

```
npm version patch --no-git-tag-version          # bump to an unused version
npm_config_browser=false npm publish --auth-type=web
```

Non-TTY publish hits the 2FA wall and **exits 1** with an `EOTP` error whose URLs are
**REDACTED** on npm 11.x:

```
npm error code EOTP
npm error   https://www.npmjs.com/auth/cli/***
npm error   https://registry.npmjs.org/-/v1/done?authId=***
```

`/auth/cli/***` is a 404 — raw `npm publish` cannot complete non-interactively on
npm 11.x. keybridge recovers by minting its own session (`src/engine.js`):

1. `mintWebAuthSession({ registry, pkgName, authToken })` — metadata-only `PUT` to the
   package route with `npm-auth-type: web` + `Authorization: Bearer <token>` → the
   registry answers **401 with live, UNREDACTED** `authUrl` + `doneUrl`.
2. Open `authUrl` (`https://www.npmjs.com/auth/cli/<uuid>`) in the keybridge browser →
   `/escalate/webauthn` → "Use security key" → `get()` → keybridge → **Touch ID** →
   "Authentication Successful".
3. `pollDoneUrl(doneUrl, { authToken })` → 202 (retry-after) … → 200 `{ token }` — a
   16-char OTP.
4. `npm publish --otp=<otp>` → `+ keybridge-test@<version>`. Verified live.

The whole publish (mint → drive ceremony → poll → publish) is what `publishWithWebAuth`
does end-to-end; it takes a `presenter({ authUrl, signal })` callback whose only job is
to get the human to the ceremony.

---

## 4. npm's WebAuthn HTTP contract (captured 2026-07-14)

This is npm's **private** web API (unversioned; `spiferack` = their "return JSON app
state instead of HTML" mechanism). Captured from the live publish ceremony.

**Challenge delivery** — `GET /escalate/webauthn?next=<next>` with header `x-spiferack: 1`
+ website session cookies returns the page's JSON state, which includes the
`navigator.credentials.get()` options (challenge, rpId=`npmjs.com`, allowCredentials,
csrftoken). No separate XHR — the challenge ships with the escalate page load.

**Assertion submit** — verified request:

```
POST https://www.npmjs.com/escalate/webauthn?next=<next>
Headers: content-type: application/json
         x-requested-with: XMLHttpRequest
         x-spiferack: 1
         origin: https://www.npmjs.com
         cookie: wub=<website session>; cs=<csrf>; __cf_bm=…; _cfuvid=…
Body:
{
  "formName": "webauthn",
  "isTfaEscalation": false,
  "isNewPublishAuthEscalation": true,           // login uses different flags
  "isNewPasswordResetFlowEscalation": false,
  "webAuthnAssertion": {
    "type": "public-key",
    "id":    "<credId b64url>",
    "rawId": "<credId b64url>",
    "response": {
      "clientDataJSON":    "<b64url>",           // {type:webauthn.get, challenge, origin:https://www.npmjs.com}
      "authenticatorData": "<b64url>",
      "signature":         "<b64url>",
      "userHandle":        "<b64url>"
    },
    "clientExtensionResults": {}
  },
  "didOptForCooldown": false,                    // the "don't challenge for 5 min" checkbox
  "csrftoken": "<cs cookie value>",
  "errorCount": 0
}
→ 200, header renderername: auth/authentication-successful
```

Then the CLI-facing `doneUrl` (`https://registry.npmjs.org/-/v1/done?authId=<uuid>`)
flips from 202 to 200 `{ token }`.

**Important:** the escalate endpoints authenticate with the npmjs.com **website session
cookie** (`wub`), *not* the registry Bearer token. See the headless research doc for why
that matters.

---

## 5. Edge cases, gotchas, and nuances (the expensive list)

### WebAuthn object shape (the reason the extension "just failed" at first)
- **Prototype patching is mandatory.** `inject.js` must
  `Object.setPrototypeOf(cred, PublicKeyCredential.prototype)` and the response to
  `AuthenticatorAttestation/AssertionResponse.prototype`. RP libs (`@simplewebauthn`,
  webauthn.io) do `instanceof` checks; a plain object literal is rejected and the
  ceremony throws in-page before anything reaches the server. `PublicKeyCredential` has
  no JS constructor, so you can't `new`/`extends` — you re-parent the prototype.
- **An own `toJSON()` is required once you patch the prototype.** Modern
  `@simplewebauthn` calls `PublicKeyCredential.prototype.toJSON`; the native method
  throws "Illegal invocation" on a synthetic object, so you must shadow it with your own.
- Provide the full L3 response surface: `getAuthenticatorData/getPublicKey/
  getPublicKeyAlgorithm/getTransports`, and rehydrate `DOMException` across the
  page/isolated JSON boundary. Polyfill `isUserVerifyingPlatformAuthenticatorAvailable`
  and `isConditionalMediationAvailable` → true so the passkey path is offered.

### Attestation
- npm and webauthn.io both accept `none` attestation (all-zero AAGUID). No attestation
  policy / AAGUID allowlist is enforced. This is what makes a software authenticator viable.

### Native messaging host launch (cost a debugging session)
- Chrome launches native-messaging hosts with a **stripped PATH** (`/usr/bin:/bin:…`),
  so `#!/usr/bin/env node` fails ("Native host has exited", exit 127 `env: node: No such
  file or directory`) because node lives in fnm/Homebrew. Fix: point the manifest at a
  `/bin/sh` launcher that `exec`s an **absolute** node path
  (`~/.keybridge/keybridge-launch.sh`). `/bin/sh` is always on the PATH.
- **Native-messaging manifest location depends on `--user-data-dir`.** With a custom
  profile, Chrome (macOS) looks in `<user-data-dir>/NativeMessagingHosts/`, **not** the
  standard `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. Symptom:
  "Specified native messaging host not found." `install.mjs` now writes the manifest to
  both. (The normal profile works only because its data dir *is* the standard path.)

### npm CLI behavior
- **npm 11.x redacts** `authUrl`/`doneUrl` in `--json` **and** in plain publish error
  output (`.../auth/cli/***`, via `@npmcli/redact`; fixed in npm 12). Plain `npm login`
  output is **not** redacted. Work around publish redaction by minting your own session
  (§3c).
- Non-TTY `npm publish` on the 2FA wall **exits 1** with EOTP (does not wait/poll).
- Arg parsing: always use `--flag=value`. `--loglevel silly` (space form) makes npm
  treat "silly" as a package spec.
- `_authToken` is protected from `npm config get` — parse `.npmrc` directly.

### Loading the extension in an automated Chrome
- **`--load-extension` is dead on Chrome 150** (stable) — silently ignored (anti-malware).
  The `--disable-features=DisableLoadExtensionCommandLineSwitch` escape hatch is also gone.
- Load via the **CDP Extensions domain** instead (`Extensions.loadUnpacked`, exposed by
  chrome-devtools-mcp's `install_extension` behind `--categoryExtensions`; needs a pipe
  connection — let the MCP launch Chrome, not `--browserUrl`). Requires
  `--enable-unsafe-extension-debugging` if you drive it over a raw ws port yourself.
- **`--headless=new` does not load unpacked extensions.** Must run headful (see headless
  research doc for the invisible-headed workaround).
- Unpacked extension **ID = SHA-256 of the absolute path** → loading from
  `v2/extension` always yields `hanmdmgojaeciaajdbjiaaafebcgkhkc`, which the native
  manifest's `allowed_origins` authorizes. Don't move the folder.

### Extension coexistence
- `inject.js` has **no fallback yet**: while installed it intercepts *all* WebAuthn on
  its matched hosts (`www.npmjs.com`, `webauthn.io`) and throws if it has no matching
  credential — so it breaks a login that uses a *different* authenticator. During the
  live test we uninstalled keybridge for the initial password login, then reinstalled it
  for enrollment. Hardening TODO: Bitwarden-style `fallbackRequested` → call the real
  `navigator.credentials` when keybridge has no credential for the rpId.

### signCount
- Each assertion bumps and persists `signCount`; npm/RP expects it non-decreasing. After
  login + publish the npm record read `signCount: 2`.

### Test isolation (bug we introduced and fixed)
- `signer.js` captures `KB_DIR = join(homedir(), '.keybridge')` at **import** time. ESM
  imports are hoisted, so tests that set `$HOME` *after* the import polluted the real
  store. Fix: set `$HOME` before a dynamic `import()` of the host modules. Verified the
  real store is untouched by a test run.

### MCP / test-browser config
- `.mcp.json` chrome-devtools args: `--channel=stable` (real Google Chrome — required so
  the fixed-path native-messaging manifest is found; Chrome for Testing would break it),
  `--userDataDir=<project>/.chrome-dev-profile` (persistent, gitignored),
  `--categoryExtensions`.
- After editing `.mcp.json`, the MCP server must be reconnected.

---

## 6. One-shot reproduction (from a clean CLI)

```bash
node v2/install.mjs                 # builds SE helper, launcher, manifests (incl. test profile)
# reconnect chrome-devtools MCP, then via the MCP:
#   install_extension  <repo>/v2/extension
#   navigate           https://www.npmjs.com/settings/<user>/tfa   → enroll (Touch ID-free create)
# login:
npm_config_browser=false npm login --auth-type=web    # open printed URL in keybridge browser → Touch ID
# publish:
cd keybridge-test && npm version patch --no-git-tag-version
node <scratch>/kb-mint.mjs          # mint → unredacted authUrl/doneUrl
#   navigate keybridge browser to authUrl → "Use security key" → Touch ID
node <scratch>/kb-publish.mjs       # pollDoneUrl → npm publish --otp=<otp>
```
