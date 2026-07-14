#!/usr/bin/env node
// keybridge MCP server - the agent-facing entry point, on silkweave/stdio.
// Tools: NpmPublish, NpmLogin. The server does all the browser driving
// internally (Tier A off-screen Chrome); the model never sees a DOM and the
// human's only involvement is the Touch ID tap.
import { silkweave } from '@silkweave/core'
import { stdio } from '@silkweave/mcp'
import { NpmLoginAction } from './actions/npm-login.ts'
import { NpmPublishAction } from './actions/npm-publish.ts'

await silkweave({
  name: 'keybridge',
  description: 'Safe WebAuthn bridge for npm publishing: the agent initiates, the human approves via Touch ID.',
  version: '0.2.0',
})
  .adapter(stdio())
  .action(NpmPublishAction)
  .action(NpmLoginAction)
  .start()
