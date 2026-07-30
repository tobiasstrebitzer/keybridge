// `NpmLogin` MCP tool: run just the web-login ceremony and persist the
// ~12h session token to the user npmrc. Useful to pre-authenticate before a
// batch of publishes (each publish still needs its own touch). Re-logs-in as
// the current (or last active) account; use npm-switch-account to change who.
import { createAction, type Logger } from '@silkweave/core'
import { z } from 'zod/v4'
import { loginAs } from '../accounts.ts'
import { PublishError, type StatusEvent } from '../engine.ts'
import { currentLogFile, kblog } from '../log.ts'

const input = z.object({
  registry: z.string().url()
    .describe('Registry to log in against. Defaults to the npm config registry (normally https://registry.npmjs.org).')
    .optional(),
})

const output = z.object({
  user: z.string().describe('The account the npm CLI is now logged in as (confirmed via `npm whoami`).'),
  registry: z.string().describe('The registry the session token was issued for.'),
  npmrc: z.string().describe('The npmrc file the session token was written to.'),
})

export const NpmLoginAction = createAction({
  name: 'npm-login',
  description: [
    'Log in to the npm registry via the web-auth ceremony. The user approves',
    'with their security key or Touch ID (driven through an invisible',
    'off-screen browser); the ~12h session token is persisted to their npmrc.',
    'Re-authenticates as the current or last active account - to change',
    'accounts use npm-switch-account instead. Publishing does this',
    'automatically when needed - call this only to pre-authenticate explicitly.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { openWorldHint: true },
  run: async ({ registry }, context) => {
    kblog('tool', { tool: 'npm-login', registry: registry ?? null })
    const logger = context.getOptional<Logger>('logger')
    let progress = 0
    const result = await loginAs(undefined, {
      registry,
      pollTimeoutMs: 300_000,
      onStatus: ({ phase, authUrl }: StatusEvent) => {
        logger?.progress({ progress: ++progress, message: phase === 'awaiting-human' ? `Waiting for WebAuthn verification at ${authUrl}` : phase })
      },
    }).catch((e: unknown) => {
      // The tool result only carries the message - fold npm's stderr in and
      // point at the ceremony trace (MCP hosts drop this server's stderr).
      kblog('tool-error', { tool: 'npm-login', code: (e as PublishError).code, error: (e as Error).message })
      if (e instanceof PublishError) {
        e.message = `${e.fullMessage()}\n(ceremony diagnostics: ${currentLogFile()})`
      }
      throw e
    })
    return { user: result.user, registry: result.registry, npmrc: result.npmrc }
  },
})
