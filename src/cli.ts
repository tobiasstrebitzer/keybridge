#!/usr/bin/env node
// keybridge CLI — human-facing entry point.
//
//   keybridge publish [--poll-timeout <sec>] [--presenter chrome|browser] [--] [npm publish args...]
//   keybridge login   [--poll-timeout <sec>] [--presenter chrome|browser] [--] [npm-ish args, e.g. --registry]
//
// publish: runs `npm publish`; when npm demands web-based WebAuthn
// verification, drives the ceremony in an invisible off-screen Chrome (Tier A)
// so the only visible step is Touch ID, then completes the publish. An expired
// or missing npm login session is handled automatically (extra touch).
// login: just the web-login ceremony; persists the session token to npmrc.
import { loginWithWebAuth, publishWithWebAuth, PublishError, type StatusEvent } from './engine.ts'
import { notifyHuman } from './presenters/browser.ts'
import { releaseChromePresenter } from './presenters/chrome.ts'
import { selectPresenter, type PresenterName } from './presenters/select.ts'

const [, , command, ...rest] = process.argv

if (command !== 'publish' && command !== 'login') {
  console.error('usage: keybridge <publish|login> [--poll-timeout <sec>] [--presenter chrome|browser] [--] [npm args...]')
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 64)
}

let pollTimeoutMs = 300_000
let presenterChoice: PresenterName | undefined
const npmArgs: string[] = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!
  if (a === '--poll-timeout') pollTimeoutMs = Number(rest[++i]) * 1000
  else if (a.startsWith('--poll-timeout=')) pollTimeoutMs = Number(a.split('=')[1]) * 1000
  else if (a === '--presenter') presenterChoice = rest[++i] as PresenterName
  else if (a.startsWith('--presenter=')) presenterChoice = a.split('=')[1] as PresenterName
  else if (a === '--') { npmArgs.push(...rest.slice(i + 1)); break }
  else npmArgs.push(a)
}

const { name: presenterName, presenter } = selectPresenter(presenterChoice)

const onStatus = ({ phase, authUrl, purpose, npmrc, code }: StatusEvent) => {
  if (phase === 'publish-attempt') console.error('· running npm publish ...')
  if (phase === 'login-required') console.error(`· npm session expired or missing (${code}) — starting web login`)
  if (phase === 'minting-session') console.error('· npm redacted the auth URLs (npm < 12) — minting a fresh web-auth session')
  if (phase === 'awaiting-human') {
    const what = purpose === 'login' ? 'login verification' : 'publish verification'
    console.error(`· npm requires human ${what} — presenting via ${presenterName}`)
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
    process.exitCode = 1
  } else {
    throw e
  }
}

// The warm Chrome (detached) outlives this process for the next invocation;
// only the CDP socket must be released so the event loop can drain.
releaseChromePresenter()
