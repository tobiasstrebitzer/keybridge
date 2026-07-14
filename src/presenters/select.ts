// Presenter selection: Tier A (off-screen Chrome) is the default on macOS —
// only Touch ID is visible. Everywhere else (or with KEYBRIDGE_PRESENTER=
// browser) fall back to opening the default browser.
import { existsSync } from 'node:fs'
import type { Presenter } from '../engine.ts'
import { browserPresenter } from './browser.ts'
import { chromePresenter, resolveOptions, type ChromePresenterOptions } from './chrome.ts'

export type PresenterName = 'chrome' | 'browser'

export function defaultPresenterName (): PresenterName {
  const forced = process.env.KEYBRIDGE_PRESENTER
  if (forced === 'chrome' || forced === 'browser') return forced
  if (process.platform === 'darwin' && existsSync(resolveOptions().chromePath)) return 'chrome'
  return 'browser'
}

export function selectPresenter (
  name: PresenterName = defaultPresenterName(),
  chromeOpts: ChromePresenterOptions = {},
): { name: PresenterName, presenter: Presenter } {
  return name === 'chrome'
    ? { name, presenter: chromePresenter(chromeOpts) }
    : { name, presenter: browserPresenter() }
}
