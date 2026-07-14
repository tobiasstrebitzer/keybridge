#!/usr/bin/env node
// Stand-in for the compiled keybridge-webshell binary: speaks the same
// JSON-lines stdio protocol, scripted through env vars so tests can drive the
// webkit presenter without WebKit.
//
//   FAKE_EVALS    comma-separated values returned by successive eval commands
//                 (falls back to "not-found" when exhausted)
//   FAKE_WEBAUTHN JSON {op, options, origin} - emitted as a webauthn event
//                 (id 99) right after the first navigate command
//   FAKE_LOG      file that every received command line is appended to
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const evals = (process.env.FAKE_EVALS ?? '').split(',').filter(Boolean)
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let navigated = false
createInterface({ input: process.stdin }).on('line', (line) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, line + '\n')
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.cmd === 'navigate' && !navigated) {
    navigated = true
    out({ event: 'nav', url: msg.url })
    if (process.env.FAKE_WEBAUTHN) out({ event: 'webauthn', id: 99, ...JSON.parse(process.env.FAKE_WEBAUTHN) })
  }
  if (msg.cmd === 'eval') out({ event: 'eval-result', id: msg.id, value: evals.shift() ?? 'not-found' })
  if (msg.cmd === 'close') process.exit(0)
})

out({ event: 'ready' })
