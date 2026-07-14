#!/usr/bin/env node
// PreToolUse guard: deny raw `npm publish` (and pnpm/yarn variants) in Bash
// so publishes go through the gated keybridge MCP tool instead. The MCP tool
// requires explicit user interaction per call; this hook closes the
// side-channel of Claude just running the command directly.

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)

let input = {}
try {
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
} catch {
  process.exit(0) // malformed input: stay out of the way
}

const command = input.tool_input?.command ?? ''

// Match `npm publish` / `pnpm publish` / `yarn publish` / `npm stage publish`
// anywhere in the command line (including after && ; |), tolerating
// intervening flags, but not words like "publisher" or file paths.
const PUBLISH_RE = /(?:^|[\s;&|(])(?:npm|pnpm|yarn)\s+(?:[\w:-]+\s+)*publish(?:\s|$|;|&|\|)/

if (PUBLISH_RE.test(command)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Raw `npm publish` is gated in this project. Use the keybridge MCP tool ' +
        '`NpmPublish` instead - it walks the user through WebAuthn verification ' +
        '(security key / Touch ID) and requires their explicit approval.',
    },
  }))
}

process.exit(0)
