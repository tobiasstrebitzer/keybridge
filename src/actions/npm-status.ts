// `NpmStatus` MCP tool: read-only identity report. Agents call this first
// whenever the target account matters - it answers "who would a publish run
// as, and would it work?" without starting any ceremony.
import { createAction } from '@silkweave/core'
import { z } from 'zod/v4'
import { accountsStatus } from '../accounts.ts'

const input = z.object({
  registry: z.string().url()
    .describe('Registry to report against. Defaults to the npm config registry (normally https://registry.npmjs.org).')
    .optional(),
})

const output = z.object({
  user: z.string().nullable()
    .describe('`npm whoami` - the account any publish would run as right now. Null when logged out or the session token expired.'),
  activeAccount: z.string().nullable()
    .describe('Last account confirmed by a keybridge login - the identity an automatic re-login would restore when the token expired.'),
  registry: z.string().describe('The registry the report applies to.'),
  twoFactorMode: z.string().nullable()
    .describe('Current account\'s npm 2FA mode. "auth-and-writes" = every publish requires the human\'s touch (what keybridge is built for). "auth-only" = the token alone can publish - keybridge\'s approval gate is BYPASSED; tell the user to switch modes. Null = unknown/logged out.'),
  accounts: z.array(z.object({
    username: z.string(),
    current: z.boolean().describe('True for the `npm whoami` account.'),
    securityKeys: z.number().describe('Enrolled keybridge security keys linked to this account.'),
    hasBrowserProfile: z.boolean().describe('Whether a dedicated web-session profile exists (no password prompt on the next login).'),
    storedToken: z.enum(['web', 'manual']).nullable()
      .describe('Token in the vault: makes npm-switch-account (and user-pinned publishes) instant while it works. "web" tokens expire ~12h; "manual" ones are user-provided granular tokens. Not validated here.'),
  })).describe('Every npm account keybridge knows about.'),
  unlinkedKeys: z.number()
    .describe('Security keys enrolled before account linking existed; they link to the current user automatically on the next login.'),
  warnings: z.array(z.string())
    .describe('Divergences that need attention (not logged in, no security key for the current user, ...). Empty means a publish should go through.'),
})

export const NpmStatusAction = createAction({
  name: 'npm-status',
  description: [
    'Report the npm identity state: who the npm CLI is logged in as (`npm',
    'whoami`), which accounts keybridge knows (with their security keys and',
    'browser profiles), and any problems that would make a publish fail.',
    'Read-only and instant - no ceremony, no user interaction. Call this',
    'FIRST whenever it matters which account a publish runs as, and before',
    'npm-switch-account.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { readOnlyHint: true },
  run: async ({ registry }) => {
    const status = await accountsStatus({ registry })
    return {
      user: status.user,
      activeAccount: status.active,
      registry: status.registry,
      twoFactorMode: status.twoFactorMode,
      accounts: status.accounts.map((a) => ({
        username: a.username,
        current: a.current,
        securityKeys: a.securityKeys,
        hasBrowserProfile: a.storeId !== null,
        storedToken: a.storedToken,
      })),
      unlinkedKeys: status.unlinkedKeys,
      warnings: status.warnings,
    }
  },
})
