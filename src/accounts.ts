// The identity layer: `npm whoami` is the single source of truth for who the
// CLI is, and everything keybridge keeps locally is keyed off it and heals
// toward it.
//
// Three surfaces have to agree for a publish to work, and they can drift
// independently (that drift is exactly the "my key is not detected" failure):
//   1. the npmrc session token        -> `npm whoami` (authoritative)
//   2. the shell's website cookies    -> per-account WKWebsiteDataStore UUID
//   3. the WebAuthn credentials       -> `username` stamp in credentials.json
//
// accounts.json maps npm usernames to their website-data-store UUID so web
// sessions never bleed across accounts, and remembers the last active account
// as a fallback for when no session token exists. After EVERY successful
// login the binding is re-derived from `npm whoami` - even when the human
// signed in as someone unexpected, local state follows reality.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  loginWithWebAuth, resolveRegistry, runNpm, writeAuthToken, PublishError,
  type FetchLike, type OnStatus, type Presenter,
} from './engine.ts'
import { selectPresenter, type PresenterName } from './presenters/select.ts'
import { listCredentials, stampUsername, takeLastAsserted } from './signer.ts'
import { deleteToken, getToken, listTokenMeta, sameRegistry, saveToken, tokenEnv, type TokenEntry } from './tokens.ts'

const KB_DIR = join(homedir(), '.keybridge')
const ACCOUNTS = join(KB_DIR, 'accounts.json')

/** The fixed store id pre-accounts keybridge used for everything (mirrored in
 * WebShell.swift). Grandfathered to the first account ever recorded, so an
 * existing installation keeps its live npm web session. */
export const LEGACY_STORE_ID = '6b657962-7269-4467-8000-4b4579427231'

export interface AccountEntry {
  /** WKWebsiteDataStore identifier holding this account's web session. */
  storeId: string
  lastSeenAt?: string
}

interface AccountsFile {
  /** Last account confirmed by `npm whoami` - the fallback identity when no
   * session token exists (expired/logged out). */
  active: string | null
  accounts: Record<string, AccountEntry>
}

function loadAccounts (): AccountsFile {
  try {
    const parsed = JSON.parse(readFileSync(ACCOUNTS, 'utf8')) as Partial<AccountsFile>
    return { active: parsed.active ?? null, accounts: parsed.accounts ?? {} }
  } catch {
    return { active: null, accounts: {} }
  }
}

function saveAccounts (file: AccountsFile): void {
  mkdirSync(KB_DIR, { recursive: true })
  writeFileSync(ACCOUNTS, JSON.stringify(file, null, 2), { mode: 0o600 })
}

export interface IdentityOptions {
  cwd?: string
  npmBin?: string
  /** npm args of the surrounding command - only config-relevant flags
   * (--registry/--userconfig) are forwarded to `npm whoami`. */
  npmArgs?: string[]
}

export function configFlags (npmArgs: string[] = []): string[] {
  const flags: string[] = []
  for (let i = 0; i < npmArgs.length; i++) {
    const a = npmArgs[i]!
    if (a === '--registry' || a === '--userconfig') flags.push(a, npmArgs[++i]!)
    else if (a.startsWith('--registry=') || a.startsWith('--userconfig=')) flags.push(a)
  }
  return flags
}

/** Who the npm CLI currently is. Null when logged out / token expired. */
export async function whoami ({ cwd, npmBin = 'npm', npmArgs = [] }: IdentityOptions = {}): Promise<string | null> {
  try {
    const res = await runNpm(['whoami', ...configFlags(npmArgs)], { cwd, npmBin })
    const name = res.stdout.trim()
    return res.code === 0 && name ? name : null
  } catch {
    return null
  }
}

/**
 * The account's npm 2FA mode: 'auth-and-writes' (every publish demands a
 * fresh WebAuthn assertion - the mode keybridge is built for) or 'auth-only'
 * (the session token alone can publish - keybridge's human gate is silently
 * BYPASSED). Null when unknown (logged out, or a registry without profile
 * support).
 */
export async function twoFactorMode (
  { cwd, npmBin = 'npm', npmArgs = [], env }: IdentityOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  try {
    const res = await runNpm(['profile', 'get', '--json', ...configFlags(npmArgs)], { cwd, npmBin, env })
    if (res.code !== 0) return null
    const tfa = (res.json as { tfa?: { mode?: string | null } } | null)?.tfa
    return tfa?.mode ?? null
  } catch {
    return null
  }
}

/** Who a SPECIFIC token authenticates as - checked via an env override, so
 * nothing on disk changes. Null when the token is dead. */
