import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { ceremonyReason, shellIsFresh, shellSigner, unwrap, webkitPresenter, type WebkitPresenterOptions, type WebShell } from '../src/presenters/webkit.ts'
import type { CredentialRecord, Signer } from '../src/signer.ts'
import { STATUS_SCRIPT } from '../src/presenters/shared.ts'
import { PublishError } from '../src/engine.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_SHELL = join(HERE, 'helpers', 'fake-shell.mjs')

// The presenter spawns whatever shellPath points at; pointing it at the fake
// shell (same stdio protocol, scripted via env) tests the whole drive loop
// without WebKit. shellSource points at the fake too so no build is attempted.
function makeRun (env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-webkit-'))
  const logFile = join(dir, 'cmds.log')
  const argvFile = join(dir, 'argv.log')
  const kbLogDir = join(dir, 'kblogs')
  const restore: Array<[string, string | undefined]> = []
  // KEYBRIDGE_LOG_DIR keeps the presenter's persistent diagnostics out of the
  // real ~/.keybridge/logs during tests.
  for (const [k, v] of Object.entries({ ...env, FAKE_LOG: logFile, FAKE_ARGV_LOG: argvFile, KEYBRIDGE_LOG_DIR: kbLogDir })) {
    restore.push([k, process.env[k]])
    process.env[k] = v
  }
  chmodSync(FAKE_SHELL, 0o755)
  return {
    logFile,
    kbLogDir,
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

test('a +remember status suffix still counts as its base status and is logged', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'not-found,clicked+remember,clicked' })
  t.after(run.dispose)

  const logs: string[] = []
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({ log: (m) => logs.push(m) }))({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-8',
    signal: abort.signal,
  })
  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 3 } catch { return false }
  })
  abort.abort()
  await presentation

  assert.ok(logs.some((m) => /remember for 5 minutes/.test(m)), 'remember tick is surfaced to the log')
  assert.ok(logs.some((m) => /ceremony triggered/.test(m)), 'clicked+remember still announces the click')
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

test('a click that starts no ceremony is re-armed, at most a few times', async (t) => {
  // The 2026-08-04 silent hang: the page reported 'clicked' but the click
  // had landed before npm's handler attached, so no WebAuthn request ever
  // followed - and the in-page one-shot flag blocked every retry. The
  // presenter must notice the silence and re-arm the click, with a cap.
  const run = makeRun({ FAKE_EVALS: Array(60).fill('clicked').join(',') })
  t.after(run.dispose)

  const logs: string[] = []
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({ reclickAfterMs: 20, log: (m) => logs.push(m) }))({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-13',
    signal: abort.signal,
  })

  const rearms = () => run.commands().filter((c) => c.cmd === 'eval' && /__keybridgeClicked = false/.test(c.js as string))
  await until(() => {
    try { return rearms().length >= 3 } catch { return false }
  })
  // Give the loop room to overshoot the cap before stopping it.
  await new Promise((r) => setTimeout(r, 150))
  abort.abort()
  await presentation

  assert.equal(rearms().length, 3, 're-armed exactly MAX_RECLICKS times, then gave up')
  assert.ok(logs.some((m) => /re-clicking \(1\/3\)/.test(m)), 'each re-arm is announced')
  assert.ok(logs.some((m) => /re-clicking \(3\/3\)/.test(m)))
})

test('a click whose ceremony arrived is never re-armed', async (t) => {
  // A WebAuthn request on the same page means the click was live - re-arming
  // then could stack a second Touch ID prompt on the human.
  const run = makeRun({
    FAKE_EVALS: Array(60).fill('clicked').join(','),
    FAKE_WEBAUTHN: JSON.stringify({
      op: 'get',
      options: { challenge: { $b64: 'AQIDBA' } },
      origin: 'https://www.npmjs.com',
    }),
  })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({
    reclickAfterMs: 20,
    webauthn: async () => ({ ok: true, credential: { id: 'fake-cred' } }),
  }))({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-14', signal: abort.signal })

  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 20 } catch { return false }
  })
  abort.abort()
  await presentation

  const rearms = run.commands().filter((c) => c.cmd === 'eval' && /__keybridgeClicked = false/.test(c.js as string))
  assert.equal(rearms.length, 0, 'a live click is left alone')
})

