// keybridge MCP server — the agent-facing entry point.
//
// Exposes a single `npm_publish` tool. Hardening decisions:
//  - No free-form argument pass-through: the model provides typed fields
//    (tag, access, dryRun); flags like --otp or --registry cannot be injected.
//  - `cwd` must resolve inside the directory the server was started in
//    (the project root when configured via .mcp.json).
//  - The tool declares _meta["anthropic/requiresUserInteraction"], so Claude
//    Code shows an approval card on every call, even when allowlisted
//    (honored on Claude Code >= 2.1.199).
//  - The WebAuthn touch itself is the non-bypassable second gate.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolve, sep } from 'node:path'
import { publishWithWebAuth, PublishError } from './engine.js'
import { browserPresenter, notifyHuman } from './presenters.js'

const PROJECT_ROOT = process.cwd()

const TOOL = {
  name: 'npm_publish',
  description: [
    'Publish the npm package in the current project to the npm registry.',
    'npm requires human WebAuthn verification: the user will be prompted to',
    'touch their security key or Touch ID before the publish completes.',
    'If the npm login session is missing or expired, a web-login ceremony',
    'runs first automatically (the user touches twice in total).',
    'Blocks until the user approves (or a timeout). Use dryRun to validate',
    'the package without publishing.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Package directory, relative to the project root. Defaults to the project root.',
      },
      tag: {
        type: 'string',
        description: 'Dist-tag to publish under (npm publish --tag). Defaults to "latest".',
        pattern: '^[a-zA-Z0-9._-]+$',
      },
      access: {
        type: 'string',
        enum: ['public', 'restricted'],
        description: 'Package access level (npm publish --access).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Run npm publish --dry-run (no auth ceremony, nothing published).',
      },
    },
    additionalProperties: false,
  },
  _meta: { 'anthropic/requiresUserInteraction': true },
}

const server = new Server(
  { name: 'keybridge', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL.name) {
    return { content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }], isError: true }
  }
  const args = request.params.arguments ?? {}
  const progressToken = request.params._meta?.progressToken

  const cwd = resolve(PROJECT_ROOT, args.cwd ?? '.')
  if (cwd !== PROJECT_ROOT && !cwd.startsWith(PROJECT_ROOT + sep)) {
    return { content: [{ type: 'text', text: `cwd escapes the project root: ${cwd}` }], isError: true }
  }

  const npmArgs = []
  if (args.tag) npmArgs.push('--tag', args.tag)
  if (args.access) npmArgs.push('--access', args.access)
  if (args.dryRun) npmArgs.push('--dry-run')

  const presenter = browserPresenter()

  let progress = 0
  const sendProgress = (message) => {
    if (progressToken === undefined) return
    server.notification({
      method: 'notifications/progress',
      params: { progressToken, progress: ++progress, message },
    }).catch(() => {})
  }

  try {
    const outcome = await publishWithWebAuth({
      npmArgs,
      cwd,
      presenter,
      pollTimeoutMs: 300_000,
      onStatus: ({ phase, authUrl }) => {
        if (phase === 'awaiting-human') {
          notifyHuman('npm publish is waiting for your security key / Touch ID approval')
          sendProgress(`Waiting for the user to complete WebAuthn verification at ${authUrl}`)
        } else {
          sendProgress(phase)
        }
      },
    })
    const summary = {
      published: !args.dryRun,
      dryRun: Boolean(args.dryRun),
      usedWebAuth: outcome.usedWebAuth,
      package: outcome.result?.id ?? outcome.result?.name ?? null,
    }
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
  } catch (e) {
    if (e instanceof PublishError) {
      const detail = e.json?.error?.detail ?? e.stderr?.slice(0, 2000) ?? ''
      return {
        content: [{ type: 'text', text: `npm publish failed [${e.code}]: ${e.message}\n${detail}`.trim() }],
        isError: true,
      }
    }
    throw e
  }
})

export async function main () {
  await server.connect(new StdioServerTransport())
}
