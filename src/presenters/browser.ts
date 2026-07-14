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

// Best-effort desktop notification so the user knows a touch is awaited.
export function notifyHuman (message: string, { title = 'keybridge' }: { title?: string } = {}): void {
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`
      spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref()
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, message], { stdio: 'ignore', detached: true }).unref()
    }
  } catch {}
}
