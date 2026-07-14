// Bits shared by the invisible-browser presenters (chrome.ts, webkit.ts).

// In-page script polled by the presenter. Finds npm's "Use security key"
// button and clicks it (which fires navigator.credentials.get() → keybridge).
// Also reports when the page bounced to a password login (expired wub cookie)
// so the presenter can surface the window for the human.
export const STATUS_SCRIPT = `(() => {
  try {
    if (document.readyState === 'loading') return 'pending'
    const clickable = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
    const key = clickable.find((el) => /use security key|security key/i.test(el.textContent || el.value || ''))
    if (key) { key.click(); return 'clicked' }
    if (document.querySelector('input[type="password"]')) return 'login-page'
    return 'not-found'
  } catch (e) { return 'pending' }
})()`

export function waitForAbort (signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((r) => signal.addEventListener('abort', () => r(), { once: true }))
}
