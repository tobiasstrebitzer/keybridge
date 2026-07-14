// In-page scripts used by the webkit presenter (webkit.ts).

// In-page script polled by the presenter. Finds npm's "Use security key"
// button and clicks it (which fires navigator.credentials.get() → keybridge).
// Also reports when the page bounced to a password login (expired wub cookie)
// so the presenter can surface the window for the human.
//
// Idempotence lives IN THE PAGE (window flag): exactly one click per page, and
// the flag dies with the page on navigation - so chained flows where every
// page needs its own click (live session: /login -> /escalate/webauthn) just
// work, with no event-ordering races in the presenter.
export const STATUS_SCRIPT = `(() => {
  try {
    if (document.readyState === 'loading') return 'pending'
    const clickable = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
    const key = clickable.find((el) => /use security key|security key/i.test(el.textContent || el.value || ''))
    if (key) {
      if (!window.__keybridgeClicked) { window.__keybridgeClicked = true; key.click() }
      return 'clicked'
    }
    if (document.querySelector('input[type="password"]')) return 'login-page'
    return 'not-found'
  } catch (e) { return 'pending' }
})()`

// Prefill npm's login form: username filled in (the flow knows who it is
// logging in as), focus handed to the password field. React-rendered form,
// so the value must go through the native setter + an `input` event or the
// page's state never sees it. Skips a username the human already typed.
// Same page-side idempotence as STATUS_SCRIPT: runs once per page, never
// fights the human's typing or focus on later poll ticks.
export const prefillScript = (username: string): string => `(() => {
  try {
    if (window.__keybridgePrefilled) return 'prefilled'
    const u = document.querySelector('input[name="username"], input#login_username')
    const p = document.querySelector('input[name="password"], input#login_password')
    if (!u || !p) return 'no-form'
    window.__keybridgePrefilled = true
    if (!u.value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(u, ${JSON.stringify(username)})
      u.dispatchEvent(new Event('input', { bubbles: true }))
      u.dispatchEvent(new Event('change', { bubbles: true }))
    }
    p.focus()
    return 'prefilled'
  } catch (e) { return 'pending' }
})()`
