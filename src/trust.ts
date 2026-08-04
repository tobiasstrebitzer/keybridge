// npm trusted publishers (GitHub Actions OIDC), configured over the registry's
// HTTP API directly - the same EOTP -> web-auth -> retry dance publishing uses,
// but keybridge builds the request itself instead of driving `npm trust`.
//
// WHY NOT SHELL OUT TO `npm trust` (measured against npm 12.0.2, 2026-08-04):
//  - `otplease` (npm/lib/utils/auth.js) opens with
//    `if (!process.stdin.isTTY || !process.stdout.isTTY) throw err` - BEFORE
//    the web-auth branch. keybridge always spawns npm without a TTY, so a
//    wrapped `npm trust` fails fast with EOTP having only PRINTED authUrl /
//    doneUrl; the ceremony never runs. (Probed: exit 1, auth page never
//    fetched.) This is the decisive reason - not a preference.
//  - npm 11.x cannot send `permissions` at all (the field did not exist), and
//    the registry rejects any config without one, so a CLI wrapper would also
//    carry a hard npm >= 12 floor.
//  - npm 11's bundled npm-registry-fetch prints only `body.error`, while the
//    trust endpoint reports its reason in `body.message` (npm/cli#9377) - so
//    every misconfiguration surfaced as a bare, unexplained 400. Fixed in npm
//    12's bundle, but only there.
// Building the request here sidesteps all three: no TTY, no version floor, and
// the registry's own message reaches the user verbatim.
//
// `npm trust ... --otp=<token>` DOES work non-interactively (verified), so the
// CLI stays a viable fallback if npm's claim shapes ever move - but it buys
// nothing today.
//
// Wire format, from npm/lib/trust-cmd.js `createConfig()` + trust/github.js
// `optionsToBody()` (byte-identical to what npm 12.0.2 puts on the wire):
//   POST <registry>/-/package/<npa-escaped-name>/trust
//   [{ "type": "github",
//      "claims": { "repository": "owner/repo",
//                  "workflow_ref": { "file": "publish.yml" },
//                  "environment": "release" },     // only when set
//      "permissions": ["createPackage"] }]
// `npm trust list` is GET on the same URI, `revoke` is DELETE .../trust/<id>;
// both are 2FA-gated too - there is no cheap read path. GitLab and CircleCI
// are separate claim shapes and deliberately out of scope here.
import { setTimeout as delay } from 'node:timers/promises'
import {
  getAuthToken, presentAndPoll, resolveRegistry, PublishError,
  type FetchLike, type OnStatus, type Presenter,
} from './engine.ts'
import { kblog } from './log.ts'

/** npm's permission routes, keyed by the flag names `npm trust` exposes. */
export const TRUST_PERMISSIONS = {
  publish: 'createPackage',
  'stage-publish': 'createStagedPackage',
} as const

export type TrustPermission = keyof typeof TRUST_PERMISSIONS

export interface GithubTrustClaims {
  repository: string
  workflow_ref: { file: string }
  environment?: string
}

export interface TrustConfigBody {
  type: 'github'
  claims: GithubTrustClaims
  permissions: string[]
}

export interface TrustSubject {
  /** GitHub `owner/repo` that publishes. */
  repository: string
  /** Workflow FILENAME (e.g. "publish.yml"), never a path. */
  workflow: string
  /** CI environment name; omit unless the workflow declares one. */
  environment?: string
  /** At least one required - the registry 400s without it. */
  permissions?: TrustPermission[]
}

/** npm-package-arg's `escapedName`: the single scope slash becomes %2f. */
export function escapePackageName (name: string): string {
  return name.replace('/', '%2f')
}

/**
 * Build the POST body, applying npm's own pre-flight validation so a bad
 * repo/workflow fails here rather than as an opaque registry 400.
 */
