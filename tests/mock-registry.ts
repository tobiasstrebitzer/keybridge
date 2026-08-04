// In-process mock of npmjs.com's publish + web-auth behavior, faithful to
// what npm-registry-fetch/npm-profile expect:
//   PUT /<pkg> without npm-otp  -> 401, www-authenticate: OTP,
//                                  body { authUrl, doneUrl }
//   GET /auth (the "browser")   -> marks the ceremony complete
//   GET /done                   -> 202 + retry-after until complete,
//                                  then 200 { token }
//   PUT /<pkg> with npm-otp     -> 201 { ok, id } when the token matches
//
// With `redactPublishUrls` it also emulates the npm < 12 CLI bug where the
// --json error output redacts the session ids: full publish PUTs (body with
// _attachments) get "***" URLs - as the npm CLI would report them - while
// metadata-only session-mint PUTs get real, live URLs.
//
// It also serves the trusted-publisher routes (verified against npm 12.0.2 on
// 2026-08-04, see src/trust.ts):
//   POST /-/package/<esc>/trust  without npm-otp -> 401 + { authUrl, doneUrl }
//                                with a good otp -> 200, config APPENDED
//                                without permissions -> 400, and the reason
//                                  lives in `message`, NOT `error`
//   GET  /-/package/<esc>/trust  -> the package's configs (2FA-gated too)
// `trustCooldown` models npm's 5-minute 2FA amnesty: after one completed
// ceremony, later trust writes are not challenged at all.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const OTP_TOKEN = 'test-otp-42'
export const SESSION_TOKEN = 'fresh-session-token'

export interface MockPut {
  otp: string | null
  authorization: string | null
  authType: string | null
  minimal: boolean
}

export interface MockTrustRequest {
  method: string
  pkg: string
  otp: string | null
  authorization: string | null
  authType: string | null
  body: unknown
}

export interface MockTrustConfig {
  id: string
  type: string
  claims: unknown
  permissions: string[]
}

export interface MockRegistryState {
  authVisited: boolean
  authComplete: boolean
  donePolls: number
  doneAuthHeaders: Set<string>
  puts: MockPut[]
  loginStarts: number
  loginPageVisited: boolean
  /** Every request that reached a /trust route, in order. */
  trustRequests: MockTrustRequest[]
  /** Configs the registry now holds, per package (writes APPEND). */
  trustConfigs: Map<string, MockTrustConfig[]>
  /** True once a trust write completed with a valid OTP (amnesty is open). */
  trustCooldownOpen: boolean
}

export interface MockRegistry {
  url: string
  state: MockRegistryState
  close: () => Promise<unknown>
}

export interface MockRegistryOptions {
  completeAuthOnVisit?: boolean
  redactPublishUrls?: boolean
  /** PUTs presenting this bearer get a plain 401 (expired session) */
  expiredToken?: string | null
  /** Packages that exist. Null (the default) means every name exists;
   * anything outside a given list 404s, as an unpublished package does. */
  knownPackages?: string[] | null
  /** Emulate npm's 5-minute 2FA amnesty on the trust routes. */
  trustCooldown?: boolean
}