export async function whoamiWithToken (
  token: string, registry: string, { cwd, npmBin = 'npm' }: IdentityOptions = {},
): Promise<string | null> {
  try {
    const res = await runNpm(['whoami', '--registry', registry], {
      cwd, npmBin, env: { ...process.env, ...tokenEnv(registry, token) },
    })
    const name = res.stdout.trim()
    return res.code === 0 && name ? name : null
  } catch {
    return null
  }
}

/** The vault token for `username` if it still works for `registry`; a dead
 * or wrong-user token is deleted on the spot (never trusted twice). */
async function validStoredToken (
  username: string, registry: string, opts: IdentityOptions,
): Promise<TokenEntry | null> {
  const stored = getToken(username)
  if (!stored || !sameRegistry(stored.registry, registry)) return null
  if (await whoamiWithToken(stored.token, registry, opts) === username) return stored
  deleteToken(username)
  return null
}

export function getActive (): string | null {
  return loadAccounts().active
}

/**
 * The store id a login for `username` should use: their recorded profile if
 * one exists, the legacy fixed store when nothing was ever recorded (that is
 * where a pre-accounts installation's session lives), otherwise a fresh UUID.
 * Pure - nothing is persisted until the login is confirmed via bindAccount.
 */
export function candidateStoreId (username?: string | null): string {
  const { accounts } = loadAccounts()
  if (username && accounts[username]) return accounts[username].storeId
  return Object.keys(accounts).length === 0 ? LEGACY_STORE_ID : randomUUID()
}

/**
 * Record that `storeId` now holds `username`'s web session. Any other account
 * that pointed at the same store lost its session (the cookies were
 * overwritten), so its binding is dropped. `activate: false` keeps the active
 * pointer where it is (mediated publishes run as another account without
 * changing whose CLI session this is).
 */
export function bindAccount (username: string, storeId: string, { activate = true } = {}): void {
  const file = loadAccounts()
  for (const [name, entry] of Object.entries(file.accounts)) {
    if (name !== username && entry.storeId === storeId) delete file.accounts[name]
  }
  file.accounts[username] = { storeId, lastSeenAt: new Date().toISOString() }
  if (activate) file.active = username
  saveAccounts(file)
}

/** Make `username` the active account without touching profile bindings -
 * used by the stored-token fast path, where no ceremony ran. */
export function setActive (username: string): void {
  const file = loadAccounts()
  file.active = username
  const entry = file.accounts[username]
  if (entry) entry.lastSeenAt = new Date().toISOString()
  saveAccounts(file)
}

/** Forget an account's profile binding (logout --web). Returns the store id
 * that held its session so the caller can purge it from disk. */
export function dropAccount (username: string): string | null {
  const file = loadAccounts()
  const entry = file.accounts[username]
  if (!entry) return null
  delete file.accounts[username]
  if (file.active === username) file.active = null
  saveAccounts(file)
  return entry.storeId
}

/** Registry host -> WebAuthn rpId of its human-facing site. Only the public
 * npm registry is known; elsewhere credential bookkeeping is skipped. */
export function rpIdForRegistry (registry: string): string | null {
  try {
    return new URL(registry).host === 'registry.npmjs.org' ? 'www.npmjs.com' : null
  } catch {
    return null
  }
}

/**
 * Post-login self-healing: ask `npm whoami` who we actually are, bind the
 * store to them, stamp the credential that answered the login ceremony with
 * their username, and stash the fresh token in the per-account vault. Passed
 * as `afterLogin` into the engine so even the automatic login inside a
 * publish keeps identity state truthful.
 */
export async function bindAfterLogin (
  storeId: string,
  opts: IdentityOptions = {},
  login?: { token: string, registry: string },
): Promise<string | null> {
  const user = await whoami(opts)
  if (!user) return null
  bindAccount(user, storeId)
  const asserted = takeLastAsserted()
  if (asserted) stampUsername([asserted], user)
  if (login) saveToken(user, { token: login.token, registry: login.registry, kind: 'web' })
  return user
}

export interface LoginAsOptions extends IdentityOptions {
  registry?: string
  presenterName?: PresenterName
  /** Test/caller override; when set, presenter selection (and the per-account
   * store binding that comes with it) is skipped. */
  presenter?: Presenter
  onStatus?: OnStatus
  pollTimeoutMs?: number
  fetchImpl?: FetchLike
}

export interface LoginAsResult {
  user: string
  registry: string
  npmrc: string
  /** True when the CLI identity changed compared to before the login. */
  switched: boolean
  /** True when a vault token made the switch instant (no ceremony ran). */
  usedStoredToken: boolean
}

