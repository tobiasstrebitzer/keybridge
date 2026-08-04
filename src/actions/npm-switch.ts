// `NpmSwitchAccount` MCP tool: change which npm account the CLI publishes as.
// Each account has its own browser profile, so switching to an account with a
// live web session only needs a Touch ID tap; a first-time (or purged)
// account surfaces the keybridge window for its password once.
import { createAction, type Logger } from '@silkweave/core'
import { z } from 'zod/v4'
import { loginAs, whoami } from '../accounts.ts'
import { PublishError, type StatusEvent } from '../engine.ts'
import { assertNpmVersion } from '../versions.ts'

const input = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._~-]*$/i)
    .describe('The npm account to switch to (as shown by npm-status).'),
  registry: z.string().url()
    .describe('Registry to log in against. Defaults to the npm config registry.')
    .optional(),
})

const output = z.object({
  user: z.string().describe('The account the npm CLI is now logged in as (confirmed via `npm whoami`).'),
  previousUser: z.string().nullable().describe('Who the CLI was before the switch (null = was logged out).'),
  alreadyCurrent: z.boolean().describe('True when the CLI was already that account and no ceremony was needed.'),
  usedStoredToken: z.boolean().describe('True when a stored token made the switch instant - no user interaction happened.'),
})

export const NpmSwitchAccountAction = createAction({
  name: 'npm-switch-account',
  description: [
    'Switch the npm CLI to a different npm account (verified via `npm',
    'whoami` afterwards). Instant and interaction-free when keybridge has a',
    'stored token for that account that still works; otherwise the account\'s',
    'own browser profile runs the login - a live web session needs only a',
    'Touch ID tap, a first-time account opens the keybridge window for its',
    'password once. Blocks until done. Call npm-status first to see the',
    'known accounts; no-op when the CLI is already the requested account.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { openWorldHint: true },
  run: async ({ username, registry }, context) => {
    await assertNpmVersion()
    const previousUser = await whoami()
    if (previousUser === username) {
      return { user: username, previousUser, alreadyCurrent: true, usedStoredToken: false }
    }

    const logger = context.getOptional<Logger>('logger')
    let progress = 0
    const result = await loginAs(username, {
      registry,
      pollTimeoutMs: 300_000,
      onStatus: ({ phase, authUrl }: StatusEvent) => {
        logger?.progress({ progress: ++progress, message: phase === 'awaiting-human' ? `Waiting for the user to approve the login at ${authUrl}` : phase })
      },
    }).catch((e: unknown) => {
      // The tool result only carries the message - fold npm's stderr in.
      if (e instanceof PublishError) e.message = e.fullMessage()
      throw e
    })
    return { user: result.user, previousUser, alreadyCurrent: false, usedStoredToken: result.usedStoredToken }
  },
})
