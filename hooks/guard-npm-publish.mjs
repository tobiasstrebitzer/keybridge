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

// Blank out quoted payloads of message-ish flags (-m/-am/--message, quoted
// inline or =-joined) before matching: a commit message that merely TALKS
// about "npm ... publish" must not trip the guard (bit ourselves during a
// release: `git commit -m "docs: correct npm version claims and scope the
// 2FA publish requirement"` was denied). Quoted strings elsewhere still
// match, so `bash -c "npm publish"` stays caught.
const MESSAGE_PAYLOAD_RE = /(\s(?:-[a-zA-Z]*m|--message)(?:=|\s+)?)(["'])(?:\\.|(?!\2).)*\2/g
const scrubbed = command.replace(MESSAGE_PAYLOAD_RE, '$1$2$2')

// Match `npm publish` / `pnpm publish` / `yarn publish` / `npm stage publish`
// anywhere in the command line (including after && ; | and inside quotes,
// e.g. `bash -c "npm publish"`), tolerating intervening flags, but not words
// like "publisher" or file paths.
const PUBLISH_RE = /(?:^|[\s;&|("'])(?:npm|pnpm|yarn)\s+(?:[\w:-]+\s+)*publish(?:\s|$|;|&|\||["'])/

if (PUBLISH_RE.test(scrubbed)) {
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
