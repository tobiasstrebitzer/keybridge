import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { publishWithWebAuth, runNpm, PublishError, type StatusEvent } from '../src/engine.ts'
import { startMockRegistry, OTP_TOKEN, SESSION_TOKEN } from './mock-registry.ts'

// Keep the engine's persistent diagnostics (src/log.ts) out of the real
// ~/.keybridge/logs while tests run.
process.env.KEYBRIDGE_LOG_DIR = mkdtempSync(join(tmpdir(), 'keybridge-logs-'))

const FIXTURE_TOKEN = 'fixture-session-token'

function makeFixture (registryUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-e2e-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'keybridge-e2e-fixture',
    version: '1.0.0',
    description: 'e2e fixture',
    license: 'MIT',
  }))
  const npmrc = join(dir, 'fixture-npmrc')
  writeFileSync(npmrc, `//${new URL(registryUrl).host}/:_authToken=${FIXTURE_TOKEN}\n`)
  return { dir, npmrc, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('full publish loop: EOTP -> auth visit -> doneUrl token -> otp retry', async (t) => {
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  const phases: string[] = []
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    onStatus: ({ phase }: StatusEvent) => phases.push(phase),
    // Simulated human: "opens the browser" by GETting the auth page.
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.equal(outcome.usedWebAuth, true)
  assert.deepEqual(phases, ['publish-attempt', 'awaiting-human', 'publish-retry'])

  // Registry saw: unauthenticated-by-otp first PUT, then the OTP retry.
  assert.equal(registry.state.puts.length, 2)
  assert.equal(registry.state.puts[0]!.otp, null)
  assert.equal(registry.state.puts[1]!.otp, OTP_TOKEN)
  assert.equal(registry.state.authVisited, true)
  // doneUrl polling carried the registry auth token.
  assert.deepEqual([...registry.state.doneAuthHeaders], [`Bearer ${FIXTURE_TOKEN}`])
})

test('a pre-packed tarball is what gets published, ceremony and all', async (t) => {
  // The pnpm-workspace path (src/pm.ts): the tarball is built by another
  // packer, and npm is only handed the file. cwd still decides the registry,
  // the auth token and the package name for the session mint.
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  const packDir = mkdtempSync(join(tmpdir(), 'keybridge-packed-'))
  t.after(() => rmSync(packDir, { recursive: true, force: true }))
  const packed = await runNpm(['pack', '--pack-destination', packDir], { cwd: fixture.dir })
  assert.equal(packed.code, 0, packed.stderr)
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz'))!)

  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    spec: tarball,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.equal(outcome.result?.id, 'keybridge-e2e-fixture@1.0.0')
  // Both attempts published the same tarball - the retry must not re-pack.
  assert.equal(registry.state.puts.length, 2)
  assert.equal(registry.state.puts[0]!.otp, null)
  assert.equal(registry.state.puts[1]!.otp, OTP_TOKEN)
})

test('npm<12 redacted URLs: engine mints its own session and recovers', async (t) => {
  const registry = await startMockRegistry({ redactPublishUrls: true })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  const phases: string[] = []
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    onStatus: ({ phase }: StatusEvent) => phases.push(phase),
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.equal(outcome.usedWebAuth, true)
  assert.deepEqual(phases, ['publish-attempt', 'minting-session', 'awaiting-human', 'publish-retry'])

  // full publish PUT (redacted 401), then our minimal session-mint PUT,
  // then the OTP retry of the real publish
  assert.equal(registry.state.puts.length, 3)
  assert.equal(registry.state.puts[0]!.minimal, false)
  assert.equal(registry.state.puts[1]!.minimal, true)
  assert.equal(registry.state.puts[1]!.authType, 'web', 'session mint must send npm-auth-type: web')
  assert.equal(registry.state.puts[1]!.authorization, `Bearer ${FIXTURE_TOKEN}`)
  assert.deepEqual([registry.state.puts[2]!.minimal, registry.state.puts[2]!.otp], [false, OTP_TOKEN])
})

test('expired session: auto web-login, token persisted, then publish', async (t) => {
  const registry = await startMockRegistry({ expiredToken: FIXTURE_TOKEN })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  const phases: string[] = []
  const presented: string[] = []
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    onStatus: ({ phase }: StatusEvent) => phases.push(phase),
    presenter: async ({ authUrl }) => { presented.push(new URL(authUrl).pathname); await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.deepEqual(phases, [
    'publish-attempt', 'login-required', 'awaiting-human', 'login-complete',
    'publish-attempt', 'awaiting-human', 'publish-retry',
  ])
  // two ceremonies: login page first, then the publish auth page
  assert.deepEqual(presented, ['/login-page', '/auth'])
  assert.equal(registry.state.loginStarts, 1)
  // fresh session token was persisted to the userconfig npmrc
  assert.match(readFileSync(fixture.npmrc, 'utf8'), new RegExp(`:_authToken=${SESSION_TOKEN}$`, 'm'))
  // stale PUT -> (login) -> unauthenticated-by-otp PUT -> OTP retry
  assert.equal(registry.state.puts.length, 3)
  assert.equal(registry.state.puts[1]!.authorization, `Bearer ${SESSION_TOKEN}`)
  assert.equal(registry.state.puts[2]!.otp, OTP_TOKEN)
})

test('times out cleanly when the human never completes the ceremony', async (t) => {
  const registry = await startMockRegistry({ completeAuthOnVisit: false })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  let presenterAborted = false
  await assert.rejects(
    publishWithWebAuth({
      cwd: fixture.dir,
      npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
      pollTimeoutMs: 1500,
      presenter: ({ signal }) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { presenterAborted = true; resolve() })
      }),
    }),
    (e: unknown) => e instanceof PublishError && e.code === 'ETIMEDOUT'
  )
  assert.equal(presenterAborted, true, 'presenter should be torn down on timeout')
  assert.ok(registry.state.donePolls > 1, 'doneUrl should have been polled repeatedly')
})

