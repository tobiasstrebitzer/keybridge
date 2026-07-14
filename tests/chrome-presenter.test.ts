import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { chromePresenter, closeChromePresenter, extIdFromPath } from '../src/presenters/chrome.ts'
import { FakeCdp, type CdpCommand } from './helpers/fake-cdp.ts'

// The presenter reattaches to a "warm Chrome" through the profile's
// DevToolsActivePort file — pointing that file at a FakeCdp lets us script the
// whole ceremony without launching a real browser.
function makeProfile (fake: FakeCdp) {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-profile-'))
  const { hostname, port, pathname } = new URL(fake.url)
  void hostname
  writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n${pathname}`)
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const EXT_PATH = '/opt/fake/keybridge-extension'
const EXT_ID = extIdFromPath(EXT_PATH)

function ceremonyHandler (evalResults: string[]): (cmd: CdpCommand) => Record<string, unknown> {
  return (cmd) => {
    switch (cmd.method) {
      case 'Extensions.loadUnpacked': return { id: EXT_ID }
      case 'Target.createTarget': return { targetId: 'TAB-1' }
      case 'Target.attachToTarget': return { sessionId: 'SES-1' }
      case 'Runtime.evaluate': return { result: { value: evalResults.shift() ?? 'not-found' } }
      case 'Browser.getWindowForTarget': return { windowId: 7 }
      default: return {}
    }
  }
}

test('drives the ceremony: reattach, load extension, navigate, click, teardown on abort', async (t) => {
  const fake = await FakeCdp.start(ceremonyHandler(['pending', 'not-found', 'clicked']))
  const profile = makeProfile(fake)
  t.after(async () => { await closeChromePresenter(); await fake.close(); profile.dispose() })

  const presenter = chromePresenter({
    userDataDir: profile.dir,
    extensionPath: EXT_PATH,
    pollIntervalMs: 5,
    log: () => {},
    notify: () => {},
  })

  const abort = new AbortController()
  const presentation = presenter({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-1', signal: abort.signal })

  // wait until the click landed (third evaluate), then complete the ceremony
  await fake.waitForCommand('Runtime.evaluate')
  while (fake.commands.filter((c) => c.method === 'Runtime.evaluate').length < 3) {
    await new Promise((r) => setTimeout(r, 5))
  }
  abort.abort()
  await presentation

  const methods = fake.commands.map((c) => c.method)
  assert.ok(methods.includes('Extensions.loadUnpacked'), 'must ensure the extension is loaded')
  const load = fake.commands.find((c) => c.method === 'Extensions.loadUnpacked')!
  assert.equal(load.params.path, EXT_PATH)

  const create = fake.commands.find((c) => c.method === 'Target.createTarget')!
  assert.equal(create.params.url, 'https://www.npmjs.com/auth/cli/uuid-1')

  const evals = fake.commands.filter((c) => c.method === 'Runtime.evaluate')
  assert.ok(evals.every((c) => c.sessionId === 'SES-1'), 'evaluate must run in the tab session')
  assert.equal(evals.length, 3, 'polling stops once the button was clicked')

  assert.ok(methods.includes('Target.closeTarget'), 'tab must be closed on abort')
  const close = fake.commands.find((c) => c.method === 'Target.closeTarget')!
  assert.equal(close.params.targetId, 'TAB-1')
  assert.ok(!methods.includes('Browser.close'), 'keepWarm leaves the browser running')
})

test('surfaces the window and notifies when npm bounces to a password login', async (t) => {
  const fake = await FakeCdp.start(ceremonyHandler(['login-page', 'login-page', 'clicked']))
  const profile = makeProfile(fake)
  t.after(async () => { await closeChromePresenter(); await fake.close(); profile.dispose() })

  const notifications: string[] = []
  const presenter = chromePresenter({
    userDataDir: profile.dir,
    extensionPath: EXT_PATH,
    pollIntervalMs: 5,
    log: () => {},
    notify: (m) => notifications.push(m),
  })

  const abort = new AbortController()
  const presentation = presenter({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-2', signal: abort.signal })

  // wait until the ceremony clicked (login-page x2 then clicked), so the
  // surface sequence has definitely run
  while (fake.commands.filter((c) => c.method === 'Runtime.evaluate').length < 3) {
    await new Promise((r) => setTimeout(r, 5))
  }
  abort.abort()
  await presentation

  const boundsCalls = fake.commands.filter((c) => c.method === 'Browser.setWindowBounds')
  // hide (minimized) on tab open, then surface = normal + reposition
  const hide = boundsCalls.find((c) => (c.params.bounds as { windowState?: string }).windowState === 'minimized')
  assert.ok(hide, 'window is hidden (minimized) while off-screen')
  const reposition = boundsCalls.find((c) => typeof (c.params.bounds as { left?: number }).left === 'number')
  assert.ok(reposition, 'window is repositioned on-screen for the login')
  assert.equal(reposition!.params.windowId, 7)
  assert.ok((reposition!.params.bounds as { left: number }).left >= 0, 'window must move on-screen')
  assert.equal(notifications.length, 1, 'human must be notified exactly once')

  // only one surface sequence even though login-page was seen twice
  assert.equal(boundsCalls.filter((c) => typeof (c.params.bounds as { left?: number }).left === 'number').length, 1,
    'window is only surfaced once')
})

test('an already-aborted signal is a no-op', async (t) => {
  const fake = await FakeCdp.start(ceremonyHandler([]))
  const profile = makeProfile(fake)
  t.after(async () => { await closeChromePresenter(); await fake.close(); profile.dispose() })

  const presenter = chromePresenter({
    userDataDir: profile.dir,
    extensionPath: EXT_PATH,
    log: () => {},
    notify: () => {},
  })
  const abort = new AbortController()
  abort.abort()
  await presenter({ authUrl: 'https://x.example/', signal: abort.signal })
  assert.equal(fake.commands.length, 0, 'no CDP traffic for an aborted ceremony')
})

test('keepWarm: false closes the whole browser after the ceremony', async (t) => {
  const fake = await FakeCdp.start(ceremonyHandler(['clicked']))
  const profile = makeProfile(fake)
  t.after(async () => { await closeChromePresenter(); await fake.close(); profile.dispose() })

  const presenter = chromePresenter({
    userDataDir: profile.dir,
    extensionPath: EXT_PATH,
    keepWarm: false,
    pollIntervalMs: 5,
    log: () => {},
    notify: () => {},
  })

  const abort = new AbortController()
  const presentation = presenter({ authUrl: 'https://www.npmjs.com/auth/cli/uuid-3', signal: abort.signal })
  await fake.waitForCommand('Runtime.evaluate')
  abort.abort()
  await presentation

  assert.ok(fake.commands.some((c) => c.method === 'Browser.close'), 'browser must be closed')
})
