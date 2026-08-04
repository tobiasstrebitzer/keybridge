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

// Blank out payloads that are DATA rather than commands the shell will run,
// before matching. Text that merely TALKS about publishing must not trip the
// guard - this has bitten twice: a release commit message
// (`git commit -m "docs: ... scope the 2FA publish requirement"`) and a smoke
// -test script whose source contained the literal string. Anything that is
// actually executed (quoted strings elsewhere, `bash -c "npm publish"`,
// shell-fed heredocs) still matches.
const MESSAGE_PAYLOAD_RE = /(\s(?:-[a-zA-Z]*m|--message)(?:=|\s+)?)(["'])(?:\\.|(?!\2).)*\2/g

// Heredoc BODIES are data being written, not commands the outer shell runs -
// a script or doc that merely contains the words must not trip the guard.
// Exception: when the heredoc feeds a shell (`bash <<EOF`), the body IS
// executed, so leave those alone.
const HEREDOC_RE = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)^\t*\2$/gm
const SHELL_FED_HEREDOC_RE = /(?:^|[\s;&|])(?:ba|z|k|da)?sh\s+[^\n]*<<-?\s*["']?[A-Za-z_]/

// Inline scripts of NON-shell interpreters are likewise data to that
// interpreter, not shell commands. `bash -c` / `sh -c` are deliberately NOT
// in this list: those really do execute, and `bash -c "npm publish"` must
// stay caught.
const INLINE_SCRIPT_RE =
  /(?:^|[\s;&|])(?:node|deno|bun|python3?|ruby|perl|osascript)\s+(?:[^\s'"]+\s+)*?(-e|--eval|-p|--print|-c)(?:=|\s+)(["'])(?:\\.|(?!\2).)*\2/g

// Blank out the payload of every match while keeping the surrounding command
// intact, so `node -e "...npm publish..." && npm publish` still trips on the
// REAL publish at the end.
const blankQuoted = (match) => match.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (q) => q[0] + q[0])

let scrubbed = command.replace(MESSAGE_PAYLOAD_RE, '$1$2$2')
if (!SHELL_FED_HEREDOC_RE.test(scrubbed)) {
  scrubbed = scrubbed.replace(HEREDOC_RE, (m, _q, tag, body) => m.replace(body, ''))
}
scrubbed = scrubbed.replace(INLINE_SCRIPT_RE, blankQuoted)

// Match `npm publish` / `pnpm publish` / `yarn publish` / `npm stage publish`
// anywhere in the command line (including after && ; | and inside quotes,
// e.g. `bash -c "npm publish"`), tolerating intervening flags, but not words
// like "publisher" or file paths. The trailing lookahead keeps `npm run
// publish-docs` out; the capture grabs that invocation's own arguments.
const PUBLISH_RE =
  /(?:^|[\s;&|("'])(?:npm|pnpm|yarn)\s+(?:[\w:-]+\s+)*publish(?=\s|$|;|&|\||["'])([^;&|]*)/g

// `npm publish --help` reads documentation, it does not publish. Checked per
// invocation rather than over the whole line, so `npm publish --help && npm
// publish` is still denied on the second one.
const HELP_RE = /\s--?h(?:elp)?(?=\s|$)/

const invocations = [...scrubbed.matchAll(PUBLISH_RE)]
const wouldPublish = invocations.some(([, args]) => !HELP_RE.test(args ?? ''))

if (wouldPublish) {
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