/**
 * Unified login/switch flow.
 *
 * With `username`: log in AS that account. A still-valid vault token makes
 * the switch instant (validated, written to npmrc, no ceremony); otherwise
 * the account's own browser profile runs the web login - a live session
 * needs only Touch ID, a fresh profile surfaces the password window once.
 * Without `username`: refresh whoever `npm whoami` (or, logged out, the last
 * active account) says we are - always a real ceremony, since the point is a
 * fresh token.
 *
 * Afterwards `npm whoami` is the referee: the store binding follows whoever
 * the login actually produced, and a mismatch with the requested username is
 * a hard error (after state was corrected, so a retry starts clean).
 */
export async function loginAs (username: string | undefined, opts: LoginAsOptions = {}): Promise<LoginAsResult> {
  const { cwd, npmBin, npmArgs = [], registry, onStatus, pollTimeoutMs, fetchImpl } = opts
  const before = await whoami(opts)

  if (username && username !== before) {
    const wanted = registry ?? await resolveRegistry({ cwd, npmBin, npmArgs })
    const stored = await validStoredToken(username, wanted, opts)
    if (stored) {
      const npmrc = writeAuthToken(wanted, stored.token, { npmArgs })
      setActive(username)
      return { user: username, registry: wanted, npmrc, switched: true, usedStoredToken: true }
    }
  }

  const expected = username ?? before ?? getActive()
  const storeId = candidateStoreId(expected)
  const presenter = opts.presenter
    ?? selectPresenter(opts.presenterName, {
      webkit: { storeId, ...(expected ? { prefillUsername: expected } : {}) },
    }).presenter

  const { registry: usedRegistry, npmrc, token } = await loginWithWebAuth({
    registry, cwd, npmBin, npmArgs, presenter, onStatus, pollTimeoutMs, fetchImpl,
  })

  const actual = await whoami(opts)
  if (!actual) {
    throw new PublishError('login completed but `npm whoami` could not confirm the account', { code: 'EIDENTITY' })
  }
  bindAccount(actual, storeId)
  const asserted = takeLastAsserted()
  if (asserted) stampUsername([asserted], actual)
  saveToken(actual, { token, registry: usedRegistry, kind: 'web' })

  if (username && actual !== username) {
    throw new PublishError(
      `logged in as "${actual}", not "${username}" - that browser profile held ${actual}'s npm session. ` +
      `Run \`keybridge switch ${username}\` again: ${username} now gets a fresh profile and the window will ask for their password.`,
      { code: 'EACCOUNT' })
  }
  return { user: actual, registry: usedRegistry, npmrc, switched: before !== actual, usedStoredToken: false }
}

export interface Mediation {
  user: string
  /** The account's own browser profile for the ceremony. */
  storeId: string
  /** process.env + the account's auth token as an npm env override - run the
   * whole publish with this and the npmrc/CLI identity stays untouched. */
  env: NodeJS.ProcessEnv
  registry: string
}

/**
 * Publish AS `username` without switching the CLI session: possible whenever
 * the vault holds a still-working token for them. Returns null when there is
 * no such token (callers fall back to switching or erroring).
 */
export async function resolveMediation (
  username: string, opts: IdentityOptions & { registry?: string } = {},
): Promise<Mediation | null> {
  const registry = opts.registry ?? await resolveRegistry(opts).catch(() => 'https://registry.npmjs.org/')
  const stored = await validStoredToken(username, registry, opts)
  if (!stored) return null
  return {
    user: username,
    storeId: candidateStoreId(username),
    env: { ...process.env, ...tokenEnv(registry, stored.token) },
    registry,
  }
}

export interface PublishIdentity {
  /** `npm whoami`, or null when no valid session token exists. */
  user: string | null
  /** Fallback identity when user is null (last confirmed account). */
  active: string | null
  /** Store id the ceremony shell should run with. */
  storeId: string
}

/**
 * Resolve the identity a publish will run as, and self-heal the active
 * pointer while at it. When the token is expired (user null) the last active
 * account's profile is used, so the automatic re-login stays silent.
 */
export async function resolvePublishIdentity (opts: IdentityOptions = {}): Promise<PublishIdentity> {
  const user = await whoami(opts)
  const active = getActive()
  const owner = user ?? active
  const storeId = candidateStoreId(owner)
  if (user) bindAccount(user, storeId)
  return { user, active, storeId }
}

/**
 * Fail fast when the invisible ceremony is guaranteed to dead-end: every
 * enrolled key is stamped with some OTHER account's name. Unstamped keys give
 * the benefit of the doubt (pre-accounts enrollments; they link on the next
 * login). Callers should gate this on the webkit presenter - in a real
 * browser (fallback presenter) the user may own hardware keys we cannot see.
 */
