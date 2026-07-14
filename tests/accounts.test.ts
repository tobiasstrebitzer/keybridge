import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// accounts.ts and signer.ts capture ~/.keybridge from homedir() at import
// time - redirect HOME BEFORE the (hoisting-safe, dynamic) imports so the
// tests never touch the real store.
const realHome = homedir()
const home = mkdtempSync(join(tmpdir(), 'kb-accounts-'))
process.env.HOME = home
process.env.KEYBRIDGE_BACKEND = 'software'
test.after(() => { rmSync(home, { recursive: true, force: true }); process.env.HOME = realHome })

const {
  LEGACY_STORE_ID, accountsStatus, assertSecurityKeyFor, bindAccount,
  candidateStoreId, configFlags, dropAccount, getActive, loginAs,
  resolveMediation, resolvePublishIdentity, rpIdForRegistry, whoami,
} = await import('../src/accounts.ts')
const { deleteToken, getToken, listTokenMeta, saveToken, tokenEnv } = await import('../src/tokens.ts')
const { createSigner, listCredentials } = await import('../src/signer.ts')
const { PublishError } = await import('../src/engine.ts')
const { startMockRegistry, SESSION_TOKEN } = await import('./mock-registry.ts')

// Scripted `npm` stand-in. `whoami`:
//  - with one of OUR tokens in the env override (`valid-<name>` / `test-*`),
//    answers for the token - like the registry would;
//  - otherwise echoes $FAKE_WHOAMI (fails when unset), mirroring the npmrc
//    session token being valid vs. missing/expired.
const fakeNpm = join(home, 'fake-npm')
writeFileSync(fakeNpm, `#!/bin/sh
case "$1" in
  whoami)
    TOK=$(printenv | sed -n 's/^npm_config_.*:_authToken=//p' | head -n 1)
    case "$TOK" in
      valid-*) echo "\${TOK#valid-}"; exit 0 ;;
      test-*) echo "npm error invalid token" >&2; exit 1 ;;
    esac
    if [ -n "$FAKE_WHOAMI" ]; then echo "$FAKE_WHOAMI"; exit 0; else echo "ENEEDAUTH" >&2; exit 1; fi ;;
  profile)
    if [ -n "$FAKE_TFA" ]; then echo "{\\"tfa\\":{\\"pending\\":null,\\"mode\\":\\"$FAKE_TFA\\"}}"; exit 0; else exit 1; fi ;;
  *) exit 1 ;;
esac
`)
chmodSync(fakeNpm, 0o755)
const asUser = (name: string | null) => {
  if (name === null) delete process.env.FAKE_WHOAMI
  else process.env.FAKE_WHOAMI = name
}

