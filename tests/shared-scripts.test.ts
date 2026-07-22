// STATUS_SCRIPT / CAPTURE_SCRIPT run inside npm's pages via the shell's eval
// channel - here they run in a vm sandbox against a stubbed DOM, which pins
// the in-page behavior (click-once, remember-once, suffix reporting) without
// WebKit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { CAPTURE_SCRIPT, STATUS_SCRIPT } from '../src/presenters/shared.ts'

interface StubCheckbox {
  checked: boolean
  clicks: number
  labels: Array<{ textContent: string }>
  name: string
  id: string
  ariaLabel: string
  getAttribute: (name: string) => string
  closest: () => null
  parentElement: null
  click: () => void
}

function checkbox (labelText: string, { checked = false, ariaLabel = '', name = '', id = '' } = {}): StubCheckbox {
  const box: StubCheckbox = {
    checked,
    clicks: 0,
    labels: labelText ? [{ textContent: labelText }] : [],
    name,
    id,
    ariaLabel,
    getAttribute: (attr) => attr === 'aria-label' ? box.ariaLabel : '',
    closest: () => null,
    parentElement: null,
    click () { box.clicks++; box.checked = !box.checked },
  }
  return box
}

function button (text: string) {
  const el = { textContent: text, value: '', clicks: 0, click () { el.clicks++ } }
  return el
}

function makePage ({ checkboxes = [] as StubCheckbox[], buttons = [] as ReturnType<typeof button>[], password = false } = {}) {
  const sandbox: Record<string, unknown> = {
    document: {
      readyState: 'complete',
      querySelectorAll: (sel: string) => sel.includes('checkbox') ? checkboxes : buttons,
      querySelector: (sel: string) => password && sel.includes('password') ? {} : null,
    },
  }
  sandbox.window = sandbox
  return vm.createContext(sandbox)
}

const runStatus = (ctx: vm.Context): unknown => vm.runInContext(STATUS_SCRIPT, ctx)

test('clicks the security key button exactly once per page', () => {
  const key = button('Use security key')
  const page = makePage({ buttons: [button('Cancel'), key] })
  assert.equal(runStatus(page), 'clicked')
  assert.equal(runStatus(page), 'clicked')
  assert.equal(key.clicks, 1, 'window flag stops the second click')
})

test('ticks the remember-for-5-minutes checkbox before clicking, reports +remember once', () => {
  const box = checkbox("Don't ask again on this device for 5 minutes")
  const key = button('Use security key')
  const page = makePage({ checkboxes: [box], buttons: [key] })
  assert.equal(runStatus(page), 'clicked+remember')
  assert.equal(box.clicks, 1)
  assert.equal(box.checked, true)
  assert.equal(key.clicks, 1)
  assert.equal(runStatus(page), 'clicked', 'remember is one-shot per page')
  assert.equal(box.clicks, 1, 'never re-clicked (would untick it)')
})

test("ticks npm's real cooldown checkbox (empty label, aria-label + name only)", () => {
  // Exact shape captured live from /escalate/webauthn on 2026-07-22.
  const box = checkbox('', {
    ariaLabel: 'Do not challenge npm publish, npm trust operations from IP address 202.65.234.30 for the next 5 minutes',
    name: 'didOptForCooldown',
    id: 'cooldownOptin_didOptForCooldown',
  })
  const page = makePage({ checkboxes: [box], buttons: [button('Use security key')] })
  assert.equal(runStatus(page), 'clicked+remember')
  assert.equal(box.checked, true)
})

test('an already-checked remember checkbox is reported but not clicked', () => {
  const box = checkbox('Remember this device', { checked: true })
  const page = makePage({ checkboxes: [box], buttons: [button('Use security key')] })
  assert.equal(runStatus(page), 'clicked+remember')
  assert.equal(box.clicks, 0, 'clicking would UNtick it')
})

test('unrelated checkboxes are left alone', () => {
  const box = checkbox('Subscribe to the npm newsletter')
  const page = makePage({ checkboxes: [box] })
  assert.equal(runStatus(page), 'not-found')
  assert.equal(box.clicks, 0)
})

test('reports a password login page', () => {
  const page = makePage({ password: true })
  assert.equal(runStatus(page), 'login-page')
})

test('CAPTURE_SCRIPT returns a parseable snapshot', () => {
  const box = checkbox('Remember this device')
  const sandbox: Record<string, unknown> = {
    location: { href: 'https://www.npmjs.com/auth/cli/uuid' },
    document: {
      title: 'npm | auth',
      readyState: 'complete',
      documentElement: { outerHTML: '<html>page</html>' },
      querySelectorAll: () => [{ tagName: 'INPUT', type: 'checkbox', name: 'remember', id: '', checked: false, labels: box.labels }],
    },
  }
  sandbox.window = sandbox
  const raw = vm.runInContext(CAPTURE_SCRIPT, vm.createContext(sandbox)) as string
  const snap = JSON.parse(raw) as { url: string, html: string, controls: Array<{ type?: string, text: string }> }
  assert.equal(snap.url, 'https://www.npmjs.com/auth/cli/uuid')
  assert.equal(snap.html, '<html>page</html>')
  assert.equal(snap.controls[0]!.type, 'checkbox')
  assert.match(snap.controls[0]!.text, /Remember this device/)
})
