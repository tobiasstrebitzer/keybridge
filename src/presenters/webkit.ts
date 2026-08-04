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
import { kblog } from '../log.ts'
import { CAPTURE_SCRIPT, prefillScript, REARM_SCRIPT, STATUS_SCRIPT } from './shared.ts'
import { handleCreate, handleGet, type CreateOptions, type GetOptions } from '../webauthn.ts'
import { createSigner, type Signer } from '../signer.ts'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const KB_DIR = join(homedir(), '.keybridge')
const NATIVE_DIR = resolve(join(HERE, '..', '..', 'native'))

// A live "Use security key" click yields a WebAuthn request within moments;
// a click that produced none after this long was lost (npm hydration gap)
// and gets re-armed - at most this many times per page.
const RECLICK_AFTER_MS = 4000
const MAX_RECLICKS = 3

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
  /** Render the Touch ID prompt inside keybridge's own HUD panel instead of
   * the system sheet (PRD §6.7). Default on for macOS secure-enclave signing;
   * KEYBRIDGE_HUD=0 restores the system sheet. Ignored when a custom
   * `webauthn` responder is supplied - that responder owns its own signing. */
  hud?: boolean
  /** If the auth page bounces to a password login, show a real window. Default true. */
  surfaceOnLogin?: boolean
  pollIntervalMs?: number
  /** How long a security-key click may stay unanswered by a WebAuthn request
   * before it is declared lost and re-armed. Default 4s. */
  reclickAfterMs?: number
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
  /** True when the caller supplied `webauthn` - then keybridge does no signing
   * of its own and the HUD's embedded prompt has nothing to drive. */
  customResponder: boolean
  hud: boolean
  /** Called when the human cancels from the HUD's ✕ (internal; the presenter
   * turns it into a fatal error so the engine stops polling immediately). */
  onDismiss?: (reason: string) => void
  surfaceOnLogin: boolean
  pollIntervalMs: number
  reclickAfterMs: number
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
    customResponder: opts.webauthn !== undefined,
    hud: opts.hud ?? process.env.KEYBRIDGE_HUD !== '0',
    surfaceOnLogin: opts.surfaceOnLogin ?? true,
    pollIntervalMs: opts.pollIntervalMs ?? 500,
    reclickAfterMs: opts.reclickAfterMs ?? RECLICK_AFTER_MS,
    launchTimeoutMs: opts.launchTimeoutMs ?? 15_000,
    // stderr for CLI users; the persistent log because MCP hosts drop stderr.
    log: opts.log ?? ((m) => {
      process.stderr.write(`[keybridge webkit] ${m}\n`)
      kblog('webkit', { msg: m })
    }),
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

/**
 * A signer whose Secure Enclave signature happens inside the live ceremony
 * shell, so the Touch ID prompt renders in keybridge's own HUD panel
 * (LAAuthenticationView) instead of the system sheet - and the same LAContext
 * unlocks the key, so it costs exactly one touch.
 *
 * Key generation and credential selection stay with the base signer: neither
 * needs user presence, and `keybridge enroll` must keep working without a HUD.
 * Anything the embedded prompt cannot do (no biometry enrolled, Touch ID
 * unavailable) rejects with EEMBEDUNAVAIL and falls back to the standalone
 * helper, so the HUD degrades rather than blocks (PRD §6.6).
 */