const resetState = () => {
  rmSync(join(home, '.keybridge', 'accounts.json'), { force: true })
  rmSync(join(home, '.keybridge', 'credentials.json'), { force: true })
  rmSync(join(home, '.keybridge', 'tokens.json'), { force: true })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('configFlags forwards only registry/userconfig flags', () => {
  assert.deepEqual(
    configFlags(['--tag', 'beta', '--registry', 'http://r', '--userconfig=/tmp/x', '--dry-run']),
    ['--registry', 'http://r', '--userconfig=/tmp/x'],
  )
  assert.deepEqual(configFlags(), [])
})

test('whoami follows the npm CLI session', async () => {
  asUser('alice')
  assert.equal(await whoami({ npmBin: fakeNpm }), 'alice')
  asUser(null)
  assert.equal(await whoami({ npmBin: fakeNpm }), null)
})

test('rpIdForRegistry knows the public registry, skips others', () => {
  assert.equal(rpIdForRegistry('https://registry.npmjs.org/'), 'www.npmjs.com')
  assert.equal(rpIdForRegistry('https://npm.example.com/'), null)
  assert.equal(rpIdForRegistry('not a url'), null)
})

test('store ids: legacy is grandfathered to the first account, then fresh UUIDs', () => {
  resetState()
  // Nothing recorded yet: everyone would get the legacy store (that is where
  // a pre-accounts installation's live web session lives).
  assert.equal(candidateStoreId('alice'), LEGACY_STORE_ID)
  assert.equal(candidateStoreId(), LEGACY_STORE_ID)

  bindAccount('alice', LEGACY_STORE_ID)
  assert.equal(getActive(), 'alice')
  assert.equal(candidateStoreId('alice'), LEGACY_STORE_ID)

  // Known accounts exist: a new account gets its own profile.
  const bobStore = candidateStoreId('bob')
  assert.notEqual(bobStore, LEGACY_STORE_ID)
  assert.match(bobStore, UUID_RE)

  // Candidate ids are not persisted until a login confirms them.
  assert.notEqual(candidateStoreId('bob'), bobStore)
})

test('binding a store to a new owner drops the previous owner', () => {
  resetState()
  bindAccount('alice', LEGACY_STORE_ID)
  // bob logged in inside alice's profile: the cookies are bob's now.
  bindAccount('bob', LEGACY_STORE_ID)
  assert.equal(getActive(), 'bob')
  assert.equal(candidateStoreId('bob'), LEGACY_STORE_ID)
  // alice lost her profile; she gets a fresh one next time.
  const aliceStore = candidateStoreId('alice')
  assert.notEqual(aliceStore, LEGACY_STORE_ID)

  assert.equal(dropAccount('bob'), LEGACY_STORE_ID)
  assert.equal(getActive(), null)
  assert.equal(dropAccount('bob'), null)
})

test('loginAs: binds whatever `npm whoami` confirms and heals credentials', async (t) => {
  resetState()
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const npmrc = join(home, 'npmrc-login')
  writeFileSync(npmrc, '')

  // A pre-accounts credential that answers the login ceremony.
  const signer = createSigner({ backend: 'software' })
  signer.register('www.npmjs.com', 'aGFuZGxl')
  signer.selectForAssertion('www.npmjs.com', [])

  asUser('alice')
  const result = await loginAs(undefined, {
    registry: registry.url,
    npmBin: fakeNpm,
    npmArgs: ['--userconfig', npmrc],
    presenter: async ({ authUrl }) => { await fetch(authUrl) },
  })

  assert.equal(result.user, 'alice')
  assert.equal(result.switched, false)
  assert.match(readFileSync(npmrc, 'utf8'), new RegExp(SESSION_TOKEN))
  assert.equal(getActive(), 'alice')
  assert.equal(candidateStoreId('alice'), LEGACY_STORE_ID, 'first account inherits the legacy store')
  // The credential that answered the ceremony is now linked to alice.
  assert.equal(listCredentials()[0]!.username, 'alice')
  // ... and the fresh session token landed in the vault for later switches.
  assert.equal(getToken('alice')?.token, SESSION_TOKEN)
  assert.equal(getToken('alice')?.kind, 'web')
})

test('token vault: CRUD and secret-free listing', () => {
  resetState()
  assert.equal(getToken('alice'), null)
  saveToken('alice', { token: 'valid-alice', registry: 'https://registry.npmjs.org/', kind: 'manual' })
  assert.equal(getToken('alice')?.token, 'valid-alice')
  const meta = listTokenMeta()
  assert.equal(meta.length, 1)
  assert.equal(meta[0]!.username, 'alice')
  assert.equal(meta[0]!.kind, 'manual')
  assert.ok(!('token' in meta[0]!), 'listing carries no secrets')
  assert.equal(deleteToken('alice'), true)
  assert.equal(deleteToken('alice'), false)
})

test('loginAs: a working stored token switches instantly, no ceremony', async (t) => {
  resetState()
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const npmrc = join(home, 'npmrc-instant')
  writeFileSync(npmrc, '')

  asUser('alice') // CLI is alice; bob's token is parked in the vault
  saveToken('bob', { token: 'valid-bob', registry: registry.url, kind: 'manual' })

  const result = await loginAs('bob', {
    registry: registry.url,
    npmBin: fakeNpm,
    npmArgs: ['--userconfig', npmrc],
    presenter: async () => { throw new Error('ceremony must not run') },
  })

  assert.equal(result.user, 'bob')
  assert.equal(result.usedStoredToken, true)
  assert.equal(result.switched, true)
  assert.match(readFileSync(npmrc, 'utf8'), /valid-bob/)
  assert.equal(getActive(), 'bob')
  assert.equal(registry.state.loginStarts, 0, 'no web-login session was ever opened')
})

test('loginAs: a dead stored token is dropped and the ceremony runs', async (t) => {
  resetState()
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const npmrc = join(home, 'npmrc-dead-token')
  writeFileSync(npmrc, '')

  asUser('alice')
  saveToken('carol', { token: 'test-dead', registry: registry.url, kind: 'web' })

  const result = await loginAs('carol', {
    registry: registry.url,
    npmBin: fakeNpm,
    npmArgs: ['--userconfig', npmrc],
    // The human logs in as carol during the ceremony.
    presenter: async ({ authUrl }) => { asUser('carol'); await fetch(authUrl) },
  })

  assert.equal(result.user, 'carol')
  assert.equal(result.usedStoredToken, false)
  // The vault was refreshed with the ceremony's fresh token.
  assert.equal(getToken('carol')?.token, SESSION_TOKEN)
  assert.equal(getToken('carol')?.kind, 'web')
})

test('resolveMediation: hands out env + profile for a working token, null otherwise', async () => {
  resetState()
  const registryUrl = 'https://registry.npmjs.org/'

  assert.equal(await resolveMediation('bob', { npmBin: fakeNpm, registry: registryUrl }), null)

  saveToken('bob', { token: 'valid-bob', registry: registryUrl, kind: 'manual' })
  const mediation = await resolveMediation('bob', { npmBin: fakeNpm, registry: registryUrl })
  assert.ok(mediation)
  assert.equal(mediation!.user, 'bob')
  assert.equal(mediation!.env['npm_config_//registry.npmjs.org/:_authToken'], 'valid-bob')
  assert.deepEqual(tokenEnv(registryUrl, 'valid-bob'), { 'npm_config_//registry.npmjs.org/:_authToken': 'valid-bob' })

  // Dead token: mediation refused AND the token is evicted.
  saveToken('mallory', { token: 'test-dead', registry: registryUrl, kind: 'web' })
  assert.equal(await resolveMediation('mallory', { npmBin: fakeNpm, registry: registryUrl }), null)
  assert.equal(getToken('mallory'), null)

  // Registry mismatch: the token is not even tried.
  saveToken('dave', { token: 'valid-dave', registry: 'https://npm.example.com/', kind: 'manual' })
  assert.equal(await resolveMediation('dave', { npmBin: fakeNpm, registry: registryUrl }), null)
  assert.ok(getToken('dave'), 'foreign-registry token stays in the vault')
})

test('loginAs: a switch that lands on the wrong user corrects state, then fails', async (t) => {
  resetState()
  const registry = await startMockRegistry()
  t.after(() => registry.close())
  const npmrc = join(home, 'npmrc-switch')
  writeFileSync(npmrc, '')

  asUser('alice') // whoever the human authenticates as, npm whoami reports alice
  await assert.rejects(
    loginAs('bob', {
      registry: registry.url,
      npmBin: fakeNpm,
      npmArgs: ['--userconfig', npmrc],
      presenter: async ({ authUrl }) => { await fetch(authUrl) },
    }),
    (e: unknown) => e instanceof PublishError && e.code === 'EACCOUNT',
  )
  // State followed reality (alice), not the request (bob).
  assert.equal(getActive(), 'alice')
})

test('assertSecurityKeyFor: fails fast only on definitive mismatches', () => {
  resetState()
  const registryUrl = 'https://registry.npmjs.org/'

  // No key enrolled at all -> the ceremony would hang; fail fast.
  assert.throws(() => assertSecurityKeyFor('alice', registryUrl),
    (e: unknown) => e instanceof PublishError && e.code === 'ENOKEY')

  // Unstamped (pre-accounts) key: benefit of the doubt.
  const signer = createSigner({ backend: 'software' })
  signer.register('www.npmjs.com', 'aGFuZGxl')
  assert.doesNotThrow(() => assertSecurityKeyFor('alice', registryUrl))

  // Custom registries have unknown rpIds - never block those.
  assert.doesNotThrow(() => assertSecurityKeyFor('alice', 'https://npm.example.com/'))
})

test('assertSecurityKeyFor: keys stamped for another account block the publish', async () => {
  resetState()
  const { stampUsername } = await import('../src/signer.ts')
  const signer = createSigner({ backend: 'software' })
  signer.register('www.npmjs.com', 'aGFuZGxl')
  stampUsername(listCredentials().map((c) => c.credId), 'bob')

  assert.throws(() => assertSecurityKeyFor('alice', 'https://registry.npmjs.org/'),
    (e: unknown) => e instanceof PublishError && e.code === 'ENOKEY' && /bob/.test(e.message))
  assert.doesNotThrow(() => assertSecurityKeyFor('bob', 'https://registry.npmjs.org/'))
})

test('resolvePublishIdentity: whoami drives, active account is the logged-out fallback', async () => {
  resetState()
  asUser('alice')
  const identity = await resolvePublishIdentity({ npmBin: fakeNpm })
  assert.equal(identity.user, 'alice')
  assert.equal(identity.storeId, LEGACY_STORE_ID)
  assert.equal(getActive(), 'alice', 'self-heals the active pointer')

  asUser(null) // token expired: fall back to alice's profile for the re-login
  const loggedOut = await resolvePublishIdentity({ npmBin: fakeNpm })
  assert.equal(loggedOut.user, null)
  assert.equal(loggedOut.active, 'alice')
  assert.equal(loggedOut.storeId, LEGACY_STORE_ID)
})

test('accountsStatus reports divergences as warnings', async () => {
  resetState()
  asUser('alice')
  const fresh = await accountsStatus({ npmBin: fakeNpm, registry: 'https://registry.npmjs.org/' })
  assert.equal(fresh.user, 'alice')
  assert.ok(fresh.warnings.some((w) => w.includes('no keybridge security key enrolled for "alice"')))
  assert.ok(fresh.warnings.some((w) => w.includes('browser profile')))

  bindAccount('alice', LEGACY_STORE_ID)
  const signer = createSigner({ backend: 'software' })
  signer.register('www.npmjs.com', 'aGFuZGxl')
  const { stampUsername } = await import('../src/signer.ts')
  stampUsername(listCredentials().map((c) => c.credId), 'alice')

  const healthy = await accountsStatus({ npmBin: fakeNpm, registry: 'https://registry.npmjs.org/' })
  assert.deepEqual(healthy.warnings, [])
  assert.equal(healthy.accounts.length, 1)
  assert.equal(healthy.accounts[0]!.username, 'alice')
  assert.equal(healthy.accounts[0]!.securityKeys, 1)
  assert.equal(healthy.accounts[0]!.current, true)

  asUser(null)
  const expired = await accountsStatus({ npmBin: fakeNpm, registry: 'https://registry.npmjs.org/' })
  assert.ok(expired.warnings.some((w) => w.includes('re-authenticates as alice')))
})

test('auth-only 2FA mode is surfaced as a loud warning (the gate is bypassed)', async (t) => {
  resetState()
  asUser('alice')
  process.env.FAKE_TFA = 'auth-only'
  t.after(() => { delete process.env.FAKE_TFA })

  const { twoFactorMode } = await import('../src/accounts.ts')
  assert.equal(await twoFactorMode({ npmBin: fakeNpm }), 'auth-only')

  const status = await accountsStatus({ npmBin: fakeNpm, registry: 'https://registry.npmjs.org/' })
  assert.equal(status.twoFactorMode, 'auth-only')
  assert.ok(status.warnings.some((w) => w.includes('auth-only') && w.includes('bypassed')))

  // auth-and-writes: the mode keybridge is built for - no warning.
  process.env.FAKE_TFA = 'auth-and-writes'
  const good = await accountsStatus({ npmBin: fakeNpm, registry: 'https://registry.npmjs.org/' })
  assert.equal(good.twoFactorMode, 'auth-and-writes')
  assert.ok(!good.warnings.some((w) => w.includes('auth-only')))
})
