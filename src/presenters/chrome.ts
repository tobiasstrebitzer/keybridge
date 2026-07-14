// Tier A presenter: an invisible, off-screen, *headed* Chrome drives the
// WebAuthn ceremony so the only thing the human sees is Touch ID.
//
// Why a browser at all: www.npmjs.com sits behind Cloudflare bot management —
// a pure HTTP client gets a managed JS challenge (403 cf-mitigated). A real
// Chrome with a persistent profile passes naturally, and the profile keeps the
// cf_clearance + wub cookies and the keybridge extension across publishes.
// See _docs/HEADLESS_UX_RESEARCH.md. Headless is not an option: new-headless
// Chrome does not run unpacked MV3 extensions.
//
// Flow per ceremony: launch/reuse Chrome (off-screen via --window-position),
// ensure the extension is loaded (CDP Extensions.loadUnpacked — the
// --load-extension flag is dead since Chrome 150), open a tab on authUrl,
// auto-click "Use security key" (fires navigator.credentials.get() → the
// extension → native host → Secure Enclave → Touch ID), then close the tab
// when the engine aborts the signal (doneUrl returned the token).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CdpClient } from '../cdp.ts'
import type { Presenter } from '../engine.ts'
import { notifyHuman } from './browser.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KB_DIR = join(homedir(), '.keybridge')
const HOST_NAME = 'bi.atomic.keybridge.webauthn'

export interface ChromePresenterOptions {
  /** Chrome binary. Must be real Google Chrome (native-messaging manifest paths). */
  chromePath?: string
  /** Unpacked keybridge extension directory. The unpacked id derives from this absolute path. */
  extensionPath?: string
  /** Persistent profile holding cf_clearance + wub cookies and the extension. */
  userDataDir?: string
  /** Keep Chrome running (off-screen) between ceremonies. Default true. */
  keepWarm?: boolean
  /** If the auth page bounces to a password login, move the window on-screen. Default true. */
  surfaceOnLogin?: boolean
  pollIntervalMs?: number
  launchTimeoutMs?: number
  /** Diagnostics sink (default: stderr). */
  log?: (message: string) => void
  /** Human-notification hook (default: macOS notification). */
  notify?: (message: string) => void
}

interface ResolvedOptions {
  chromePath: string
  extensionPath: string
  userDataDir: string
  keepWarm: boolean
  surfaceOnLogin: boolean
  pollIntervalMs: number
  launchTimeoutMs: number
  log: (message: string) => void
  notify: (message: string) => void
}

export function resolveOptions (opts: ChromePresenterOptions = {}): ResolvedOptions {
  return {
    chromePath: opts.chromePath
      ?? process.env.KEYBRIDGE_CHROME
      ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    extensionPath: resolve(opts.extensionPath
      ?? process.env.KEYBRIDGE_EXTENSION
      ?? join(HERE, '..', '..', 'v2', 'extension')),
    userDataDir: opts.userDataDir
      ?? process.env.KEYBRIDGE_CHROME_PROFILE
      ?? join(KB_DIR, 'chrome-profile'),
    keepWarm: opts.keepWarm ?? true,
    surfaceOnLogin: opts.surfaceOnLogin ?? true,
    pollIntervalMs: opts.pollIntervalMs ?? 500,
    launchTimeoutMs: opts.launchTimeoutMs ?? 20_000,
    log: opts.log ?? ((m) => process.stderr.write(`[keybridge chrome] ${m}\n`)),
    notify: opts.notify ?? notifyHuman,
  }
}

// Chrome derives an unpacked extension's ID from the SHA-256 of its absolute
// path: first 16 bytes, each nibble mapped 0..15 -> 'a'..'p'.
export function extIdFromPath (absPath: string): string {
  const hash = createHash('sha256').update(absPath, 'utf8').digest()
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i]! >> 4))
    id += String.fromCharCode(97 + (hash[i]! & 0x0f))
  }
  return id
}

