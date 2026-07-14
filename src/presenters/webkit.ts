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
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { Presenter } from '../engine.ts'
import { notifyHuman } from './browser.ts'
import { STATUS_SCRIPT, waitForAbort } from './shared.ts'
import { handleCreate, handleGet, type CreateOptions, type GetOptions } from '../webauthn.ts'
import { createSigner } from '../signer.ts'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const KB_DIR = join(homedir(), '.keybridge')
const NATIVE_DIR = resolve(join(HERE, '..', '..', 'native'))

export type WebAuthnResponse =
  | { ok: true, credential: unknown }
  | { ok: false, error: string, code?: string }
export type WebAuthnResponder = (op: string, options: unknown, origin: string) => Promise<WebAuthnResponse>

export interface WebkitPresenterOptions {
  /** Compiled shell binary. Default ~/.keybridge/keybridge-webshell (auto-built from shellSource when missing/stale). */
  shellPath?: string
  /** Swift source the binary is built from. */
  shellSource?: string
  /** navigator.credentials override injected at documentStart. */
  injectPath?: string
  /** Extra args for the shell (tests use ['--ephemeral']). */
  shellArgs?: string[]
  /** Answers create/get ceremonies. Default: v2 host webauthn + signer (Touch ID via Secure Enclave backend). */
  webauthn?: WebAuthnResponder
  /** If the auth page bounces to a password login, show a real window. Default true. */
  surfaceOnLogin?: boolean
  pollIntervalMs?: number
  launchTimeoutMs?: number
  /** Diagnostics sink (default: stderr). */
  log?: (message: string) => void
  /** Human-notification hook (default: macOS notification). */
  notify?: (message: string) => void
}

interface ResolvedOptions {
  shellPath: string
  shellSource: string
  injectPath: string
  shellArgs: string[]
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
    shellArgs: opts.shellArgs ?? [],
    webauthn: opts.webauthn ?? answerWebAuthn,
    surfaceOnLogin: opts.surfaceOnLogin ?? true,
    pollIntervalMs: opts.pollIntervalMs ?? 500,
    launchTimeoutMs: opts.launchTimeoutMs ?? 15_000,
    log: opts.log ?? ((m) => process.stderr.write(`[keybridge webkit] ${m}\n`)),
    notify: opts.notify ?? notifyHuman,
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
async function answerWebAuthn (op: string, options: unknown, origin: string): Promise<WebAuthnResponse> {
  try {
    const signer = createSigner()
    const opts = unwrap(options)
    const credential = op === 'create'
      ? await handleCreate(opts as CreateOptions, origin, signer)
      : await handleGet(opts as GetOptions, origin, signer)
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

  private constructor (child: ChildProcess, log: (m: string) => void) {
    this.#child = child
    this.#log = log
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
 * The Tier A2 presenter. Engine contract: called with ({ authUrl, signal });
 * must get the human to the ceremony; the engine aborts `signal` once doneUrl
 * reports completion (or on timeout), at which point the shell is torn down.
 */
export function webkitPresenter (opts: WebkitPresenterOptions = {}): Presenter {
  const o = resolveWebkitOptions(opts)

  return async ({ authUrl, signal }) => {
    if (signal.aborted) return
    await ensureShellBinary(o)
    const shell = await WebShell.start(o)
    try {
      shell.send({ cmd: 'navigate', url: authUrl })

      let surfaced = false
      while (!signal.aborted) {
        const status = await shell.eval(STATUS_SCRIPT).catch(() => 'pending')
        if (status === 'clicked') {
          o.log('ceremony triggered - waiting for Touch ID approval')
          break
        }
        if (status === 'login-page' && o.surfaceOnLogin && !surfaced) {
          surfaced = true
          o.log('npm wants a password login - surfacing the ceremony window')
          shell.send({ cmd: 'surface' })
          o.notify('npm needs you to log in - a keybridge window has been opened')
        }
        await delay(o.pollIntervalMs, null, { signal }).catch(() => {})
      }
      // The engine owns completion: it aborts the signal once doneUrl flips.
      await waitForAbort(signal)
    } finally {
      shell.close()
    }
  }
}
