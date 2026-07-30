// Persistent ceremony diagnostics: ~/.keybridge/logs/keybridge-YYYY-MM-DD.jsonl.
//
// Why a file and not stderr: MCP hosts (Claude Code included) only surface a
// server's stderr around connection startup - everything written during a
// tool call is dropped. A ceremony that hangs inside the MCP server is
// therefore invisible unless it also logs to disk. Every stage (presenter,
// shell, webauthn responder, Secure Enclave helper, MCP actions) appends
// structured lines here in every context, CLI and MCP alike.
//
// Never log secrets: no tokens, no doneUrl response bodies. authUrls are
// single-use and expire in minutes; they are the ceremony's identity and are
// worth having.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEEP_DAYS = 14
const FILE_RE = /^keybridge-(\d{4}-\d{2}-\d{2})\.jsonl$/

/** Override with KEYBRIDGE_LOG_DIR (tests point this at a scratch dir). */
export function logDir (): string {
  return process.env.KEYBRIDGE_LOG_DIR ?? join(homedir(), '.keybridge', 'logs')
}

/** Today's log file - where kblog appends right now. */
export function currentLogFile (): string {
  return join(logDir(), `keybridge-${new Date().toISOString().slice(0, 10)}.jsonl`)
}

/** Newest existing log file (for `keybridge logs`), or null when none. */
export function latestLogFile (): string | null {
  try {
    const names = readdirSync(logDir()).filter((n) => FILE_RE.test(n)).toSorted()
    const last = names.at(-1)
    return last ? join(logDir(), last) : null
  } catch {
    return null
  }
}

const prunedDirs = new Set<string>()

function prune (dir: string): void {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const name of readdirSync(dir)) {
    const day = FILE_RE.exec(name)?.[1]
    if (day && day < cutoff) rmSync(join(dir, name), { force: true })
  }
}

/**
 * Append one structured diagnostic line. Fire-and-forget: diagnostics must
 * never break (or slow) a ceremony, so every failure is swallowed. The `ts`
 * and `pid` fields make interleaved lines from concurrent keybridge server
 * processes attributable.
 */
export function kblog (event: string, detail: Record<string, unknown> = {}): void {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!prunedDirs.has(dir)) {
      prunedDirs.add(dir)
      try { prune(dir) } catch {}
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...detail })
    appendFileSync(currentLogFile(), line + '\n', { mode: 0o600 })
  } catch {}
}
