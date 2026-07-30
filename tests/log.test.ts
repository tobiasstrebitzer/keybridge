import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { currentLogFile, kblog, latestLogFile, logDir } from '../src/log.ts'

function scratchLogDir (t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'keybridge-log-'))
  const prev = process.env.KEYBRIDGE_LOG_DIR
  process.env.KEYBRIDGE_LOG_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.KEYBRIDGE_LOG_DIR
    else process.env.KEYBRIDGE_LOG_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('kblog appends structured JSONL to the day file', (t) => {
  const dir = scratchLogDir(t)
  assert.equal(logDir(), dir, 'KEYBRIDGE_LOG_DIR overrides the log directory')

  kblog('ceremony-start', { purpose: 'publish', pkg: 'x@1.0.0' })
  kblog('ceremony-end', { aborted: true })

  const lines = readFileSync(currentLogFile(), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.equal(lines.length, 2)
  assert.equal(lines[0]!.event, 'ceremony-start')
  assert.equal(lines[0]!.pkg, 'x@1.0.0')
  assert.equal(lines[0]!.pid, process.pid)
  assert.ok(typeof lines[0]!.ts === 'string')
  assert.equal(lines[1]!.event, 'ceremony-end')
})

test('old day files are pruned; foreign files and recent days survive', (t) => {
  const dir = scratchLogDir(t)
  mkdirSync(dir, { recursive: true })
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  writeFileSync(join(dir, `keybridge-${old}.jsonl`), '{}\n')
  writeFileSync(join(dir, 'unrelated.txt'), 'keep me\n')

  kblog('tick')

  const names = readdirSync(dir).toSorted()
  assert.ok(!names.includes(`keybridge-${old}.jsonl`), '30-day-old log was pruned')
  assert.ok(names.includes('unrelated.txt'), 'non-log files are untouched')
  assert.equal(latestLogFile(), currentLogFile(), 'latest resolves to today')
})

test('latestLogFile is null when nothing was ever logged', (t) => {
  scratchLogDir(t)
  // The scratch dir exists but is empty - and a missing dir must not throw.
  assert.equal(latestLogFile(), null)
  process.env.KEYBRIDGE_LOG_DIR = join(tmpdir(), 'keybridge-log-never-created')
  assert.equal(latestLogFile(), null)
})
