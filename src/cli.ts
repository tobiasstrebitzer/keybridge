#!/usr/bin/env node
// keybridge CLI - human-facing entry point.
//
//   keybridge setup                 # build native helpers, pick backend
//   keybridge status                # identity overview: whoami, profiles, keys (alias: whoami)
//   keybridge enroll                # add the keybridge security key to the CURRENT npm account
//   keybridge login                 # (re)login as the current/last-active account
//   keybridge switch <username>     # change npm accounts (each account has its own browser profile)
//   keybridge logout [--web]        # npm logout; --web also deletes the account's browser profile
//   keybridge open [url]            # surfaced keybridge window on the current account's profile
//   keybridge token <ls|set|rm> [username] [token]   # per-account token vault
//   keybridge publish [--user <name>] [--] [npm publish args...]
//
// login/switch/publish also accept [--poll-timeout <sec>] [--presenter webkit|browser].
//
// Identity model: `npm whoami` drives every decision. Each npm account gets
// its own WKWebsiteDataStore (browser profile), so switching accounts never
// clobbers another account's web session, and after every login the local
// bindings re-sync to whatever whoami reports (see src/accounts.ts).
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  accountsStatus, assertSecurityKeyFor, bindAccount, bindAfterLogin, candidateStoreId,
  dropAccount, getActive, loginAs, resolveMediation, resolvePublishIdentity,
  twoFactorMode, whoami, whoamiWithToken, type Mediation,
} from './accounts.ts'
import { deleteToken, getToken, listTokenMeta, saveToken } from './tokens.ts'
import { publishWithWebAuth, resolveRegistry, runNpm, PublishError, type StatusEvent } from './engine.ts'
import { defaultPresenterName, selectPresenter, type PresenterName } from './presenters/select.ts'
import { openSurfacedShell, purgeWebStore } from './presenters/webkit.ts'
import { listCredentials, paths, stampUsername } from './signer.ts'
import { runSetup } from './setup.ts'
import { join } from 'node:path'

const USAGE = 'usage: keybridge <setup|status|enroll|login|switch|logout|open|token|publish> ' +
  '[--user <name>] [--poll-timeout <sec>] [--presenter webkit|browser] [--web] [--] [npm args...]'

const [, , command, ...rest] = process.argv

const fail = (message: string): never => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (command === 'setup') {
  runSetup()
  console.error('✓ setup complete - next: `keybridge login` (first run opens a window to log into npmjs.com once), then `keybridge enroll`')
  process.exit(0)
}

// First-run bootstrap - makes `npx keybridge publish` work from zero: any
// command that needs the native helpers auto-runs setup when it never
// happened on this machine (otherwise the signer would silently fall back to
// the software backend, losing the Touch ID gate).
if (['enroll', 'login', 'switch', 'open', 'publish'].includes(command ?? '') &&
    process.platform === 'darwin' && !existsSync(join(paths.KB_DIR, 'config.json'))) {
  console.error('· first run - setting up keybridge (compiling the native helpers) ...')
  runSetup()
}

if (command === 'status' || command === 'whoami') {
  const status = await accountsStatus()
  console.log(`npm CLI session : ${status.user ?? '(not logged in)'}`)
  console.log(`active account  : ${status.active ?? '(none)'}`)
  console.log(`registry        : ${status.registry}`)
  if (status.twoFactorMode) console.log(`2FA mode        : ${status.twoFactorMode}${status.twoFactorMode === 'auth-only' ? '  ⚠ publishes skip Touch ID!' : ''}`)
  if (status.accounts.length > 0) {
    console.log('\naccounts:')
    for (const a of status.accounts) {
      const keys = a.securityKeys === 1 ? '1 security key ' : `${a.securityKeys} security keys`
      const profile = a.storeId ? 'browser profile ✓' : 'browser profile ✗'
      const token = a.storedToken ? `token ✓ (${a.storedToken})` : 'token ✗'
      console.log(`  ${a.current ? '●' : ' '} ${a.username.padEnd(20)} ${keys}  ${profile}  ${token}${a.current ? '  ← current' : ''}`)
    }
  }
  if (status.unlinkedKeys > 0) {
    console.log(`  (${status.unlinkedKeys} security ${status.unlinkedKeys === 1 ? 'key' : 'keys'} not linked to an account yet)`)
  }
  for (const w of status.warnings) console.log(`\n⚠ ${w}`)
  process.exit(0)
}