// --- embedded Touch ID (PRD §6.7): signing moves into the ceremony shell ---

const SE_RECORD = {
  credId: 'cred-1', rpId: 'www.npmjs.com', userHandle: null,
  backend: 'secure-enclave', keyTag: 'bi.atomic.keybridge.cred-1', signCount: 1,
} satisfies CredentialRecord

/** A base signer that records whether the standalone helper path was used. */
function baseSigner (): Signer & { signs: Array<{ reason: string }> } {
  const signs: Array<{ reason: string }> = []
  return {
    signs,
    backend: 'secure-enclave',
    register: () => ({ credId: Buffer.from('x'), publicKey: { x: Buffer.alloc(32), y: Buffer.alloc(32) } }),
    selectForAssertion: () => ({ record: SE_RECORD, signCount: 1 }),
    async sign (_record, _message, reason) {
      signs.push({ reason })
      return Buffer.from('system-sheet-signature')
    },
  }
}

function stubShell (sign: (tag: string, message: Buffer, reason: string) => Promise<Buffer>): WebShell {
  return { sign } as unknown as WebShell
}

test('routes Secure Enclave signing through the live shell, with a display-ready label', async () => {
  const base = baseSigner()
  const calls: Array<{ tag: string, reason: string }> = []
  const signer = shellSigner(base, () => stubShell(async (tag, _message, reason) => {
    calls.push({ tag, reason })
    return Buffer.from('embedded-signature')
  }))

  const sig = await signer.sign(SE_RECORD, Buffer.from('payload'), 'publish keybridge@0.7.0 to npm as tstrebitzer')

  assert.equal(sig.toString(), 'embedded-signature')
  assert.equal(base.signs.length, 0, 'the standalone Touch ID helper was never invoked')
  assert.equal(calls[0]!.tag, SE_RECORD.keyTag)
  // The HUD renders this as its own sentence, not as “…is trying to <reason>”.
  assert.equal(calls[0]!.reason, 'Publish keybridge@0.7.0 to npm as tstrebitzer')
})

test('falls back to the system sheet when the embedded prompt cannot run', async () => {
  // biometry not enrolled / Touch ID unavailable: the HUD must degrade, never
  // block (PRD §6.6).
  const base = baseSigner()
  const signer = shellSigner(base, () => stubShell(async () => {
    const err = new Error('cannot evaluate biometrics') as Error & { code?: string }
    err.code = 'EEMBEDUNAVAIL'
    throw err
  }))

  const sig = await signer.sign(SE_RECORD, Buffer.from('payload'), 'publish x@1 to npm')

  assert.equal(sig.toString(), 'system-sheet-signature')
  assert.equal(base.signs.length, 1, 'the standalone helper took over')
})

test('a cancelled Touch ID is NOT retried through the system sheet', async () => {
  // userCancel is the human saying no - re-asking via a second prompt would be
  // a prompt they never asked for.
  const base = baseSigner()
  const signer = shellSigner(base, () => stubShell(async () => {
    const err = new Error('Touch ID / user presence check failed: userCancel') as Error & { code?: string }
    err.code = 'userCancel'
    throw err
  }))

  await assert.rejects(
    () => signer.sign(SE_RECORD, Buffer.from('payload'), 'publish x@1 to npm'),
    /userCancel/)
  assert.equal(base.signs.length, 0, 'no second prompt after a deliberate cancel')
})

