// Credential store + signing backends.
//
// A credential is a P-256 keypair scoped to an rpId. Two backends:
//   - secure-enclave: private key generated in the macOS Secure Enclave,
//     non-extractable, every signature gated by Touch ID (via the Swift
//     helper built by `keybridge setup`). The intended production backend.
//   - software: private key is a normal P-256 key stored (PEM) in the store
//     file. No hardware gate - used for tests and non-macOS machines.
//
// The store lives at ~/.keybridge/credentials.json. Public keys are stored
// base64url; the software backend additionally stores the private key PEM.
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const KB_DIR = join(homedir(), '.keybridge')
const STORE = join(KB_DIR, 'credentials.json')

const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url')
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url')

export interface CredentialRecord {
  credId: string
  rpId: string
  userHandle: string | null
  backend: string
  keyTag: string
  signCount: number
  publicKey?: { x: string, y: string }
  privateKeyPem?: string
}

export interface Signer {
  backend: string
  register (rpId: string, userHandle: string | null): { credId: Buffer, publicKey: { x: Buffer, y: Buffer } }
  selectForAssertion (rpId: string, allowIds: string[]): { record: CredentialRecord, signCount: number }
  sign (record: CredentialRecord, message: Buffer, reason: string): Promise<Buffer>
}

interface Store { credentials: CredentialRecord[] }

function loadStore (): Store {
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Store } catch { return { credentials: [] } }
}
function saveStore (store: Store): void {
  mkdirSync(KB_DIR, { recursive: true })
  writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function resolveBackend (): string {
  if (process.env.KEYBRIDGE_BACKEND) return process.env.KEYBRIDGE_BACKEND
  try {
    const cfg = JSON.parse(readFileSync(join(KB_DIR, 'config.json'), 'utf8')) as { backend?: string }
    if (cfg.backend) return cfg.backend
  } catch {}
  return 'software'
}

export function createSigner ({
  backend = resolveBackend(),
  helperPath = join(KB_DIR, 'keybridge-se-signer'),
}: { backend?: string, helperPath?: string } = {}): Signer {
  const seCreate = (keyTag: string): { x: Buffer, y: Buffer } => {
    const out = execFileSync(helperPath, ['create', '--tag', keyTag], { encoding: 'utf8' })
    const { x, y } = JSON.parse(out) as { x: string, y: string }
    return { x: Buffer.from(x, 'base64'), y: Buffer.from(y, 'base64') }
  }
  const seSign = (keyTag: string, message: Buffer, reason: string): Buffer => {
    const out = execFileSync(helperPath, [
      'sign', '--tag', keyTag, '--message', Buffer.from(message).toString('base64'), '--reason', reason,
    ], { encoding: 'utf8' })
    return Buffer.from((JSON.parse(out) as { signature: string }).signature, 'base64')
  }

  return {
    backend,

    register (rpId, userHandle) {
      const credIdBuf = randomBytes(16)
      const credId = b64url(credIdBuf)
      const keyTag = `bi.atomic.keybridge.${credId}`
      const record: CredentialRecord = {
        credId, rpId, userHandle, backend, keyTag, signCount: 0,
      }

      let x: Buffer, y: Buffer
      if (backend === 'secure-enclave') {
        ({ x, y } = seCreate(keyTag))
        record.publicKey = { x: b64url(x), y: b64url(y) }
      } else {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        const jwk = publicKey.export({ format: 'jwk' })
        x = fromB64url(jwk.x as string); y = fromB64url(jwk.y as string)
        record.publicKey = { x: jwk.x as string, y: jwk.y as string }
        record.privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
      }

      const store = loadStore()
      store.credentials.push(record)
      saveStore(store)
      return { credId: credIdBuf, publicKey: { x, y } }
    },

    // Pick a credential for this rpId (optionally constrained to allowIds),
    // bump + persist its signature counter, return the record.
    selectForAssertion (rpId, allowIds) {
      const store = loadStore()
      const candidates = store.credentials.filter((c) =>
        c.rpId === rpId && (allowIds.length === 0 || allowIds.includes(c.credId)))
      if (candidates.length === 0) {
        // ENOCRED is the fallback signal: the inject script hands the ceremony
        // to the real authenticator instead of failing the page (Bitwarden-
        // style fallbackRequested), so keybridge can coexist with other
        // passkeys for the same site.
        const err = new Error(`no keybridge credential for rpId "${rpId}"${allowIds.length ? ' matching allowCredentials' : ''}`) as Error & { code: string }
        err.code = 'ENOCRED'
        throw err
      }
      const record = candidates[candidates.length - 1]! // most recently registered
      record.signCount = (record.signCount ?? 0) + 1
      saveStore(store)
      return { record, signCount: record.signCount }
    },

    async sign (record, message, reason) {
      if (record.backend === 'secure-enclave') {
        return seSign(record.keyTag, message, reason)
      }
      return createSign('SHA256').update(message).sign(record.privateKeyPem!)
    },
  }
}

export function selfTestBackend (helperPath: string): boolean {
  try {
    execFileSync(helperPath, ['probe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

export const paths = { KB_DIR, STORE, existsSync }
