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
// Before clicking, it also ticks npm's "remember this device / don't ask
// again for 5 minutes" checkbox when the page renders one, so a chain of
// publishes needs only ONE ceremony per 5-minute window (the remembered
// approval lives in the account's persistent WKWebsiteDataStore). Ticking
// happens BEFORE the security-key click in the same tick, and is one-shot
// per page via its own window flag; a tick is reported back to the presenter
// as a '+remember' suffix on the status.
export const STATUS_SCRIPT = `(() => {
  try {
    if (document.readyState === 'loading') return 'pending'
    let remembered = false
    if (!window.__keybridgeRemembered) {
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
      for (const box of boxes) {
        // npm's real markup (captured live 2026-07-22): the <label> is EMPTY,
        // the visible text is a sibling aria-hidden <p>; the reliable hooks
        // are the input's aria-label ("Do not challenge npm publish ... for
        // the next 5 minutes") and its name/id ("didOptForCooldown").
        const text = [
          box.getAttribute('aria-label') || '',
          box.labels ? [...box.labels].map((l) => l.textContent).join(' ') : '',
          box.closest('label') ? box.closest('label').textContent : '',
          box.parentElement ? box.parentElement.textContent : '',
          box.name || '', box.id || '',
        ].join(' ')
        if (/cooldown|remember|don.?t ask|do not challenge|5 ?min/i.test(text)) {
          window.__keybridgeRemembered = true
          remembered = true
          if (!box.checked) box.click()
          break
        }
      }
    }
    const clickable = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
    const key = clickable.find((el) => /use security key|security key/i.test(el.textContent || el.value || ''))
    let status
    if (key) {
      if (!window.__keybridgeClicked) { window.__keybridgeClicked = true; key.click() }
      status = 'clicked'
    } else if (document.querySelector('input[type="password"]')) {
      status = 'login-page'
    } else {
      status = 'not-found'
    }
    return remembered ? status + '+remember' : status
  } catch (e) { return 'pending' }
})()`

// Debug instrumentation (KEYBRIDGE_CAPTURE_DOM): a full snapshot of the
// current page, JSON-stringified so it survives the eval channel. The
// presenter diffs consecutive snapshots and writes the changed ones to disk -
// how we learn the exact DOM of npm's auth pages (e.g. the remember-for-5-
// minutes checkbox) from a real ceremony without a visible browser.
export const CAPTURE_SCRIPT = `(() => {
  try {
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || undefined,
      name: el.name || undefined,
      id: el.id || undefined,
      checked: el.type === 'checkbox' ? el.checked : undefined,
      text: (el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(' ') : el.textContent || el.value || '').trim().slice(0, 200),
    })
    return JSON.stringify({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      controls: [...document.querySelectorAll('button, input, a[href], [role="button"], form')].map(describe),
      html: document.documentElement.outerHTML,
    })
  } catch (e) { return JSON.stringify({ error: String(e) }) }
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
