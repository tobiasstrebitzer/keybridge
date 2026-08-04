// The agent-facing `NpmTrust` MCP tool: configure npm trusted publishers
// (GitHub Actions OIDC) for one or many packages.
//
// Same hardening as npm-publish: typed fields only (no free-form npm args),
// and the human's WebAuthn touch is the non-bypassable gate - every trust
// write is 2FA-gated by the registry. Unlike publish there is no `cwd`: this
// tool touches no files at all, it only talks to the registry, so the package
// names are the whole input surface.
//
// Why bulk: npm's 5-minute 2FA amnesty (ticked automatically on the ceremony
// page) means one - occasionally two - touches cover a whole repo's worth of
// packages. One call per package would cost one ceremony per package.
import { createAction, type Logger, type SilkweaveContext } from '@silkweave/core'
import { z } from 'zod/v4'
import { assertSecurityKeyFor, resolveMediation, resolvePublishIdentity, whoami, type Mediation } from '../accounts.ts'
import { resolveRegistry, PublishError, type StatusEvent } from '../engine.ts'
import { currentLogFile, kblog } from '../log.ts'
import { defaultPresenterName, selectPresenter } from '../presenters/select.ts'
import { trustPackages } from '../trust.ts'
import { assertNpmVersion } from '../versions.ts'

const input = z.object({
  packages: z.array(z.string().min(1)).min(1)
    .describe('Package names to configure, e.g. ["acme", "@acme/client"]. Bulk is the point: npm\'s 5-minute 2FA amnesty means one (sometimes two) human touches cover the whole set, whereas one call per package costs one touch each.'),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/)
    .describe('GitHub "owner/repo" whose workflow may publish. Must match the publishing repo exactly or OIDC rejects the token at publish time.'),
  workflow: z.string().regex(/^[^/]+\.ya?ml$/)
    .describe('Workflow FILENAME only, e.g. "publish.yml" - not a path, not ".github/workflows/publish.yml".'),
  environment: z.string()
    .describe('GitHub Actions environment name. Omit unless the workflow job declares `environment:`; a mismatch makes OIDC fail at publish time.')
    .optional(),
  permissions: z.array(z.enum(['publish', 'stage-publish']))
    .describe('What the workflow may do. At least one is required (the registry rejects a config without permissions). Defaults to ["publish"].')
    .optional(),
  registry: z.string().url()
    .describe('Registry to configure against. Defaults to the npm config registry (normally https://registry.npmjs.org). Trusted publishing is an npmjs.com feature.')
    .optional(),
  dryRun: z.boolean()
    .describe('Validate the inputs and report the exact request bodies without sending anything (no ceremony, nothing changed).')
    .optional(),
  user: z.string().regex(/^[a-z0-9][a-z0-9._~-]*$/i)
    .describe('npm account this must run as. If the CLI is logged in as someone else but keybridge holds a working token for this account, the run is mediated with that token (the CLI session is untouched); otherwise it fails fast with nothing changed - call npm-status / npm-switch-account.')
    .optional(),
})

const output = z.object({
  configured: z.array(z.object({
    package: z.string(),
    id: z.string().describe('The trust config id the registry assigned (use it with `npm trust revoke --id`).'),
  })).describe('Packages that now have this trusted publisher.'),
  failed: z.array(z.object({
    package: z.string(),
    reason: z.string().describe('The registry\'s own message, verbatim.'),
  })).describe('Packages the registry rejected. Nothing was configured for these.'),
  skipped: z.array(z.object({
    package: z.string(),
    reason: z.string(),
  })).describe('Packages not attempted or not found - most often "not published yet" (a package must exist on the registry before a trusted publisher can be configured for it).'),
  usedWebAuth: z.boolean().describe('Whether a human WebAuthn ceremony was required.'),
  ceremonies: z.number().describe('How many human touches it actually took (1-2 typical for a set, thanks to npm\'s 5-minute amnesty window).'),
  registry: z.string(),
  user: z.string().nullable().describe('The npm account the configuration ran as.'),
})

