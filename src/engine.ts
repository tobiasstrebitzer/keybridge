// Core engine: wraps `npm publish --json`, catches npm's EOTP web-auth error
// (authUrl/doneUrl contract, npm CLI >= 11.6 / #8952), hands the WebAuthn
// ceremony to a presenter (off-screen Chrome, browser tab, ...), polls doneUrl
// for the one-time token, and retries the publish with --otp=<token>.
//
// The doneUrl polling protocol mirrors npm-profile's webAuthCheckLogin:
//   GET doneUrl -> 202 + retry-after header while pending
//               -> 200 + {"token": "..."} once the human completed WebAuthn

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface NpmErrorJson {
  code?: string
  summary?: string
  detail?: string
  authUrl?: string
  doneUrl?: string
}

export interface NpmJson {
  error?: NpmErrorJson
  id?: string
  name?: string
  [key: string]: unknown
}

export interface NpmRunResult {
  code: number | null
  stdout: string
  stderr: string
  json: NpmJson | null
}

/** Gets the human to the WebAuthn ceremony; aborted via `signal` once done. */
export type Presenter = (opts: { authUrl: string, signal: AbortSignal }) => Promise<unknown> | unknown

export interface StatusEvent {
  phase: 'publish-attempt' | 'login-required' | 'minting-session' | 'awaiting-human' | 'login-complete' | 'publish-retry'
  authUrl?: string
  purpose?: 'login' | 'publish'
  npmrc?: string
  code?: string
}

export type OnStatus = (event: StatusEvent) => void

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface PublishErrorDetail {
  code?: string
  stdout?: string
  stderr?: string
  json?: NpmJson | null
}

export class PublishError extends Error {
  code: string
  stdout: string | undefined
  stderr: string | undefined
  json: NpmJson | null | undefined

  constructor (message: string, { code = 'EPUBLISH', stdout, stderr, json }: PublishErrorDetail = {}) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
    this.json = json
  }

  /**
   * Message with the npm stderr tail folded in - for surfaces that only show
   * `message` (MCP tool results), where a bare npm summary like "command
   * failed" is undiagnosable. The CLI prints stderr separately instead.
   */
  fullMessage (): string {
    const detail = (this.stderr ?? '').trim()
    return detail ? `${this.message}\n${detail.slice(-800)}` : this.message
  }
}

const parseJson = (text: string): NpmJson | null => {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch {}
  // npm occasionally prefixes JSON output with notices; fall back to the first brace
  const i = trimmed.indexOf('{')
  if (i === -1) return null
  try { return JSON.parse(trimmed.slice(i)) } catch { return null }
}

export interface RunNpmOptions {
  cwd?: string
  npmBin?: string
  env?: NodeJS.ProcessEnv
}

export function runNpm (args: string[], { cwd, npmBin = 'npm', env }: RunNpmOptions = {}): Promise<NpmRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(npmBin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d })
    child.stderr.on('data', (d: Buffer) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, json: parseJson(stdout) }))
  })
}

// Read the auth token npm would use for this registry host. npm marks
// _authToken as protected (`npm config get` refuses to print it), so we
// resolve it the way npm does: env var, then project .npmrc, then the
// user config (--userconfig from npmArgs, or ~/.npmrc). Returns null when
// no token is configured - doneUrl polling then runs unauthenticated.
export async function getAuthToken (
  registryLikeUrl: string,
  { cwd = process.cwd(), npmArgs = [] }: { cwd?: string, npmArgs?: string[] } = {},
): Promise<string | null> {
  const { host } = new URL(registryLikeUrl)
  const key = `//${host}/:_authToken`

  const fromEnv = process.env[`npm_config_${key}`]
  if (fromEnv) return fromEnv

  let userconfig = join(homedir(), '.npmrc')
  for (let i = 0; i < npmArgs.length; i++) {
    const a = npmArgs[i]!
    if (a === '--userconfig') userconfig = npmArgs[i + 1]!
    else if (a.startsWith('--userconfig=')) userconfig = a.slice('--userconfig='.length)
  }

  for (const file of [join(cwd, '.npmrc'), userconfig]) {
    const token = readNpmrcKey(file, key)
    if (token) return token
  }
  return null
}

