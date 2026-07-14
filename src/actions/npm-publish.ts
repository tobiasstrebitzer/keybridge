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
//    dropped - an acceptable loss since the touch still gates the publish.)
import { createAction, type Logger, type SilkweaveContext } from '@silkweave/core'
import { resolve, sep } from 'node:path'
import { z } from 'zod/v4'
import { assertSecurityKeyFor, bindAccount, bindAfterLogin, resolveMediation, resolvePublishIdentity, whoami, type Mediation } from '../accounts.ts'
import { publishWithWebAuth, resolveRegistry, PublishError, type StatusEvent } from '../engine.ts'
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
  user: z.string().regex(/^[a-z0-9][a-z0-9._~-]*$/i)
    .describe('npm account this publish must run as. If the CLI is logged in as someone else but keybridge has a working stored token for this account, the publish is mediated with that token (the CLI session is untouched); otherwise it fails fast with nothing published - call npm-status / npm-switch-account. Recommended whenever the account matters.')
    .optional(),
})

const output = z.object({
  published: z.boolean().describe('Whether the package was actually published.'),
  dryRun: z.boolean().describe('Whether this was a --dry-run validation.'),
  usedWebAuth: z.boolean().describe('Whether a human WebAuthn ceremony was required.'),
  package: z.string().nullable().describe('The published package id (name@version).'),
  user: z.string().nullable().describe('The npm account the publish ran as (`npm whoami`).'),
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
    '(driven through an invisible off-screen browser - only Touch ID is shown).',
    'If the npm login session is missing or expired, a web-login ceremony',
    'runs first automatically (the user touches twice in total).',
    'Blocks until the user approves (or a timeout). Use dryRun to validate',
    'the package without publishing. When the account matters, pass `user`',
    '(the expected npm username) - the publish fails fast instead of going',
    'out under the wrong account.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { destructiveHint: false, openWorldHint: true },
  run: async ({ cwd: cwdInput, tag, access, dryRun, user: expectedUser }, context) => {
    const cwd = resolve(PROJECT_ROOT, cwdInput ?? '.')
    if (cwd !== PROJECT_ROOT && !cwd.startsWith(PROJECT_ROOT + sep)) {
      throw new PublishError(`cwd escapes the project root: ${cwd}`, { code: 'ECWD' })
    }

    const npmArgs: string[] = []
    if (tag) npmArgs.push('--tag', tag)
    if (access) npmArgs.push('--access', access)
    if (dryRun) npmArgs.push('--dry-run')

    // Identity preflight: `npm whoami` decides who this publish runs as; the
    // ceremony shell uses that account's own browser profile. When the CLI is
    // someone else but a stored token for `user` still works, the publish is
    // MEDIATED: that token rides along as an env override and the CLI
    // session/npmrc stays untouched.
    const identity = await resolvePublishIdentity({ cwd, npmArgs })
    let publishUser = identity.user
    let storeId = identity.storeId
    let mediation: Mediation | null = null
    if (expectedUser && identity.user !== expectedUser) {
      mediation = await resolveMediation(expectedUser, { cwd, npmArgs })
      if (mediation) {
        publishUser = expectedUser
        storeId = mediation.storeId
      } else if (identity.user) {
        throw new PublishError(
          `npm is logged in as "${identity.user}" and no working token is stored for "${expectedUser}" - nothing was published. Call npm-switch-account first.`,
          { code: 'EACCOUNT' })
      } else {
        throw new PublishError(
          `npm is logged out and no working token is stored for "${expectedUser}" - nothing was published. Call npm-switch-account first.`,
          { code: 'EACCOUNT' })
      }
    }
    const prefillUsername = publishUser ?? identity.active
    const { name: presenterName, presenter } = selectPresenter(undefined, {
      webkit: { storeId, ...(prefillUsername ? { prefillUsername } : {}) },
    })
    if (publishUser && presenterName === 'webkit' && !dryRun) {
      const registry = mediation?.registry
        ?? await resolveRegistry({ cwd, npmArgs }).catch(() => 'https://registry.npmjs.org/')
      assertSecurityKeyFor(publishUser, registry)
    }

    const sendProgress = progressReporter(context)

    const outcome = await publishWithWebAuth({
      npmArgs,
      cwd,
      presenter,
      pollTimeoutMs: 300_000,
      // Mediated publishes must never auto-login: that would mint a token
      // for the WRONG account into npmrc. An expired token fails fast.
      ...(mediation ? { env: mediation.env, autoLogin: false } : {}),
      afterLogin: async (login) => { await bindAfterLogin(storeId, { cwd, npmArgs }, login) },
      onStatus: ({ phase, authUrl }: StatusEvent) => {
        if (phase === 'awaiting-human') {
          sendProgress(`Waiting for the user to complete WebAuthn verification at ${authUrl}`)
        } else {
          sendProgress(phase)
        }
      },
    }).catch((e: unknown) => {
      // The tool result only carries the message - fold npm's stderr in so
      // failures are diagnosable without hunting for server logs.
      if (e instanceof PublishError) e.message = e.fullMessage()
      throw e
    })

    // A mediated ceremony proved the profile belongs to that account - keep
    // the binding (without stealing the active pointer).
    if (mediation && outcome.usedWebAuth) bindAccount(mediation.user, storeId, { activate: false })

    // npm can exit 0 without a publish result; mirror the CLI and never claim
    // a publish that has no package id to show for it.
    const pkg = outcome.result?.id ?? outcome.result?.name ?? null
    return {
      published: !dryRun && pkg !== null,
      dryRun: Boolean(dryRun),
      usedWebAuth: outcome.usedWebAuth,
      package: pkg,
      // When the publish auto-logged-in, the identity was unknown up front -
      // report who it actually ran as.
      user: publishUser ?? await whoami({ cwd, npmArgs }),
    }
  },
})
