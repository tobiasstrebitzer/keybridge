import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PublishError } from '../src/engine.ts'
import { assertNpmVersion, majorOf, MIN_NPM_MAJOR, resetVersionChecks } from '../src/versions.ts'

process.env.KEYBRIDGE_LOG_DIR = mkdtempSync(join(tmpdir(), 'keybridge-logs-'))

/** A stand-in `npm` that reports whatever version we tell it to. */
function fakeNpm (version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-npmbin-'))
  const file = join(dir, 'npm-stub')
  writeFileSync(file, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`)
  chmodSync(file, 0o755)
  return file
}

test('majorOf reads the leading major, or gives up', () => {
  assert.equal(majorOf('12.0.2'), 12)
  assert.equal(majorOf('v11.12.1'), 11)
  assert.equal(majorOf('  12.0.0-pre.1'), 12)
  assert.equal(majorOf('not a version'), null)
  assert.equal(majorOf(''), null)
})

test('an npm below the floor is a hard, actionable error', async () => {
  resetVersionChecks()
  await assert.rejects(
    assertNpmVersion({ npmBin: fakeNpm(`${MIN_NPM_MAJOR - 1}.12.1`) }),
    (e: unknown) => e instanceof PublishError && e.code === 'EVERSION' &&
      new RegExp(`requires npm >= ${MIN_NPM_MAJOR}`).test(e.message) &&
      /npm install -g npm@latest/.test(e.message),
  )
})

test('an npm at or above the floor passes and reports its version', async () => {
  resetVersionChecks()
  assert.equal(await assertNpmVersion({ npmBin: fakeNpm(`${MIN_NPM_MAJOR}.0.2`) }), `${MIN_NPM_MAJOR}.0.2`)
})

test('an unreadable version is an error too, not a silent pass', async () => {
  resetVersionChecks()
  await assert.rejects(
    assertNpmVersion({ npmBin: fakeNpm('something went wrong') }),
    (e: unknown) => e instanceof PublishError && e.code === 'EVERSION',
  )
})

test('a failed check is not cached - upgrading takes effect without a restart', async () => {
  resetVersionChecks()
  const old = fakeNpm(`${MIN_NPM_MAJOR - 1}.0.0`)
  await assert.rejects(assertNpmVersion({ npmBin: old }), (e: unknown) => (e as PublishError).code === 'EVERSION')
  // Same process, a newer npm on the path now: the floor must be re-evaluated.
  assert.equal(await assertNpmVersion({ npmBin: fakeNpm(`${MIN_NPM_MAJOR}.1.0`) }), `${MIN_NPM_MAJOR}.1.0`)
})