export function shellSigner (
  base: Signer,
  getShell: () => WebShell | null,
  log: (m: string) => void = () => {},
): Signer {
  return {
    backend: base.backend,
    register: (rpId, userHandle) => base.register(rpId, userHandle),
    selectForAssertion: (rpId, allowIds) => base.selectForAssertion(rpId, allowIds),
    async sign (record, message, reason) {
      const shell = getShell()
      if (!shell || record.backend !== 'secure-enclave') {
        return base.sign(record, message, reason)
      }
      const started = Date.now()
      try {
        // The HUD renders this as its own sentence, so it leads with a
        // capital; the system sheet's “"KeyBridge" is trying to <reason>”
        // phrasing only applies on the fallback path below.
        const label = reason.charAt(0).toUpperCase() + reason.slice(1)
        const signature = await shell.sign(record.keyTag, message, label)
        kblog('se-shell-sign', { ok: true, ms: Date.now() - started })
        return signature
      } catch (e) {
        const err = e as Error & { code?: string }
        kblog('se-shell-sign', {
          ok: false, ms: Date.now() - started, error: err.message, ...(err.code ? { code: err.code } : {}),
        })
        // Only an unusable embedded prompt is worth retrying elsewhere. A
        // userCancel is the human saying no - re-asking through the system
        // sheet would be a second prompt they did not ask for.
        if (err.code !== 'EEMBEDUNAVAIL' && err.code !== 'ENOKEY') throw err
        log(`embedded Touch ID unavailable (${err.code}) - falling back to the system sheet`)
        return base.sign(record, message, reason)
      }
    },
  }
}