function progressReporter (context: SilkweaveContext): (message: string) => void {
  const logger = context.getOptional<Logger>('logger')
  let progress = 0
  return (message) => logger?.progress({ progress: ++progress, message })
}

export const NpmTrustAction = createAction({
  name: 'npm-trust',
  description: [
    'Configure npm trusted publishing (GitHub Actions OIDC) for one or more',
    'packages, so future releases can be published by CI without a token.',
    'Every trust write is 2FA-gated by npm: the user is prompted to approve',
    'with their security key / Touch ID, exactly like a publish. Pass ALL the',
    'packages in one call - npm grants a 5-minute amnesty after the first',
    'approval, so a whole repo usually costs one or two touches instead of one',
    'per package. The package must already exist on the registry: configure',
    'trusted publishing AFTER a package\'s first publish, never before.',
    'Configs are appended, not replaced - re-running adds a second config',
    'rather than updating the first. Use dryRun to check the request first.',
  ].join(' '),
  input,
  output,
  disposition: 'structured',
  annotations: { destructiveHint: false, openWorldHint: true },
  run: async ({ packages, repository, workflow, environment, permissions, registry: registryInput, dryRun, user: expectedUser }, context) => {
    await assertNpmVersion()
    kblog('tool', {
      tool: 'npm-trust', packages, repository, workflow,
      environment: environment ?? null, permissions: permissions ?? ['publish'],
      dryRun: Boolean(dryRun), user: expectedUser ?? null,
    })

    const sendProgress = progressReporter(context)

    // Identity preflight, same contract as npm-publish: `npm whoami` decides
    // who this runs as, and a stored token can MEDIATE for another account
    // without touching the CLI session.
    const identity = await resolvePublishIdentity({})
    let trustUser = identity.user
    let storeId = identity.storeId
    let mediation: Mediation | null = null
    if (expectedUser && identity.user !== expectedUser) {
      mediation = await resolveMediation(expectedUser, {})
      if (mediation) {
        trustUser = expectedUser
        storeId = mediation.storeId
      } else {
        throw new PublishError(
          `npm is ${identity.user ? `logged in as "${identity.user}"` : 'logged out'} and no working token is stored for "${expectedUser}" - nothing was configured. Call npm-switch-account first.`,
          { code: 'EACCOUNT' })
      }
    }

    const registry = registryInput
      ?? mediation?.registry
      ?? await resolveRegistry({}).catch(() => 'https://registry.npmjs.org/')

    const presenterName = defaultPresenterName()
    if (trustUser && presenterName === 'webkit' && !dryRun) {
      assertSecurityKeyFor(trustUser, registry)
    }

    try {
      const outcome = await trustPackages({
        packages, repository, workflow, registry,
        ...(environment ? { environment } : {}),
        ...(permissions ? { permissions } : {}),
        ...(dryRun ? { dryRun: true } : {}),
        ...(mediation ? { env: mediation.env } : {}),
        pollTimeoutMs: 300_000,
        // One presenter per ceremony so the Touch ID line names the package
        // whose publish rights are being handed to CI.
        presenter: (pkg) => selectPresenter(presenterName, {
          webkit: {
            storeId,
            ...(trustUser ? { prefillUsername: trustUser } : {}),
            ceremonyContext: { pkg, ...(trustUser ? { user: trustUser } : {}) },
          },
        }).presenter,
        onStatus: ({ phase, authUrl, pkg }: StatusEvent) => {
          if (phase === 'awaiting-human') {
            sendProgress(`Waiting for the user to approve trusted publishing for ${pkg} at ${authUrl}`)
          } else {
            sendProgress(pkg ? `${phase} ${pkg}` : phase)
          }
        },
      })

      return {
        ...outcome,
        user: trustUser ?? await whoami({}),
      }
    } catch (e) {
      kblog('tool-error', { tool: 'npm-trust', code: (e as PublishError).code, error: (e as Error).message })
      if (e instanceof PublishError) {
        e.message = `${e.fullMessage()}\n(ceremony diagnostics: ${currentLogFile()})`
      }
      throw e
    }
  },
})
