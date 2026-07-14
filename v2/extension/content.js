// ISOLATED-world content script: relays WebAuthn requests from the page
// (inject.js, MAIN world) to the background service worker, which owns the
// nativeMessaging permission. Both worlds share the same DOM window, so
// window.postMessage bridges them.
window.addEventListener('message', (e) => {
  if (e.source !== window) return
  const d = e.data
  if (!d || d.source !== 'keybridge-inject') return

  chrome.runtime.sendMessage(
    { source: 'keybridge', op: d.op, options: d.options, origin: d.origin },
    (resp) => {
      const error = chrome.runtime.lastError
      window.postMessage({
        source: 'keybridge-content',
        id: d.id,
        resp: error ? { ok: false, error: error.message } : resp,
      }, window.location.origin)
    }
  )
})