// Default ceremony responder. Note: the standalone secure-enclave signer shells
// out synchronously, so the event loop stalls while the human decides on Touch
// ID; that's fine - the engine's doneUrl polling just resumes afterwards. The
// shell signer (above) is async and does not stall.
async function answerWebAuthn (
  op: string, options: unknown, origin: string, reason?: string, signerOverride?: Signer,
): Promise<WebAuthnResponse> {
  const started = Date.now()
  try {
    const signer = signerOverride ?? createSigner()
    const opts = unwrap(options)
    const credential = op === 'create'
      ? await handleCreate(opts as CreateOptions, origin, signer)
      : await handleGet(opts as GetOptions, origin, signer, reason)
    kblog('webauthn', { op, origin, ok: true, ms: Date.now() - started })
    return { ok: true, credential }
  } catch (e) {
    const err = e as Error & { code?: string }
    kblog('webauthn', {
      op, origin, ok: false, ms: Date.now() - started,
      error: err.message || String(e), ...(err.code ? { code: err.code } : {}),
    })
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
  code?: string
  signature?: string
  reason?: string
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
  #signSeq = 0
  #pendingSigns = new Map<number, { resolve: (v: Buffer) => void, reject: (e: Error) => void }>()
  #log: (m: string) => void
  /** Main-frame loads seen so far - the page-epoch counter. In-page one-shot
   * flags die with each epoch (but survive SPA route changes, which don't
   * tick this). */
  navCount = 0
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
        // A pending sign is a human staring at a Touch ID prompt that just
        // died with the shell - reject it rather than hang the ceremony.
        for (const p of shell.#pendingSigns.values()) p.reject(new Error('webkit shell exited'))
        shell.#pendingSigns.clear()
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
      case 'sign-result': {
        const pending = this.#pendingSigns.get(msg.id ?? -1)
        if (!pending) return
        this.#pendingSigns.delete(msg.id ?? -1)
        if (typeof msg.signature === 'string') {
          pending.resolve(Buffer.from(msg.signature, 'base64'))
        } else {
          const err = new Error(msg.error ?? 'shell signing failed') as Error & { code?: string }
          if (msg.code) err.code = msg.code
          pending.reject(err)
        }
        break
      }
      case 'hud':
        this.#log(`ceremony HUD shown (visible: ${(msg as { visible?: boolean }).visible})`)
        break
      case 'hud-focus':
        // Losing key status mid-prompt pauses Touch ID; the shell claws it
        // back, but record both edges so a stalled ceremony is explicable.
        this.#log((msg as { key?: boolean }).key
          ? 'ceremony sheet has focus'
          : 'ceremony sheet lost focus - Touch ID is paused until it returns')
        break
      case 'hud-dismissed':
        this.#log(`ceremony cancelled from the sheet (${msg.reason ?? 'user'})`)
        o.onDismiss?.(msg.reason ?? 'user')
        break
      case 'nav':
        this.navCount++
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

  /** Show the ceremony HUD (no keyboard focus taken until a prompt runs). */
  hudShow (reason: string, status: string): void {
    this.send({ cmd: 'hud-show', reason, status })
  }

  hudStatus (status: string): void {
    this.send({ cmd: 'hud-status', status })
  }

  hudClose (): void {
    this.send({ cmd: 'hud-close' })
  }

  /**
   * Secure Enclave signature performed INSIDE the shell, so the LAContext that
   * drove the embedded Touch ID prompt is the one that unlocks the key - one
   * touch, no system sheet. Rejects with a coded Error (LAError name, or
   * EEMBEDUNAVAIL when the embedded prompt cannot run at all) so the caller
   * can fall back to the standalone signer.
   */
  sign (tag: string, message: Buffer, reason: string): Promise<Buffer> {
    const id = ++this.#signSeq
    return new Promise((resolvePromise, reject) => {
      this.#pendingSigns.set(id, { resolve: resolvePromise, reject })
      this.send({ cmd: 'sign', id, tag, message: Buffer.from(message).toString('base64'), reason })
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
    kblog('ceremony-start', {
      purpose, authUrl, shellArgs: o.shellArgs, ...o.ceremonyContext,
    })

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
    // What the click supervisor (below) needs to know about ceremonies: which
    // page epoch last produced a WebAuthn request, and whether one is being
    // answered right now (the human may be looking at the Touch ID sheet).
    const ceremony = { epoch: -1, pending: 0 }
    let shell!: WebShell
    // With the HUD on, signing moves INTO the shell so the Touch ID prompt
    // renders in our own panel (PRD §6.7). A caller-supplied responder does
    // its own signing, so it opts out automatically.
    const hudOn = o.hud && !o.customResponder
    const signer = hudOn ? shellSigner(createSigner(), () => shell, o.log) : undefined
    const run: ResolvedOptions = {
      ...o,
      // The ✕ is meant to be equivalent to ctrl-C: without this the ceremony
      // would just fail silently on the page and the engine would keep polling
      // doneUrl until the five-minute timeout.
      onDismiss: (why) => {
        const err = new PublishError(
          `the keybridge ceremony was cancelled from the sheet (${why})`, { code: 'ECANCEL' })
        err.fatal = true
        state.fatal = err
        kblog('ceremony-cancelled', { reason: why })
      },
      webauthn: async (op, options, origin) => {
        ceremony.epoch = shell?.navCount ?? 0
        ceremony.pending++
        try {
          const resp = o.customResponder
            ? await o.webauthn(op, options, origin, reason)
            : await answerWebAuthn(op, options, origin, reason, signer)
          if (!resp.ok && resp.code === 'ENOCRED' && !state.surfaced) {
            const err = new PublishError(
              'npm asked for a security key that keybridge has not enrolled for this account - run `keybridge enroll` for it (`keybridge status` shows which accounts have keys)',
              { code: 'ENOCRED' })
            err.fatal = true
            state.fatal = err
            o.notify('keybridge has no security key for this npm account - run `keybridge enroll`')
          }
          return resp
        } finally {
          ceremony.pending--
        }
      },
    }

    // The windowless shell is the ONLY way this ceremony can complete:
    // nothing is on screen and no human is watching a browser, so a shell
    // that cannot start (or dies mid-ceremony) means waiting out the poll
    // timeout would just be a silent hang. Both cases are FATAL - the engine
    // aborts doneUrl polling immediately and the caller gets a diagnosable
    // error instead of five quiet minutes.
    try {
      await ensureShellBinary(o)
      shell = await WebShell.start(run)
    } catch (e) {
      const err = new PublishError(
        `the webkit ceremony shell could not start: ${(e as Error).message} - nothing was shown; \`keybridge logs\` has the ceremony trace`,
        { code: 'ESHELL' })
      err.fatal = true
      kblog('ceremony-failed', { code: 'ESHELL', error: (e as Error).message })
      throw err
    }
    const shellExit = { code: undefined as number | null | undefined }
    void shell.exited.then((code) => { shellExit.code = code })
    try {
      shell.send({ cmd: 'navigate', url: authUrl })
      // The HUD is the ceremony's visible surface from here on. It only takes
      // keyboard focus when a prompt actually runs (see focusForPrompt in
      // WebShell.swift), so showing it early costs the user nothing.
      if (hudOn) {
        shell.hudShow(
          reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Authorize a keybridge ceremony',
          'talking to npm…')
      }

      // The engine owns completion: it aborts the signal once doneUrl flips.
      // Polling never stops: the auto-click is per PAGE, not per ceremony -
      // npm's flows can chain pages that each need their "Use security key"
      // pressed (a live session redirects /login -> /escalate/webauthn, and
      // only the escalate page's click fires navigator.credentials.get()).
      // One-click-per-page and one-prefill-per-page are enforced by window
      // flags INSIDE the page (they reset on navigation), so the presenter
      // needs no navigation bookkeeping at all.
      const capture = run.captureDir ? new DomCapture(run.captureDir, o.log) : null
      // Click supervision. 'clicked' only means the page-side flag is set - a
      // click that landed before npm's React handler attached did NOTHING,
      // and the one-shot flag then blocks every retry (the silent "no Touch
      // ID, no error" hang of 2026-08-04). Only the presenter can tell a dead
      // click from a live one: a live one is followed by a WebAuthn request
      // within moments. A click cycle that stays silent past RECLICK_AFTER_MS
      // gets re-armed - but never while a ceremony is being answered (a human
      // may be looking at the Touch ID sheet) and never on a page that
      // already produced one (no prompt spam after a deliberate cancel).
      let clickEpoch = -1
      let clickedAt = 0
      let rearms = 0
      let announcedPrefill = false
      while (!signal.aborted) {
        if (state.fatal) throw state.fatal
        if (shellExit.code !== undefined) {
          // A dead shell would otherwise be invisible: every eval rejects and
          // reads as 'pending' forever (the exact shape of a silent hang).
          const err = new PublishError(
            `the webkit ceremony shell exited unexpectedly (code ${shellExit.code ?? 'unknown'}) - the ceremony can never complete; \`keybridge logs\` has the ceremony trace`,
            { code: 'ESHELL' })
          err.fatal = true
          throw err
        }
        const raw = await shell.eval(STATUS_SCRIPT).catch(() => 'pending')
        // A '+remember' suffix means the page's "don't ask again for 5
        // minutes" checkbox was just ticked (see STATUS_SCRIPT).
        const [status, flag] = String(raw).split('+')
        if (flag === 'remember') {
          o.log('ticked npm\'s "remember for 5 minutes" option - publishes in the next 5 minutes should skip the ceremony')
        }
        await capture?.tick(shell)
        if (status === 'clicked') {
          if (clickEpoch !== shell.navCount) {
            clickEpoch = shell.navCount
            clickedAt = Date.now()
            rearms = 0
            o.log('ceremony triggered - waiting for Touch ID approval')
            if (hudOn) shell.hudStatus('npm asked for your security key…')
          } else if (ceremony.pending === 0 && ceremony.epoch < clickEpoch
            && rearms < MAX_RECLICKS && Date.now() - clickedAt > o.reclickAfterMs) {
            rearms++
            clickedAt = Date.now()
            o.log(`the security-key click started no ceremony - re-clicking (${rearms}/${MAX_RECLICKS})`)
            await shell.eval(REARM_SCRIPT).catch(() => {})
          }
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
    } catch (e) {
      kblog('ceremony-failed', {
        code: (e as PublishError).code ?? 'EPRESENT', error: (e as Error).message,
      })
      throw e
    } finally {
      kblog('ceremony-end', { aborted: signal.aborted })
      if (hudOn) shell.hudClose()
      shell.close()
    }
  }
}