// enroll: open the shell SURFACED on npm's 2FA settings so the human can add
// the keybridge security key (create() is answered by our signer → Touch ID).
// Enrollment can't piggyback on `login`: on an account without 2FA the login
// ceremony completes right after the password and tears the window down.
const npmjsCredIds = (): Set<string> =>
  new Set(listCredentials().filter((c) => c.rpId.includes('npmjs.com')).map((c) => c.credId))

if (command === 'enroll') {
  const username = await whoami()
  if (!username) fail('not logged in - run `keybridge login` first, then `keybridge enroll` (the key must be added to a specific npm account)')
  const storeId = candidateStoreId(username)
  bindAccount(username!, storeId)

  console.error(`· opening npm two-factor settings for ${username} in the keybridge window`)
  console.error('  → click "Add security key", name it (e.g. "keybridge"), approve with Touch ID')
  const before = npmjsCredIds()
  const shell = await openSurfacedShell(`https://www.npmjs.com/settings/${username}/tfa`, { storeId })
  const deadline = Date.now() + 10 * 60_000
  let enrolled: string[] = []
  while (Date.now() < deadline) {
    await delay(1000)
    enrolled = [...npmjsCredIds()].filter((id) => !before.has(id))
    if (enrolled.length > 0) break
  }
  shell.close()
  if (enrolled.length > 0) {
    stampUsername(enrolled, username!)
    console.error(`✓ keybridge security key enrolled for ${username} - publishes are now Touch ID-gated`)
    process.exit(0)
  }
  fail('timed out waiting for the security key to be added (10 min)')
}

if (command === 'logout') {
  const web = rest.includes('--web')
  const user = await whoami() ?? getActive()
  const res = await runNpm(['logout']).catch(() => null)
  if (res?.code === 0) console.error(`✓ npm session token revoked${user ? ` (${user})` : ''}`)
  else console.error('· no npm session token to revoke')
  // The revoked token is (usually) the one in the vault - drop it. Manual
  // (granular) tokens are not revoked by `npm logout`, so they survive.
  if (user && getToken(user)?.kind === 'web') deleteToken(user)
  if (web) {
    if (!user) fail('no account to purge - already logged out and no active account recorded')
    const storeId = dropAccount(user!)
    const purged = storeId ? await purgeWebStore(storeId) : false
    if (storeId && !purged) console.error(`⚠ could not purge the browser profile (${storeId}) - it will be orphaned on disk`)
    else console.error(`✓ browser profile for ${user} removed - the next login asks for the password again`)
  }
  process.exit(0)
}

// token vault: keeps every account's npm token so switches (and --user
// publishes) don't need a ceremony while the token is alive. `set` is for
// long-lived granular access tokens (create WITHOUT "bypass 2FA" - publishes
// must keep requiring the touch).
if (command === 'token') {
  const [sub, username, tokenArg] = rest
  if (sub === undefined || sub === 'ls') {
    const metas = listTokenMeta()
    if (metas.length === 0) console.log('no stored tokens - `keybridge login`/`switch` store them automatically, or `keybridge token set <user>`')
    for (const t of metas) {
      console.log(`  ${t.username.padEnd(20)} ${t.kind === 'web' ? 'web session (~12h)' : 'manual       '}  saved ${t.savedAt}  ${t.registry}`)
    }
    process.exit(0)
  }
  if (sub === 'rm') {
    if (!username) fail('usage: keybridge token rm <username>')
    console.error(deleteToken(username!) ? `✓ token for ${username} removed` : `· no token stored for ${username}`)
    process.exit(0)
  }
  if (sub !== 'set') fail('usage: keybridge token <ls|set|rm> [username] [token]')
  if (!username) fail('usage: keybridge token set <username> [token]  (omit the token to paste it interactively)')
  let token = tokenArg
  if (!token) {
    console.error(`paste the npm token for ${username} and press Enter:`)
    token = await new Promise<string>((resolve) => {
      process.stdin.once('data', (d) => resolve(String(d).trim()))
    })
  }
  if (!token) fail('no token provided')
  const registry = await resolveRegistry({}).catch(() => 'https://registry.npmjs.org/')
  const name = await whoamiWithToken(token!, registry)
  if (!name) fail(`that token does not authenticate against ${registry}`)
  if (name !== username) fail(`that token belongs to "${name}", not "${username}" - run \`keybridge token set ${name}\` instead`)
  saveToken(username!, { token: token!, registry, kind: 'manual' })
  console.error(`✓ token for ${username} stored - \`keybridge switch ${username}\` and \`keybridge publish --user ${username}\` are instant while it lives`)
  process.exit(0)
}