// Persist a fresh session token the way `npm login` does: into the user
// npmrc (or the --userconfig file the caller passed). Preserves all other
// lines; replaces an existing token line for the host or appends one.
export function writeAuthToken (
  registryLikeUrl: string,
  token: string,
  { npmArgs = [] }: { npmArgs?: string[] } = {},
): string {
  const { host } = new URL(registryLikeUrl)
  const key = `//${host}/:_authToken`
  let file = join(homedir(), '.npmrc')
  for (let i = 0; i < npmArgs.length; i++) {
    const a = npmArgs[i]!
    if (a === '--userconfig') file = npmArgs[i + 1]!
    else if (a.startsWith('--userconfig=')) file = a.slice('--userconfig='.length)
  }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch {}
  const lines = text.split(/\r?\n/)
  const entry = `${key}=${token}`
  const idx = lines.findIndex((l) => {
    const eq = l.indexOf('=')
    return eq !== -1 && l.slice(0, eq).trim() === key
  })
  if (idx !== -1) lines[idx] = entry
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(entry)
  }
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
  return file
}

export interface LoginOptions {
  registry?: string
  cwd?: string
  npmBin?: string
  npmArgs?: string[]
  presenter?: Presenter
  onStatus?: OnStatus
  pollTimeoutMs?: number
  fetchImpl?: FetchLike
}

