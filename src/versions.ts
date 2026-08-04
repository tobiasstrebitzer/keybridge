// Tool version floors. keybridge does not carry compatibility shims for old
// package managers - when a version is below the floor it fails loudly and
// says what to upgrade, rather than half-working in ways that are hard to
// diagnose from the outside.
//
// npm >= 12 is a hard requirement for keybridge as a whole, not per command:
//  - `npm publish --json` changed shape in 12 (the result moved under the
//    package name); on npm 11 keybridge would misreport publishes.
//  - npm 11.9.0-11.14.x redact the publish authUrl/doneUrl, so the whole
//    ceremony depends on a recovery path that only exists because of them.
//  - `npm trust` (trusted publishers) does not exist before 12 at all, and
//    npm 11 could not send the `permissions` field the registry requires.
//
// pnpm >= 11 is the floor for the pack path - the version keybridge's pnpm
// behaviour (pack contract, manifest obfuscation, OTP non-interactivity) has
// actually been measured against.
import { PublishError, runNpm } from './engine.ts'

export const MIN_NPM_MAJOR = 12
export const MIN_PNPM_MAJOR = 11

/** Leading major from a semver-ish version string. Null when unparseable. */
export function majorOf (version: string): number | null {
  const major = Number(/^\s*v?(\d+)\./.exec(version)?.[1])
  return Number.isFinite(major) ? major : null
}

// Only SUCCESS is cached: a failed check must re-run, so upgrading the tool
// takes effect without restarting a long-lived MCP server.
const confirmed = new Map<string, string>()

async function assertVersion (
  // `bin` is what we run (a caller may point at another binary); `tool` is
  // what the human is told to upgrade.
  { bin, tool, minMajor, upgrade, env }:
  { bin: string, tool: string, minMajor: number, upgrade: string, env?: NodeJS.ProcessEnv },
): Promise<string> {
  const cached = confirmed.get(bin)
  if (cached) return cached

  let res
  try {
    res = await runNpm(['--version'], env ? { npmBin: bin, env } : { npmBin: bin })
  } catch (e) {
    // Distinct from EVERSION: the tool is not installed at all, which callers
    // usually want to explain in their own terms.
    throw new PublishError(
      `keybridge needs ${tool} >= ${minMajor} but could not run \`${bin} --version\` (${(e as Error).message})`,
      { code: 'ENOTOOL' })
  }
  const version = res.stdout.trim()
  const major = majorOf(version)
  if (res.code !== 0 || major === null) {
    throw new PublishError(
      `keybridge needs ${tool} >= ${minMajor} but \`${bin} --version\` reported ${version || 'nothing'}`,
      { code: 'EVERSION', stdout: res.stdout, stderr: res.stderr })
  }
  if (major < minMajor) {
    throw new PublishError(
      `keybridge requires ${tool} >= ${minMajor} (found ${version}) - upgrade with \`${upgrade}\``,
      { code: 'EVERSION' })
  }
  confirmed.set(bin, version)
  return version
}

/** Gate every keybridge operation that touches npm. Returns the version. */
export function assertNpmVersion ({ npmBin = 'npm', env }: { npmBin?: string, env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return assertVersion({
    bin: npmBin, tool: 'npm', minMajor: MIN_NPM_MAJOR, upgrade: 'npm install -g npm@latest', ...(env ? { env } : {}),
  })
}

/** Gate the pnpm pack path (src/pm.ts). Returns the version. */
export function assertPnpmVersion ({ env }: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return assertVersion({
    bin: 'pnpm', tool: 'pnpm', minMajor: MIN_PNPM_MAJOR, upgrade: 'npm install -g pnpm@latest', ...(env ? { env } : {}),
  })
}

/** Test seam: forget the memoized successful checks. */
export function resetVersionChecks (): void {
  confirmed.clear()
}
