// Core engine: wraps `npm publish --json`, catches npm's EOTP web-auth error
// (authUrl/doneUrl contract, npm CLI >= 11.6 / #8952), hands the WebAuthn
// ceremony to a presenter (browser tab, macOS sheet, ...), polls doneUrl for
// the one-time token, and retries the publish with --otp=<token>.
//
// The doneUrl polling protocol mirrors npm-profile's webAuthCheckLogin:
//   GET doneUrl -> 202 + retry-after header while pending
//               -> 200 + {"token": "..."} once the human completed WebAuthn

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export class PublishError extends Error {
  constructor (message, { code = 'EPUBLISH', stdout, stderr, json } = {}) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
    this.json = json
  }
}

const parseJson = (text) => {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch {}
  // npm occasionally prefixes JSON output with notices; fall back to the first brace
  const i = trimmed.indexOf('{')
  if (i === -1) return null
  try { return JSON.parse(trimmed.slice(i)) } catch { return null }
}

export function runNpm (args, { cwd, npmBin = 'npm', env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmBin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, json: parseJson(stdout) }))
  })
}

// Read the auth token npm would use for this registry host. npm marks
// _authToken as protected (`npm config get` refuses to print it), so we
// resolve it the way npm does: env var, then project .npmrc, then the
// user config (--userconfig from npmArgs, or ~/.npmrc). Returns null when
// no token is configured — doneUrl polling then runs unauthenticated.
export async function getAuthToken (registryLikeUrl, { cwd = process.cwd(), npmArgs = [] } = {}) {
  const { host } = new URL(registryLikeUrl)
  const key = `//${host}/:_authToken`

  const fromEnv = process.env[`npm_config_${key}`]
  if (fromEnv) return fromEnv

  let userconfig = join(homedir(), '.npmrc')
  for (let i = 0; i < npmArgs.length; i++) {
    const a = npmArgs[i]
    if (a === '--userconfig') userconfig = npmArgs[i + 1]
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
export function writeAuthToken (registryLikeUrl, token, { npmArgs = [] } = {}) {
  const { host } = new URL(registryLikeUrl)
  const key = `//${host}/:_authToken`
  let file = join(homedir(), '.npmrc')
  for (let i = 0; i < npmArgs.length; i++) {
    const a = npmArgs[i]
    if (a === '--userconfig') file = npmArgs[i + 1]
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

// Web-based login (what `npm login` does since Dec 2025 — yields a session
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
} = {}) {
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
  const body = await res.json().catch(() => ({}))
  if (res.status !== 200 || !body.loginUrl || !body.doneUrl) {
    throw new PublishError(`could not start web login (registry answered ${res.status})`, { code: 'EWEBLOGIN', json: body })
  }

  onStatus({ phase: 'awaiting-human', authUrl: body.loginUrl, purpose: 'login' })
  const presenterAbort = new AbortController()
  let presenterError = null
  const presentation = Promise.resolve()
    .then(() => presenter({ authUrl: body.loginUrl, signal: presenterAbort.signal }))
    .catch((e) => { presenterError = e })

  let token
  try {
    token = await pollDoneUrl(body.doneUrl, { timeoutMs: pollTimeoutMs, fetchImpl })
  } catch (e) {
    if (presenterError) e.message += ` (presenter also failed: ${presenterError.message})`
    throw e
  } finally {
    presenterAbort.abort()
    await presentation
  }

  const npmrc = writeAuthToken(registry, token, { npmArgs })
  onStatus({ phase: 'login-complete', npmrc })
  return { registry, npmrc }
}

function readNpmrcKey (file, key) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() !== key) continue
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
    // npmrc supports ${VAR} environment expansion
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
  }
  return null
}

// npm < 12 redacts the session ids in its --json error output (authUrl and
// doneUrl arrive as ".../auth/cli/***" — @npmcli/redact runs over the JSON
// payload; fixed in npm 12). When that happens the URLs are useless, so we
// mint a replacement web-auth session ourselves: a metadata-only PUT (no
// tarball) to the package route with `npm-auth-type: web` makes the registry
// create a fresh, live session and return unredacted URLs in the 401 body.
// Completing that ceremony yields an OTP valid for the real publish retry.
export const isRedacted = (url) => typeof url !== 'string' || url.includes('***')

