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
//   FAKE_ARGV_LOG file the shell's argv is written to on startup (JSON array)
//   FAKE_NAV_AFTER_EVALS  emit a nav event right after the Nth eval (page
//                 chain simulation, e.g. /login -> /escalate/webauthn)
//   FAKE_DIE      exit(7) immediately, before the ready event (launch failure)
//   FAKE_EXIT_AFTER_EVALS  exit(86) right after answering the Nth eval
//                 (mid-ceremony shell crash simulation)
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.env.FAKE_DIE) process.exit(7)

if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\n')

const evals = (process.env.FAKE_EVALS ?? '').split(',').filter(Boolean)
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let navigated = false
let evalCount = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, line + '\n')
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.cmd === 'navigate' && !navigated) {
    navigated = true
    out({ event: 'nav', url: msg.url })
    if (process.env.FAKE_WEBAUTHN) out({ event: 'webauthn', id: 99, ...JSON.parse(process.env.FAKE_WEBAUTHN) })
  }
  if (msg.cmd === 'eval') {
    out({ event: 'eval-result', id: msg.id, value: evals.shift() ?? 'not-found' })
    evalCount++
    if (String(evalCount) === process.env.FAKE_NAV_AFTER_EVALS) {
      out({ event: 'nav', url: 'https://www.npmjs.com/escalate/webauthn' })
    }
    if (String(evalCount) === process.env.FAKE_EXIT_AFTER_EVALS) process.exit(86)
  }
  if (msg.cmd === 'close') process.exit(0)
})

out({ event: 'ready' })
