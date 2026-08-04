// Package-manager strategy: which CLI owns this project, and what exactly
// `npm publish` should be pointed at.
//
// Why this exists: pnpm workspaces express intra-repo dependencies as
// `"@scope/dep": "workspace:*"` (and shared ranges as `"dep": "catalog:"`).
// `pnpm publish`/`pnpm pack` rewrite those to concrete versions while packing;
// `npm publish` does NOT - it ships the protocol strings verbatim and breaks
// every consumer of the published package.
//
// Driving `pnpm publish` instead is not an option (measured 2026-08-04 against
// pnpm 11.8.0 with tests/mock-registry.ts):
//   - spawned non-interactively - which is the only way keybridge ever runs it
//     - pnpm aborts the moment the registry asks for a one-time password:
//     `{"error":{"code":"ERR_PNPM_OTP_NON_INTERACTIVE"}}`, and the authUrl /
//     doneUrl from the 401 body are dropped on that path;
//   - `--otp=X`, `--otp X` and `npm_config_otp=X` all fail to reach the
//     request (the PUT carries no npm-otp header and `npm-auth-type: web`).
//     pnpm's `publishWithOtpHandling` spreads `{ ...publishOptions, otp }`
//     with `otp === undefined` on the first attempt, overwriting whatever the
//     CLI passed, and the non-interactive guard throws before the retry that
//     would have supplied one.
// So there is no OTP to hand pnpm even after a successful ceremony. keybridge
// therefore keeps npm as the publisher - it is the half the whole EOTP /
// web-auth flow depends on - and uses pnpm only to PACK. `pnpm pack` resolves
// workspace:/catalog: deps, runs `prepack`, and applies pnpm's manifest
// obfuscation exactly as `pnpm publish` would; the resulting tarball is then
// handed to `npm publish <tarball>`, which takes `--otp` fine.
//
// Yarn is deliberately not detected: keybridge has never driven it, and
// mapping it onto npm here is what already happens by default.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PublishError, runNpm } from './engine.ts'
import { kblog } from './log.ts'
import { assertPnpmVersion } from './versions.ts'

export type PackageManager = 'npm' | 'pnpm'

/** What the caller may ask for: a concrete manager, or detection. */
export type PackageManagerChoice = PackageManager | 'auto'

const PNPM_MARKERS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'pnpm-lock.yaml']
const NPM_MARKERS = ['package-lock.json', 'npm-shrinkwrap.json']

/** The `packageManager` field of `dir`'s manifest, if it declares one. Any
 * declaration ends the search - a project that names its package manager is
 * not overruled by a lockfile further up. */
function declaredPackageManager (dir: string): PackageManager | null {
  let pkg: { packageManager?: unknown }
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { packageManager?: unknown }
  } catch { return null }
  if (typeof pkg.packageManager !== 'string') return null
  return pkg.packageManager.split('@')[0] === 'pnpm' ? 'pnpm' : 'npm'
}

/**
 * Which package manager governs the package in `cwd`. Nearest evidence wins,
 * walking up to the filesystem root: a `packageManager` field first, then
 * pnpm's workspace/lock files, then npm's lockfiles. Defaults to npm, which
 * is also today's behaviour for everything unrecognised.
 */
export function detectPackageManager (cwd: string): PackageManager {
  let dir = resolve(cwd)
  while (true) {
    const declared = declaredPackageManager(dir)
    if (declared) return declared
    if (PNPM_MARKERS.some((m) => existsSync(join(dir, m)))) return 'pnpm'
    if (NPM_MARKERS.some((m) => existsSync(join(dir, m)))) return 'npm'
    const parent = dirname(dir)
    if (parent === dir) return 'npm'
    dir = parent
  }
}

export interface PublishTarget {
  manager: PackageManager
  /** Positional for `npm publish <spec>`. A pnpm-packed tarball for pnpm
   * projects; undefined means "publish the directory", as before. */
  spec?: string
  /** Removes the temp directory holding the tarball. Always safe to call,
   * including more than once. */
  cleanup: () => void
}

const noop = (): void => {}

const PNPM_REQUIRED =
  'keybridge packs pnpm projects with pnpm so workspace:/catalog: dependencies become real ' +
  'versions before publishing - npm would ship them verbatim and break consumers. ' +
  'Install pnpm, or force the npm strategy if this package has no such dependencies.'

export interface ResolvePublishTargetOptions {
  /** Skip detection and use this manager. */
  packageManager?: PackageManagerChoice
  /** Environment for the pack subprocess (mediated publishes pass theirs). */
  env?: NodeJS.ProcessEnv
}

/**
 * Decide what `npm publish` should be handed for the package in `cwd`, packing
 * with pnpm first when this is a pnpm project. The caller owns the returned
 * `cleanup` - call it in a `finally`, after the publish (and any auto-login
 * retry inside it) is done with the tarball.
 */
export async function resolvePublishTarget (
  cwd: string, { packageManager = 'auto', env }: ResolvePublishTargetOptions = {},
): Promise<PublishTarget> {
  const manager = packageManager === 'auto' ? detectPackageManager(cwd) : packageManager
  if (manager !== 'pnpm') return { manager, cleanup: noop }

  // Fail on a missing or ancient pnpm here rather than on some downstream
  // difference in its pack contract (see src/versions.ts for the floor
  // policy). A too-old pnpm keeps the version error; an absent one gets the
  // explanation of why pnpm is required at all.
  await assertPnpmVersion(env ? { env } : {}).catch((e: unknown) => {
    const err = e as PublishError
    if (err.code !== 'ENOTOOL') throw err
    throw new PublishError(`this is a pnpm project but \`pnpm\` could not be run. ${PNPM_REQUIRED}`, { code: 'EPACKMGR' })
  })

  const dir = mkdtempSync(join(tmpdir(), 'keybridge-pack-'))
  const discard = () => rmSync(dir, { recursive: true, force: true })
  let res
  try {
    res = await runNpm(['pack', '--json', '--pack-destination', dir], { cwd, npmBin: 'pnpm', env })
  } catch (e) {
    discard()
    throw new PublishError(
      `this is a pnpm project but \`pnpm\` could not be run (${(e as Error).message}). ${PNPM_REQUIRED}`,
      { code: 'EPACKMGR' })
  }
  if (res.code !== 0) {
    discard()
    // pnpm --json reports failures as {"error":{"code","message"}} on stdout.
    const err = (res.json as { error?: { code?: string, message?: string } } | null)?.error
    kblog('pack-failed', { manager, cwd, code: err?.code ?? null, error: err?.message ?? null })
    throw new PublishError(err?.message ?? `pnpm pack failed (exit ${res.code})`, {
      code: err?.code ?? 'EPACK', stdout: res.stdout, stderr: res.stderr, json: res.json,
    })
  }

  // The destination is ours and freshly created, so the single tarball in it
  // is the answer. `--json` names it too, but a `prepack` script that writes
  // to stdout can corrupt that payload - the directory listing cannot.
  const tarballs = readdirSync(dir).filter((f) => f.endsWith('.tgz'))
  const named = (res.json as { filename?: string } | null)?.filename
  const spec = tarballs.length === 1
    ? join(dir, tarballs[0]!)
    : (named && existsSync(named) ? named : null)
  if (!spec) {
    discard()
    throw new PublishError(
      `pnpm pack reported success but produced no tarball in ${dir}`,
      { code: 'EPACK', stdout: res.stdout, stderr: res.stderr, json: res.json })
  }
  kblog('packed', { manager, cwd, spec })
  return { manager, spec, cleanup: discard }
}
