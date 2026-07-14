// keybridge web shell: a WINDOWLESS WKWebView driven by a parent process
// (src/presenters/webkit.ts) over a JSON-lines stdio protocol. There is no
// browser window at all - no launch animation, nothing in the Dock - until the
// parent explicitly asks for `surface` (password login / cookie seeding).
//
// Probed live 2026-07-14: a windowless WKWebView with a Safari UA loads
// www.npmjs.com (and /login) through Cloudflare with NO challenge on a cold
// profile; page JS and network run fine while `document.visibilityState` is
// "hidden" (page timers are throttled to ~1 Hz, but the parent drives the page
// via `eval`, which is not throttled).
//
// Protocol (one JSON object per line):
//   parent -> shell
//     {"cmd":"navigate","url":"https://..."}
//     {"cmd":"eval","id":1,"js":"..."}            // page-world evaluate
//     {"cmd":"surface"}                            // show a real window
//     {"cmd":"hide"}                               // hide it again
//     {"cmd":"webauthn-result","id":3,"resp":{...}} // answer a webauthn event
//     {"cmd":"close"}
//   shell -> parent
//     {"event":"ready"}
//     {"event":"nav","url":"..."}                  // main-frame didFinish
//     {"event":"nav-error","error":"..."}
//     {"event":"eval-result","id":1,"value":...}   // or {"id":1,"error":"..."}
//     {"event":"webauthn","id":3,"op":"get","options":{...},"origin":"..."}
//
// The injected user script (--inject, required) runs at documentStart in the
// page content world and overrides navigator.credentials; its transport is
// webkit.messageHandlers.keybridge.postMessage (a WithReply handler, so the
// page-side call returns a Promise that resolves with the parent's resp).
//
// Usage:
//   keybridge-webshell --inject /path/to/inject-webkit.js
//                      [--store-id <uuid> | --ephemeral] [--ua <string>]
import AppKit
import WebKit

let cliArgs = CommandLine.arguments
func argValue(_ name: String) -> String? {
  guard let i = cliArgs.firstIndex(of: name), i + 1 < cliArgs.count else { return nil }
  return cliArgs[i + 1]
}

guard let injectPath = argValue("--inject"),
      let injectSource = try? String(contentsOfFile: injectPath, encoding: .utf8) else {
  FileHandle.standardError.write(Data("keybridge-webshell: --inject <path> is required and must be readable\n".utf8))
  exit(2)
}

// Default persistent store id - the hex spells "keybridge". One fixed identity
// so every invocation shares cookies (npm `wub` session; any cf_clearance).
let defaultStoreId = "6b657962-7269-4467-8000-4b4579427231"
let safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

func writeLine(_ obj: [String: Any]) {
  var payload = obj
  if !JSONSerialization.isValidJSONObject(payload) {
    payload = ["event": obj["event"] ?? "?", "error": "unserializable payload"]
  }
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

final class Shell: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
  let webView: WKWebView
  var window: NSWindow?
  var webauthnSeq = 0
  var webauthnReplies: [Int: (Any?, String?) -> Void] = [:]

  init(injectSource: String) {
    let config = WKWebViewConfiguration()
    if cliArgs.contains("--ephemeral") {
      config.websiteDataStore = .nonPersistent()
    } else {
      let id = UUID(uuidString: argValue("--store-id") ?? defaultStoreId) ?? UUID(uuidString: defaultStoreId)!
      config.websiteDataStore = WKWebsiteDataStore(forIdentifier: id)
    }
    config.userContentController.addUserScript(WKUserScript(
      source: injectSource, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 800), configuration: config)
    webView.customUserAgent = argValue("--ua") ?? safariUA
    super.init()
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "keybridge")
    webView.navigationDelegate = self
  }

  // MARK: parent -> shell commands (main thread)
  func handle(_ msg: [String: Any]) {
    switch msg["cmd"] as? String {
    case "navigate":
      if let s = msg["url"] as? String, let url = URL(string: s) {
        webView.load(URLRequest(url: url))
      }
    case "eval":
      let id = msg["id"] as? Int ?? -1
      guard let js = msg["js"] as? String else { return }
      webView.evaluateJavaScript(js, in: nil, in: .page) { result in
        switch result {
        case .success(let v):
          let value: Any = (v is String || v is NSNumber || v is NSNull) ? v : String(describing: v)
          writeLine(["event": "eval-result", "id": id, "value": value])
        case .failure(let e):
          writeLine(["event": "eval-result", "id": id, "error": e.localizedDescription])
        }
      }
    case "webauthn-result":
      if let id = msg["id"] as? Int, let reply = webauthnReplies.removeValue(forKey: id) {
        // Hand the resp through as a JSON string; the inject script parses it.
        let respData = (try? JSONSerialization.data(withJSONObject: msg["resp"] ?? [:])) ?? Data("{}".utf8)
        reply(String(data: respData, encoding: .utf8), nil)
      }
    case "surface":
      surface()
    case "hide":
      window?.orderOut(nil)
    case "close":
      // Small grace so the network process can flush freshly-set cookies to
      // the persistent store before we die.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    default:
      writeLine(["event": "error", "error": "unknown cmd"])
    }
  }

  // The window is created lazily - in the happy path it never exists.
  func surface() {
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
                       styleMask: [.titled, .closable, .resizable],
                       backing: .buffered, defer: false)
      w.title = "keybridge"
      w.isReleasedWhenClosed = false
      w.contentView = webView
      window = w
    }
    guard let w = window else { return }
    w.center()
    // We're a background process (often a child of an agent's shell) - macOS
    // may deny NSApp.activate, which would leave a makeKeyAndOrderFront window
    // buried behind everything. orderFrontRegardless + a floating level makes
    // the window VISIBLE unconditionally; the user's first click makes it key.
    w.level = .floating
    w.orderFrontRegardless()
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    writeLine(["event": "surfaced", "visible": w.isVisible])
  }

  // MARK: WKNavigationDelegate
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    writeLine(["event": "nav", "url": webView.url?.absoluteString ?? ""])
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    writeLine(["event": "nav-error", "error": error.localizedDescription])
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    writeLine(["event": "nav-error", "error": error.localizedDescription])
  }

  // MARK: WKScriptMessageHandlerWithReply - navigator.credentials traffic
  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    guard let body = message.body as? [String: Any],
          let op = body["op"] as? String else {
      replyHandler(nil, "malformed webauthn request")
      return
    }
    webauthnSeq += 1
    let id = webauthnSeq
    webauthnReplies[id] = replyHandler
    writeLine([
      "event": "webauthn",
      "id": id,
      "op": op,
      "options": body["options"] ?? [:],
      "origin": body["origin"] as? String ?? (message.frameInfo.securityOrigin.description),
    ])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon; can still show a window on `surface`

let shell = Shell(injectSource: injectSource)

// stdin reader: one JSON object per line, dispatched to the main thread.
// EOF (parent died) => exit.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    DispatchQueue.main.async { shell.handle(msg) }
  }
  DispatchQueue.main.async { exit(0) }
}

writeLine(["event": "ready"])
app.run()