// Chrome launched with a custom --user-data-dir resolves native-messaging
// manifests under <user-data-dir>/NativeMessagingHosts (the standard
// ~/Library/... path is NOT consulted), so the ceremony profile needs its own
// copy. Points at the /bin/sh launcher install.mjs wrote (absolute node path —
// Chrome strips PATH for native hosts). Manifests are read at Chrome startup.
export function ensureNativeManifest (userDataDir: string, extensionPath: string): void {
  const launcher = join(KB_DIR, 'keybridge-launch.sh')
  if (!existsSync(launcher)) {
    throw new Error(`keybridge native host launcher not found at ${launcher} — run \`node v2/install.mjs\` first`)
  }
  const manifest = {
    name: HOST_NAME,
    description: 'keybridge WebAuthn signing host',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extIdFromPath(extensionPath)}/`],
  }
  const dir = join(userDataDir, 'NativeMessagingHosts')
  const file = join(dir, `${HOST_NAME}.json`)
  const json = JSON.stringify(manifest, null, 2)
  try { if (readFileSync(file, 'utf8') === json) return } catch {}
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, json)
}

// One warm Chrome per process (module-level). Cross-process reuse goes through
// the profile's DevToolsActivePort file, so a CLI invocation can reattach to
// the Chrome a previous invocation left warm.
let warm: { client: CdpClient, userDataDir: string } | null = null

function readDevToolsActivePort (userDataDir: string): string | null {
  try {
    const [port, path] = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')
    if (!port || !path) return null
    return `ws://127.0.0.1:${port}${path}`
  } catch { return null }
}

async function launchChrome (o: ResolvedOptions): Promise<CdpClient> {
  if (!existsSync(o.chromePath)) {
    throw new Error(`Chrome not found at ${o.chromePath} (set KEYBRIDGE_CHROME or pass chromePath)`)
  }
  mkdirSync(o.userDataDir, { recursive: true })
  ensureNativeManifest(o.userDataDir, o.extensionPath)

  const args = [
    `--user-data-dir=${o.userDataDir}`,
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging', // Extensions.loadUnpacked over a raw ws port
    '--window-position=-32000,-32000',     // nudge off-screen (macOS clamps this to the display edge; we also minimize below)
    '--window-size=1000,720',
    '--start-minimized',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    'about:blank',
  ]
  const child = spawn(o.chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  child.unref()

  // Chrome prints "DevTools listening on ws://..." to stderr once ready.
  const wsUrl = await new Promise<string>((resolvePromise, reject) => {
    let buf = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      // A Chrome already running on this profile (without a debug port) makes
      // our process defer to it and never print the DevTools line.
      reject(new Error(
        `Chrome did not report a DevTools endpoint within ${o.launchTimeoutMs}ms — ` +
        `is another Chrome already running with profile ${o.userDataDir}?`
      ))
    }, o.launchTimeoutMs)
    child.stderr!.on('data', (d: Buffer) => {
      if (done) { return }
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) {
        done = true
        clearTimeout(timer)
        child.stderr!.resume() // keep draining, discard
        resolvePromise(m[1]!)
      }
    })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`Chrome exited with code ${code} before the DevTools endpoint appeared (profile locked by another instance?)`))
    })
  })

  return CdpClient.connect(wsUrl)
}

// Ensure the keybridge extension is loaded in this browser. --load-extension
// is silently ignored since Chrome 150; Extensions.loadUnpacked is the
// supported path. Loading the same absolute path is idempotent id-wise (the
// unpacked id is derived from the path), so a warm profile that already has
// the extension resolves to the same id.
async function ensureExtension (client: CdpClient, o: ResolvedOptions): Promise<string> {
  const expectedId = extIdFromPath(o.extensionPath)
  try {
    const { id } = await client.send<{ id: string }>('Extensions.loadUnpacked', { path: o.extensionPath })
    if (id !== expectedId) o.log(`extension loaded with unexpected id ${id} (expected ${expectedId})`)
    return id
  } catch (e) {
    // Already-installed extensions can make loadUnpacked unhappy; accept if
    // Chrome shows the extension's service worker / pages as a known target.
    const { targetInfos } = await client.send<{ targetInfos: Array<{ url: string }> }>('Target.getTargets')
    if (targetInfos.some((t) => t.url.startsWith(`chrome-extension://${expectedId}/`))) return expectedId
    throw new Error(`could not load the keybridge extension from ${o.extensionPath}: ${(e as Error).message}`, { cause: e })
  }
}