if (command === 'open') {
  const url = rest.find((a) => !a.startsWith('-')) ?? 'https://www.npmjs.com/'
  const user = await whoami() ?? getActive()
  const storeId = candidateStoreId(user)
  const shell = await openSurfacedShell(url, { storeId })
  console.error(`· opened ${url} in ${user ? `${user}'s` : 'the default'} browser profile`)
  console.error('  → press Enter (or Ctrl-C) here when you are done')
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve())
    process.once('SIGINT', () => resolve())
    void shell.exited.then(() => resolve())
  })
  shell.close()
  await shell.exited
  console.error('· window closed - if you changed npm accounts inside it, run `keybridge login` to re-sync')
  process.exit(0)
}

if (command !== 'publish' && command !== 'login' && command !== 'switch') {
  console.error(USAGE)
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 64)
}

// switch takes its target account as the first positional argument.
let switchTarget: string | undefined
const flags = [...rest]
if (command === 'switch') {
  switchTarget = flags[0] && !flags[0].startsWith('-') ? flags.shift() : undefined
  if (!switchTarget) fail('usage: keybridge switch <npm-username>')
}

let pollTimeoutMs = 300_000
let presenterChoice: PresenterName | undefined
let expectUser: string | undefined
const npmArgs: string[] = []
for (let i = 0; i < flags.length; i++) {
  const a = flags[i]!
  // Intercept help before the `--` separator: forwarding it would make npm
  // print its help and "succeed" without publishing anything.
  if (a === '--help' || a === '-h') {
    console.error(USAGE)
    process.exit(0)
  }
  if (a === '--poll-timeout') pollTimeoutMs = Number(flags[++i]) * 1000
  else if (a.startsWith('--poll-timeout=')) pollTimeoutMs = Number(a.split('=')[1]) * 1000
  else if (a === '--presenter') presenterChoice = flags[++i] as PresenterName
  else if (a.startsWith('--presenter=')) presenterChoice = a.split('=')[1] as PresenterName
  else if (a === '--user') expectUser = flags[++i]
  else if (a.startsWith('--user=')) expectUser = a.split('=')[1]
  else if (a === '--') { npmArgs.push(...flags.slice(i + 1)); break }
  else npmArgs.push(a)
}

const presenterName = presenterChoice ?? defaultPresenterName()

const onStatus = ({ phase, authUrl, purpose, npmrc, code }: StatusEvent) => {
  if (phase === 'publish-attempt') console.error('· running npm publish ...')
  if (phase === 'login-required') console.error(`· npm session expired or missing (${code}) - starting web login`)
  if (phase === 'minting-session') console.error('· npm redacted the auth URLs (npm < 12) - minting a fresh web-auth session')
  if (phase === 'awaiting-human') {
    const what = purpose === 'login' ? 'login verification' : 'publish verification'
    console.error(`· npm requires human ${what} - presenting via ${presenterName}`)
    console.error(`  ${authUrl}`)
    console.error('  → touch your security key / Touch ID to approve')
  }
  if (phase === 'login-complete') console.error(`· logged in - session token saved to ${npmrc}`)
  if (phase === 'publish-retry') console.error('· verified - completing publish ...')
}

