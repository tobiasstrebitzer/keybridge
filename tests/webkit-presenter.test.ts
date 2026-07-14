import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { shellIsFresh, unwrap, webkitPresenter, type WebkitPresenterOptions } from '../src/presenters/webkit.ts'
import { STATUS_SCRIPT } from '../src/presenters/shared.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_SHELL = join(HERE, 'helpers', 'fake-shell.mjs')

// The presenter spawns whatever shellPath points at; pointing it at the fake
// shell (same stdio protocol, scripted via env) tests the whole drive loop
// without WebKit. shellSource points at the fake too so no build is attempted.
function makeRun (env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-webkit-'))
  const logFile = join(dir, 'cmds.log')
  const argvFile = join(dir, 'argv.log')
  const restore: Array<[string, string | undefined]> = []
  for (const [k, v] of Object.entries({ ...env, FAKE_LOG: logFile, FAKE_ARGV_LOG: argvFile })) {
    restore.push([k, process.env[k]])
    process.env[k] = v
  }
  chmodSync(FAKE_SHELL, 0o755)
  return {
    logFile,
    argv: () => JSON.parse(readFileSync(argvFile, 'utf8').trim().split('\n')[0]!) as string[],
    commands: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, any>),
    dispose: () => {
      for (const [k, v] of restore) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function presenterOpts (over: WebkitPresenterOptions = {}): WebkitPresenterOptions {
  return {
    shellPath: FAKE_SHELL,
    shellSource: FAKE_SHELL, // same mtime => always fresh, never builds
    pollIntervalMs: 5,
    log: () => {},
    notify: () => {},
    ...over,
  }
}

async function until (cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('drives the ceremony: navigate, poll, click, teardown on abort', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'pending,not-found,clicked' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts())({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-1',
    signal: abort.signal,
  })

  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 3 } catch { return false }
  })
  abort.abort()
  await presentation
  // close is written to the shell's stdin after the presenter resolves - wait
  // for the fake shell to log it before asserting on the command stream.
  await until(() => run.commands().some((c) => c.cmd === 'close'))

  const cmds = run.commands()
  assert.equal(cmds[0]!.cmd, 'navigate')
  assert.equal(cmds[0]!.url, 'https://www.npmjs.com/auth/cli/uuid-1')
  const evals = cmds.filter((c) => c.cmd === 'eval')
  assert.ok(evals.length >= 3, 'kept polling the page status')
  assert.ok(evals.every((c) => c.js === STATUS_SCRIPT), 'polls the shared status script')
  assert.match(STATUS_SCRIPT, /__keybridgeClicked/, 'one click per page is enforced inside the page')
  assert.ok(!cmds.some((c) => c.cmd === 'surface'), 'never surfaces in the happy path')
  assert.equal(cmds.at(-1)!.cmd, 'close', 'shell is closed on abort')
})

test('surfaces the window and notifies when npm bounces to a password login', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'login-page,login-page,clicked' })
  t.after(run.dispose)

  const notifications: string[] = []
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({ notify: (m) => notifications.push(m) }))({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-2',
    signal: abort.signal,
  })

  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 3 } catch { return false }
  })
  abort.abort()
  await presentation

  const cmds = run.commands()
  assert.equal(cmds.filter((c) => c.cmd === 'surface').length, 1, 'surfaces exactly once')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0]!, /log in/)
})

test('answers webauthn events through the responder', async (t) => {
  const run = makeRun({
    FAKE_EVALS: 'clicked',
    FAKE_WEBAUTHN: JSON.stringify({
      op: 'get',
      options: { challenge: { $b64: 'AQIDBA' }, allowCredentials: [{ type: 'public-key', id: { $b64: 'CQk' } }] },
      origin: 'https://www.npmjs.com',
    }),
  })
  t.after(run.dispose)

  const seen: Array<{ op: string, options: unknown, origin: string }> = []
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({
    webauthn: async (op, options, origin) => {
      seen.push({ op, options, origin })
      return { ok: true, credential: { id: 'fake-cred' } }
    },
  }))({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-3', signal: abort.signal })

  await until(() => {
    try { return run.commands().some((c) => c.cmd === 'webauthn-result') } catch { return false }
  })
  abort.abort()
  await presentation

  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.op, 'get')
  assert.equal(seen[0]!.origin, 'https://www.npmjs.com')

  const result = run.commands().find((c) => c.cmd === 'webauthn-result')!
  assert.equal(result.id, 99, 'answers the event id the shell assigned')
  assert.deepEqual(result.resp, { ok: true, credential: { id: 'fake-cred' } })
})