export function assertSecurityKeyFor (username: string, registry: string): void {
  const rpId = rpIdForRegistry(registry)
  if (!rpId) return
  const creds = listCredentials().filter((c) => c.rpId === rpId)
  if (creds.some((c) => c.username === username || !c.username)) return
  const owners = [...new Set(creds.map((c) => c.username))].join(', ')
  throw new PublishError(
    creds.length === 0
      ? `no keybridge security key is enrolled - run \`keybridge enroll\` as "${username}" first`
      : `the enrolled keybridge security keys belong to ${owners}, not "${username}" - run \`keybridge enroll\` for this account first`,
    { code: 'ENOKEY' })
}

export interface AccountStatusEntry {
  username: string
  /** Recorded browser profile (web session) id, if any. */
  storeId: string | null
  /** Number of enrolled keybridge security keys stamped for this account. */
  securityKeys: number
  /** Vault token on file ('web' ~12h, 'manual' user-provided), unvalidated. */
  storedToken: TokenEntry['kind'] | null
  /** This is what `npm whoami` currently reports. */
  current: boolean
  /** Last account confirmed by a keybridge login. */
  active: boolean
  lastSeenAt?: string
}

export interface AccountsStatus {
  user: string | null
  active: string | null
  registry: string
  /** Current account's npm 2FA mode ('auth-and-writes' | 'auth-only' | null).
   * 'auth-only' means publishes skip the WebAuthn ceremony entirely. */
  twoFactorMode: string | null
  accounts: AccountStatusEntry[]
  /** Keys enrolled before username stamping existed - they link to the
   * current user automatically on the next successful login. */
  unlinkedKeys: number
  warnings: string[]
}

/** Merged identity view across npmrc token, browser profiles, and enrolled
 * credentials - with explicit warnings for every known divergence. */
export async function accountsStatus (opts: IdentityOptions & { registry?: string } = {}): Promise<AccountsStatus> {
  const user = await whoami(opts)
  const tfaMode = user ? await twoFactorMode(opts) : null
  const registry = opts.registry
    ?? await resolveRegistry(opts).catch(() => 'https://registry.npmjs.org/')
  const rpId = rpIdForRegistry(registry) ?? 'www.npmjs.com'
  const creds = listCredentials().filter((c) => c.rpId === rpId)
  const file = loadAccounts()
  const tokens = new Map(listTokenMeta().map((t) => [t.username, t.kind]))

  const names = new Set<string>(Object.keys(file.accounts))
  for (const c of creds) if (c.username) names.add(c.username)
  for (const t of tokens.keys()) names.add(t)
  if (user) names.add(user)

  const accounts: AccountStatusEntry[] = [...names].toSorted().map((username) => ({
    username,
    storeId: file.accounts[username]?.storeId ?? null,
    securityKeys: creds.filter((c) => c.username === username).length,
    storedToken: tokens.get(username) ?? null,
    current: username === user,
    active: username === file.active,
    ...(file.accounts[username]?.lastSeenAt ? { lastSeenAt: file.accounts[username].lastSeenAt } : {}),
  }))
  const unlinkedKeys = creds.filter((c) => !c.username).length

  const warnings: string[] = []
  if (user && tfaMode === 'auth-only') {
    warnings.push(
      `account 2FA mode is "auth-only" - npm publishes with the session token ALONE, no Touch ID / security key asked. ` +
      `keybridge's human approval gate is bypassed! Switch to "auth-and-writes": \`keybridge open https://www.npmjs.com/settings/${user}/tfa\``)
  }
  if (!user) {
    warnings.push(file.active
      ? `not logged in to npm (token missing or expired) - \`keybridge login\` re-authenticates as ${file.active}`
      : 'not logged in to npm - run `keybridge login`')
  } else {
    const mine = creds.filter((c) => c.username === user).length
    if (mine === 0 && unlinkedKeys === 0) {
      warnings.push(`no keybridge security key enrolled for "${user}" - publishes will fail; run \`keybridge enroll\``)
    }
    if (!file.accounts[user]) {
      warnings.push(`"${user}" has no keybridge browser profile yet - the next \`keybridge login\` creates one`)
    }
    if (file.active && file.active !== user) {
      warnings.push(`npm CLI session ("${user}") differs from the last keybridge login ("${file.active}") - keybridge follows the CLI session; the next login re-syncs this`)
    }
  }
  if (unlinkedKeys > 0) {
    warnings.push(`${unlinkedKeys} enrolled security ${unlinkedKeys === 1 ? 'key is' : 'keys are'} not linked to an account yet - linking happens automatically on the next login`)
  }

  return { user, active: file.active, registry, twoFactorMode: tfaMode, accounts, unlinkedKeys, warnings }
}