export async function resolveRegistry ({ cwd = process.cwd(), npmBin = 'npm', npmArgs = [] } = {}) {
  for (let i = 0; i < npmArgs.length; i++) {
    if (npmArgs[i] === '--registry') return npmArgs[i + 1]
    if (npmArgs[i].startsWith('--registry=')) return npmArgs[i].slice('--registry='.length)
  }
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
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

export async function mintWebAuthSession ({ registry, pkgName, authToken, fetchImpl = fetch }) {
  const escaped = pkgName.replace('/', '%2F')
  const headers = {
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
  const body = await res.json().catch(() => ({}))
  if (res.status !== 401 || !body.authUrl || !body.doneUrl) {
    throw new PublishError(
      `could not create a web-auth session (registry answered ${res.status})`,
      { code: 'EWEBLOGIN', json: body }
    )
  }
  if (isRedacted(body.authUrl) || isRedacted(body.doneUrl)) {
    throw new PublishError('registry returned redacted web-auth URLs', { code: 'EWEBLOGIN' })
  }
  return { authUrl: body.authUrl, doneUrl: body.doneUrl }
}

export async function pollDoneUrl (doneUrl, { authToken, timeoutMs = 300_000, signal, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs
  const headers = { accept: 'application/json', 'npm-auth-type': 'web' }
  if (authToken) headers.authorization = `Bearer ${authToken}`
  while (true) {
    signal?.throwIfAborted()
    if (Date.now() > deadline) {
      throw new PublishError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for WebAuthn approval`, { code: 'ETIMEDOUT' })
    }
    const res = await fetchImpl(doneUrl, { headers, signal })
    if (res.status === 200) {
      const body = await res.json()
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

/**
 * Publish with WebAuthn hand-off.
 *
 * @param {object} opts
 * @param {string[]} opts.npmArgs      extra args forwarded to `npm publish`
 * @param {string}   opts.cwd          package directory
 * @param {Function} opts.presenter    async ({ authUrl, signal }) => void — must get the
 *                                     human to the WebAuthn ceremony; aborted via signal
 *                                     once the ceremony completes or times out
 * @param {Function} opts.onStatus     ({ phase, ...detail }) => void progress callback
 * @param {number}   opts.pollTimeoutMs how long to wait for the human
 */
export async function publishWithWebAuth ({
  npmArgs = [],
  cwd = process.cwd(),
  npmBin = 'npm',
  presenter,
  onStatus = () => {},
  pollTimeoutMs = 300_000,
  autoLogin = true,
} = {}) {
  if (!presenter) throw new TypeError('publishWithWebAuth requires a presenter')

  onStatus({ phase: 'publish-attempt' })
  const first = await runNpm(['publish', '--json', ...npmArgs], { cwd, npmBin })
  if (first.code === 0) {
    return { published: true, usedWebAuth: false, result: first.json }
  }

  const err = first.json?.error

  // Expired 12h session token or no login at all: run the web-login
  // ceremony, persist the fresh token, then start over (the publish itself
  // will still demand its own 2FA verification — a second touch).
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
  let authToken
  if (isRedacted(authUrl) || isRedacted(doneUrl)) {
    // npm < 12: --json output redacted the session ids; mint our own session
    onStatus({ phase: 'minting-session' })
    const registry = await resolveRegistry({ cwd, npmBin, npmArgs })
    authToken = await getAuthToken(registry, { cwd, npmArgs })
    let pkgName
    try {
      pkgName = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).name
    } catch (e) {
      throw new PublishError(`could not read package name from ${cwd}: ${e.message}`, { code: 'ECONFIG' })
    }
    ;({ authUrl, doneUrl } = await mintWebAuthSession({ registry, pkgName, authToken }))
  } else {
    authToken = await getAuthToken(doneUrl, { cwd, npmArgs })
  }

  onStatus({ phase: 'awaiting-human', authUrl })

  const presenterAbort = new AbortController()
  let presenterError = null
  const presentation = Promise.resolve()
    .then(() => presenter({ authUrl, signal: presenterAbort.signal }))
    .catch((e) => { presenterError = e })

  let otp
  try {
    otp = await pollDoneUrl(doneUrl, { authToken, timeoutMs: pollTimeoutMs })
  } catch (e) {
    if (presenterError) e.message += ` (presenter also failed: ${presenterError.message})`
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