test('prefills the login form (page-side idempotence, focus to password)', async (t) => {
  // Every 'login-page' tick sends the prefill eval; the window flag inside
  // the page makes it a no-op after the first run and resets on navigation
  // (a reloaded form after a wrong password gets filled again).
  const run = makeRun({ FAKE_EVALS: 'login-page,prefilled,login-page,prefilled,clicked' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({ prefillUsername: 'tstrebitzer' }))({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-7',
    signal: abort.signal,
  })
  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 5 } catch { return false }
  })
  abort.abort()
  await presentation

  const prefills = run.commands().filter((c) => c.cmd === 'eval' && (c.js as string).includes('login_username'))
  assert.ok(prefills.length >= 1, 'prefill script was sent to the login page')
  assert.match(prefills[0]!.js as string, /"tstrebitzer"/)
  assert.match(prefills[0]!.js as string, /p\.focus\(\)/)
  assert.match(prefills[0]!.js as string, /__keybridgePrefilled/, 'one prefill per page is enforced inside the page')
})

test('keeps polling after a click so chained pages get their own click', async (t) => {
  // A live npm session chains pages: the first click (on /login) navigates to
  // /escalate/webauthn, whose OWN "Use security key" button fires the actual
  // ceremony. Stopping at the first 'clicked' would leave that page untouched
  // forever; one-click-per-page is guaranteed by the in-page window flag,
  // which resets on navigation.
  const run = makeRun({
    FAKE_EVALS: 'clicked,not-found,clicked',
    FAKE_NAV_AFTER_EVALS: '1', // the click triggers a navigation
  })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts())({
    authUrl: 'https://www.npmjs.com/login?next=/login/cli/uuid-6',
    signal: abort.signal,
  })

  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 3 } catch { return false }
  })
  abort.abort()
  await presentation

  const evals = run.commands().filter((c) => c.cmd === 'eval')
  assert.ok(evals.length >= 3, 'polling continued across the navigation')
})

test('runs the shell with the account store id', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'clicked' })
  t.after(run.dispose)

  const storeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({ storeId }))({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-4',
    signal: abort.signal,
  })
  await until(() => {
    try { return run.commands().some((c) => c.cmd === 'navigate') } catch { return false }
  })
  abort.abort()
  await presentation

  const argv = run.argv()
  const i = argv.indexOf('--store-id')
  assert.notEqual(i, -1, 'shell got --store-id')
  assert.equal(argv[i + 1], storeId)
})

test('ENOCRED during a hidden ceremony fails the presentation fast', async (t) => {
  const run = makeRun({
    FAKE_EVALS: 'not-found',
    FAKE_WEBAUTHN: JSON.stringify({
      op: 'get',
      options: { challenge: { $b64: 'AQIDBA' } },
      origin: 'https://www.npmjs.com',
    }),
  })
  t.after(run.dispose)

  const notifications: string[] = []
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({
    notify: (m) => notifications.push(m),
    webauthn: async () => ({ ok: false, error: 'no keybridge credential for rpId "www.npmjs.com"', code: 'ENOCRED' }),
  }))({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-5', signal: abort.signal })

  await assert.rejects(Promise.resolve(presentation), (e: Error & { code?: string, fatal?: boolean }) =>
    e.code === 'ENOCRED' && e.fatal === true)
  abort.abort()

  // The page still got its answer (so it can render npm's own error state).
  await until(() => run.commands().some((c) => c.cmd === 'webauthn-result'))
  assert.equal(notifications.length, 1)
  assert.match(notifications[0]!, /enroll/)
})

test('unwrap undoes the inject script buffer serialization', () => {
  assert.deepEqual(
    unwrap({
      challenge: { $b64: 'AQIDBA' },
      rpId: 'npmjs.com',
      allowCredentials: [{ type: 'public-key', id: { $b64: 'CQk' } }],
      userVerification: 'preferred',
    }),
    {
      challenge: 'AQIDBA',
      rpId: 'npmjs.com',
      allowCredentials: [{ type: 'public-key', id: 'CQk' }],
      userVerification: 'preferred',
    },
  )
})

test('shellIsFresh compares binary and source mtimes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-fresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const src = join(dir, 'WebShell.swift')
  const bin = join(dir, 'keybridge-webshell')

  writeFileSync(src, '// src')
  assert.equal(shellIsFresh(bin, src), false, 'missing binary is stale')

  writeFileSync(bin, 'bin')
  utimesSync(src, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  assert.equal(shellIsFresh(bin, src), true, 'binary newer than source is fresh')

  utimesSync(src, new Date(), new Date())
  utimesSync(bin, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  assert.equal(shellIsFresh(bin, src), false, 'edited source makes the binary stale')
})
