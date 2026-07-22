// The primary presenter (macOS): a WINDOWLESS WKWebView does the ceremony, so
// nothing is ever on screen except Touch ID - no browser window exists at all
// (no launch animation, no Dock icon).
//
// The shell (native/WebShell.swift, compiled to ~/.keybridge/
// keybridge-webshell) hosts the web view and speaks a JSON-lines stdio
// protocol; native/inject.js overrides navigator.credentials in the page
// world and routes ceremonies here, where they're answered in-process by the
// webauthn assembly + signer (src/webauthn.ts + src/signer.ts).
//
// Probed live 2026-07-14: a windowless WKWebView with a Safari UA loads
// www.npmjs.com and /login through Cloudflare with NO challenge even on a
// cold profile (unlike plain HTTP, which gets a managed challenge). Page
// timers are throttled while hidden, but the presenter drives the page via
// `eval`, which is not throttled.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { PublishError, type Presenter } from '../engine.ts'
import { CAPTURE_SCRIPT, prefillScript, STATUS_SCRIPT } from './shared.ts'
import { handleCreate, handleGet, type CreateOptions, type GetOptions } from '../webauthn.ts'
import { createSigner } from '../signer.ts'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const KB_DIR = join(homedir(), '.keybridge')
const NATIVE_DIR = resolve(join(HERE, '..', '..', 'native'))

export type WebAuthnResponse =
  | { ok: true, credential: unknown }
  | { ok: false, error: string, code?: string }
/** `reason` (when given) is the human-readable approval line for the Touch ID
 * dialog - phrased by the presenter from its ceremony context + purpose. */
export type WebAuthnResponder = (op: string, options: unknown, origin: string, reason?: string) => Promise<WebAuthnResponse>

/** What this shell session is authorizing - feeds the Touch ID reason line. */
export interface CeremonyContext {
  /** package id being published, e.g. "keybridge@0.5.1" */
  pkg?: string
  /** npm account the ceremony runs as */
  user?: string
}

/** The Touch ID dialog renders “"KeyBridge" is trying to <this>.” */
export function ceremonyReason (purpose: 'login' | 'publish' | undefined, ctx: CeremonyContext | undefined): string | undefined {
  const asUser = ctx?.user ? ` as ${ctx.user}` : ''
  if (purpose === 'publish') return `publish ${ctx?.pkg ?? 'a package'} to npm${asUser}`
  if (purpose === 'login') return `log in to npm${asUser}`
  return undefined
}

export interface WebkitPresenterOptions {
  /** Compiled shell binary. Default ~/.keybridge/keybridge-webshell (auto-built from shellSource when missing/stale). */
  shellPath?: string
  /** Swift source the binary is built from. */
  shellSource?: string
  /** navigator.credentials override injected at documentStart. */
  injectPath?: string
  /** Website-data-store UUID: which account profile's cookies the shell uses.
   * Default: the shell's built-in fixed id (the pre-accounts legacy store). */
  storeId?: string
  /** When npm bounces to a password login, prefill this username and focus
   * the password field (the flow knows who it is logging in as). */
  prefillUsername?: string
  /** What this ceremony authorizes (package, account) - shown in the Touch ID
   * dialog so concurrent publishes can never be confused. */
  ceremonyContext?: CeremonyContext
  /** Extra args for the shell (tests use ['--ephemeral']). */
  shellArgs?: string[]
  /** Answers create/get ceremonies. Default: v2 host webauthn + signer (Touch ID via Secure Enclave backend). */
  webauthn?: WebAuthnResponder
  /** If the auth page bounces to a password login, show a real window. Default true. */
  surfaceOnLogin?: boolean
  pollIntervalMs?: number
  launchTimeoutMs?: number
  /** Write a JSON snapshot of every distinct page state the shell renders
   * into this directory (DOM debugging). Default: a timestamped dir under
   * ~/.keybridge/captures when KEYBRIDGE_CAPTURE_DOM is set, else off. */
  captureDir?: string
  /** Diagnostics sink (default: stderr). */
  log?: (message: string) => void
  /** Attention hook for surfaced-window / dead-end moments (default: none -
   * the sheet itself is the signal; tests observe through this). */
  notify?: (message: string) => void
}