test('software credentials never go near the shell', async () => {
  const base = baseSigner()
  let shellUsed = false
  const signer = shellSigner(base, () => stubShell(async () => { shellUsed = true; return Buffer.alloc(0) }))

  await signer.sign({ ...SE_RECORD, backend: 'software' }, Buffer.from('p'), 'authenticate to www.npmjs.com')

  assert.equal(shellUsed, false)
  assert.equal(base.signs.length, 1)
})

test('shows the ceremony HUD for the whole flow and closes it at teardown', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'pending,clicked' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort())
  const presentation = webkitPresenter(presenterOpts({
    ceremonyContext: { pkg: 'keybridge@0.7.0', user: 'tstrebitzer' },
  }))({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-15', signal: abort.signal, purpose: 'publish' })

  // Wait for the click to be seen, not just for the panel: the status update
  // it triggers is what this test is about.
  await until(() => {
    try { return run.commands().some((c) => c.cmd === 'hud-status') } catch { return false }
  })
  abort.abort()
  await presentation
  await until(() => run.commands().some((c) => c.cmd === 'hud-close'))

  const cmds = run.commands()
  const show = cmds.find((c) => c.cmd === 'hud-show')!
  // The embedded view is icon-only, so this line is the only thing naming what
  // is being approved - it must carry the package and the account.
  assert.equal(show.reason, 'Publish keybridge@0.7.0 to npm as tstrebitzer')
  assert.ok(cmds.some((c) => c.cmd === 'hud-status' && /security key/.test(c.status as string)),
    'the click advances the HUD status')
})

