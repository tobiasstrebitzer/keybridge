// `NpmLogin` MCP tool: run just the web-login ceremony and persist the
// ~12h session token to the user npmrc. Useful to pre-authenticate before a
// batch of publishes (each publish still needs its own touch).
import { createAction, type Logger } from '@silkweave/core'
import { z } from 'zod/v4'
import { loginWithWebAuth, PublishError, type StatusEvent } from '../engine.ts'
import { notifyHuman } from '../presenters/browser.ts'
import { selectPresenter } from '../presenters/select.ts'

const input = z.object({
  registry: z.string().url()
    .describe('Registry to log in against. Defaults to the npm config registry (normally https://registry.npmjs.org).')
    .optional(),
})

const output = z.object({
  registry: z.string().describe('The registry the session token was issued for.'),
  npmrc: z.string().describe('The npmrc file the session token was written to.'),
})

export const NpmLoginAction = createAction({
  name: 'npm-login',
  description: [
    'Log in to the npm registry via the web-auth ceremony. The user approves',
    'with their security key or Touch ID (driven through an invisible',
    'off-screen browser); the ~12h session token is persisted to their npmrc.',
    'Publishing does this automatically when needed - call this only to',
    'pre-authenticate explicitly.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { openWorldHint: true },
  run: async ({ registry }, context) => {
    const { presenter } = selectPresenter()
    const logger = context.getOptional<Logger>('logger')
    let progress = 0
    const result = await loginWithWebAuth({
      registry,
      presenter,
      pollTimeoutMs: 300_000,
      onStatus: ({ phase, authUrl }: StatusEvent) => {
        if (phase === 'awaiting-human') {
          notifyHuman('npm login is waiting for your security key / Touch ID approval')
        }
        logger?.progress({ progress: ++progress, message: phase === 'awaiting-human' ? `Waiting for WebAuthn verification at ${authUrl}` : phase })
      },
    }).catch((e: unknown) => {
      // The tool result only carries the message - fold npm's stderr in.
      if (e instanceof PublishError) e.message = e.fullMessage()
      throw e
    })
    return { registry: result.registry, npmrc: result.npmrc }
  },
})
