// The agent-facing `NpmPublish` MCP tool, as a silkweave action.
//
// Hardening decisions (carried over from the v1 server):
//  - No free-form argument pass-through: the model provides typed fields
//    (tag, access, dryRun); flags like --otp or --registry cannot be injected.
//  - `cwd` must resolve inside the directory the server was started in
//    (the project root when configured via .mcp.json).
//  - The WebAuthn touch itself is the non-bypassable second gate. (The v1
//    server also set _meta["anthropic/requiresUserInteraction"]; silkweave's
//    registrar doesn't forward custom tool _meta, so that hint is currently
//    dropped — an acceptable loss since the touch still gates the publish.)
import { createAction, type Logger, type SilkweaveContext } from '@silkweave/core'
import { resolve, sep } from 'node:path'
import { z } from 'zod/v4'
import { publishWithWebAuth, PublishError, type StatusEvent } from '../engine.ts'
import { notifyHuman } from '../presenters/browser.ts'
import { selectPresenter } from '../presenters/select.ts'

const PROJECT_ROOT = process.cwd()

const input = z.object({
  cwd: z.string()
    .describe('Package directory, relative to the project root. Defaults to the project root.')
    .optional(),
  tag: z.string().regex(/^[a-zA-Z0-9._-]+$/)
    .describe('Dist-tag to publish under (npm publish --tag). Defaults to "latest".')
    .optional(),
  access: z.enum(['public', 'restricted'])
    .describe('Package access level (npm publish --access).')
    .optional(),
  dryRun: z.boolean()
    .describe('Run npm publish --dry-run (no auth ceremony, nothing published).')
    .optional(),
})

const output = z.object({
  published: z.boolean().describe('Whether the package was actually published.'),
  dryRun: z.boolean().describe('Whether this was a --dry-run validation.'),
  usedWebAuth: z.boolean().describe('Whether a human WebAuthn ceremony was required.'),
  package: z.string().nullable().describe('The published package id (name@version).'),
})

function progressReporter (context: SilkweaveContext): (message: string) => void {
  const logger = context.getOptional<Logger>('logger')
  let progress = 0
  return (message) => logger?.progress({ progress: ++progress, message })
}

export const NpmPublishAction = createAction({
  name: 'npm-publish',
  description: [
    'Publish the npm package in the current project to the npm registry.',
    'npm requires human WebAuthn verification: the user will be prompted to',
    'touch their security key or Touch ID before the publish completes',
    '(driven through an invisible off-screen browser — only Touch ID is shown).',
    'If the npm login session is missing or expired, a web-login ceremony',
    'runs first automatically (the user touches twice in total).',
    'Blocks until the user approves (or a timeout). Use dryRun to validate',
    'the package without publishing.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { destructiveHint: false, openWorldHint: true },
  run: async ({ cwd: cwdInput, tag, access, dryRun }, context) => {
    const cwd = resolve(PROJECT_ROOT, cwdInput ?? '.')
    if (cwd !== PROJECT_ROOT && !cwd.startsWith(PROJECT_ROOT + sep)) {
      throw new PublishError(`cwd escapes the project root: ${cwd}`, { code: 'ECWD' })
    }

    const npmArgs: string[] = []
    if (tag) npmArgs.push('--tag', tag)
    if (access) npmArgs.push('--access', access)
    if (dryRun) npmArgs.push('--dry-run')

    const { presenter } = selectPresenter()
    const sendProgress = progressReporter(context)

    const outcome = await publishWithWebAuth({
      npmArgs,
      cwd,
      presenter,
      pollTimeoutMs: 300_000,
      onStatus: ({ phase, authUrl }: StatusEvent) => {
        if (phase === 'awaiting-human') {
          notifyHuman('npm publish is waiting for your security key / Touch ID approval')
          sendProgress(`Waiting for the user to complete WebAuthn verification at ${authUrl}`)
        } else {
          sendProgress(phase)
        }
      },
    })

    return {
      published: !dryRun,
      dryRun: Boolean(dryRun),
      usedWebAuth: outcome.usedWebAuth,
      package: outcome.result?.id ?? outcome.result?.name ?? null,
    }
  },
})
