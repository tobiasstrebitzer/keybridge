// `keybridge setup` - compile the native helpers into ~/.keybridge and pick a
// signing backend. Safe to re-run anytime (existing credentials are untouched).
//
//   keybridge-se-signer   Secure Enclave P-256 signer (Touch ID gates every
//                         signature). Built from native/SecureEnclaveSigner.swift.
//   keybridge-webshell    windowless WKWebView ceremony shell. Built from
//                         native/WebShell.swift. (The webkit presenter also
//                         rebuilds this on demand when the source is newer.)
//   config.json           { backend: 'secure-enclave' | 'software' }
//
// The CryptoKit SecureEnclave API stores an on-disk key blob rather than a
// keychain item, so no entitlement or provisioning profile is required - an
// ad-hoc-signed binary works.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selfTestBackend } from './signer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const NATIVE_DIR = resolve(join(HERE, '..', 'native'))
const KB_DIR = join(homedir(), '.keybridge')

export interface SetupResult {
  backend: string
  helperPath: string | null
  shellPath: string | null
}

function buildSwift (source: string, out: string, log: (m: string) => void): void {
  log(`• building ${out} (swiftc) ...`)
  execFileSync('swiftc', ['-O', source, '-o', out], { stdio: ['ignore', 'inherit', 'inherit'] })
  try { execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'ignore' }) } catch {}
}

export function runSetup ({
  backend,
  log = (m: string) => console.error(m),
}: { backend?: string, log?: (m: string) => void } = {}): SetupResult {
  mkdirSync(KB_DIR, { recursive: true })

  if (platform() !== 'darwin') {
    writeFileSync(join(KB_DIR, 'config.json'), JSON.stringify({ backend: backend ?? 'software' }, null, 2))
    log('• non-macOS: software signing backend, default-browser presenter')
    return { backend: backend ?? 'software', helperPath: null, shellPath: null }
  }

  // 1. Secure Enclave signer - determines the backend.
  const helperPath = join(KB_DIR, 'keybridge-se-signer')
  if (!backend) {
    try {
      buildSwift(join(NATIVE_DIR, 'SecureEnclaveSigner.swift'), helperPath, log)
      log('• probing Secure Enclave (creates a throwaway key) ...')
      if (!selfTestBackend(helperPath)) throw new Error('probe failed')
      backend = 'secure-enclave'
      log('  ✓ Secure Enclave available - every signature will require Touch ID')
    } catch (e) {
      backend = 'software'
      log(`  ! Secure Enclave not usable (${String((e as Error).message).split('\n')[0]}) - falling back to software backend`)
    }
  }

  // 2. Ceremony shell (windowless WKWebView).
  let shellPath: string | null = join(KB_DIR, 'keybridge-webshell')
  try {
    buildSwift(join(NATIVE_DIR, 'WebShell.swift'), shellPath, log)
  } catch (e) {
    shellPath = null
    log(`  ! web shell build failed (${String((e as Error).message).split('\n')[0]}) - the default-browser presenter will be used`)
  }

  writeFileSync(join(KB_DIR, 'config.json'), JSON.stringify({ backend }, null, 2))
  log(`• backend: ${backend}  (override anytime with KEYBRIDGE_BACKEND=software|secure-enclave)`)
  return { backend, helperPath, shellPath }
}