// Web-based login (what `npm login` does since Dec 2025 - yields a session
// token, currently ~12h): POST /-/v1/login with npm-auth-type: web, hand the
// loginUrl to the human, poll doneUrl, persist the token.
export async function loginWithWebAuth ({
  registry,
  cwd = process.cwd(),
  npmBin = 'npm',
  npmArgs = [],
  presenter,
  onStatus = () => {},
  pollTimeoutMs = 300_000,
  fetchImpl = fetch,
}: LoginOptions = {}): Promise<{ registry: string, npmrc: string }> {
  if (!presenter) throw new TypeError('loginWithWebAuth requires a presenter')
  registry ??= await resolveRegistry({ cwd, npmBin, npmArgs })
  const res = await fetchImpl(`${registry.replace(/\/+$/, '')}/-/v1/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'keybridge (npm publish web-auth bridge)',
      'npm-auth-type': 'web',
      'npm-command': 'login',
    },
    body: JSON.stringify({}),
  })
  const body = await res.json().catch(() => ({})) as { loginUrl?: string, doneUrl?: string }
  if (res.status !== 200 || !body.loginUrl || !body.doneUrl) {
    throw new PublishError(`could not start web login (registry answered ${res.status})`, { code: 'EWEBLOGIN', json: body as NpmJson })
  }
  const { loginUrl, doneUrl } = body

  onStatus({ phase: 'awaiting-human', authUrl: loginUrl, purpose: 'login' })
  const presenterAbort = new AbortController()
  let presenterError: Error | null = null
  const presentation = Promise.resolve()
    .then(() => presenter({ authUrl: loginUrl, signal: presenterAbort.signal }))
    .catch((e: Error) => { presenterError = e })

  let token: string
  try {
    token = await pollDoneUrl(doneUrl, { timeoutMs: pollTimeoutMs, fetchImpl })
  } catch (e) {
    if (presenterError && e instanceof Error) e.message += ` (presenter also failed: ${(presenterError as Error).message})`
    throw e
  } finally {
    presenterAbort.abort()
    await presentation
  }

  const npmrc = writeAuthToken(registry, token, { npmArgs })
  onStatus({ phase: 'login-complete', npmrc })
  return { registry, npmrc }
}

function readNpmrcKey (file: string, key: string): string | null {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return null }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() !== key) continue
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
    // npmrc supports ${VAR} environment expansion
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
  }
  return null
}

// npm < 12 redacts the session ids in its --json error output (authUrl and
// doneUrl arrive as ".../auth/cli/***" - @npmcli/redact runs over the JSON
// payload; fixed in npm 12). When that happens the URLs are useless, so we
// mint a replacement web-auth session ourselves: a metadata-only PUT (no
// tarball) to the package route with `npm-auth-type: web` makes the registry
// create a fresh, live session and return unredacted URLs in the 401 body.
// Completing that ceremony yields an OTP valid for the real publish retry.
export const isRedacted = (url: unknown): boolean => typeof url !== 'string' || url.includes('***')

export async function resolveRegistry (
  { cwd = process.cwd(), npmBin = 'npm', npmArgs = [] }: { cwd?: string, npmBin?: string, npmArgs?: string[] } = {},
): Promise<string> {
  for (let i = 0; i < npmArgs.length; i++) {
    const a = npmArgs[i]!
    if (a === '--registry') return npmArgs[i + 1]!
    if (a.startsWith('--registry=')) return a.slice('--registry='.length)
  }
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { publishConfig?: { registry?: string } }
    if (pkg.publishConfig?.registry) return pkg.publishConfig.registry
  } catch {}
  const cfgFlags = npmArgs.filter((a, i, arr) =>
    a.startsWith('--userconfig') || a.startsWith('--globalconfig') ||
    arr[i - 1] === '--userconfig' || arr[i - 1] === '--globalconfig')
  const res = await runNpm(['config', 'get', 'registry', ...cfgFlags], { cwd, npmBin })
  const value = res.stdout.trim()
  if (!value || value === 'undefined') throw new PublishError('could not resolve registry URL', { code: 'ECONFIG' })
  return value
}

export async function mintWebAuthSession (
  { registry, pkgName, authToken, fetchImpl = fetch }:
  { registry: string, pkgName: string, authToken?: string | null, fetchImpl?: FetchLike },
): Promise<{ authUrl: string, doneUrl: string }> {
  const escaped = pkgName.replace('/', '%2F')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent': 'keybridge (npm publish web-auth bridge)',
    'npm-auth-type': 'web',
    'npm-command': 'publish',
  }
  if (authToken) headers.authorization = `Bearer ${authToken}`
  const res = await fetchImpl(`${registry.replace(/\/+$/, '')}/${escaped}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ _id: pkgName, name: pkgName }),
  })
  const body = await res.json().catch(() => ({})) as { authUrl?: string, doneUrl?: string }
  if (res.status !== 401 || !body.authUrl || !body.doneUrl) {
    throw new PublishError(
      `could not create a web-auth session (registry answered ${res.status})`,
      { code: 'EWEBLOGIN', json: body as NpmJson }
    )
  }
  if (isRedacted(body.authUrl) || isRedacted(body.doneUrl)) {
    throw new PublishError('registry returned redacted web-auth URLs', { code: 'EWEBLOGIN' })
  }
  return { authUrl: body.authUrl, doneUrl: body.doneUrl }
}

