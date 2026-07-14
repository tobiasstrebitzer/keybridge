#!/usr/bin/env node
// keybridge CLI - human-facing entry point.
//
//   keybridge setup                                       # build native helpers, pick backend
//   keybridge enroll                                      # add the keybridge security key to the npm account
//   keybridge publish [--poll-timeout <sec>] [--presenter webkit|browser] [--] [npm publish args...]
//   keybridge login   [--poll-timeout <sec>] [--presenter webkit|browser] [--] [npm-ish args, e.g. --registry]
//
// publish: runs `npm publish`; when npm demands web-based WebAuthn
// verification, drives the ceremony in an invisible windowless WKWebView so
// the only visible step is Touch ID, then completes the publish. An expired
// or missing npm login session is handled automatically (extra touch).
// login: just the web-login ceremony; persists the session token to npmrc.
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loginWithWebAuth, publishWithWebAuth, runNpm, PublishError, type StatusEvent } from './engine.ts'
import { notifyHuman } from './presenters/browser.ts'
import { selectPresenter, type PresenterName } from './presenters/select.ts'
import { openSurfacedShell } from './presenters/webkit.ts'
import { paths } from './signer.ts'
import { runSetup } from './setup.ts'

const USAGE = 'usage: keybridge <setup|enroll|publish|login> [--poll-timeout <sec>] [--presenter webkit|browser] [--] [npm args...]'

const [, , command, ...rest] = process.argv

if (command === 'setup') {
  runSetup()
  console.error('✓ setup complete - next: `keybridge login` (first run opens a window to log into npmjs.com once), then `keybridge enroll`')
  process.exit(0)
}

const npmjsCredentials = (): number => {
  try {
    const store = JSON.parse(readFileSync(paths.STORE, 'utf8')) as { credentials: Array<{ rpId: string }> }
    return store.credentials.filter((c) => c.rpId.includes('npmjs.com')).length
  } catch { return 0 }
}

// enroll: open the shell SURFACED on npm's 2FA settings so the human can add
// the keybridge security key (create() is answered by our signer → Touch ID).
// Enrollment can't piggyback on `login`: on an account without 2FA the login
// ceremony completes right after the password and tears the window down.
if (command === 'enroll') {
  const who = await runNpm(['whoami']).catch(() => null)
  const username = who?.code === 0 ? who.stdout.trim() : ''
  const url = username
    ? `https://www.npmjs.com/settings/${username}/tfa`
    : 'https://www.npmjs.com/settings' // npm redirects; the user navigates to 2FA settings
  console.error(`· opening npm two-factor settings${username ? ` for ${username}` : ''} in the keybridge window`)
  console.error('  → click "Add security key", name it (e.g. "keybridge"), approve with Touch ID')
  const before = npmjsCredentials()
  const shell = await openSurfacedShell(url)
  const deadline = Date.now() + 10 * 60_000
  let enrolled = false
  while (Date.now() < deadline) {
    await delay(1000)
    if (npmjsCredentials() > before) { enrolled = true; break }
  }
  shell.close()
  if (enrolled) {
    console.error('✓ keybridge security key enrolled - publishes are now Touch ID-gated')
    process.exit(0)
  }
  console.error('✗ timed out waiting for the security key to be added (10 min)')
  process.exit(1)
}

if (command !== 'publish' && command !== 'login') {
  console.error(USAGE)
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 64)
}

let pollTimeoutMs = 300_000
let presenterChoice: PresenterName | undefined
const npmArgs: string[] = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!
  // Intercept help before the `--` separator: forwarding it would make npm
  // print its help and "succeed" without publishing anything.
  if (a === '--help' || a === '-h') {
    console.error(USAGE)
    process.exit(0)
  }
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
  if (phase === 'login-required') console.error(`· npm session expired or missing (${code}) - starting web login`)
  if (phase === 'minting-session') console.error('· npm redacted the auth URLs (npm < 12) - minting a fresh web-auth session')
  if (phase === 'awaiting-human') {
    const what = purpose === 'login' ? 'login verification' : 'publish verification'
    console.error(`· npm requires human ${what} - presenting via ${presenterName}`)
    console.error(`  ${authUrl}`)
    console.error('  → touch your security key / Touch ID to approve')
    notifyHuman(`npm ${purpose === 'login' ? 'login' : 'publish'} is waiting for your security key / Touch ID approval`)
  }
  if (phase === 'login-complete') console.error(`· logged in - session token saved to ${npmrc}`)
  if (phase === 'publish-retry') console.error('· verified - completing publish ...')
}

try {
  if (command === 'login') {
    await loginWithWebAuth({ npmArgs, presenter, pollTimeoutMs, onStatus })
    console.error('✓ npm login complete')
  } else {
    const outcome = await publishWithWebAuth({ npmArgs, presenter, pollTimeoutMs, onStatus })
    const id = outcome.result?.id ?? outcome.result?.name
    if (!id) {
      // npm exited 0 without a publish result (e.g. a forwarded flag made it
      // print help) - do not claim success for a publish that never happened.
      console.error('✗ npm exited without a publish result - nothing was published')
      process.exitCode = 1
    } else {
      console.error(`✓ published ${id}${outcome.usedWebAuth ? ' (via WebAuthn hand-off)' : ''}`)
      console.log(JSON.stringify(outcome.result, null, 2))
    }
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
