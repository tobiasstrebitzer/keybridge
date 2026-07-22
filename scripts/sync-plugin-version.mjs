#!/usr/bin/env node
// Keeps .claude-plugin/plugin.json's version in lockstep with package.json.
//
// Why this matters: Claude Code caches an installed plugin under
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ and only re-clones
// when the version changes. If the npm package ships a new version but the
// plugin manifest still says the old one, every consumer keeps running the
// stale checkout (old skills, old bootstrap, old `npm install` of keybridge).
//
// Run with --check to assert parity (wired into `pnpm check`); run bare to fix.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginPath = join(root, '.claude-plugin', 'plugin.json')

const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const raw = readFileSync(pluginPath, 'utf8')
const current = JSON.parse(raw).version

if (current === pkgVersion) process.exit(0)

if (process.argv.includes('--check')) {
  console.error(
    `plugin version drift: .claude-plugin/plugin.json is ${current}, package.json is ${pkgVersion}.\n` +
      `Consumers would keep the stale plugin cache. Run \`pnpm sync:plugin\` and commit the result.`,
  )
  process.exit(1)
}

// Patch the one line rather than re-serializing, so hand-formatted arrays survive.
writeFileSync(pluginPath, raw.replace(/("version":\s*)"[^"]+"/, `$1"${pkgVersion}"`))
console.log(`plugin.json: ${current} -> ${pkgVersion}`)
