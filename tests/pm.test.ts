import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectPackageManager, resolvePublishTarget } from '../src/pm.ts'
import { PublishError } from '../src/engine.ts'
import { MIN_PNPM_MAJOR, resetVersionChecks } from '../src/versions.ts'

// Keep kblog() out of the real ~/.keybridge/logs while tests run.
process.env.KEYBRIDGE_LOG_DIR = mkdtempSync(join(tmpdir(), 'keybridge-logs-'))

const scratch = (): string => mkdtempSync(join(tmpdir(), 'keybridge-pm-'))

function writePkg (dir: string, pkg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
}

/** A stand-in `pnpm` on PATH, so the pack contract can be tested without a
 * real pnpm install (which needs a resolved workspace to pack at all).
 * Answers `--version` first - keybridge gates the pack path on a pnpm version
 * floor (src/versions.ts) before it packs anything. */
function fakePnpm (body: string, version = '11.8.0'): { env: NodeJS.ProcessEnv } {
  const bin = scratch()
  const file = join(bin, 'pnpm')
  writeFileSync(file, [
    '#!/usr/bin/env node',
    `if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0) }`,
    body,
  ].join('\n') + '\n')
  chmodSync(file, 0o755)
  resetVersionChecks()
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } }
}

// Writes a tarball into --pack-destination and reports it the way
// `pnpm pack --json` does.
const PACKS_OK = `
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dest = process.argv[process.argv.indexOf('--pack-destination') + 1]
const filename = join(dest, 'demo-1.0.0.tgz')
writeFileSync(filename, 'tarball')
console.log(JSON.stringify({ name: 'demo', version: '1.0.0', filename, files: [] }))
`

test('detects pnpm from the packageManager field', () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', packageManager: 'pnpm@11.8.0' })
  assert.equal(detectPackageManager(dir), 'pnpm')
})

test('an explicit packageManager field beats a lockfile in the same directory', () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', packageManager: 'npm@11.12.1' })
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
  assert.equal(detectPackageManager(dir), 'npm')
})

test('detects pnpm from the workspace file of an ancestor', () => {
  const root = scratch()
  writePkg(root, { name: 'root', private: true })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  const pkg = join(root, 'packages', 'core')
  writePkg(pkg, { name: '@x/core', version: '1.0.0' })
  assert.equal(detectPackageManager(pkg), 'pnpm')
})

test('the nearest evidence wins over the workspace root', () => {
  // A package that declares npm inside a pnpm workspace is taken at its word:
  // walking up must stop at the first directory that answers.
  const root = scratch()
  writePkg(root, { name: 'root', private: true, packageManager: 'pnpm@11.8.0' })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  const pkg = join(root, 'packages', 'core')
  writePkg(pkg, { name: '@x/core', version: '1.0.0', packageManager: 'npm@11.12.1' })
  assert.equal(detectPackageManager(pkg), 'npm')
})

test('falls back to npm for lockfile-less and unrecognised projects', () => {
  const npmish = scratch()
  writePkg(npmish, { name: 'x' })
  writeFileSync(join(npmish, 'package-lock.json'), '{}')
  assert.equal(detectPackageManager(npmish), 'npm')

  const bare = scratch()
  writePkg(bare, { name: 'x' })
  assert.equal(detectPackageManager(bare), 'npm')

  // Yarn is not driven by keybridge - it resolves to today's behaviour.
  const yarnish = scratch()
  writePkg(yarnish, { name: 'x', packageManager: 'yarn@4.0.0' })
  assert.equal(detectPackageManager(yarnish), 'npm')
})

test('an npm project publishes its directory - nothing is packed', async () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0' })
  const target = await resolvePublishTarget(dir)
  assert.equal(target.manager, 'npm')
  assert.equal(target.spec, undefined)
  target.cleanup()
})

test('a pnpm project is packed and the tarball is handed on, then cleaned up', async () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0', packageManager: 'pnpm@11.8.0' })
  const target = await resolvePublishTarget(dir, fakePnpm(PACKS_OK))

  assert.equal(target.manager, 'pnpm')
  assert.ok(target.spec?.endsWith('.tgz'), `expected a tarball spec, got ${target.spec}`)
  assert.ok(existsSync(target.spec!), 'the packed tarball exists while the publish runs')

  target.cleanup()
  assert.equal(existsSync(target.spec!), false, 'the temp tarball is removed afterwards')
  target.cleanup() // idempotent - callers run this from a finally
})

test('a pnpm below the floor is rejected before anything is packed', async () => {
  // keybridge carries no compatibility shims: too old is an error, not a
  // best-effort attempt that fails somewhere less legible.
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0', packageManager: 'pnpm@9.0.0' })
  const fake = fakePnpm(PACKS_OK, `${MIN_PNPM_MAJOR - 1}.0.0`)
  await assert.rejects(
    resolvePublishTarget(dir, fake),
    (e: unknown) => e instanceof PublishError && e.code === 'EVERSION' &&
      new RegExp(`pnpm >= ${MIN_PNPM_MAJOR}`).test(e.message),
  )
})

test('a prepack script writing to stdout does not lose the tarball', async () => {
  // pnpm forwards lifecycle-script output; anything on stdout corrupts the
  // --json payload, so the destination listing is the source of truth.
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0', packageManager: 'pnpm@11.8.0' })
  const target = await resolvePublishTarget(dir, fakePnpm(`console.log('> build\\nnoise')\n${PACKS_OK}`))
  assert.ok(target.spec?.endsWith('demo-1.0.0.tgz'), `expected the packed tarball, got ${target.spec}`)
  target.cleanup()
})

test('a pnpm pack failure surfaces pnpm\'s own code and message', async () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0', packageManager: 'pnpm@11.8.0' })
  const fake = fakePnpm(`
console.log(JSON.stringify({ error: {
  code: 'ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL',
  message: 'Cannot resolve workspace protocol of dependency "@x/proto" because this dependency is not installed. Try running "pnpm install".',
} }))
process.exit(1)
`)
  await assert.rejects(
    resolvePublishTarget(dir, fake),
    (e: unknown) => e instanceof PublishError &&
      e.code === 'ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL' &&
      /pnpm install/.test(e.message),
  )
})

test('a pnpm project with no pnpm on PATH fails instead of publishing workspace: deps', async () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0', packageManager: 'pnpm@11.8.0' })
  // A missing pnpm must explain WHY pnpm is required, not just report that
  // the version probe could not run - regardless of whether an earlier check
  // in this process already memoized a pnpm.
  resetVersionChecks()
  await assert.rejects(
    resolvePublishTarget(dir, { env: { ...process.env, PATH: scratch() } }),
    (e: unknown) => e instanceof PublishError && e.code === 'EPACKMGR',
  )
})

test('the packageManager choice can be forced past detection', async () => {
  const dir = scratch()
  writePkg(dir, { name: 'x', version: '1.0.0', packageManager: 'pnpm@11.8.0' })
  const target = await resolvePublishTarget(dir, { packageManager: 'npm' })
  assert.equal(target.manager, 'npm')
  assert.equal(target.spec, undefined)
})
