// Assemble WebAuthn responses (the authenticator's job) from ceremony options
// the page passed. We are the "client + authenticator": we build the exact
// bytes an RP verifies. Signing (and where the private key lives) is delegated
// to the signer; here we only shape clientDataJSON / authenticatorData /
// attestationObject / COSE.
import { createHash } from 'node:crypto'
import { encode as cborEncode, type CborValue } from './cbor.ts'
import type { Signer } from './signer.ts'

const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url')

const rpIdHash = (rpId: string): Buffer => createHash('sha256').update(rpId, 'utf8').digest()

// flags byte: bit0 UP (user present), bit2 UV (user verified),
// bit6 AT (attested credential data included)
const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

/** Serialized WebAuthn credential (all binary fields base64url strings). */
export interface WireCredential {
  id: string
  rawId: string
  type: 'public-key'
  authenticatorAttachment: string
  response: Record<string, unknown>
}

/** create() options after unwrap: binary fields are base64url strings. */
export interface CreateOptions {
  rp?: { id?: string }
  user?: { id?: string }
  challenge: string
}

/** get() options after unwrap: binary fields are base64url strings. */
export interface GetOptions {
  rpId?: string
  challenge: string
  allowCredentials?: Array<{ id: string }>
}

function clientDataJSON (type: string, challengeB64url: string, origin: string): Buffer {
  // `challenge` in clientDataJSON is the base64url of the raw challenge - the
  // page handed it to us already base64url-encoded, so pass it through.
  return Buffer.from(JSON.stringify({
    type,
    challenge: challengeB64url,
    origin,
    crossOrigin: false,
  }), 'utf8')
}

function cosePublicKey (x: Buffer, y: Buffer): Buffer {
  // COSE_Key for an ES256 (ECDSA P-256) public key
  return cborEncode(new Map<CborValue, CborValue>([
    [1, 2],   // kty: EC2
    [3, -7],  // alg: ES256
    [-1, 1],  // crv: P-256
    [-2, Buffer.from(x)], // x-coordinate (32 bytes)
    [-3, Buffer.from(y)], // y-coordinate (32 bytes)
  ]))
}

function authenticatorData ({ rpId, flags, signCount, attestedCredentialData }: {
  rpId: string, flags: number, signCount: number, attestedCredentialData?: Buffer,
}): Buffer {
  const head = Buffer.alloc(37)
  rpIdHash(rpId).copy(head, 0)
  head[32] = flags
  head.writeUInt32BE(signCount >>> 0, 33)
  return attestedCredentialData ? Buffer.concat([head, attestedCredentialData]) : head
}

const rpIdFor = (explicit: string | undefined, origin: string): string =>
  explicit || new URL(origin).hostname

// navigator.credentials.create() - registration
export async function handleCreate (options: CreateOptions, origin: string, signer: Signer): Promise<WireCredential> {
  const rpId = rpIdFor(options.rp?.id, origin)
  const userHandle = options.user?.id ?? null // base64url string or null

  const cdj = clientDataJSON('webauthn.create', options.challenge, origin)
  const { credId, publicKey } = signer.register(rpId, userHandle)

  const aaguid = Buffer.alloc(16) // all zeros - self/none attestation
  const credIdLen = Buffer.alloc(2); credIdLen.writeUInt16BE(credId.length, 0)
  const attestedCredentialData = Buffer.concat([
    aaguid, credIdLen, credId, cosePublicKey(publicKey.x, publicKey.y),
  ])
  const authData = authenticatorData({
    rpId, flags: FLAG_UP | FLAG_UV | FLAG_AT, signCount: 0, attestedCredentialData,
  })
  const attestationObject = cborEncode(new Map<CborValue, CborValue>([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]))

  return {
    id: b64url(credId),
    rawId: b64url(credId),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64url(cdj),
      attestationObject: b64url(attestationObject),
      authenticatorData: b64url(authData),
      publicKeyAlgorithm: -7,
      transports: ['internal'],
    },
  }
}

// navigator.credentials.get() - authentication
export async function handleGet (options: GetOptions, origin: string, signer: Signer): Promise<WireCredential> {
  const rpId = rpIdFor(options.rpId, origin)
  const allowIds = (options.allowCredentials ?? []).map((c) => c.id) // base64url strings

  const cdj = clientDataJSON('webauthn.get', options.challenge, origin)
  const { record, signCount } = signer.selectForAssertion(rpId, allowIds)

  const authData = authenticatorData({ rpId, flags: FLAG_UP | FLAG_UV, signCount })
  const clientDataHash = createHash('sha256').update(cdj).digest()
  const message = Buffer.concat([authData, clientDataHash])
  // Touch ID dialog reads: “"KeyBridge Agent" is trying to <reason>.”
  const signature = await signer.sign(record, message, `authenticate to ${rpId}`)

  return {
    id: record.credId,
    rawId: record.credId,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64url(cdj),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
      userHandle: record.userHandle ?? null,
    },
  }
}
