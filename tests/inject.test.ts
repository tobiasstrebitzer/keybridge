import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto'
import type { Signer } from '../src/signer.ts'

// Redirect HOME BEFORE importing the signer (it captures ~/.keybridge at
// import time), so the software signer writes into a throwaway store.
const realHome = homedir()
process.env.HOME = mkdtempSync(join(tmpdir(), 'kb-inject-'))
process.env.KEYBRIDGE_BACKEND = 'software'
test.after(() => { rmSync(process.env.HOME!, { recursive: true, force: true }); process.env.HOME = realHome })

const { decode } = await import('../src/cbor.ts')
const { handleCreate, handleGet } = await import('../src/webauthn.ts')
const { createSigner } = await import('../src/signer.ts')
const { unwrap } = await import('../src/presenters/webkit.ts')

const b64url = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url')
const HERE = dirname(fileURLToPath(import.meta.url))
const INJECT_SRC = readFileSync(join(HERE, '..', 'native', 'inject.js'), 'utf8')

/* eslint-disable  @typescript-eslint/no-explicit-any */
type Any = any

// Stub the native WebAuthn classes. Their prototype getters/methods THROW
// "Illegal invocation" - exactly like the real browser classes when invoked on
// an object lacking the internal slots. So if inject.js's mapped object fails
// to define an own property that shadows one of these, reading it here blows
// up - which is the precise failure mode we're guarding against.
const illegal = (name: string) => () => { throw new TypeError(`Illegal invocation: ${name}`) }

function makeNativeClasses () {
  const throwingGetters = (proto: object, names: string[]) => {
    for (const n of names) Object.defineProperty(proto, n, { configurable: true, get: illegal(n) })
  }
  const throwingMethods = (proto: object, names: string[]) => {
    for (const n of names) Object.defineProperty(proto, n, { configurable: true, writable: true, value: illegal(n) })
  }

  // The index signature keeps TS from narrowing test objects to a member-less
  // class after `assert.ok(x instanceof ...)` - the members are installed via
  // defineProperty above, invisible to the type system.
  class PublicKeyCredential {
    [key: string]: Any
    static isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false)
    static isConditionalMediationAvailable = () => Promise.resolve(false)
  }
  throwingGetters(PublicKeyCredential.prototype, ['id', 'rawId', 'type', 'response', 'authenticatorAttachment'])
  throwingMethods(PublicKeyCredential.prototype, ['getClientExtensionResults', 'toJSON'])

  class AuthenticatorAttestationResponse { [key: string]: Any }
  throwingGetters(AuthenticatorAttestationResponse.prototype, ['clientDataJSON', 'attestationObject'])
  throwingMethods(AuthenticatorAttestationResponse.prototype,
    ['getAuthenticatorData', 'getPublicKey', 'getPublicKeyAlgorithm', 'getTransports'])

  class AuthenticatorAssertionResponse { [key: string]: Any }
  throwingGetters(AuthenticatorAssertionResponse.prototype, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'])

  return { PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse }
}

interface WebAuthnBody { op: string, options: unknown, origin: string }

