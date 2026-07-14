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
  const restore: Array<[string, string | undefined]> = []
  for (const [k, v] of Object.entries({ ...env, FAKE_LOG: logFile })) {
    restore.push([k, process.env[k]])
    process.env[k] = v
  }
  chmodSync(FAKE_SHELL, 0o755)
  return {
    logFile,
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

async function until (cond: () => boolean, ms = 2000): Promise<void> {
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
  assert.equal(evals.length, 3, 'polling stops once the button was clicked')
  assert.ok(evals.every((c) => c.js === STATUS_SCRIPT), 'polls the shared status script')
  assert.ok(!cmds.some((c) => c.cmd === 'surface'), 'never surfaces in the happy path')
  assert.equal(cmds.at(-1)!.cmd, 'close', 'shell is closed on abort')
})

test('surfaces the window and notifies when npm bounces to a password login', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'login-page,login-page,clicked' })
  t.after(run.dispose)

  const notifications: string[] = []
  const abort = new AbortController()
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
