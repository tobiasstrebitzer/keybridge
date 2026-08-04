import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PublishError, runNpm, type Presenter, type StatusEvent } from '../src/engine.ts'
import { escapePackageName, githubTrustConfig, listTrust, registryMessage, trustPackages } from '../src/trust.ts'
import { ceremonyReason } from '../src/presenters/webkit.ts'
import { startMockRegistry, type MockRegistry } from './mock-registry.ts'

// Keep kblog() out of the real ~/.keybridge/logs while tests run.
process.env.KEYBRIDGE_LOG_DIR = mkdtempSync(join(tmpdir(), 'keybridge-logs-'))

const TOKEN = 'fixture-session-token'

function fixture (registryUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-trust-'))
  const npmrc = join(dir, 'fixture-npmrc')
  writeFileSync(npmrc, `//${new URL(registryUrl).host}/:_authToken=${TOKEN}\n`)
  return { dir, npmrc, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A simulated human: "opens the browser" by GETting the auth page. */
function humanPresenter (): { presenter: (pkg: string) => Presenter, seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    presenter: (pkg) => async ({ authUrl, purpose }) => {
      seen.push(`${purpose}:${pkg}`)
      await fetch(authUrl)
    },
  }
}

function baseOptions (registry: MockRegistry, npmrc: string) {
  return {
    registry: registry.url,
    npmArgs: ['--userconfig', npmrc],
    pollTimeoutMs: 30_000,
    // No point sleeping npm's bulk-rate-limit gap in tests.
    spacingMs: 0,
  }
}

test('full trust loop: 401 -> ceremony -> otp retry -> config id', async (t) => {
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const { presenter, seen } = humanPresenter()
  const phases: string[] = []
  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['demo'],
    repository: 'acme/demo',
    workflow: 'publish.yml',
    presenter,
    onStatus: ({ phase }: StatusEvent) => phases.push(phase),
  })

  assert.deepEqual(outcome.configured, [{ package: 'demo', id: 'trust-config-1' }])
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.skipped, [])
  assert.equal(outcome.usedWebAuth, true)
  assert.equal(outcome.ceremonies, 1)
  assert.deepEqual(phases, ['trust-attempt', 'awaiting-human', 'trust-retry'])
  // The ceremony was told what it authorizes, and for which package.
  assert.deepEqual(seen, ['trust:demo'])

  // Two POSTs: the challenge, then the OTP retry - both carrying the same body.
  assert.equal(registry.state.trustRequests.length, 2)
  const [first, second] = registry.state.trustRequests
  assert.equal(first!.otp, null)
  assert.equal(second!.otp, 'test-otp-42')
  for (const req of [first!, second!]) {
    assert.equal(req.method, 'POST')
    assert.equal(req.authorization, `Bearer ${TOKEN}`)
    // Without this header the registry demands a typed TOTP code instead of
    // handing back a web-auth session.
    assert.equal(req.authType, 'web')
  }
})

test('the request body is byte-identical to what npm 12 puts on the wire', async (t) => {
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['demo'],
    repository: 'acme/demo',
    workflow: 'release.yaml',
    environment: 'production',
    permissions: ['publish', 'stage-publish'],
    presenter: humanPresenter().presenter,
  })

  assert.deepEqual(registry.state.trustRequests[0]!.body, [{
    type: 'github',
    claims: {
      repository: 'acme/demo',
      workflow_ref: { file: 'release.yaml' },
      environment: 'production',
    },
    permissions: ['createPackage', 'createStagedPackage'],
  }])
})

test('one ceremony covers the whole set while npm\'s amnesty window is open', async (t) => {
  const registry = await startMockRegistry({ trustCooldown: true })
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const { presenter, seen } = humanPresenter()
  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['a', 'b', 'c', 'd'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    presenter,
  })

  assert.deepEqual(outcome.configured.map((c) => c.package), ['a', 'b', 'c', 'd'])
  assert.equal(outcome.ceremonies, 1, 'only the first package should be challenged')
  assert.deepEqual(seen, ['trust:a'])
  // a: challenge + retry, then b/c/d one request each.
  assert.equal(registry.state.trustRequests.length, 5)
})

test('without the amnesty window every package costs its own ceremony', async (t) => {
  const registry = await startMockRegistry({ trustCooldown: false })
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const { presenter, seen } = humanPresenter()
  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['a', 'b', 'c'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    presenter,
  })

  assert.equal(outcome.configured.length, 3)
  assert.equal(outcome.ceremonies, 3)
  assert.deepEqual(seen, ['trust:a', 'trust:b', 'trust:c'])
})

