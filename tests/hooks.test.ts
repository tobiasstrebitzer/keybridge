import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The PreToolUse hook that denies raw `npm/pnpm/yarn publish` in Bash, forcing
// publishes through the gated keybridge bridge. Exercised as a subprocess the
// way Claude Code invokes it: hook JSON on stdin, decision JSON on stdout.
const guardScript = fileURLToPath(new URL('../hooks/guard-npm-publish.mjs', import.meta.url))

interface GuardResult { code: number | null, stdout: string }

function runGuard (hookInput: unknown): Promise<GuardResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guardScript], { stdio: ['pipe', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end(JSON.stringify(hookInput))
  })
}

test('hook guard denies raw npm/pnpm/yarn publish, allows everything else', async () => {
  const denied = [
    'npm publish',
    'npm publish --access public',
    'cd pkg && npm publish --tag beta',
    'pnpm publish',
    'npm stage publish',
    'yarn publish --new-version 1.0.1',
  ]
  const allowed = [
    'npm install',
    'npm run publish-docs',
    'echo npm-publisher',
    'npx keybridge publish',
    'git push origin main',
  ]
  for (const command of denied) {
    const { code, stdout } = await runGuard({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(code, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', `should deny: ${command}`)
  }
  for (const command of allowed) {
    const { code, stdout } = await runGuard({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(code, 0)
    assert.equal(stdout, '', `should not intervene on: ${command}`)
  }
})

test('the guard is not greedy: text ABOUT publishing is not a publish', async () => {
  // Twice now the guard has blocked work that only mentioned the words: a
  // release commit message, and a smoke-test script whose source contained
  // the literal string. Payloads that are data to something else - commit
  // messages, heredoc bodies, non-shell inline scripts - must pass.
  const allowed = [
    'git commit -m "docs: scope the 2FA publish requirement for npm publish"',
    'node -e "console.log(\'run npm publish to ship\')"',
    'node --eval "const hint = \'npm publish --access public\'"',
    'python3 -c "print(\'npm publish\')"',
    "cat > smoke.mjs <<'EOF'\nconsole.log('npm publish')\nEOF",
    'cat > README.md <<EOF\nRun npm publish to release.\nEOF',
  ]
  for (const command of allowed) {
    const { code, stdout } = await runGuard({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(code, 0)
    assert.equal(stdout, '', `should not intervene on: ${command}`)
  }
})

test('scrubbing does not open a bypass', async () => {
  // The scrubbing above must only blank DATA. Anything the shell actually
  // executes still has to be caught, including a real publish sitting next to
  // an innocent mention of one.
  const denied = [
    'bash -c "npm publish"',                                    // -c on a SHELL executes
    'sh -c "cd pkg && npm publish"',
    'node -e "console.log(\'hi\')" && npm publish',             // real publish after an inline script
    'git commit -m "chore: release" && npm publish',            // real publish after a message
    'bash <<EOF\nnpm publish\nEOF',                             // heredoc FED TO A SHELL runs
  ]
  for (const command of denied) {
    const { code, stdout } = await runGuard({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(code, 0)
    assert.notEqual(stdout, '', `should still deny: ${command}`)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', `should still deny: ${command}`)
  }
})
