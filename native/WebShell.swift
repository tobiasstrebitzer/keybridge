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
//                      [--appearance dark|light]   (default: follow the system)
import AppKit
import WebKit

let cliArgs = CommandLine.arguments
func argValue(_ name: String) -> String? {
  guard let i = cliArgs.firstIndex(of: name), i + 1 < cliArgs.count else { return nil }
  return cliArgs[i + 1]
}

// Default persistent store id - the hex spells "keybridge". Pre-accounts
// keybridge used this one fixed identity for every invocation; the identity
// layer (src/accounts.ts) now passes a per-npm-account UUID via --store-id
// and grandfathers this id to the first account it records.
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

// --purge-store <uuid>: delete that account profile's persistent website data
// store (`keybridge logout --web`), report {"event":"purge","ok":…}, exit.
// No web view, no stdio protocol - runs before the --inject requirement.
if let purgeArg = argValue("--purge-store") {
  guard let purgeId = UUID(uuidString: purgeArg) else {
    FileHandle.standardError.write(Data("keybridge-webshell: --purge-store requires a UUID\n".utf8))
    exit(2)
  }
  let purgeApp = NSApplication.shared
  purgeApp.setActivationPolicy(.prohibited) // never visible, never in the Dock
  DispatchQueue.main.async {
    // Touch WebKit before the class-level identifier calls: they dispatch to
    // WebKit's internal main run loop, which only exists once some WebKit
    // object was created - without this they crash (null RunLoop deref).
    _ = WKWebsiteDataStore.default()
    // remove(forIdentifier:) is idempotent - a store that never existed
    // reports no error, so logout --web can always be retried.
    WKWebsiteDataStore.remove(forIdentifier: purgeId) { error in
      if let error {
        writeLine(["event": "purge", "ok": false, "error": error.localizedDescription])
        exit(1)
      }
      writeLine(["event": "purge", "ok": true])
      exit(0)
    }
  }
  purgeApp.run()
}

guard let injectPath = argValue("--inject"),
      let injectSource = try? String(contentsOfFile: injectPath, encoding: .utf8) else {
  FileHandle.standardError.write(Data("keybridge-webshell: --inject <path> is required and must be readable\n".utf8))
  exit(2)
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
    // npmjs.com cosmetic tweaks for the sheet:
    //  - the site theme defaults to LIGHT unless its localStorage setting
    //    ("npm-color-mode": light|dark|system) says otherwise - seed it to
    //    "system" so the page follows the macOS appearance like the window
    //    chrome does. Only when unset: a choice the user makes via npm's own
    //    theme toggle wins. Persists per account profile (website data store).
    //  - hide the alert banner (2FA-deprecation notice etc.) - it eats a
    //    third of the sheet. CSS beats the bypass2fa_banner_dismissed cookie,
    //    which expires after a day and is per profile.
    config.userContentController.addUserScript(WKUserScript(
      source: """
      try {
        if (location.host === "www.npmjs.com") {
          if (!localStorage.getItem("npm-color-mode")) {
            localStorage.setItem("npm-color-mode", "system")
          }
          const style = document.createElement("style")
          style.textContent = '[data-test-id="alert-banner"] { display: none !important; }'
          document.documentElement.appendChild(style)
        }
      } catch (e) {}
      """,
      injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 800), configuration: config)
    webView.customUserAgent = argValue("--ua") ?? safariUA
    // Match the window chrome while pages load / overscroll - otherwise dark
    // mode flashes a white sheet before the page paints.
    webView.underPageBackgroundColor = .windowBackgroundColor
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

  // The window is created lazily - in the happy path it never exists. It is
  // a sheet-like NON-ACTIVATING panel: compact, bottom-center, slides up, and
  // takes keyboard input WITHOUT making keybridge the frontmost app - the
  // user's current app (e.g. a password manager) keeps focus context, yet
  // typing and cmd+V land in the panel (key equivalents resolve against our
  // main menu because the panel is the key window).
  func surface() {
    if window == nil {
      // Sheet look: no visible title bar (content runs edge to edge, the
      // native rounded corners and the traffic-light close button remain),
      // draggable from anywhere. Phone-ish width on purpose: npm's
      // responsive CSS switches to its compact layout, which fits a
      // form-only sheet much better than the desktop layout.
      let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 418, height: 680),
                          styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
                          backing: .buffered, defer: false)
      panel.title = "keybridge"
      panel.titleVisibility = .hidden
      panel.titlebarAppearsTransparent = true
      // Pure sheet: no traffic lights either (.closable stays in the style
      // mask so cmd+W / the Window menu can still close it).
      for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
        panel.standardWindowButton(button)?.isHidden = true
      }
      panel.isMovableByWindowBackground = true
      panel.isReleasedWhenClosed = false
      panel.isFloatingPanel = true
      panel.becomesKeyOnlyIfNeeded = false
      panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
      panel.contentView = webView
      window = panel
    }
    guard let w = window else { return }
    // Bottom-center "sheet" placement, flush with the bottom of the usable
    // screen (the Dock edge); orderFrontRegardless + floating level keeps it
    // visible even when we're a background process that macOS won't let
    // activate (often a child of an agent's shell).
    w.level = .floating
    let size = w.frame.size
    if let screen = NSScreen.main ?? NSScreen.screens.first {
      let v = screen.visibleFrame
      let x = v.midX - size.width / 2
      let y = v.minY
      w.setFrame(NSRect(x: x, y: y - 36, width: size.width, height: size.height), display: false)
      w.alphaValue = 0
      w.orderFrontRegardless()
      w.makeKeyAndOrderFront(nil)
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.28
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        w.animator().alphaValue = 1
        w.animator().setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
      }
    } else {
      w.center()
      w.orderFrontRegardless()
      w.makeKeyAndOrderFront(nil)
    }
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