// Build a fake page `window` with a webkit.messageHandlers transport (what the
// WKWebView shell registers), load native/inject.js into it, and answer via
// the REAL signing code - the full page → shell → parent round trip, minus
// WebKit. `realCreate`/`realGet` stub the page's native navigator.credentials
// (the fallback target); `daemon` overrides the round trip with a scripted
// response for fault-injection tests.
function loadInjectedPage (origin: string, signer: Signer | null, {
  realCreate, realGet, daemon,
}: {
  realCreate?: (options: unknown) => Promise<unknown>
  realGet?: (options: unknown) => Promise<unknown>
  daemon?: (body: WebAuthnBody) => Promise<{ ok: boolean, credential?: unknown, error?: string, code?: string }>
} = {}) {
  const natives = makeNativeClasses()

  // The WithReply handler: postMessage returns a Promise of the parent's
  // response (mirrors WebShell.swift + the presenter's answerWebAuthn).
  const postMessage = async (body: WebAuthnBody) => {
    if (daemon) return daemon(body)
    try {
      const options = unwrap(body.options) as Any
      const credential = body.op === 'create'
        ? await handleCreate(options, body.origin, signer!)
        : await handleGet(options, body.origin, signer!)
      return { ok: true, credential }
    } catch (err) {
      const e = err as Error & { code?: string }
      return { ok: false, error: String(e?.message ?? err), ...(e?.code ? { code: e.code } : {}) }
    }
  }

  const window: Any = {
    location: { origin },
    ...natives,
    webkit: { messageHandlers: { keybridge: { postMessage } } },
  }
  const navigator: Any = {
    credentials: {
      create: realCreate ?? (async () => { throw new Error('real create should not be called') }),
      get: realGet ?? (async () => { throw new Error('real get should not be called') }),
    },
  }

  // Free identifiers `window`/`navigator` in inject.js bind to these params;
  // every other global (Object, ArrayBuffer, Promise, btoa, DOMException, ...)
  // resolves to the real Node global, so cross-realm identity holds.
  new Function('window', 'navigator', INJECT_SRC)(window, navigator)

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
  const att = decode(Buffer.from(regJson.response.attestationObject, 'base64url')) as Map<string, Buffer>
  assert.equal(att.get('fmt'), 'none')
  const authData = att.get('authData')!
  const credIdLen = authData.readUInt16BE(53)
  const cose = decode(authData.subarray(55 + credIdLen)) as Map<number, Buffer>
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)!), y: b64url(cose.get(-3)!) },
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

test('get() falls back to the real authenticator when keybridge has no credential (ENOCRED)', async () => {
  // Fresh store (fresh HOME) - no credential for npmjs.com exists.
  const signer = createSigner({ backend: 'software' })
  const sentinel = { native: 'assertion-from-real-authenticator' }
  let realGetOptions: unknown = null
  const { navigator } = loadInjectedPage('https://www.npmjs.com', signer, {
    realGet: async (options) => { realGetOptions = options; return sentinel },
  })

  const options = {
    publicKey: {
      challenge: randomBytes(32),
      rpId: 'npmjs.com',
      allowCredentials: [{ type: 'public-key', id: randomBytes(16) }],
    },
  }
  const result = await navigator.credentials.get(options)
  assert.equal(result, sentinel, 'the real authenticator result must be returned as-is')
  assert.equal(realGetOptions, options, 'the ORIGINAL options object (live ArrayBuffers) must be passed through')
})

test('create() falls back to the real authenticator on an ENOCRED response', async () => {
  const sentinel = { native: 'attestation-from-real-authenticator' }
  let realCreateOptions: unknown = null
  const { navigator } = loadInjectedPage('https://www.npmjs.com', null, {
    daemon: async () => ({ ok: false, error: 'no keybridge credential', code: 'ENOCRED' }),
    realCreate: async (options) => { realCreateOptions = options; return sentinel },
  })

  const options = { publicKey: { challenge: randomBytes(32), rp: { id: 'npmjs.com' }, user: { id: randomBytes(8) } } }
  const result = await navigator.credentials.create(options)
  assert.equal(result, sentinel)
  assert.equal(realCreateOptions, options)
})

test('non-ENOCRED errors still reject with NotAllowedError (no fallback)', async () => {
  let realGetCalled = false
  const { navigator } = loadInjectedPage('https://www.npmjs.com', null, {
    daemon: async () => ({ ok: false, error: 'signer exploded' }),
    realGet: async () => { realGetCalled = true; return {} },
  })

  await assert.rejects(
    navigator.credentials.get({ publicKey: { challenge: randomBytes(32), rpId: 'npmjs.com' } }),
    (e: unknown) => e instanceof DOMException && e.name === 'NotAllowedError' && /signer exploded/.test((e as Error).message),
  )
  assert.equal(realGetCalled, false, 'genuine failures must NOT fall back')
})

test('non-publicKey requests always pass straight through to the real API', async () => {
  const sentinel = { native: 'password-credential' }
  const { navigator } = loadInjectedPage('https://www.npmjs.com', null, {
    daemon: async () => { throw new Error('daemon must not be consulted') },
    realGet: async () => sentinel,
  })
  assert.equal(await navigator.credentials.get({ password: true }), sentinel)
})