interface ResolvedOptions {
  shellPath: string
  shellSource: string
  injectPath: string
  shellArgs: string[]
  prefillUsername?: string
  ceremonyContext?: CeremonyContext
  captureDir?: string
  webauthn: WebAuthnResponder
  surfaceOnLogin: boolean
  pollIntervalMs: number
  launchTimeoutMs: number
  log: (message: string) => void
  notify: (message: string) => void
}

export function resolveWebkitOptions (opts: WebkitPresenterOptions = {}): ResolvedOptions {
  return {
    shellPath: opts.shellPath ?? process.env.KEYBRIDGE_WEBSHELL ?? join(KB_DIR, 'keybridge-webshell'),
    shellSource: opts.shellSource ?? join(NATIVE_DIR, 'WebShell.swift'),
    injectPath: opts.injectPath ?? join(NATIVE_DIR, 'inject.js'),
    shellArgs: [
      ...(opts.storeId ? ['--store-id', opts.storeId] : []),
      // Window chrome + prefers-color-scheme follow the system by default;
      // KEYBRIDGE_APPEARANCE=dark|light forces one.
      ...(process.env.KEYBRIDGE_APPEARANCE ? ['--appearance', process.env.KEYBRIDGE_APPEARANCE] : []),
      ...(opts.shellArgs ?? []),
    ],
    ...(opts.prefillUsername ? { prefillUsername: opts.prefillUsername } : {}),
    ...(opts.ceremonyContext ? { ceremonyContext: opts.ceremonyContext } : {}),
    ...(resolveCaptureDir(opts.captureDir)),
    webauthn: opts.webauthn ?? answerWebAuthn,
    surfaceOnLogin: opts.surfaceOnLogin ?? true,
    pollIntervalMs: opts.pollIntervalMs ?? 500,
    launchTimeoutMs: opts.launchTimeoutMs ?? 15_000,
    log: opts.log ?? ((m) => process.stderr.write(`[keybridge webkit] ${m}\n`)),
    notify: opts.notify ?? (() => {}),
  }
}

function resolveCaptureDir (explicit?: string): { captureDir?: string } {
  if (explicit) return { captureDir: explicit }
  if (!process.env.KEYBRIDGE_CAPTURE_DOM) return {}
  return { captureDir: join(KB_DIR, 'captures', new Date().toISOString().replace(/[:.]/g, '-')) }
}

/**
 * DOM debugging (KEYBRIDGE_CAPTURE_DOM): snapshots the page via
 * CAPTURE_SCRIPT on every tick and writes each DISTINCT state (url + html
 * fingerprint) to <captureDir>/NN.json - so one real ceremony records the
 * exact DOM of every npm auth page it passed through.
 */
export class DomCapture {
  #dir: string
  #log: (m: string) => void
  #seq = 0
  #lastSig = ''

  constructor (dir: string, log: (m: string) => void) {
    this.#dir = dir
    this.#log = log
    log(`DOM capture enabled -> ${dir}`)
  }