test('non-EOTP publish failures surface as PublishError without a ceremony', async (t) => {
  const fixture = makeFixture('http://127.0.0.1:1') // unreachable registry
  t.after(() => fixture.dispose())

  let presenterCalled = false
  await assert.rejects(
    publishWithWebAuth({
      cwd: fixture.dir,
      npmArgs: ['--registry', 'http://127.0.0.1:1', '--userconfig', fixture.npmrc, '--fetch-retries', '0'],
      presenter: async () => { presenterCalled = true },
    }),
    (e: unknown) => e instanceof PublishError
  )
  assert.equal(presenterCalled, false)
})

test('a non-fatal presenter failure is surfaced via onStatus while polling continues', async (t) => {
  // The browser-fallback shape: the presenter dies but the human could still
  // open authUrl themselves, so polling continues to the timeout - which must
  // NOT be silent: the failure is reported as a status event immediately and
  // folded into the timeout error.
  const registry = await startMockRegistry({ completeAuthOnVisit: false })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  const phases: string[] = []
  await assert.rejects(
    publishWithWebAuth({
      cwd: fixture.dir,
      npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
      pollTimeoutMs: 1500,
      onStatus: ({ phase }: StatusEvent) => phases.push(phase),
      presenter: async () => { throw new Error('browser failed to open') },
    }),
    (e: unknown) => e instanceof PublishError && e.code === 'ETIMEDOUT' &&
      /presenter also failed: browser failed to open/.test(e.message),
  )
  assert.ok(phases.includes('presenter-failed'), 'presenter failure was reported as a status event')
})

test('a fatal presenter error aborts doneUrl polling immediately', async (t) => {
  // The ceremony can never complete: /done stays 202 (auth page never marks
  // it complete) and the presenter dies with a fatal error (the webkit
  // presenter's ENOCRED path). The publish must fail with that error right
  // away instead of waiting out the 30s poll timeout.
  const registry = await startMockRegistry({ completeAuthOnVisit: false })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())

  const fatalErr = new PublishError('no keybridge credential enrolled for this account', { code: 'ENOCRED' })
  fatalErr.fatal = true

  const started = Date.now()
  await assert.rejects(
    publishWithWebAuth({
      cwd: fixture.dir,
      npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
      pollTimeoutMs: 30_000,
      presenter: async () => { throw fatalErr },
    }),
    (e: unknown) => e instanceof PublishError && e.code === 'ENOCRED'
  )
  assert.ok(Date.now() - started < 10_000, 'failed fast instead of waiting for the poll timeout')
})

test('env token override authenticates the whole publish without touching npmrc', async (t) => {
  // The mediation path: another account's token rides along as an npm env
  // override. Both the publish PUTs and the doneUrl polling must use it, and
  // the npmrc must stay untouched.
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture.dispose())
  const emptyNpmrc = join(fixture.dir, 'empty-npmrc')
  writeFileSync(emptyNpmrc, '')

  const tokenKey = `npm_config_//${new URL(registry.url).host}/:_authToken`
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', emptyNpmrc],
    env: { ...process.env, [tokenKey]: 'vault-token-x' },
    autoLogin: false,
    pollTimeoutMs: 30_000,
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.equal(registry.state.puts[0]!.authorization, 'Bearer vault-token-x', 'publish PUT used the env token')
  assert.deepEqual([...registry.state.doneAuthHeaders], ['Bearer vault-token-x'], 'doneUrl polling used the env token')
  assert.equal(readFileSync(emptyNpmrc, 'utf8'), '', 'npmrc stayed untouched')
})
