#!/usr/bin/env node
// keybridge MCP server - the agent-facing entry point, on silkweave/stdio.
// Tools: NpmStatus (read-only identity report), NpmSwitchAccount, NpmLogin,
// NpmPublish. The server does all the browser driving internally (windowless
// WKWebView); the model never sees a DOM and the human's only involvement is
// the Touch ID tap (plus a one-time password window per account).
//
// Agent flow when the account matters:
//   NpmStatus -> (wrong user? NpmSwitchAccount) -> NpmPublish { user }
import { readFileSync } from 'node:fs'
import { silkweave } from '@silkweave/core'
import { stdio } from '@silkweave/mcp'
import { NpmLoginAction } from './actions/npm-login.ts'
import { NpmPublishAction } from './actions/npm-publish.ts'
import { NpmStatusAction } from './actions/npm-status.ts'
import { NpmSwitchAccountAction } from './actions/npm-switch.ts'

// package.json ships in the tarball and sits one level above both src/ and dist/.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

await silkweave({
  name: 'keybridge',
  description: 'Safe WebAuthn bridge for npm publishing: the agent initiates, the human approves via Touch ID.',
  version,
})
  .adapter(stdio())
  .action(NpmPublishAction)
  .action(NpmLoginAction)
  .action(NpmStatusAction)
  .action(NpmSwitchAccountAction)
  .start()