try {
  if (command === 'login' || command === 'switch') {
    const target = switchTarget ?? expectUser
    const { user, switched, usedStoredToken } = await loginAs(target, {
      npmArgs, presenterName: presenterChoice, pollTimeoutMs, onStatus,
    })
    const how = usedStoredToken ? ' (stored token - no ceremony)' : ''
    console.error(switched ? `✓ switched to ${user}${how}` : `✓ npm login complete (${user})${how}`)
  } else {
    const identity = await resolvePublishIdentity({ npmArgs })
    let publishUser = identity.user
    let storeId = identity.storeId
    let mediation: Mediation | null = null

    if (expectUser && identity.user !== expectUser) {
      // Publish AS someone the CLI is not logged in as: a stored token lets
      // us mediate - the publish runs with that account's token via env
      // override and its own browser profile; the CLI session stays put.
      mediation = await resolveMediation(expectUser, { npmArgs })
      if (mediation) {
        publishUser = expectUser
        storeId = mediation.storeId
        console.error(`· publishing as ${expectUser} via stored token (CLI session stays ${identity.user ?? 'logged out'})`)
      } else if (identity.user) {
        fail(`npm is logged in as "${identity.user}" and no working token is stored for "${expectUser}" - run \`keybridge switch ${expectUser}\` (or park a token: \`keybridge token set ${expectUser}\`)`)
      } else {
        // Logged out + explicit identity: log in as them before publishing so
        // the publish can never go out under the wrong account.
        console.error(`· not logged in - logging in as ${expectUser} first`)
        await loginAs(expectUser, { npmArgs, presenterName: presenterChoice, pollTimeoutMs, onStatus })
        publishUser = expectUser
        storeId = candidateStoreId(expectUser)
      }
    }

    if (publishUser) {
      if (!mediation) console.error(`· publishing as ${publishUser}`)
      if (presenterName === 'webkit' && !npmArgs.includes('--dry-run')) {
        const registry = mediation?.registry
          ?? await resolveRegistry({ npmArgs }).catch(() => 'https://registry.npmjs.org/')
        assertSecurityKeyFor(publishUser, registry)
      }
      // auth-only 2FA = npm publishes with the token alone; the human gate
      // keybridge exists for never fires. Warn loudly (mediated publishes
      // check the mediated account's own token/session).
      if (!npmArgs.includes('--dry-run')) {
        const mode = await twoFactorMode(mediation ? { npmArgs, env: mediation.env } : { npmArgs })
        if (mode === 'auth-only') {
          console.error('⚠ 2FA mode is "auth-only" - npm will NOT ask for Touch ID on this publish (the human gate is bypassed)')
          console.error(`  → fix: \`keybridge open https://www.npmjs.com/settings/${publishUser}/tfa\` and set "Require two-factor... for writes"`)
        }
      }
    } else {
      console.error(`· not logged in - a web login will run first${identity.active ? ` (last account: ${identity.active})` : ''}`)
    }

    const prefillUsername = publishUser ?? identity.active
    const { presenter } = selectPresenter(presenterChoice, {
      webkit: { storeId, ...(prefillUsername ? { prefillUsername } : {}) },
    })
    const outcome = await publishWithWebAuth({
      npmArgs, presenter, pollTimeoutMs, onStatus,
      // Mediated: never auto-login (it would mint a token for the WRONG
      // account into npmrc); an expired mediation token fails fast instead.
      ...(mediation ? { env: mediation.env, autoLogin: false } : {}),
      afterLogin: async (login) => { await bindAfterLogin(storeId, { npmArgs }, login) },
    })
    // A mediated ceremony proved the profile belongs to that account - keep
    // the binding (without stealing the active pointer).
    if (mediation && outcome.usedWebAuth) bindAccount(mediation.user, storeId, { activate: false })
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
