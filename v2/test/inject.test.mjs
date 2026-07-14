import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto'

// Redirect HOME BEFORE importing the host modules: signer.js captures
// KB_DIR = join(homedir(), '.keybridge') at import time, so this must happen
// first or the software signer would write into the real ~/.keybridge.
const realHome = homedir()
process.env.HOME = mkdtempSync(join(tmpdir(), 'kb-v2-inject-'))
process.env.KEYBRIDGE_BACKEND = 'software'
test.after(() => { rmSync(process.env.HOME, { recursive: true, force: true }); process.env.HOME = realHome })

const { default: cbor } = await import('../host/cbor.js')
const { handleCreate, handleGet } = await import('../host/webauthn.js')
const { createSigner } = await import('../host/signer.js')

const b64url = (b) => Buffer.from(b).toString('base64url')
const HERE = dirname(fileURLToPath(import.meta.url))
const INJECT_SRC = readFileSync(join(HERE, '../extension/inject.js'), 'utf8')

// The host's own {$b64:...} -> base64url reviver (mirrors keybridge-webauthn-host.js).
function unwrap (v) {
  if (v && typeof v === 'object' && typeof v.$b64 === 'string') return v.$b64
  if (Array.isArray(v)) return v.map(unwrap)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) o[k] = unwrap(v[k])
    return o
  }
  return v
}

// Stub the native WebAuthn classes. Their prototype getters/methods THROW
// "Illegal invocation" — exactly like the real browser classes when invoked on
// an object lacking the internal slots. So if inject.js's mapped object fails to
// define an own property that shadows one of these, reading it here blows up —
// which is the precise failure mode we're guarding against.
function makeNativeClasses () {
  const illegal = (name) => () => { throw new TypeError(`Illegal invocation: ${name}`) }
  const throwingGetters = (proto, names) => {
    for (const n of names) Object.defineProperty(proto, n, { configurable: true, get: illegal(n) })
  }
  const throwingMethods = (proto, names) => {
    for (const n of names) Object.defineProperty(proto, n, { configurable: true, writable: true, value: illegal(n) })
  }

  class PublicKeyCredential {}
  throwingGetters(PublicKeyCredential.prototype, ['id', 'rawId', 'type', 'response', 'authenticatorAttachment'])
  throwingMethods(PublicKeyCredential.prototype, ['getClientExtensionResults', 'toJSON'])
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false)
  PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false)

  class AuthenticatorAttestationResponse {}
  throwingGetters(AuthenticatorAttestationResponse.prototype, ['clientDataJSON', 'attestationObject'])
  throwingMethods(AuthenticatorAttestationResponse.prototype,
    ['getAuthenticatorData', 'getPublicKey', 'getPublicKeyAlgorithm', 'getTransports'])

  class AuthenticatorAssertionResponse {}
  throwingGetters(AuthenticatorAssertionResponse.prototype, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'])

  return { PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse }
}

// Build a fake page `window` with a working postMessage event bus, load inject.js
// into it, and wire a daemon that answers via the REAL host signing code — the
// full page -> content -> host round trip, minus Chrome.
function loadInjectedPage (origin, signer) {
  const natives = makeNativeClasses()
  const listeners = []
  const window = {
    location: { origin },
    ...natives,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn) },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) },
    postMessage: (data) => { queueMicrotask(() => { for (const fn of listeners.slice()) fn({ source: window, data }) }) },
  }
  const navigator = {
    credentials: {
      create: async () => { throw new Error('real create should not be called') },
      get: async () => { throw new Error('real get should not be called') },
    },
  }

  // Free identifiers `window`/`navigator` in inject.js bind to these params;
  // every other global (Object, ArrayBuffer, Promise, btoa, DOMException, ...)
  // resolves to the real Node global, so cross-realm identity holds.
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', INJECT_SRC)(window, navigator)

  // Daemon: intercept inject's requests, sign with the host, post the result back.
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return
    const d = e.data
    if (!d || d.source !== 'keybridge-inject') return
    try {
      const options = unwrap(d.options)
      const credential = d.op === 'create'
        ? await handleCreate(options, d.origin, signer)
        : await handleGet(options, d.origin, signer)
      window.postMessage({ source: 'keybridge-content', id: d.id, resp: { ok: true, credential } })
    } catch (err) {
      window.postMessage({ source: 'keybridge-content', id: d.id, resp: { ok: false, error: String(err?.message ?? err) } })
    }
  })

  return { window, navigator, natives }
}