async function ensureBrowser (o: ResolvedOptions): Promise<CdpClient> {
  if (warm && warm.userDataDir === o.userDataDir && warm.client.connected) return warm.client
  warm = null

  // Reattach to a Chrome a previous invocation left warm on this profile.
  const existing = readDevToolsActivePort(o.userDataDir)
  let client: CdpClient | null = null
  if (existing) {
    client = await CdpClient.connect(existing, { timeoutMs: 1500 }).catch(() => null)
    if (client) o.log(`reusing warm Chrome at ${existing}`)
  }
  if (!client) {
    o.log(`launching off-screen Chrome (profile ${o.userDataDir})`)
    client = await launchChrome(o)
  }
  await ensureExtension(client, o)
  warm = { client, userDataDir: o.userDataDir }
  return client
}

// In-page script polled via Runtime.evaluate. Finds npm's "Use security key"
// button and clicks it (which fires navigator.credentials.get() → keybridge).
// Also reports when the page bounced to a password login (expired wub cookie)
// so we can surface the window for the human.
const STATUS_SCRIPT = `(() => {
  try {
    if (document.readyState === 'loading') return 'pending'
    const clickable = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
    const key = clickable.find((el) => /use security key|security key/i.test(el.textContent || el.value || ''))
    if (key) { key.click(); return 'clicked' }
    if (document.querySelector('input[type="password"]')) return 'login-page'
    return 'not-found'
  } catch (e) { return 'pending' }
})()`

async function pageStatus (client: CdpClient, sessionId: string): Promise<string> {
  try {
    const { result } = await client.send<{ result: { value?: string } }>(
      'Runtime.evaluate',
      { expression: STATUS_SCRIPT, returnByValue: true },
      sessionId,
    )
    return result.value ?? 'pending'
  } catch {
    return 'pending' // navigation in flight; evaluate again next tick
  }
}

// macOS clamps a window's position to the visible display, so we can't shove
// it to (-32000, -32000). Minimizing is the reliable "invisible" state — and
// (probed live) the page's JS and network keep running while minimized, so the
// ceremony still completes with only the Touch ID dialog visible.
async function hideWindow (client: CdpClient, targetId: string): Promise<void> {
  const { windowId } = await client.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
  await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
}

async function surfaceWindow (client: CdpClient, targetId: string): Promise<void> {
  const { windowId } = await client.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
  // Un-minimize first: Chrome ignores position changes on a minimized window.
  await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await client.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 120, top: 120, width: 1000, height: 760 },
  })
}

function waitForAbort (signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((r) => signal.addEventListener('abort', () => r(), { once: true }))
}

/**
 * The Tier A presenter. Engine contract: called with ({ authUrl, signal });
 * must get the human to the ceremony; the engine aborts `signal` once doneUrl
 * reports completion (or on timeout), at which point we tear the tab down.
 */
export function chromePresenter (opts: ChromePresenterOptions = {}): Presenter {
  const o = resolveOptions(opts)

  return async ({ authUrl, signal }) => {
    if (signal.aborted) return
    const client = await ensureBrowser(o)

    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: authUrl })
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    // Opening a tab can raise the window; keep it hidden until/unless we need
    // the human (password login), then surface it.
    await hideWindow(client, targetId).catch(() => {})

    let surfaced = false
    try {
      let clicked = false
      while (!signal.aborted && !clicked) {
        const status = await pageStatus(client, sessionId)
        if (status === 'clicked') {
          clicked = true
          o.log('ceremony triggered — waiting for Touch ID approval')
          break
        }
        if (status === 'login-page' && o.surfaceOnLogin && !surfaced) {
          surfaced = true
          o.log('npm wants a password login — surfacing the browser window')
          await surfaceWindow(client, targetId).catch(() => {})
          o.notify('npm needs you to log in — a browser window has been opened')
        }
        await delay(o.pollIntervalMs, null, { signal }).catch(() => {})
      }
      // The engine owns completion: it aborts the signal once doneUrl flips.
      await waitForAbort(signal)
    } finally {
      await client.send('Target.closeTarget', { targetId }).catch(() => {})
      if (!o.keepWarm) await closeChromePresenter()
    }
  }
}

/**
 * Release the CDP socket but leave Chrome running off-screen (warm for the
 * next invocation, which reattaches via DevToolsActivePort). Lets a CLI
 * process exit cleanly without paying the cold start next time.
 */
export function releaseChromePresenter (): void {
  if (!warm) return
  const { client } = warm
  warm = null
  client.close()
}

/** Tear down the warm Chrome (closes the whole browser). */
export async function closeChromePresenter (): Promise<void> {
  if (!warm) return
  const { client } = warm
  warm = null
  await client.send('Browser.close').catch(() => {})
  client.close()
}