export function githubTrustConfig ({ repository, workflow, environment, permissions = ['publish'] }: TrustSubject): TrustConfigBody {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new PublishError(`GitHub repository must be "owner/repo" (got "${repository}")`, { code: 'ETRUSTARG' })
  }
  if (workflow.includes('/')) {
    throw new PublishError(`the GitHub Actions workflow must be a bare filename, not a path (got "${workflow}")`, { code: 'ETRUSTARG' })
  }
  if (!/\.ya?ml$/.test(workflow)) {
    throw new PublishError(`the GitHub Actions workflow file must end in .yml or .yaml (got "${workflow}")`, { code: 'ETRUSTARG' })
  }
  if (permissions.length === 0) {
    throw new PublishError('at least one permission is required ("publish" and/or "stage-publish")', { code: 'ETRUSTARG' })
  }
  return {
    type: 'github',
    claims: {
      repository,
      workflow_ref: { file: workflow },
      ...(environment ? { environment } : {}),
    },
    permissions: permissions.map((p) => TRUST_PERMISSIONS[p]),
  }
}

/**
 * The registry's own reason for a failure. The trust endpoint reports under
 * `message`; classic registry routes use `error`. Reading both is the whole
 * point of talking HTTP directly (see the header note).
 */
export function registryMessage (body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown, error?: unknown }
    if (typeof b.message === 'string' && b.message.trim()) return b.message.trim()
    if (typeof b.error === 'string' && b.error.trim()) return b.error.trim()
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 400)
  return `registry answered ${status} with no message`
}

interface TrustResponse {
  status: number
  body: unknown
  authUrl?: string
  doneUrl?: string
}