test('inject.js create/get: native prototypes, toJSON, and RP-verifiable crypto', async () => {
  const origin = 'https://webauthn.io'
  const rpId = 'webauthn.io'
  const signer = createSigner({ backend: 'software' })
  const { navigator, natives } = loadInjectedPage(origin, signer)
  const { PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse } = natives

  // inject.js should have forced UVPAA / conditional mediation to resolve true.
  assert.equal(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true)
  assert.equal(await PublicKeyCredential.isConditionalMediationAvailable(), true)

  // --- navigator.credentials.create()
  const regChallenge = randomBytes(32)
  const userId = randomBytes(8)
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: 'webauthn.io' },
      user: { id: userId, name: 'tobias', displayName: 'Tobias' },
      challenge: regChallenge,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    },
  })

  // Prototype patched: instanceof passes for RP libraries that check it.
  assert.ok(cred instanceof PublicKeyCredential, 'credential instanceof PublicKeyCredential')
  assert.ok(cred.response instanceof AuthenticatorAttestationResponse, 'response instanceof AuthenticatorAttestationResponse')

  // Own properties shadow the throwing native getters (no "Illegal invocation").
  assert.equal(cred.type, 'public-key')
  assert.equal(cred.authenticatorAttachment, 'platform')
  assert.ok(cred.rawId instanceof ArrayBuffer)
  assert.deepEqual(cred.getClientExtensionResults(), {})
  assert.ok(cred.response.clientDataJSON instanceof ArrayBuffer)
  assert.ok(cred.response.attestationObject instanceof ArrayBuffer)
  assert.ok(cred.response.getAuthenticatorData() instanceof ArrayBuffer)
  assert.equal(cred.response.getPublicKeyAlgorithm(), -7)
  assert.deepEqual(cred.response.getTransports(), ['internal'])

  // toJSON() is what @simplewebauthn sends to the server; must be own (native throws).
  const regJson = cred.toJSON()
  assert.equal(regJson.type, 'public-key')
  assert.equal(regJson.id, cred.id)
  const regCdj = JSON.parse(Buffer.from(regJson.response.clientDataJSON, 'base64url').toString('utf8'))
  assert.equal(regCdj.type, 'webauthn.create')
  assert.equal(regCdj.challenge, b64url(regChallenge))
  assert.equal(regCdj.origin, origin)

  // Extract the registered public key from the attestation, RP-style.
  const att = cbor.decode(Buffer.from(regJson.response.attestationObject, 'base64url'))
  assert.equal(att.get('fmt'), 'none')
  const authData = att.get('authData')
  const credIdLen = authData.readUInt16BE(53)
  const cose = cbor.decode(authData.subarray(55 + credIdLen))
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) },
    format: 'jwk',
  })

  // --- navigator.credentials.get()
  const authChallenge = randomBytes(32)
  const asr = await navigator.credentials.get({
    publicKey: {
      challenge: authChallenge,
      rpId,
      allowCredentials: [{ type: 'public-key', id: cred.rawId }],
      userVerification: 'required',
    },
  })

  assert.ok(asr instanceof PublicKeyCredential, 'assertion instanceof PublicKeyCredential')
  assert.ok(asr.response instanceof AuthenticatorAssertionResponse, 'response instanceof AuthenticatorAssertionResponse')
  assert.ok(asr.response.signature instanceof ArrayBuffer)

  const getJson = asr.toJSON()
  const getCdj = JSON.parse(Buffer.from(getJson.response.clientDataJSON, 'base64url').toString('utf8'))
  assert.equal(getCdj.type, 'webauthn.get')
  assert.equal(getCdj.challenge, b64url(authChallenge))

  // The proof: verify the assertion exactly as an RP does.
  const sigAuthData = Buffer.from(getJson.response.authenticatorData, 'base64url')
  const clientDataHash = createHash('sha256').update(Buffer.from(getJson.response.clientDataJSON, 'base64url')).digest()
  const signedMessage = Buffer.concat([sigAuthData, clientDataHash])
  const ok = createVerify('SHA256').update(signedMessage).verify(publicKey, Buffer.from(getJson.response.signature, 'base64url'))
  assert.equal(ok, true, 'assertion from inject.js must verify against the registered public key')
})