export async function pollDoneUrl (
  doneUrl: string,
  { authToken, timeoutMs = 300_000, signal, fetchImpl = fetch }:
  { authToken?: string | null, timeoutMs?: number, signal?: AbortSignal, fetchImpl?: FetchLike } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const headers: Record<string, string> = { accept: 'application/json', 'npm-auth-type': 'web' }
  if (authToken) headers.authorization = `Bearer ${authToken}`
  while (true) {
    signal?.throwIfAborted()
    if (Date.now() > deadline) {
      throw new PublishError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for WebAuthn approval`, { code: 'ETIMEDOUT' })
    }
    const res = await fetchImpl(doneUrl, { headers, signal })
    if (res.status === 200) {
      const body = await res.json() as { token?: string }
      if (!body.token) throw new PublishError('Registry returned 200 from doneUrl without a token', { code: 'EWEBLOGIN' })
      return body.token
    }
    if (res.status === 202) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await delay(retryAfter > 0 ? retryAfter * 1000 : 1000, null, { signal })
      continue
    }
    throw new PublishError(`Unexpected status ${res.status} while polling doneUrl`, { code: 'EWEBLOGIN' })
  }
}

export interface PublishOptions {
  /** extra args forwarded to `npm publish` */
  npmArgs?: string[]
  /** package directory */
  cwd?: string
  npmBin?: string
  /** gets the human to the WebAuthn ceremony; aborted via signal once done */
  presenter?: Presenter
  /** progress callback */
  onStatus?: OnStatus
  /** how long to wait for the human */
  pollTimeoutMs?: number
  autoLogin?: boolean
}

export interface PublishOutcome {
  published: boolean
  usedWebAuth: boolean
  result: NpmJson | null
}

/** Publish with WebAuthn hand-off. */
export async function publishWithWebAuth ({
  npmArgs = [],
  cwd = process.cwd(),
  npmBin = 'npm',
  presenter,
  onStatus = () => {},
  pollTimeoutMs = 300_000,
  autoLogin = true,
}: PublishOptions = {}): Promise<PublishOutcome> {
  if (!presenter) throw new TypeError('publishWithWebAuth requires a presenter')

  onStatus({ phase: 'publish-attempt' })
  const first = await runNpm(['publish', '--json', ...npmArgs], { cwd, npmBin })
  if (first.code === 0) {
    return { published: true, usedWebAuth: false, result: first.json }
  }

  const err = first.json?.error

  // Expired 12h session token or no login at all: run the web-login
  // ceremony, persist the fresh token, then start over (the publish itself
  // will still demand its own 2FA verification - a second touch).
  if (autoLogin && (err?.code === 'ENEEDAUTH' || err?.code === 'E401')) {
    onStatus({ phase: 'login-required', code: err.code })
    await loginWithWebAuth({ cwd, npmBin, npmArgs, presenter, onStatus, pollTimeoutMs })
    return publishWithWebAuth({
      npmArgs, cwd, npmBin, presenter, onStatus, pollTimeoutMs, autoLogin: false,
    })
  }

  if (!(err?.code === 'EOTP' && err.authUrl && err.doneUrl)) {
    throw new PublishError(err?.summary || `npm publish failed (exit ${first.code})`, {
      code: err?.code ?? 'EPUBLISH',
      stdout: first.stdout,
      stderr: first.stderr,
      json: first.json,
    })
  }

  let { authUrl, doneUrl } = err
  let authToken: string | null
  if (isRedacted(authUrl) || isRedacted(doneUrl)) {
    // npm < 12: --json output redacted the session ids; mint our own session
    onStatus({ phase: 'minting-session' })
    const registry = await resolveRegistry({ cwd, npmBin, npmArgs })
    authToken = await getAuthToken(registry, { cwd, npmArgs })
    let pkgName: string
    try {
      pkgName = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string }).name
    } catch (e) {
      throw new PublishError(`could not read package name from ${cwd}: ${(e as Error).message}`, { code: 'ECONFIG' })
    }
    ;({ authUrl, doneUrl } = await mintWebAuthSession({ registry, pkgName, authToken }))
  } else {
    authToken = await getAuthToken(doneUrl, { cwd, npmArgs })
  }

  onStatus({ phase: 'awaiting-human', authUrl, purpose: 'publish' })

  const presenterAbort = new AbortController()
  let presenterError: Error | null = null
  const presentation = Promise.resolve()
    .then(() => presenter({ authUrl: authUrl!, signal: presenterAbort.signal }))
    .catch((e: Error) => { presenterError = e })

  let otp: string
  try {
    otp = await pollDoneUrl(doneUrl, { authToken, timeoutMs: pollTimeoutMs })
  } catch (e) {
    if (presenterError && e instanceof Error) e.message += ` (presenter also failed: ${(presenterError as Error).message})`
    throw e
  } finally {
    presenterAbort.abort()
    await presentation
  }

  onStatus({ phase: 'publish-retry' })
  const second = await runNpm(['publish', '--json', ...npmArgs, `--otp=${otp}`], { cwd, npmBin })
  if (second.code === 0) {
    return { published: true, usedWebAuth: true, result: second.json }
  }
  const err2 = second.json?.error
  throw new PublishError(err2?.summary || `npm publish failed after web auth (exit ${second.code})`, {
    code: err2?.code ?? 'EPUBLISH',
    stdout: second.stdout,
    stderr: second.stderr,
    json: second.json,
  })
}