test('the HUD close button aborts the ceremony fatally, not silently', async (t) => {
  // The ✕ is meant to behave like ctrl-C. Without a FATAL error the engine
  // would keep polling doneUrl for five minutes after the human gave up.
  const run = makeRun({ FAKE_EVALS: 'pending,pending,clicked', FAKE_DISMISS_AFTER_EVALS: '2' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort())
  await assert.rejects(
    Promise.resolve(webkitPresenter(presenterOpts())({
      authUrl: 'https://www.npmjs.com/auth/cli/uuid-17',
      signal: abort.signal,
      purpose: 'publish',
    })),
    (e: unknown) => e instanceof PublishError && e.code === 'ECANCEL' && e.fatal === true &&
      /cancelled from the sheet/.test(e.message),
  )
})

test('KEYBRIDGE_HUD=0 restores the invisible flow (no panel, no in-shell signing)', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'pending,clicked', KEYBRIDGE_HUD: '0' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort())
  const presentation = webkitPresenter(presenterOpts())({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-16',
    signal: abort.signal,
    purpose: 'publish',
  })

  await until(() => {
    try { return run.commands().filter((c) => c.cmd === 'eval').length >= 2 } catch { return false }
  })
  abort.abort()
  await presentation
  await until(() => run.commands().some((c) => c.cmd === 'close'))

  const cmds = run.commands()
  assert.equal(cmds.filter((c) => String(c.cmd).startsWith('hud-')).length, 0, 'no HUD commands at all')
  assert.equal(cmds.filter((c) => c.cmd === 'sign').length, 0, 'signing stays with the standalone helper')
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

test('a shell that dies before ready fails the presentation fast and fatally', async (t) => {
  // Launch failure used to be swallowed as a non-fatal presenter error while
  // the engine silently polled doneUrl for the full timeout - the "hung with
  // no prompt" shape. Nothing can ever answer a hidden ceremony without the
  // shell, so this must be fatal.
  const run = makeRun({ FAKE_DIE: '1' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort())
  await assert.rejects(
    Promise.resolve(webkitPresenter(presenterOpts())({
      authUrl: 'https://www.npmjs.com/auth/cli/uuid-10',
      signal: abort.signal,
    })),
    (e: unknown) => e instanceof PublishError && e.code === 'ESHELL' && e.fatal === true &&
      /could not start/.test(e.message),
  )
})

test('a shell that exits mid-ceremony fails the presentation fatally', async (t) => {
  // A crashed shell is otherwise invisible: every eval rejects and reads as
  // 'pending' forever, so the drive loop would spin silently to the timeout.
  const run = makeRun({ FAKE_EVALS: 'pending,pending', FAKE_EXIT_AFTER_EVALS: '2' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort())
  await assert.rejects(
    Promise.resolve(webkitPresenter(presenterOpts())({
      authUrl: 'https://www.npmjs.com/auth/cli/uuid-11',
      signal: abort.signal,
    })),
    (e: unknown) => e instanceof PublishError && e.code === 'ESHELL' && e.fatal === true &&
      /exited unexpectedly \(code 86\)/.test(e.message),
  )
})

test('ceremony diagnostics land in the persistent log', async (t) => {
  const run = makeRun({ FAKE_EVALS: 'clicked' })
  t.after(run.dispose)

  const abort = new AbortController()
  t.after(() => abort.abort())
  const presentation = webkitPresenter(presenterOpts())({
    authUrl: 'https://www.npmjs.com/auth/cli/uuid-12',
    signal: abort.signal,
    purpose: 'publish',
  })
  await until(() => {
    try { return run.commands().some((c) => c.cmd === 'eval') } catch { return false }
  })
  abort.abort()
  await presentation

  const [file] = readdirSync(run.kbLogDir)
  assert.ok(file, 'a log file was created')
  const events = readFileSync(join(run.kbLogDir, file!), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { event: string, purpose?: string })
  assert.ok(events.some((e) => e.event === 'ceremony-start' && e.purpose === 'publish'))
  assert.ok(events.some((e) => e.event === 'ceremony-end'))
})

test('the ceremony purpose + context become the Touch ID reason for the responder', async (t) => {
  const run = makeRun({
    FAKE_EVALS: 'clicked',
    FAKE_WEBAUTHN: JSON.stringify({
      op: 'get',
      options: { challenge: { $b64: 'AQIDBA' } },
      origin: 'https://www.npmjs.com',
    }),
  })
  t.after(run.dispose)

  const reasons: Array<string | undefined> = []
  const abort = new AbortController()
  t.after(() => abort.abort()) // a failed assertion must not leave the drive loop running
  const presentation = webkitPresenter(presenterOpts({
    ceremonyContext: { pkg: 'keybridge@9.9.9', user: 'tstrebitzer' },
    webauthn: async (_op, _options, _origin, reason) => {
      reasons.push(reason)
      return { ok: true, credential: { id: 'fake-cred' } }
    },
  }))({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-9', signal: abort.signal, purpose: 'publish' })

  await until(() => {
    try { return run.commands().some((c) => c.cmd === 'webauthn-result') } catch { return false }
  })
  abort.abort()
  await presentation

  assert.deepEqual(reasons, ['publish keybridge@9.9.9 to npm as tstrebitzer'])
})

test('ceremonyReason phrases every purpose/context combination', () => {
  assert.equal(ceremonyReason('publish', { pkg: 'a@1.0.0', user: 'bob' }), 'publish a@1.0.0 to npm as bob')
  assert.equal(ceremonyReason('publish', { pkg: 'a@1.0.0' }), 'publish a@1.0.0 to npm')
  assert.equal(ceremonyReason('publish', undefined), 'publish a package to npm')
  assert.equal(ceremonyReason('login', { user: 'bob' }), 'log in to npm as bob')
  assert.equal(ceremonyReason('login', undefined), 'log in to npm')
  // A trust ceremony approves a STANDING grant to CI, not one release - the
  // sheet must not read like a publish.
  assert.equal(
    ceremonyReason('trust', { pkg: '@acme/client', user: 'bob' }),
    'configure trusted publishing for @acme/client on npm as bob')
  assert.equal(ceremonyReason('trust', undefined), 'configure trusted publishing for a package on npm')
  assert.equal(ceremonyReason(undefined, { pkg: 'a@1.0.0' }), undefined, 'no purpose -> default rpId phrasing downstream')
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
