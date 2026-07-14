import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// The signer persists to ~/.keybridge/credentials.json and captures KB_DIR from
// homedir() at import time. Redirect HOME BEFORE importing the host modules
// (ESM imports are hoisted), or the test would write into the real store.
const realHome = homedir()
process.env.HOME = mkdtempSync(join(tmpdir(), 'kb-v2-home-'))
process.env.KEYBRIDGE_BACKEND = 'software'
test.after(() => { rmSync(process.env.HOME, { recursive: true, force: true }); process.env.HOME = realHome })

const { default: cbor } = await import('../host/cbor.js')
const { handleCreate, handleGet } = await import('../host/webauthn.js')
const { createSigner } = await import('../host/signer.js')

const b64url = (b) => Buffer.from(b).toString('base64url')

// Parse an authenticatorData buffer into its WebAuthn fields.
function parseAuthData (buf) {
  const rpIdHash = buf.subarray(0, 32)
  const flags = buf[32]
  const signCount = buf.readUInt32BE(33)
  let credId, cose
  if (flags & 0x40) { // AT: attested credential data present
    const credIdLen = buf.readUInt16BE(53) // 16 aaguid + 2 len at offset 37..55
    credId = buf.subarray(55, 55 + credIdLen)
    cose = cbor.decode(buf.subarray(55 + credIdLen))
  }
  return { rpIdHash, flags, signCount, credId, cose }
}

function coseToPublicKey (cose) {
  // cose is a Map: 1=kty, 3=alg, -1=crv, -2=x, -3=y
  const x = b64url(cose.get(-2))
  const y = b64url(cose.get(-3))
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' })
}

test('registration → authentication produces an RP-verifiable ES256 assertion', async () => {
  const signer = createSigner({ backend: 'software' })
  const origin = 'https://webauthn.io'
  const rpId = 'webauthn.io'
  const userHandle = b64url(randomBytes(8))

  // --- create
  const regChallenge = b64url(randomBytes(32))
  const cred = await handleCreate({
    rp: { id: rpId, name: 'webauthn.io' },
    user: { id: userHandle, name: 'tobias', displayName: 'Tobias' },
    challenge: regChallenge,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  }, origin, signer)

  // clientDataJSON is well-formed and echoes challenge + origin
  const regCdj = JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8'))
  assert.equal(regCdj.type, 'webauthn.create')
  assert.equal(regCdj.challenge, regChallenge)
  assert.equal(regCdj.origin, origin)

  // attestationObject: fmt none, authData carries our rpIdHash + AT + COSE key
  const att = cbor.decode(Buffer.from(cred.response.attestationObject, 'base64url'))
  assert.equal(att.get('fmt'), 'none')
  const regAuth = parseAuthData(att.get('authData'))
  assert.deepEqual(regAuth.rpIdHash, createHash('sha256').update(rpId).digest())
  assert.ok(regAuth.flags & 0x01, 'UP set')
  assert.ok(regAuth.flags & 0x04, 'UV set')
  assert.ok(regAuth.flags & 0x40, 'AT set')
  assert.equal(b64url(regAuth.credId), cred.rawId)

  const publicKey = coseToPublicKey(regAuth.cose)

  // --- get (authentication) with the freshly registered credential
  const authChallenge = b64url(randomBytes(32))
  const asr = await handleGet({
    challenge: authChallenge,
    rpId,
    allowCredentials: [{ type: 'public-key', id: cred.rawId }],
    userVerification: 'required',
  }, origin, signer)

  const getCdj = JSON.parse(Buffer.from(asr.response.clientDataJSON, 'base64url').toString('utf8'))
  assert.equal(getCdj.type, 'webauthn.get')
  assert.equal(getCdj.challenge, authChallenge)
  assert.equal(asr.id, cred.id)
  assert.equal(asr.response.userHandle, userHandle)

  // The core proof: verify the signature exactly as an RP does —
  // ECDSA/SHA-256 over (authenticatorData || SHA-256(clientDataJSON)).
  const authData = Buffer.from(asr.response.authenticatorData, 'base64url')
  const clientDataHash = createHash('sha256').update(Buffer.from(asr.response.clientDataJSON, 'base64url')).digest()
  const signedMessage = Buffer.concat([authData, clientDataHash])
  const signature = Buffer.from(asr.response.signature, 'base64url')

  const ok = createVerify('SHA256').update(signedMessage).verify(publicKey, signature)
  assert.equal(ok, true, 'assertion signature must verify against the registered COSE public key')

  // signature counter advanced, and rpIdHash matches on assertion too
  const getAuth = parseAuthData(authData)
  assert.equal(getAuth.signCount, 1)
  assert.deepEqual(getAuth.rpIdHash, createHash('sha256').update(rpId).digest())
})

test('a tampered challenge breaks verification (sanity: we are really signing)', async () => {
  const signer = createSigner({ backend: 'software' })
  const origin = 'https://webauthn.io'
  const cred = await handleCreate({
    rp: { id: 'webauthn.io' }, user: { id: b64url(randomBytes(8)) },
    challenge: b64url(randomBytes(32)),
  }, origin, signer)
  const att = cbor.decode(Buffer.from(cred.response.attestationObject, 'base64url'))
  const publicKey = coseToPublicKey(parseAuthData(att.get('authData')).cose)

  const asr = await handleGet({
    challenge: b64url(randomBytes(32)), rpId: 'webauthn.io',
    allowCredentials: [{ type: 'public-key', id: cred.rawId }],
  }, origin, signer)

  const authData = Buffer.from(asr.response.authenticatorData, 'base64url')
  // hash a DIFFERENT clientDataJSON than what was signed
  const wrongHash = createHash('sha256').update('not-the-real-client-data').digest()
  const forged = Buffer.concat([authData, wrongHash])
  const ok = createVerify('SHA256').update(forged).verify(publicKey, Buffer.from(asr.response.signature, 'base64url'))
  assert.equal(ok, false)
})

test('assertion for an unknown rpId is refused with the ENOCRED fallback signal', async () => {
  const signer = createSigner({ backend: 'software' })
  await assert.rejects(
    handleGet({ challenge: b64url(randomBytes(32)), rpId: 'evil.example', allowCredentials: [] }, 'https://evil.example', signer),
    (e) => /no keybridge credential/.test(e.message) && e.code === 'ENOCRED'
  )
})