async function trustRequest (
  url: string,
  { method, authToken, otp, payload, fetchImpl = fetch }:
  { method: 'GET' | 'POST', authToken?: string | null, otp?: string | null, payload?: unknown, fetchImpl?: FetchLike },
): Promise<TrustResponse> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'keybridge (npm publish web-auth bridge)',
    // What makes the registry answer a 401 with a web-auth session instead of
    // demanding a typed TOTP code - same contract publish relies on.
    'npm-auth-type': 'web',
    'npm-command': 'trust',
  }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  if (authToken) headers.authorization = `Bearer ${authToken}`
  if (otp) headers['npm-otp'] = otp

  const res = await fetchImpl(url, {
    method,
    headers,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
  const text = await res.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch {}
  const challenge = body as { authUrl?: string, doneUrl?: string } | null
  return {
    status: res.status,
    body,
    ...(typeof challenge?.authUrl === 'string' ? { authUrl: challenge.authUrl } : {}),
    ...(typeof challenge?.doneUrl === 'string' ? { doneUrl: challenge.doneUrl } : {}),
  }
}

/** Per-package presenter, so each ceremony's Touch ID line names exactly what
 * it authorizes (the HUD's reason text is the only thing that does). */
export type PresenterFactory = (pkg: string) => Presenter

export interface TrustOptions extends TrustSubject {
  /** Package names to configure. Bulk is the point: npm's 5-minute 2FA
   * amnesty means one (occasionally two) ceremonies cover the whole set. */
  packages: string[]
  registry?: string
  cwd?: string
  npmBin?: string
  npmArgs?: string[]
  /** Environment used to resolve the auth token - a mediated run passes
   * another account's token here (see accounts.resolveMediation). */
  env?: NodeJS.ProcessEnv
  presenter?: PresenterFactory
  onStatus?: OnStatus
  pollTimeoutMs?: number
  fetchImpl?: FetchLike
  /** Gap between package requests - npm's own guidance for bulk config. */
  spacingMs?: number
  /** Validate and report the exact request bodies; send nothing. */
  dryRun?: boolean
}

export interface TrustOutcome {
  configured: Array<{ package: string, id: string }>
  failed: Array<{ package: string, reason: string }>
  skipped: Array<{ package: string, reason: string }>
  usedWebAuth: boolean
  /** How many human ceremonies it actually took (1-2 typical for a set). */
  ceremonies: number
  registry: string
}

interface TrustEntry {
  id?: string
  type?: string
  claims?: { repository?: string, workflow_ref?: { file?: string } }
}

/** The id of the config we just created: the echoed entry whose claims match
 * what we sent, else the last one (the response echoes the package's list). */
function createdId (body: unknown, config: TrustConfigBody): string | null {
  const entries: TrustEntry[] = Array.isArray(body) ? body as TrustEntry[] : [body as TrustEntry]
  const match = entries.find((e) =>
    e?.claims?.repository === config.claims.repository &&
    e?.claims?.workflow_ref?.file === config.claims.workflow_ref.file)
  const chosen = match ?? entries.at(-1)
  return typeof chosen?.id === 'string' ? chosen.id : null
}

const isNpmjs = (registry: string): boolean => {
  try { return new URL(registry).host === 'registry.npmjs.org' } catch { return false }
}

/**
 * Configure a GitHub Actions trusted publisher for each package.
 *
 * One package per request - the URL is package-scoped and npm has no batch
 * route; what makes a set cheap is npm's 5-minute 2FA amnesty, which the
 * ceremony page ticks automatically (presenters/shared.ts STATUS_SCRIPT), so
 * later packages usually go through with no ceremony at all.
 *
 * Nothing here is transactional: a package already configured earlier in the
 * run stays configured even if a later one fails, and a ceremony failure stops
 * the run with the partial result intact rather than throwing it away (a blind
 * re-run would create DUPLICATE configs, since the registry appends rather
 * than replaces).
 */
export async function trustPackages (opts: TrustOptions): Promise<TrustOutcome> {
  const {
    packages, repository, workflow, environment, permissions,
    cwd = process.cwd(), npmBin = 'npm', npmArgs = [], env,
    presenter, onStatus = () => {}, pollTimeoutMs = 300_000,
    fetchImpl = fetch, spacingMs = 2000, dryRun = false,
  } = opts

  if (packages.length === 0) throw new PublishError('no packages given to configure', { code: 'ETRUSTARG' })
  const config = githubTrustConfig({ repository, workflow, ...(environment ? { environment } : {}), ...(permissions ? { permissions } : {}) })

  const registry = opts.registry ?? await resolveRegistry({ cwd, npmBin, npmArgs, ...(env ? { env } : {}) })
  const base = registry.replace(/\/+$/, '')
  const outcome: TrustOutcome = { configured: [], failed: [], skipped: [], usedWebAuth: false, ceremonies: 0, registry }

  if (dryRun) {
    for (const pkg of packages) {
      outcome.skipped.push({
        package: pkg,
        reason: `dry run - would POST ${base}/-/package/${escapePackageName(pkg)}/trust ${JSON.stringify([config])}`,
      })
    }
    return outcome
  }

  if (!presenter) throw new TypeError('trustPackages requires a presenter')
  const authToken = await getAuthToken(registry, { cwd, npmArgs, ...(env ? { env } : {}) })

  // A 404 means different things on npmjs.com (package not published yet -
  // the chicken-and-egg in README) and elsewhere (registry has no trust API).
  const notFoundReason = isNpmjs(registry)
    ? 'not on the registry yet - a package must be published once before a trusted publisher can be configured for it'
    : `not found on ${registry} - the package may not exist there, or this registry may not support trusted publishing`

  for (const [index, pkg] of packages.entries()) {
    if (index > 0) await delay(spacingMs)
    const url = `${base}/-/package/${escapePackageName(pkg)}/trust`

    onStatus({ phase: 'trust-attempt', pkg })
    let res = await trustRequest(url, { method: 'POST', authToken, payload: [config], fetchImpl })

    // 401 + a web-auth session = npm wants the human. Inside the 5-minute
    // amnesty window this never happens after the first package.
    if (res.status === 401 && res.authUrl && res.doneUrl) {
      onStatus({ phase: 'awaiting-human', authUrl: res.authUrl, purpose: 'trust', pkg })
      let otp: string
      try {
        otp = await presentAndPoll(presenter(pkg), res.authUrl, res.doneUrl, {
          authToken, timeoutMs: pollTimeoutMs, fetchImpl, purpose: 'trust', onStatus,
        })
      } catch (e) {
        // Every remaining package needs this same ceremony, so re-prompting
        // for each would just repeat the failure. Stop, but keep (and report)
        // whatever was already configured.
        const reason = `WebAuthn verification failed: ${(e as Error).message}`
        kblog('trust-ceremony-failed', { pkg, error: (e as Error).message, code: (e as PublishError).code })
        outcome.failed.push({ package: pkg, reason })
        for (const rest of packages.slice(index + 1)) {
          outcome.skipped.push({ package: rest, reason: 'aborted - the WebAuthn ceremony did not complete' })
        }
        return outcome
      }
      outcome.usedWebAuth = true
      outcome.ceremonies++
      onStatus({ phase: 'trust-retry', pkg })
      res = await trustRequest(url, { method: 'POST', authToken, otp, payload: [config], fetchImpl })
    }

    if (res.status >= 200 && res.status < 300) {
      const id = createdId(res.body, config)
      outcome.configured.push({ package: pkg, id: id ?? '(no id returned)' })
      kblog('trust-configured', { pkg, id, repository, workflow })
      continue
    }
    if (res.status === 404) {
      outcome.skipped.push({ package: pkg, reason: notFoundReason })
      continue
    }
    const reason = res.status === 401
      ? `not authorized (${registryMessage(res.body, res.status)}) - the npm session token is missing or expired; run \`keybridge login\``
      : registryMessage(res.body, res.status)
    outcome.failed.push({ package: pkg, reason: `${res.status}: ${reason}` })
    kblog('trust-failed', { pkg, status: res.status, reason })
  }

  return outcome
}

export interface TrustListEntry {
  id: string | null
  type: string | null
  repository: string | null
  workflow: string | null
  environment: string | null
  permissions: string[]
}

/**
 * Existing trusted-publisher configs for a package (`npm trust list`).
 * 2FA-gated like every other trust route, so this is NOT a cheap read: it
 * costs a ceremony unless the amnesty window is still open.
 */
export async function listTrust (
  pkg: string,
  { registry: registryOpt, cwd = process.cwd(), npmBin = 'npm', npmArgs = [], env, presenter, onStatus = () => {}, pollTimeoutMs = 300_000, fetchImpl = fetch }:
  Omit<TrustOptions, 'packages' | 'repository' | 'workflow' | 'permissions' | 'environment' | 'spacingMs' | 'dryRun'> = {},
): Promise<{ registry: string, configs: TrustListEntry[] }> {
  const registry = registryOpt ?? await resolveRegistry({ cwd, npmBin, npmArgs, ...(env ? { env } : {}) })
  const url = `${registry.replace(/\/+$/, '')}/-/package/${escapePackageName(pkg)}/trust`
  const authToken = await getAuthToken(registry, { cwd, npmArgs, ...(env ? { env } : {}) })

  let res = await trustRequest(url, { method: 'GET', authToken, fetchImpl })
  if (res.status === 401 && res.authUrl && res.doneUrl) {
    if (!presenter) throw new PublishError('`npm trust list` is 2FA-gated and no presenter was supplied', { code: 'ETRUST' })
    onStatus({ phase: 'awaiting-human', authUrl: res.authUrl, purpose: 'trust', pkg })
    const otp = await presentAndPoll(presenter(pkg), res.authUrl, res.doneUrl, {
      authToken, timeoutMs: pollTimeoutMs, fetchImpl, purpose: 'trust', onStatus,
    })
    res = await trustRequest(url, { method: 'GET', authToken, otp, fetchImpl })
  }
  if (res.status < 200 || res.status >= 300) {
    throw new PublishError(`could not list trusted publishers for ${pkg} (${res.status}: ${registryMessage(res.body, res.status)})`, { code: 'ETRUST' })
  }

  const raw: unknown[] = Array.isArray(res.body) ? res.body : res.body ? [res.body] : []
  const configs = raw.map((entry) => {
    const e = entry as {
      id?: string, type?: string, permissions?: string[]
      claims?: { repository?: string, workflow_ref?: { file?: string }, environment?: string }
    }
    return {
      id: e?.id ?? null,
      type: e?.type ?? null,
      repository: e?.claims?.repository ?? null,
      workflow: e?.claims?.workflow_ref?.file ?? null,
      environment: e?.claims?.environment ?? null,
      permissions: Array.isArray(e?.permissions) ? e.permissions : [],
    }
  })
  return { registry, configs }
}
