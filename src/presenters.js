// Presenters get the human to the WebAuthn ceremony. Each is an async
// function ({ authUrl, signal }) that resolves when the presentation ends;
// the engine aborts `signal` once doneUrl reports completion, at which point
// any UI the presenter spawned should be torn down.

import { spawn } from 'node:child_process'

// Open the system default browser. Works everywhere; the tab stays open after
// auth (npm's page shows its own success state).
//
// NOTE (next step — Tier A): a headless/invisible flow will add an off-screen
// Chrome presenter that drives the keybridge extension via CDP so only the
// Touch ID prompt is visible. See _docs/HEADLESS_UX_RESEARCH.md. A pure
// browserless HTTP client is not viable — Cloudflare fronts www.npmjs.com.
export function browserPresenter () {
  return ({ authUrl }) => new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === 'darwin'
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
export function notifyHuman (message, { title = 'keybridge' } = {}) {
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`
      spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref()
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, message], { stdio: 'ignore', detached: true }).unref()
    }
  } catch {}
}