export function startMockRegistry (
  {
    completeAuthOnVisit = true, redactPublishUrls = false, expiredToken = null,
    knownPackages = null, trustCooldown = false,
  }: MockRegistryOptions = {},
): Promise<MockRegistry> {
  const state: MockRegistryState = {
    authVisited: false,
    authComplete: false,
    donePolls: 0,
    doneAuthHeaders: new Set(),
    puts: [],
    loginStarts: 0,
    loginPageVisited: false,
    trustRequests: [],
    trustConfigs: new Map(),
    trustCooldownOpen: false,
  }
  let nextTrustId = 1

  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    const port = () => (server.address() as AddressInfo).port

    if (req.method === 'GET' && url.pathname === '/auth') {
      state.authVisited = true
      if (completeAuthOnVisit) state.authComplete = true
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>WebAuthn ceremony placeholder - you have been "verified".</body></html>')
      return
    }

    if (req.method === 'GET' && url.pathname === '/done') {
      state.donePolls++
      if (req.headers.authorization) state.doneAuthHeaders.add(req.headers.authorization)
      if (state.authComplete) return send(200, { token: OTP_TOKEN })
      return send(202, {}, { 'retry-after': '0.1' })
    }

    if (req.method === 'POST' && url.pathname === '/-/v1/login') {
      state.loginStarts++
      if (req.headers['npm-auth-type'] !== 'web') return send(401, { error: 'You must be logged in to publish packages.' })
      const base = `http://127.0.0.1:${port()}`
      return send(200, { loginUrl: `${base}/login-page`, doneUrl: `${base}/login-done` })
    }

    if (req.method === 'GET' && url.pathname === '/login-page') {
      state.loginPageVisited = true
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>Login WebAuthn ceremony placeholder.</body></html>')
      return
    }

    if (req.method === 'GET' && url.pathname === '/login-done') {
      if (state.loginPageVisited && completeAuthOnVisit) return send(200, { token: SESSION_TOKEN })
      return send(202, {}, { 'retry-after': '0.1' })
    }

    // /-/package/<npa-escaped-name>/trust - the trusted-publisher routes.
    const trustMatch = /^\/-\/package\/(.+)\/trust$/.exec(url.pathname)
    if (trustMatch && (req.method === 'POST' || req.method === 'GET')) {
      const pkg = decodeURIComponent(trustMatch[1]!)
      const bufs: Buffer[] = []
      req.on('data', (d: Buffer) => bufs.push(d))
      req.on('end', () => {
        const raw = Buffer.concat(bufs).toString('utf8')
        let body: unknown = null
        try { body = JSON.parse(raw) } catch {}
        const otp = (req.headers['npm-otp'] as string | undefined) ?? null
        state.trustRequests.push({
          method: req.method!,
          pkg,
          otp,
          authorization: req.headers.authorization ?? null,
          authType: (req.headers['npm-auth-type'] as string | undefined) ?? null,
          body,
        })

        if (knownPackages && !knownPackages.includes(pkg)) {
          // What an unpublished package looks like: the reason is in
          // `message`, the field npm 11 never printed.
          return send(404, { message: 'package not found' })
        }

        // 2FA gate. Once the amnesty window is open, writes sail through -
        // which is what makes configuring a whole repo cost one touch.
        const challenged = otp !== OTP_TOKEN && !(trustCooldown && state.trustCooldownOpen)
        if (challenged) {
          const base = `http://127.0.0.1:${port()}`
          return send(401, {
            error: 'You must provide a one-time pass. Upgrade your client or visit the auth URL.',
            authUrl: `${base}/auth`,
            doneUrl: `${base}/done`,
          }, { 'www-authenticate': 'OTP' })
        }
        if (otp === OTP_TOKEN) state.trustCooldownOpen = true

        const existing = state.trustConfigs.get(pkg) ?? []
        if (req.method === 'GET') return send(200, existing)

        const entries = Array.isArray(body) ? body : null
        if (!entries || entries.length === 0) {
          return send(400, { message: 'body must be a non-empty array of trust configurations' })
        }
        const VALID = ['createPackage', 'createStagedPackage']
        for (const entry of entries as Array<{ permissions?: unknown }>) {
          const perms = Array.isArray(entry?.permissions)
            ? entry.permissions.filter((p) => VALID.includes(p as string))
            : []
          if (perms.length === 0) {
            // The exact 400 npm 11 could never explain (npm/cli#9377): the
            // reason is under `message`, and npm only printed `error`.
            return send(400, { message: 'permissions is required and must contain at least one valid route' })
          }
        }
        // Writes APPEND - re-running mints a NEW id rather than updating.
        const created = (entries as Array<{ type?: string, claims?: unknown, permissions?: string[] }>).map((entry) => ({
          id: `trust-config-${nextTrustId++}`,
          type: entry.type ?? 'github',
          claims: entry.claims ?? {},
          permissions: entry.permissions ?? [],
        }))
        state.trustConfigs.set(pkg, [...existing, ...created])
        return send(200, created)
      })
      return
    }

    if (req.method === 'PUT') {
      const bufs: Buffer[] = []
      req.on('data', (d: Buffer) => bufs.push(d))
      req.on('end', () => {
        let body: { _attachments?: unknown } = {}
        try { body = JSON.parse(Buffer.concat(bufs).toString('utf8')) } catch {}
        const put: MockPut = {
          otp: (req.headers['npm-otp'] as string | undefined) ?? null,
          authorization: req.headers.authorization ?? null,
          authType: (req.headers['npm-auth-type'] as string | undefined) ?? null,
          minimal: !body._attachments,
        }
        state.puts.push(put)
        if (expiredToken && put.authorization === `Bearer ${expiredToken}`) {
          // plain 401, no www-authenticate: OTP -> npm reports E401
          return send(401, { error: 'Invalid or expired authentication token.' })
        }
        if (put.otp === OTP_TOKEN) {
          return send(201, { ok: true, id: decodeURIComponent(url.pathname.slice(1)) })
        }
        const base = `http://127.0.0.1:${port()}`
        const redact = redactPublishUrls && !put.minimal
        send(401, {
          error: 'You must provide a one-time pass. Upgrade your client or visit the auth URL.',
          authUrl: redact ? `${base.replace(/:\d+$/, '')}/auth/cli/***` : `${base}/auth`,
          doneUrl: redact ? `${base.replace(/:\d+$/, '')}/-/v1/done?authId=***` : `${base}/done`,
        }, { 'www-authenticate': 'OTP' })
      })
      return
    }

    send(404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
