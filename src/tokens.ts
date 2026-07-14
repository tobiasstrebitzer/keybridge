// Per-account npm token vault: lets keybridge keep MULTIPLE accounts signed
// in at once. npm's npmrc has a single _authToken slot per registry, so
// without this every account switch burns a ceremony; with it, a switch (or a
// user-pinned publish) reuses the stored token as long as it still works.
//
// Storage is ~/.keybridge/tokens.json with mode 0600 - the same protection
// (and the same risk surface) as ~/.npmrc itself, which stores the live token
// in plaintext. Web-login tokens expire after ~12h; users can park a granular
// access token per account (`keybridge token set <user>`) for long-lived,
// still-Touch-ID-gated publishing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KB_DIR = join(homedir(), '.keybridge')
const VAULT = join(KB_DIR, 'tokens.json')

export interface TokenEntry {
  token: string
  registry: string
  /** 'web' = ~12h session token captured at login; 'manual' = user-provided
   * (typically a granular access token, up to 90 days). */
  kind: 'web' | 'manual'
  savedAt: string
}

interface Vault { tokens: Record<string, TokenEntry> }

function loadVault (): Vault {
  try {
    const parsed = JSON.parse(readFileSync(VAULT, 'utf8')) as Partial<Vault>
    return { tokens: parsed.tokens ?? {} }
  } catch {
    return { tokens: {} }
  }
}

function saveVault (vault: Vault): void {
  mkdirSync(KB_DIR, { recursive: true })
  writeFileSync(VAULT, JSON.stringify(vault, null, 2), { mode: 0o600 })
}

export function saveToken (username: string, entry: Omit<TokenEntry, 'savedAt'>): void {
  const vault = loadVault()
  vault.tokens[username] = { ...entry, savedAt: new Date().toISOString() }
  saveVault(vault)
}

export function getToken (username: string): TokenEntry | null {
  return loadVault().tokens[username] ?? null
}

export function deleteToken (username: string): boolean {
  const vault = loadVault()
  if (!vault.tokens[username]) return false
  delete vault.tokens[username]
  saveVault(vault)
  return true
}

/** Vault contents WITHOUT the secrets - for status displays. */
export function listTokenMeta (): Array<{ username: string, kind: TokenEntry['kind'], registry: string, savedAt: string }> {
  return Object.entries(loadVault().tokens)
    .map(([username, e]) => ({ username, kind: e.kind, registry: e.registry, savedAt: e.savedAt }))
}

/** True when both URLs point at the same registry host. */
export function sameRegistry (a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host
  } catch {
    return false
  }
}

/** The npm config key npm reads a registry's auth token from. */
export function authTokenKey (registry: string): string {
  return `//${new URL(registry).host}/:_authToken`
}

/** Env override that makes any spawned `npm` authenticate with `token` -
 * without touching npmrc (npm reads `npm_config_<key>` env vars). */
export function tokenEnv (registry: string, token: string): Record<string, string> {
  return { [`npm_config_${authTokenKey(registry)}`]: token }
}
