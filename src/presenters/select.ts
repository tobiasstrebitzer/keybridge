// Presenter selection: the windowless WKWebView shell is the default on
// macOS — no browser window ever exists, only Touch ID is visible. Everywhere
// else (or with KEYBRIDGE_PRESENTER=browser) fall back to opening the default
// browser, where the ceremony needs whatever authenticator the user has there.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Presenter } from '../engine.ts'
import { browserPresenter } from './browser.ts'
import { resolveWebkitOptions, webkitPresenter, type WebkitPresenterOptions } from './webkit.ts'

export type PresenterName = 'webkit' | 'browser'

// The webkit shell is usable if it's already compiled, or if the Xcode CLT
// toolchain is present to compile it on first use (/usr/bin/swiftc is a stub
// that exists even without the CLT, so probe xcode-select instead).
function webkitAvailable (): boolean {
  if (existsSync(resolveWebkitOptions().shellPath)) return true
  try {
    execFileSync('xcode-select', ['-p'], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

export function defaultPresenterName (): PresenterName {
  const forced = process.env.KEYBRIDGE_PRESENTER
  if (forced === 'webkit' || forced === 'browser') return forced
  if (process.platform === 'darwin' && webkitAvailable()) return 'webkit'
  return 'browser'
}

export function selectPresenter (
  name: PresenterName = defaultPresenterName(),
  opts: { webkit?: WebkitPresenterOptions } = {},
): { name: PresenterName, presenter: Presenter } {
  return name === 'webkit'
    ? { name, presenter: webkitPresenter(opts.webkit) }
    : { name: 'browser', presenter: browserPresenter() }
}