// Appearance: follow the macOS system light/dark mode by default (the web
// view inherits it and reports it to pages as `prefers-color-scheme` - npm's
// site honors it when the npm account's theme is set to "system").
// --appearance forces one, for taste or for screenshots.
switch argValue("--appearance") {
case "dark": app.appearance = NSAppearance(named: .darkAqua)
case "light": app.appearance = NSAppearance(named: .aqua)
default: break
}

// The surfaced window hosts real form input (npm password/username), so the
// shell must behave like a normal app there:
//  - macOS "smart" text substitution auto-capitalizes the first letter of
//    inputs (tstrebitzer -> Tstrebitzer) unless the app opts out.
//  - Key equivalents (cmd+V/C/X/A/Z/W) only work when a main menu carries the
//    standard edit actions - a menubar-less app silently drops them (while
//    right-click -> Paste still works, which is extra confusing).
// set (not register): the system preference lives in the GLOBAL defaults
// domain, which outranks registered fallbacks - only the app's own domain
// wins over it.
for key in [
  "NSAutomaticCapitalizationEnabled",
  "NSAutomaticSpellingCorrectionEnabled",
  "NSAutomaticTextReplacementEnabled",
  "NSAutomaticPeriodSubstitutionEnabled",
  "NSAutomaticQuoteSubstitutionEnabled",
  "NSAutomaticDashSubstitutionEnabled",
] { UserDefaults.standard.set(false, forKey: key) }
let mainMenu = NSMenu()
let appItem = NSMenuItem(); mainMenu.addItem(appItem)
let appMenu = NSMenu(); appItem.submenu = appMenu
appMenu.addItem(withTitle: "Quit keybridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
let editItem = NSMenuItem(); mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "Edit"); editItem.submenu = editMenu
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
editMenu.addItem(NSMenuItem.separator())
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
let windowItem = NSMenuItem(); mainMenu.addItem(windowItem)
let windowMenu = NSMenu(title: "Window"); windowItem.submenu = windowMenu
windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
app.mainMenu = mainMenu

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