  async tick (shell: WebShell): Promise<void> {
    const raw = await shell.eval(CAPTURE_SCRIPT).catch(() => null)
    if (typeof raw !== 'string') return
    let snap: { url?: string, html?: string }
    try { snap = JSON.parse(raw) as { url?: string, html?: string } } catch { return }
    const sig = `${snap.url}#${snap.html?.length ?? 0}`
    if (sig === this.#lastSig) return
    this.#lastSig = sig
    const file = join(this.#dir, `${String(++this.#seq).padStart(2, '0')}.json`)
    try {
      mkdirSync(this.#dir, { recursive: true })
      writeFileSync(file, raw)
      this.#log(`captured page state ${this.#seq}: ${snap.url}`)
    } catch (e) {
      this.#log(`capture write failed: ${(e as Error).message}`)
    }
  }
}

// Undo inject.js's ArrayBuffer serialization: {$b64:"..."} -> the base64url
// string the webauthn module expects.
export function unwrap (v: unknown): unknown {
  if (v && typeof v === 'object' && typeof (v as { $b64?: unknown }).$b64 === 'string') {
    return (v as { $b64: string }).$b64
  }
  if (Array.isArray(v)) return v.map(unwrap)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) o[k] = unwrap((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

// Default ceremony responder. Note: the secure-enclave signer shells out
// synchronously, so the event loop stalls while the human decides on Touch ID;
// that's fine - the engine's doneUrl polling just resumes afterwards.
async function answerWebAuthn (op: string, options: unknown, origin: string, reason?: string): Promise<WebAuthnResponse> {
  try {
    const signer = createSigner()
    const opts = unwrap(options)
    const credential = op === 'create'
      ? await handleCreate(opts as CreateOptions, origin, signer)
      : await handleGet(opts as GetOptions, origin, signer, reason)
    return { ok: true, credential }
  } catch (e) {
    const err = e as Error & { code?: string }
    return { ok: false, error: err.message || String(e), ...(err.code ? { code: err.code } : {}) }
  }
}

/** True when the compiled shell exists and is newer than its Swift source. */
export function shellIsFresh (shellPath: string, shellSource: string): boolean {
  if (!existsSync(shellPath)) return false
  try { return statSync(shellPath).mtimeMs >= statSync(shellSource).mtimeMs } catch { return true }
}

async function ensureShellBinary (o: ResolvedOptions): Promise<void> {
  if (shellIsFresh(o.shellPath, o.shellSource)) return
  if (!existsSync(o.shellSource)) {
    throw new Error(`webkit shell binary missing at ${o.shellPath} and source not found at ${o.shellSource}`)
  }
  o.log(`building webkit shell (swiftc ${o.shellSource}) ...`)
  mkdirSync(dirname(o.shellPath), { recursive: true })
  await execFileP('swiftc', ['-O', o.shellSource, '-o', o.shellPath])
  await execFileP('codesign', ['--force', '--sign', '-', o.shellPath]).catch(() => {})
}

interface ShellMessage {
  event?: string
  id?: number
  value?: unknown
  error?: string
  url?: string
  op?: string
  options?: unknown
  origin?: string
}

/** Thin protocol client over the shell's stdio. */
export class WebShell {
  #child: ChildProcess
  #evalSeq = 0
  #pendingEvals = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>()
  #log: (m: string) => void
  /** Resolves with the exit code once the shell process is gone. */
  readonly exited: Promise<number | null>

  private constructor (child: ChildProcess, log: (m: string) => void) {
    this.#child = child
    this.#log = log
    // A write after the shell died (e.g. close() racing its exit) raises
    // EPIPE on stdin - swallow it, the exit handler already settles state.
    child.stdin?.on('error', () => {})
    this.exited = new Promise((resolveExit) => {
      child.once('exit', (code) => resolveExit(code))
      child.once('error', () => resolveExit(null))
    })
  }

  static start (o: ResolvedOptions): Promise<WebShell> {
    const child = spawn(o.shellPath, ['--inject', o.injectPath, ...o.shellArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const shell = new WebShell(child, o.log)

    createInterface({ input: child.stderr! }).on('line', (line) => o.log(`shell: ${line}`))

    return new Promise<WebShell>((resolvePromise, reject) => {
      let ready = false
      const timer = setTimeout(() => {
        if (ready) return
        child.kill()
        reject(new Error(`webkit shell did not report ready within ${o.launchTimeoutMs}ms`))
      }, o.launchTimeoutMs)

      createInterface({ input: child.stdout! }).on('line', (line) => {
        let msg: ShellMessage
        try { msg = JSON.parse(line) as ShellMessage } catch { return }
        if (msg.event === 'ready' && !ready) {
          ready = true
          clearTimeout(timer)
          resolvePromise(shell)
          return
        }
        shell.#dispatch(msg, o)
      })

      child.on('error', (e) => {
        clearTimeout(timer)
        if (!ready) reject(e)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (!ready) reject(new Error(`webkit shell exited with code ${code} before ready`))
        for (const p of shell.#pendingEvals.values()) p.reject(new Error('webkit shell exited'))
        shell.#pendingEvals.clear()
      })
    })
  }

  #dispatch (msg: ShellMessage, o: ResolvedOptions): void {
    switch (msg.event) {
      case 'eval-result': {
        const pending = this.#pendingEvals.get(msg.id ?? -1)
        if (!pending) return
        this.#pendingEvals.delete(msg.id ?? -1)
        if (msg.error) pending.reject(new Error(msg.error))
        else pending.resolve(msg.value)
        break
      }
      case 'webauthn': {
        const { id, op, options, origin } = msg
        this.#log(`webauthn ${op} requested by ${origin}`)
        void o.webauthn(op ?? '', options, origin ?? '')
          .catch((e: Error): WebAuthnResponse => ({ ok: false, error: e.message || String(e) }))
          .then((resp) => this.send({ cmd: 'webauthn-result', id, resp }))
        break
      }
      case 'nav':
        this.#log(`page: ${msg.url}`)
        break
      case 'surfaced':
        this.#log(`ceremony window surfaced (visible: ${(msg as { visible?: boolean }).visible})`)
        break
      case 'nav-error':
        this.#log(`navigation error: ${msg.error}`)
        break
      default:
        break
    }
  }

  send (msg: Record<string, unknown>): void {
    this.#child.stdin?.write(JSON.stringify(msg) + '\n')
  }

  eval (js: string): Promise<unknown> {
    const id = ++this.#evalSeq
    return new Promise((resolvePromise, reject) => {
      this.#pendingEvals.set(id, { resolve: resolvePromise, reject })
      this.send({ cmd: 'eval', id, js })
    })
  }

  /** Graceful close (lets the shell flush cookies), hard kill as backstop. */
  close (): void {
    this.send({ cmd: 'close' })
    const killer = setTimeout(() => this.#child.kill(), 1500)
    killer.unref()
    this.#child.once('exit', () => clearTimeout(killer))
  }
}

/**
 * Open the ceremony shell SURFACED on a URL, outside any engine ceremony -
 * used by `keybridge enroll` to let the human add the keybridge security key
 * on npm's 2FA settings page (the injected override answers the create()
 * ceremony with Touch ID). The caller owns the shell's lifetime.
 */
export async function openSurfacedShell (url: string, opts: WebkitPresenterOptions = {}): Promise<WebShell> {
  const o = resolveWebkitOptions(opts)
  await ensureShellBinary(o)
  const shell = await WebShell.start(o)
  shell.send({ cmd: 'navigate', url })
  shell.send({ cmd: 'surface' })
  // Surfaced sessions have no drive loop; when DOM capture is on, snapshot on
  // a timer instead (KEYBRIDGE_CAPTURE_DOM=1 keybridge open <url> records the
  // pages the human walks through).
  if (o.captureDir) {
    const capture = new DomCapture(o.captureDir, o.log)
    const timer = setInterval(() => { void capture.tick(shell) }, 1000)
    timer.unref()
    void shell.exited.then(() => clearInterval(timer))
  }
  return shell
}

/**
 * Delete the persistent website data store of one account profile (used by
 * `keybridge logout --web`). Best effort: false when the shell binary is
 * unavailable or the purge fails.
 */
export async function purgeWebStore (storeId: string, opts: WebkitPresenterOptions = {}): Promise<boolean> {
  const o = resolveWebkitOptions(opts)
  try {
    await ensureShellBinary(o)
    const { stdout } = await execFileP(o.shellPath, ['--purge-store', storeId])
    const last = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { ok?: boolean }
    return last.ok === true
  } catch {
    return false
  }
}

/**
 * The Tier A2 presenter. Engine contract: called with ({ authUrl, signal });
 * must get the human to the ceremony; the engine aborts `signal` once doneUrl
 * reports completion (or on timeout), at which point the shell is torn down.
 */
export function webkitPresenter (opts: WebkitPresenterOptions = {}): Presenter {
  const o = resolveWebkitOptions(opts)

  return async ({ authUrl, signal, purpose }) => {
    if (signal.aborted) return
    await ensureShellBinary(o)

    // The Touch ID approval line for this ceremony - names the package and
    // account so concurrent multi-project publishes can never be confused.
    const reason = ceremonyReason(purpose, o.ceremonyContext)

    // A ceremony the credential store can't answer (ENOCRED) never completes
    // while the shell is hidden: the inject script's fallback to the real
    // authenticator has nothing to talk to inside a WKWebView, and no human is
    // looking at the page. Fail the flow fast (the engine aborts its doneUrl
    // polling on `fatal`) instead of hanging until the poll timeout. Once the
    // window is surfaced a human is present and can use npm's own fallbacks
    // (e.g. "use a recovery code"), so ENOCRED is no longer fatal.
    const state = { surfaced: false, fatal: null as PublishError | null }
    const run: ResolvedOptions = {
      ...o,
      webauthn: async (op, options, origin) => {
        const resp = await o.webauthn(op, options, origin, reason)
        if (!resp.ok && resp.code === 'ENOCRED' && !state.surfaced) {
          const err = new PublishError(
            'npm asked for a security key that keybridge has not enrolled for this account - run `keybridge enroll` for it (`keybridge status` shows which accounts have keys)',
            { code: 'ENOCRED' })
          err.fatal = true
          state.fatal = err
          o.notify('keybridge has no security key for this npm account - run `keybridge enroll`')
        }
        return resp
      },
    }

    const shell = await WebShell.start(run)
    try {
      shell.send({ cmd: 'navigate', url: authUrl })

      // The engine owns completion: it aborts the signal once doneUrl flips.
      // Polling never stops: the auto-click is per PAGE, not per ceremony -
      // npm's flows can chain pages that each need their "Use security key"
      // pressed (a live session redirects /login -> /escalate/webauthn, and
      // only the escalate page's click fires navigator.credentials.get()).
      // One-click-per-page and one-prefill-per-page are enforced by window
      // flags INSIDE the page (they reset on navigation), so the presenter
      // needs no navigation bookkeeping at all.
      const capture = run.captureDir ? new DomCapture(run.captureDir, o.log) : null
      let announcedClick = false
      let announcedPrefill = false
      while (!signal.aborted) {
        if (state.fatal) throw state.fatal
        const raw = await shell.eval(STATUS_SCRIPT).catch(() => 'pending')
        // A '+remember' suffix means the page's "don't ask again for 5
        // minutes" checkbox was just ticked (see STATUS_SCRIPT).
        const [status, flag] = String(raw).split('+')
        if (flag === 'remember') {
          o.log('ticked npm\'s "remember for 5 minutes" option - publishes in the next 5 minutes should skip the ceremony')
        }
        await capture?.tick(shell)
        if (status === 'clicked' && !announcedClick) {
          announcedClick = true
          o.log('ceremony triggered - waiting for Touch ID approval')
        } else if (status === 'login-page') {
          if (o.surfaceOnLogin && !state.surfaced) {
            state.surfaced = true
            o.log('npm wants a password login - surfacing the ceremony window')
            shell.send({ cmd: 'surface' })
            o.notify('npm needs you to log in - a keybridge window has been opened')
          }
          if (o.prefillUsername) {
            const result = await shell.eval(prefillScript(o.prefillUsername)).catch(() => 'pending')
            if (result === 'prefilled' && !announcedPrefill) {
              announcedPrefill = true
              o.log(`login form prefilled for ${o.prefillUsername}`)
            }
          }
        }
        await delay(o.pollIntervalMs, null, { signal }).catch(() => {})
      }
      if (state.fatal) throw state.fatal
    } finally {
      shell.close()
    }
  }
}
