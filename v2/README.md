# keybridge v2 — WebAuthn interception bridge (PoC)

A different, more ambitious take than the v1 `authUrl`/`doneUrl` wrapper: a
**browser extension that intercepts the WebAuthn ceremony** and answers it from
a **local signing daemon** backed by the macOS **Secure Enclave** with a
**Touch ID** gate.

This is the same technique password managers (Bitwarden, 1Password) use to be
your passkey — the difference is the private key lives in your Secure Enclave
and the daemon can enforce policy and keep an audit log. The goal is the
original vision: *Claude asks → you touch the fingerprint sensor → done*, with
no visible browser step.

> Status: **proof of concept.** The signing pipeline is verified end-to-end
> (assertions are RP-verifiable); the browser + Touch ID legs need your
> interactive test. Not yet wired to npm.

## How it works

```
 web page (webauthn.io / npmjs.com)
   │  navigator.credentials.create/get(...)
   ▼
 inject.js         MAIN world — replaces navigator.credentials.*
   │  window.postMessage (serialized options)
   ▼
 content.js        ISOLATED world — relays to the background worker
   │  chrome.runtime.sendMessage
   ▼
 background.js     service worker — owns nativeMessaging
   │  chrome.runtime.sendNativeMessage  (length-prefixed JSON over stdio)
   ▼
 keybridge-webauthn-host.js     native host (Node)
   │  builds clientDataJSON / authenticatorData / attestationObject (COSE)
   ▼
 signer.js  ──▶  keybridge-se-signer (Swift, CryptoKit SecureEnclave)
                    │  ECDSA-P256/SHA-256 signature, gated by Touch ID
                    ▼
                  Secure Enclave  (private key never leaves hardware)
```

The authenticator never sees the origin — the RP does. We construct
`clientDataJSON` with the page's real origin and sign
`authenticatorData || SHA-256(clientDataJSON)`, exactly as a hardware key
would. To an RP it is an ordinary platform authenticator.

## Why the Secure Enclave path needs no entitlement

The obvious approach — an SE key in the keychain — requires a
`keychain-access-groups` entitlement backed by a provisioning profile; an
ad-hoc-signed CLI claiming it gets `Killed: 9`. This PoC instead uses
CryptoKit's `SecureEnclave.P256`, which stores an **opaque wrapped key blob on
disk** (`~/.keybridge/se-keys/`) that only this Mac's Secure Enclave can use.
No keychain, so **no entitlement and no Apple Developer identity required** —
an unsigned binary works. Verified on this machine.

## Install

```sh
node v2/install.mjs
```

This derives the unpacked-extension ID from the extension folder path, writes
the native-messaging host manifest for each Chromium-family browser found,
builds + ad-hoc-signs the Swift helper, probes the Secure Enclave, and records
the chosen backend in `~/.keybridge/config.json`.

Then, in Chrome:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `v2/extension`.
2. Check the extension ID matches the one the installer printed. If Chrome
   shows a different ID, re-run `node v2/install.mjs --ext-id <that-id>`.
3. **Restart Chrome** (native-messaging manifests are read at startup).

## Test on webauthn.io

1. Go to <https://webauthn.io>.
2. Pick a username, click **Register**. → Touch ID prompt (the daemon minting a
   Secure Enclave credential + signing the attestation).
3. Click **Authenticate**. → Touch ID prompt; the site should report success.

Watch `~/.keybridge/audit.log` for one line per ceremony, and the service
worker console (chrome://extensions → *service worker*) for errors. The DevTools
page console shows `[keybridge] WebAuthn bridge active`.

### Backends

`~/.keybridge/config.json` selects the signer; override per-invocation with
`KEYBRIDGE_BACKEND`:

| backend | key location | gate |
|---|---|---|
| `secure-enclave` (default on capable Macs) | Secure Enclave, blob in `~/.keybridge/se-keys/` | Touch ID per signature |
| `software` | P-256 PEM in `~/.keybridge/credentials.json` | none — tests / non-macOS |

## What's proven vs. open

**Proven (automated, `node --test 'v2/test/*.test.mjs'`):**
- CBOR + COSE + `authenticatorData` + `attestationObject` assembly.
- A registration→authentication round-trip whose assertion **verifies against
  the registered COSE public key** the way an RP verifies it (ECDSA-P256/
  SHA-256 over `authData || SHA-256(clientDataJSON)`), plus tamper and
  unknown-rpId negative checks.
- The same round-trip driven through the **native-messaging host** over the
  real length-prefixed stdio protocol.
- Swift helper compiles; Secure Enclave key creation works **unsigned**.

**Open (needs your interactive test / next steps):**
- The browser legs: MAIN-world override reaching a real ceremony, the
  messaging chain, and Chrome accepting our synthetic `PublicKeyCredential`
  (webauthn.io uses `@simplewebauthn/browser`).
- The **Touch ID signing** leg (blob reload + prompt + DER signature) — not
  exercised here to avoid an unexpected fingerprint prompt.
- **npm enrollment**: whether npmjs.com's security-key registration accepts a
  `none`-attestation platform authenticator. Only after that can this bridge
  publish. (Add `www.npmjs.com` is already in the manifest matches.)
- Hardening: origin/rpId allowlist policy, per-rp confirmation, credential
  management UI. The daemon already writes an audit log as a starting point.

## Security notes

- The private key is non-extractable in the Secure Enclave; the daemon can
  only ask it to sign, and only after Touch ID.
- The extension is scoped to `webauthn.io` and `www.npmjs.com` — it does not
  see WebAuthn on other sites.
- This intentionally makes your Mac an authenticator for accounts you enroll
  it on. Treat the daemon and its audit log as security-sensitive.
