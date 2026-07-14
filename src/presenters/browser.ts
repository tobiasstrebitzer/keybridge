// Fallback presenter: open the system default browser. Works everywhere; the
// tab stays open after auth (npm's page shows its own success state). The
// primary presenter is the invisible off-screen Chrome in ./chrome.ts.

import { spawn } from 'node:child_process'
import type { Presenter } from '../engine.ts'

export function browserPresenter (): Presenter {
  return ({ authUrl }) => new Promise<void>((resolve, reject) => {
    const [cmd, args]: [string, string[]] = process.platform === 'darwin'
      ? ['open', [authUrl]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', authUrl]]
        : ['xdg-open', [authUrl]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`failed to open browser (${cmd} exited ${code})`))
    })
    child.unref()
  })
}

