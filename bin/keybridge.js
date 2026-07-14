#!/usr/bin/env node
// keybridge CLI — human-facing entry point.
//
//   keybridge publish [--poll-timeout <sec>] [--] [npm publish args...]
//   keybridge login   [--poll-timeout <sec>] [--] [npm-ish args, e.g. --registry]
//
// publish: runs `npm publish`; when npm demands web-based WebAuthn
// verification, opens the ceremony in the default browser, waits for your
// touch, and completes the publish. An expired or missing npm login session is
// handled automatically (extra touch).
// login: just the web-login ceremony; persists the session token to npmrc.

import { publishWithWebAuth, loginWithWebAuth, PublishError } from '../src/engine.js'
import { browserPresenter, notifyHuman } from '../src/presenters.js'

const [, , command, ...rest] = process.argv

if (command !== 'publish' && command !== 'login') {
  console.error('usage: keybridge <publish|login> [--poll-timeout <sec>] [--] [npm args...]')
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 64)
}

let pollTimeoutMs = 300_000
const npmArgs = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a === '--poll-timeout') pollTimeoutMs = Number(rest[++i]) * 1000
  else if (a.startsWith('--poll-timeout=')) pollTimeoutMs = Number(a.split('=')[1]) * 1000
  else if (a === '--') { npmArgs.push(...rest.slice(i + 1)); break }
  else npmArgs.push(a)
}

const presenter = browserPresenter()
const presenterName = 'browser'

const onStatus = ({ phase, authUrl, purpose, npmrc, code }) => {
  if (phase === 'publish-attempt') console.error('· running npm publish ...')
  if (phase === 'login-required') console.error(`· npm session expired or missing (${code}) — starting web login`)
  if (phase === 'minting-session') console.error('· npm redacted the auth URLs (npm < 12) — minting a fresh web-auth session')
  if (phase === 'awaiting-human') {
    const what = purpose === 'login' ? 'login verification' : 'publish verification'
    console.error(`· npm requires human ${what} — opening ${presenterName}`)
    console.error(`  ${authUrl}`)
    console.error('  → touch your security key / Touch ID to approve')
    notifyHuman(`npm ${purpose === 'login' ? 'login' : 'publish'} is waiting for your security key / Touch ID approval`)
  }
  if (phase === 'login-complete') console.error(`· logged in — session token saved to ${npmrc}`)
  if (phase === 'publish-retry') console.error('· verified — completing publish ...')
}

try {
  if (command === 'login') {
    await loginWithWebAuth({ npmArgs, presenter, pollTimeoutMs, onStatus })
    console.error('✓ npm login complete')
  } else {
    const outcome = await publishWithWebAuth({ npmArgs, presenter, pollTimeoutMs, onStatus })
    const id = outcome.result?.id ?? ''
    console.error(`✓ published ${id}${outcome.usedWebAuth ? ' (via WebAuthn hand-off)' : ''}`)
    console.log(JSON.stringify(outcome.result, null, 2))
  }
} catch (e) {
  if (e instanceof PublishError) {
    console.error(`✗ ${e.message} [${e.code}]`)
    if (e.stderr) console.error(e.stderr.trim())
    process.exit(1)
  }
  throw e
}
