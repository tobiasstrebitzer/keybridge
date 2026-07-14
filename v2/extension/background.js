// Service worker: bridge extension messages to the native keybridge host.
// Only the background context may call nativeMessaging.
const NATIVE_HOST = 'bi.atomic.keybridge.webauthn'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.source !== 'keybridge') return
  chrome.runtime.sendNativeMessage(
    NATIVE_HOST,
    { op: msg.op, options: msg.options, origin: msg.origin },
    (resp) => {
      const error = chrome.runtime.lastError
      if (error) sendResponse({ ok: false, error: `native host: ${error.message}` })
      else sendResponse(resp)
    }
  )
  return true // async sendResponse
})
