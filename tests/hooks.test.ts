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
