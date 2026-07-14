import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readFileSync } from 'node:fs'
import { publishWithWebAuth, PublishError } from '../src/engine.js'
import { startMockRegistry, OTP_TOKEN, SESSION_TOKEN } from './mock-registry.mjs'

const FIXTURE_TOKEN = 'fixture-session-token'

function makeFixture (registryUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-e2e-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'keybridge-e2e-fixture',
    version: '1.0.0',
    description: 'e2e fixture',
    license: 'MIT',
  }))
  const npmrc = join(dir, 'fixture-npmrc')
  writeFileSync(npmrc, `//${new URL(registryUrl).host}/:_authToken=${FIXTURE_TOKEN}\n`)
  return { dir, npmrc, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) }
}

test('full publish loop: EOTP -> auth visit -> doneUrl token -> otp retry', async (t) => {
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture[Symbol.dispose]())

  const phases = []
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    onStatus: ({ phase }) => phases.push(phase),
    // Simulated human: "opens the browser" by GETting the auth page.
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.equal(outcome.usedWebAuth, true)
  assert.deepEqual(phases, ['publish-attempt', 'awaiting-human', 'publish-retry'])

  // Registry saw: unauthenticated-by-otp first PUT, then the OTP retry.
  assert.equal(registry.state.puts.length, 2)
  assert.equal(registry.state.puts[0].otp, null)
  assert.equal(registry.state.puts[1].otp, OTP_TOKEN)
  assert.equal(registry.state.authVisited, true)
  // doneUrl polling carried the registry auth token.
  assert.deepEqual([...registry.state.doneAuthHeaders], [`Bearer ${FIXTURE_TOKEN}`])
})

test('npm<12 redacted URLs: engine mints its own session and recovers', async (t) => {
  const registry = await startMockRegistry({ redactPublishUrls: true })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture[Symbol.dispose]())

  const phases = []
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    onStatus: ({ phase }) => phases.push(phase),
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(outcome.published, true)
  assert.equal(outcome.usedWebAuth, true)
  assert.deepEqual(phases, ['publish-attempt', 'minting-session', 'awaiting-human', 'publish-retry'])

  // full publish PUT (redacted 401), then our minimal session-mint PUT,
  // then the OTP retry of the real publish
  assert.equal(registry.state.puts.length, 3)
  assert.equal(registry.state.puts[0].minimal, false)
  assert.equal(registry.state.puts[1].minimal, true)
  assert.equal(registry.state.puts[1].authType, 'web', 'session mint must send npm-auth-type: web')
  assert.equal(registry.state.puts[1].authorization, `Bearer ${FIXTURE_TOKEN}`)
  assert.deepEqual([registry.state.puts[2].minimal, registry.state.puts[2].otp], [false, OTP_TOKEN])
})

test('expired session: auto web-login, token persisted, then publish', async (t) => {
  const registry = await startMockRegistry({ expiredToken: FIXTURE_TOKEN })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture[Symbol.dispose]())

  const phases = []
  const presented = []
  const outcome = await publishWithWebAuth({
    cwd: fixture.dir,
    npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
    pollTimeoutMs: 30_000,
    onStatus: ({ phase }) => phases.push(phase),
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
  assert.equal(registry.state.puts[1].authorization, `Bearer ${SESSION_TOKEN}`)
  assert.equal(registry.state.puts[2].otp, OTP_TOKEN)
})

test('times out cleanly when the human never completes the ceremony', async (t) => {
  const registry = await startMockRegistry({ completeAuthOnVisit: false })
  t.after(() => registry.close())
  const fixture = makeFixture(registry.url)
  t.after(() => fixture[Symbol.dispose]())

  let presenterAborted = false
  await assert.rejects(
    publishWithWebAuth({
      cwd: fixture.dir,
      npmArgs: ['--registry', registry.url, '--userconfig', fixture.npmrc],
      pollTimeoutMs: 1500,
      presenter: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { presenterAborted = true; resolve() })
      }),
    }),
    (e) => e instanceof PublishError && e.code === 'ETIMEDOUT'
  )
  assert.equal(presenterAborted, true, 'presenter should be torn down on timeout')
  assert.ok(registry.state.donePolls > 1, 'doneUrl should have been polled repeatedly')
})

test('non-EOTP publish failures surface as PublishError without a ceremony', async (t) => {
  const fixture = makeFixture('http://127.0.0.1:1') // unreachable registry
  t.after(() => fixture[Symbol.dispose]())

  let presenterCalled = false
  await assert.rejects(
    publishWithWebAuth({
      cwd: fixture.dir,
      npmArgs: ['--registry', 'http://127.0.0.1:1', '--userconfig', fixture.npmrc, '--fetch-retries', '0'],
      presenter: async () => { presenterCalled = true },
    }),
    (e) => e instanceof PublishError
  )
  assert.equal(presenterCalled, false)
})

const guardScript = fileURLToPath(new URL('../hooks/guard-npm-publish.mjs', import.meta.url))

function runGuard (hookInput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guardScript], { stdio: ['pipe', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end(JSON.stringify(hookInput))
  })
}

test('hook guard denies raw npm/pnpm/yarn publish, allows everything else', async () => {
  const denied = [
    'npm publish',
    'npm publish --access public',
    'cd pkg && npm publish --tag beta',
    'pnpm publish',
    'npm stage publish',
    'yarn publish --new-version 1.0.1',
  ]
  const allowed = [
    'npm install',
    'npm run publish-docs',
    'echo npm-publisher',
    'npx keybridge publish',
    'git push origin main',
  ]
  for (const command of denied) {
    const { code, stdout } = await runGuard({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(code, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', `should deny: ${command}`)
  }
  for (const command of allowed) {
    const { code, stdout } = await runGuard({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(code, 0)
    assert.equal(stdout, '', `should not intervene on: ${command}`)
  }
})
