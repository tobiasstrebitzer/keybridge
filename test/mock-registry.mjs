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
// _attachments) get "***" URLs — as the npm CLI would report them — while
// metadata-only session-mint PUTs get real, live URLs.
import { createServer } from 'node:http'

export const OTP_TOKEN = 'test-otp-42'
export const SESSION_TOKEN = 'fresh-session-token'

// `expiredToken`: PUTs presenting this bearer get a plain 401 (invalid/expired
// session), like the registry after the 12h npm login session lapses. The
// web-login flow (POST /-/v1/login) then issues SESSION_TOKEN.
export function startMockRegistry ({ completeAuthOnVisit = true, redactPublishUrls = false, expiredToken = null } = {}) {
  const state = {
    authVisited: false,
    authComplete: false,
    donePolls: 0,
    doneAuthHeaders: new Set(),
    puts: [], // { otp, authorization, minimal, authType }
    loginStarts: 0,
    loginPageVisited: false,
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === '/auth') {
      state.authVisited = true
      if (completeAuthOnVisit) state.authComplete = true
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>WebAuthn ceremony placeholder — you have been "verified".</body></html>')
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
      const base = `http://127.0.0.1:${server.address().port}`
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

    if (req.method === 'PUT') {
      const bufs = []
      req.on('data', (d) => bufs.push(d))
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(Buffer.concat(bufs).toString('utf8')) } catch {}
        const put = {
          otp: req.headers['npm-otp'] ?? null,
          authorization: req.headers.authorization ?? null,
          authType: req.headers['npm-auth-type'] ?? null,
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
        const base = `http://127.0.0.1:${server.address().port}`
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
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