test('a rejected config reports the registry\'s `message`, not a bare status', async (t) => {
  // The finding that cost the original session two hours: the trust endpoint
  // puts its reason in `message`, and npm 11's error formatter only printed
  // `error` - so every misconfiguration looked like an unexplained 400.
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['demo'],
    repository: 'acme/demo',
    workflow: 'publish.yml',
    // What npm 11 effectively sent: a config with no permissions at all.
    permissions: ['publish'],
    presenter: humanPresenter().presenter,
    fetchImpl: (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Array<Record<string, unknown>> : undefined
      if (body) for (const entry of body) delete entry.permissions
      return fetch(url, { ...init, ...(body ? { body: JSON.stringify(body) } : {}) })
    },
  })

  assert.deepEqual(outcome.configured, [])
  assert.equal(outcome.failed.length, 1)
  assert.equal(
    outcome.failed[0]!.reason,
    '400: permissions is required and must contain at least one valid route',
  )
})

test('on npmjs an unpublished package is skipped with the chicken-and-egg reason, the rest still land', async (t) => {
  const registry = await startMockRegistry({ knownPackages: ['published'], trustCooldown: true })
  t.after(() => registry.close())
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-trust-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const npmrc = join(dir, 'npmrc')
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${TOKEN}\n`)

  // Run against the real npmjs URL (so the npmjs-specific 404 wording applies)
  // while every request still lands on the mock.
  const toMock: typeof fetch = (url, init) =>
    fetch(String(url).replace('https://registry.npmjs.org', registry.url), init)

  const outcome = await trustPackages({
    registry: 'https://registry.npmjs.org',
    npmArgs: ['--userconfig', npmrc],
    spacingMs: 0,
    packages: ['published', 'never-published'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    presenter: humanPresenter().presenter,
    fetchImpl: toMock,
  })

  assert.deepEqual(outcome.configured.map((c) => c.package), ['published'])
  assert.deepEqual(outcome.skipped.map((s) => s.package), ['never-published'])
  assert.match(outcome.skipped[0]!.reason, /published once before/)
  assert.deepEqual(outcome.failed, [])
})

test('elsewhere a 404 says the registry may simply not do trusted publishing', async (t) => {
  const registry = await startMockRegistry({ knownPackages: [], trustCooldown: true })
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['demo'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    presenter: humanPresenter().presenter,
  })

  assert.match(outcome.skipped[0]!.reason, /may not support trusted publishing/)
})

test('scoped names are escaped the way npm-package-arg escapes them', async (t) => {
  assert.equal(escapePackageName('@acme/client'), '@acme%2fclient')
  assert.equal(escapePackageName('plain'), 'plain')

  const registry = await startMockRegistry({ trustCooldown: true })
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['@acme/client'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    presenter: humanPresenter().presenter,
  })

  assert.equal(outcome.configured.length, 1)
  // The registry saw the un-escaped name back, i.e. the route matched.
  assert.equal(registry.state.trustRequests[0]!.pkg, '@acme/client')
})

test('a dry run validates and reports the request without sending anything', async (t) => {
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['demo', '@acme/client'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    dryRun: true,
    // Deliberately no presenter: a dry run must never reach a ceremony.
  })

  assert.deepEqual(outcome.configured, [])
  assert.equal(outcome.skipped.length, 2)
  assert.match(outcome.skipped[0]!.reason, /^dry run - would POST /)
  assert.match(outcome.skipped[1]!.reason, /@acme%2fclient\/trust/)
  assert.equal(outcome.usedWebAuth, false)
  assert.equal(registry.state.trustRequests.length, 0)
})

test('bad claims fail before the network, the way npm 12 validates them', () => {
  const ok = { repository: 'acme/demo', workflow: 'publish.yml' }
  assert.equal(githubTrustConfig(ok).claims.repository, 'acme/demo')
  assert.deepEqual(githubTrustConfig(ok).permissions, ['createPackage'])
  // environment only rides along when it was actually given
  assert.equal('environment' in githubTrustConfig(ok).claims, false)

  assert.throws(() => githubTrustConfig({ ...ok, repository: 'acme' }), /owner\/repo/)
  assert.throws(() => githubTrustConfig({ ...ok, workflow: '.github/workflows/publish.yml' }), /bare filename/)
  assert.throws(() => githubTrustConfig({ ...ok, workflow: 'publish.json' }), /\.yml or \.yaml/)
  assert.throws(() => githubTrustConfig({ ...ok, permissions: [] }), /at least one permission/)
})

test('a failed ceremony stops the run but keeps what was already configured', async (t) => {
  const registry = await startMockRegistry({ trustCooldown: false })
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  let ceremonies = 0
  const outcome = await trustPackages({
    ...baseOptions(registry, fx.npmrc),
    packages: ['a', 'b', 'c'],
    repository: 'acme/repo',
    workflow: 'publish.yml',
    pollTimeoutMs: 2000,
    // The human approves the first package, then cancels from the sheet.
    presenter: () => async ({ authUrl }) => {
      if (++ceremonies === 1) { await fetch(authUrl); return }
      const err = new PublishError('the keybridge ceremony was cancelled from the sheet', { code: 'ECANCEL' })
      err.fatal = true
      throw err
    },
  })

  // "a" survives - re-running blindly would APPEND a duplicate config for it.
  assert.deepEqual(outcome.configured.map((c) => c.package), ['a'])
  assert.deepEqual(outcome.failed.map((f) => f.package), ['b'])
  assert.match(outcome.failed[0]!.reason, /cancelled from the sheet/)
  assert.deepEqual(outcome.skipped, [{ package: 'c', reason: 'aborted - the WebAuthn ceremony did not complete' }])
})

test('trust writes append, and listing them is 2FA-gated too', async (t) => {
  const registry = await startMockRegistry({ trustCooldown: true })
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())

  const opts = {
    ...baseOptions(registry, fx.npmrc),
    packages: ['demo'],
    repository: 'acme/demo',
    workflow: 'publish.yml',
    presenter: humanPresenter().presenter,
  }
  await trustPackages(opts)
  const second = await trustPackages(opts)
  // Re-running mints a NEW id rather than updating the first config.
  assert.equal(second.configured[0]!.id, 'trust-config-2')

  const { configs } = await listTrust('demo', {
    registry: registry.url,
    npmArgs: ['--userconfig', fx.npmrc],
    presenter: humanPresenter().presenter,
  })
  assert.deepEqual(configs.map((c) => c.id), ['trust-config-1', 'trust-config-2'])
  assert.deepEqual(configs[0], {
    id: 'trust-config-1',
    type: 'github',
    repository: 'acme/demo',
    workflow: 'publish.yml',
    environment: null,
    permissions: ['createPackage'],
  })
  assert.equal(registry.state.trustRequests.some((r) => r.method === 'GET'), true)
})

test('registryMessage prefers `message`, falls back to `error`', () => {
  assert.equal(registryMessage({ message: 'the real reason' }, 400), 'the real reason')
  assert.equal(registryMessage({ error: 'classic reason' }, 400), 'classic reason')
  assert.equal(registryMessage({ message: 'wins', error: 'loses' }, 400), 'wins')
  assert.equal(registryMessage('plain text body', 500), 'plain text body')
  assert.equal(registryMessage({}, 503), 'registry answered 503 with no message')
})

test('the Touch ID line says a standing grant is being approved, not a release', () => {
  assert.equal(
    ceremonyReason('trust', { pkg: '@acme/client', user: 'tstrebitzer' }),
    'configure trusted publishing for @acme/client on npm as tstrebitzer',
  )
  assert.equal(ceremonyReason('trust', undefined), 'configure trusted publishing for a package on npm')
})

test('`npm trust` cannot complete the ceremony without a TTY - why keybridge talks HTTP', async (t) => {
  const version = await runNpm(['--version'])
  const major = Number(version.stdout.trim().split('.')[0])
  if (!Number.isFinite(major) || major < 12) {
    t.skip(`needs npm >= 12 for the trust command (found ${version.stdout.trim() || 'nothing'})`)
    return
  }

  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fx = fixture(registry.url)
  t.after(() => fx.dispose())
  writeFileSync(join(fx.dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))

  // npm's `trust` command rejects --userconfig (its option list is closed), so
  // the token has to arrive as an npm_config_ env override.
  const host = new URL(registry.url).host
  const res = await runNpm([
    'trust', 'github', 'demo', '--file', 'publish.yml', '--repo', 'acme/demo',
    '--allow-publish', '--yes', '--registry', registry.url,
  ], { cwd: fx.dir, env: { ...process.env, [`npm_config_//${host}/:_authToken`]: TOKEN } })

  // otplease() bails on `!process.stdin.isTTY` BEFORE its web-auth branch: npm
  // prints the authUrl and gives up. Nothing ever visits the ceremony page, so
  // a keybridge wrapper around the CLI could never complete it.
  assert.notEqual(res.code, 0)
  assert.match(res.stderr, /EOTP/)
  assert.equal(registry.state.authVisited, false, 'npm must not have run the ceremony')
  assert.equal(registry.state.trustRequests.length, 1)
  assert.equal(registry.state.trustRequests[0]!.otp, null)
})
