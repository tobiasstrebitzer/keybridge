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
//     {"cmd":"hud-show","reason":"...","status":"..."}  // ceremony HUD
//     {"cmd":"hud-status","status":"..."}
//     {"cmd":"hud-close"}
//     {"cmd":"sign","id":4,"tag":"..","message":"<b64>","reason":".."}
//     {"cmd":"close"}
//   shell -> parent
//     {"event":"ready"}
//     {"event":"nav","url":"..."}                  // main-frame didFinish
//     {"event":"nav-error","error":"..."}
//     {"event":"eval-result","id":1,"value":...}   // or {"id":1,"error":"..."}
//     {"event":"webauthn","id":3,"op":"get","options":{...},"origin":"..."}
//     {"event":"sign-result","id":4,"signature":"<b64 DER>"}
//                                  // or {"id":4,"error":"..","code":"<LAError>"}
//
// The HUD (ceremony panel) hosts the Touch ID prompt IN THIS WINDOW via
// LAAuthenticationView, and `sign` does the Secure Enclave signature here so
// the very same LAContext satisfies the key's .userPresence gate - one touch,
// no system sheet, no frontmost-process lottery. See _docs/PRD-ceremony-hud.md
// §6.7 for the measurements behind this design.
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
import CryptoKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
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

// MARK: - Ceremony HUD
//
// A bottom-center non-activating panel that hosts the Touch ID prompt inside
// our own window (LAAuthenticationView) instead of relying on the system
// sheet. Same window family as `Shell.surface()` below, and deliberately so:
// it appears over whatever the user is doing without taking their focus.
/// A borderless panel that can still take KEY status.
///
/// `.borderless` windows return false from `canBecomeKey` by default, and that
/// would be fatal here: LocalAuthentication refuses to run the biometric
/// mechanism until our window becomes key (see `focusForPrompt`). The sheet
/// look therefore requires this override, not just a style mask.
final class HudPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class CeremonyHud: NSObject {
  private var panel: NSPanel?
  /// The context driving the prompt on screen right now - kept so the ✕ can
  /// invalidate it and end the ceremony instead of orphaning it.
  private var activeContext: LAContext?
  /// How many times we have clawed key status back during this prompt.
  private var refocusAttempts = 0
  /// Enough to win against an app that briefly steals focus, low enough that
  /// we stop fighting a user who genuinely wants to be elsewhere.
  private static let maxRefocus = 8
  private let reasonLabel = NSTextField(wrappingLabelWithString: "")
  private let statusLabel = NSTextField(labelWithString: "")
  private let authSlot = NSView()
  private var authView: LAAuthenticationView?
  /// Where the sheet rests when fully shown - the anchor both slide
  /// animations interpolate against.
  private var restingFrame = NSRect.zero
  private var slidingOut = false

  private let sheetWidth: CGFloat = 418
  /// A floor, not the height: the sheet grows to fit its content, so a long
  /// package name wrapping the reason line onto a second row pushes the sheet
  /// taller instead of pushing the status text off the bottom.
  private let minSheetHeight: CGFloat = 224
  private let cornerRadius: CGFloat = 16
  private let slideDuration = 0.30
  /// How far the window extends BELOW the screen edge. The window's shadow
  /// wraps all four sides, so a window whose bottom sits exactly on the screen
  /// edge draws a visible bottom border and dims radially into the bottom-left
  /// and bottom-right corners. Pushing the bottom edge off-screen moves that
  /// whole side out of view, leaving only the left/right/top shadow that makes
  /// the sheet read as raised.
  private let bleed: CGFloat = 28

  /// True while a Touch ID prompt is waiting on the human.
  private var promptActive = false
  /// The status to restore once focus comes back (see the focus observers).
  private var promptStatus = ""
  private var focusObservers: [NSObjectProtocol] = []
  private var content: NSVisualEffectView?

  private var keyDir: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".keybridge/se-keys", isDirectory: true)
  }

  private func build() -> NSPanel {
    // Borderless + transparent so the rounded TOP corners we draw ourselves
    // are the only chrome: a titled window would impose the system's own
    // all-four-corners rounding and a bottom edge we don't want.
    let panel = HudPanel(contentRect: NSRect(x: 0, y: 0, width: sheetWidth, height: minSheetHeight + bleed),
                         styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    // A sheet is anchored to the screen edge; letting it be dragged away from
    // that edge would just break the illusion.
    panel.isMovableByWindowBackground = false
    panel.isReleasedWhenClosed = false
    panel.isFloatingPanel = true
    panel.becomesKeyOnlyIfNeeded = false
    // Never vanish when another app takes over, sit above ordinary floating
    // windows, and follow the user to whatever Space they switch to: the
    // ceremony is modal in intent, so it should not be possible to lose it
    // behind something.
    panel.hidesOnDeactivate = false
    panel.level = .modalPanel
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

    let title = NSTextField(labelWithString: "keybridge")
    title.font = .systemFont(ofSize: 11, weight: .semibold)
    title.textColor = .secondaryLabelColor

    // LAAuthenticationView is NON-TEXTUAL (a compact icon; Apple's header:
    // "The reason for the authentication must be apparent from the
    // surrounding UI"). This label is therefore the ONLY thing telling the
    // human what they are approving - it is load-bearing, not decoration.
    reasonLabel.font = .systemFont(ofSize: 13, weight: .medium)
    reasonLabel.alignment = .center
    // Deterministic wrapping, so the fitting-size measurement below knows how
    // many lines this label really needs.
    reasonLabel.preferredMaxLayoutWidth = sheetWidth - 40

    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.alignment = .center

    authSlot.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView(views: [title, reasonLabel, authSlot, statusLabel])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 18
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    stack.translatesAutoresizingMaskIntoConstraints = false

    // NSVisualEffectView rather than a plain layer colour: it tracks the
    // light/dark appearance on its own, so the sheet follows the system theme
    // like the rest of the shell's chrome.
    let content = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: sheetWidth, height: minSheetHeight + bleed))
    content.material = .windowBackground
    content.blendingMode = .behindWindow
    content.state = .active
    content.wantsLayer = true
    // Top corners only. On macOS layer geometry MaxY is the TOP edge, so these
    // two are top-left and top-right; the bottom stays square and flush with
    // the screen edge, which is what makes it read as a sheet rather than a
    // floating dialog.
    content.layer?.cornerRadius = cornerRadius
    content.layer?.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    content.layer?.masksToBounds = true

    content.addSubview(stack)
    NSLayoutConstraint.activate([
      // Fixed width makes the wrapping label's height well-defined, which is
      // what `fittingSize` needs to measure the sheet.
      content.widthAnchor.constraint(equalToConstant: sheetWidth),
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      stack.topAnchor.constraint(equalTo: content.topAnchor),
      // EQUAL, not <=: the stack now DRIVES the content height, reserving the
      // off-screen bleed below it. With <= the content could exceed the window
      // and the status line fell off the bottom.
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -bleed),
      // Minimums, not sizes - the auth view keeps its intrinsic size and this
      // just guarantees breathing room around it.
      authSlot.heightAnchor.constraint(greaterThanOrEqualToConstant: 96),
      authSlot.widthAnchor.constraint(greaterThanOrEqualToConstant: 96),
    ])
    // Cancel affordance: a quiet circular ✕ in the top-right. Sits OUTSIDE the
    // stack so it overlays the header without affecting the fitted height.
    let close = NSButton()
    close.isBordered = false
    close.bezelStyle = .shadowlessSquare
    close.title = ""
    close.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Cancel")?
      .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 15, weight: .regular))
    close.imagePosition = .imageOnly
    close.contentTintColor = .tertiaryLabelColor
    close.toolTip = "Cancel this ceremony"
    close.target = self
    close.action = #selector(dismissClicked)
    close.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(close)
    NSLayoutConstraint.activate([
      close.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
      close.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
    ])

    panel.contentView = content
    self.content = content
    observeFocus(panel)
    return panel
  }

  /// The ✕. Ends the whole ceremony rather than just hiding the sheet:
  /// invalidating the context makes `evaluatePolicy` complete (as appCancel),
  /// and `hud-dismissed` tells the parent to abort its doneUrl polling instead
  /// of waiting out the five-minute timeout.
  @objc private func dismissClicked() {
    cancelPrompt(reason: "user")
  }

  private func cancelPrompt(reason: String) {
    if promptActive, let ctx = activeContext {
      promptActive = false
      ctx.invalidate() // -> evaluatePolicy completion fires with appCancel
    }
    activeContext = nil
    writeLine(["event": "hud-dismissed", "reason": reason])
    close()
  }

  /// Window height for the CURRENT content: whatever the stack needs, plus the
  /// off-screen bleed, never below the floor. Recomputed whenever the content
  /// changes (text set, auth view mounted or torn down).
  private func fittedHeight() -> CGFloat {
    guard let content else { return minSheetHeight + bleed }
    content.layoutSubtreeIfNeeded()
    return max(content.fittingSize.height, minSheetHeight + bleed)
  }

  /// Re-fit an already-visible sheet, keeping its bottom pinned below the
  /// screen edge so it grows upward rather than sliding.
  private func refit() {
    guard let panel, panel.isVisible, !slidingOut else { return }
    restingFrame = restingFrameFor(panel)
    panel.setFrame(restingFrame, display: true)
  }

  /// Losing key status mid-prompt is not cosmetic: LocalAuthentication PAUSES
  /// the biometric mechanism the moment the app stops being active, and only
  /// resumes on NSWindowDidBecomeKeyNotification (PRD §6.7 finding 3). The
  /// sensor then does nothing and the human has no idea why - the exact
  /// silent-hang shape keybridge keeps having to design out. So watch for it
  /// and say plainly what to do: click the sheet.
  ///
  /// While a prompt is up we CLAW KEY STATUS BACK rather than just asking: a
  /// half-finished ceremony that silently stops responding is worse than a
  /// sheet that insists. Capped at `maxRefocus` so we never ping-pong forever
  /// with an app that wants focus more than we do - past the cap we stop
  /// fighting and fall back to telling the human to click.
  private func observeFocus(_ panel: NSPanel) {
    let nc = NotificationCenter.default
    focusObservers.append(nc.addObserver(forName: NSWindow.didResignKeyNotification,
                                         object: panel, queue: .main) { [weak self] _ in
      guard let self, self.promptActive else { return }
      let willRegrab = self.refocusAttempts < Self.maxRefocus
      writeLine(["event": "hud-focus", "key": false, "regrab": willRegrab])
      guard willRegrab else {
        self.statusLabel.textColor = .systemOrange
        self.statusLabel.stringValue = "paused - click this sheet, then use Touch ID"
        return
      }
      self.refocusAttempts += 1
      // Next runloop turn: makeKey inside the resign notification itself is
      // swallowed while AppKit is still settling the focus change.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
        guard let self, self.promptActive else { return }
        self.panel?.orderFrontRegardless()
        self.panel?.makeKeyAndOrderFront(nil)
      }
    })
    focusObservers.append(nc.addObserver(forName: NSWindow.didBecomeKeyNotification,
                                         object: panel, queue: .main) { [weak self] _ in
      guard let self, self.promptActive else { return }
      self.statusLabel.textColor = .secondaryLabelColor
      self.statusLabel.stringValue = self.promptStatus
      writeLine(["event": "hud-focus", "key": true])
    })
  }

  /// Bottom-center, flush with the ABSOLUTE bottom of the screen - `frame`,
  /// not `visibleFrame`, so the sheet meets the screen edge instead of
  /// floating above the Dock. The window is `bleed` points TALLER than the
  /// sheet and hangs that much below the screen, so its bottom edge (and the
  /// shadow around it) is never on screen; content is top-anchored, so the
  /// visible height is still exactly `sheetHeight`.
  private func restingFrameFor(_ panel: NSPanel) -> NSRect {
    let h = fittedHeight()
    guard let screen = NSScreen.main ?? NSScreen.screens.first else {
      return NSRect(x: 0, y: 0, width: sheetWidth, height: h)
    }
    let f = screen.frame
    return NSRect(x: f.midX - sheetWidth / 2, y: f.minY - bleed, width: sheetWidth, height: h)
  }

  /// Fully off-screen below the bottom edge - where a slide starts and ends.
  private func offscreenFrame(_ resting: NSRect) -> NSRect {
    NSRect(x: resting.minX, y: resting.minY - resting.height,
           width: resting.width, height: resting.height)
  }

  func show(reason: String, status: String) {
    reasonLabel.stringValue = reason
    statusLabel.stringValue = status
    let panel = self.panel ?? build()
    self.panel = panel

    // Already up and staying up - just the text changed.
    if panel.isVisible && !slidingOut { return }

    restingFrame = restingFrameFor(panel)
    // A show landing mid-dismissal reverses the slide from wherever it is,
    // rather than snapping the sheet off-screen first.
    if !slidingOut {
      panel.setFrame(offscreenFrame(restingFrame), display: false)
      panel.alphaValue = 0
    }
    slidingOut = false
    panel.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = slideDuration
      ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
      panel.animator().alphaValue = 1
      panel.animator().setFrame(restingFrame, display: true)
    }
    writeLine(["event": "hud", "visible": true])
  }

  /// Slide back down through the bottom edge, then order out. `then` runs
  /// after the sheet is actually gone.
  private func slideOut(then: (() -> Void)? = nil) {
    guard let panel, panel.isVisible, !slidingOut else {
      then?()
      return
    }
    slidingOut = true
    let target = offscreenFrame(restingFrame == .zero ? restingFrameFor(panel) : restingFrame)
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = slideDuration
      ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
      panel.animator().alphaValue = 0
      panel.animator().setFrame(target, display: true)
    }, completionHandler: { [weak self] in
      // A show() that arrived mid-slide already claimed the sheet - leave it.
      guard let self, self.slidingOut else { then?(); return }
      self.slidingOut = false
      panel.orderOut(nil)
      then?()
    })
  }

  /// Take KEY window status - called only when a prompt is about to run, never
  /// merely to show progress, so we hold the user's keyboard focus for the
  /// seconds of the ceremony rather than the minutes of the whole flow.
  ///
  /// This is NOT redundant with orderFrontRegardless(). On a
  /// `.nonactivatingPanel`, becoming key takes keyboard focus WITHOUT
  /// activating keybridge (the user's app stays frontmost), and
  /// LocalAuthentication REFUSES to run the biometric mechanism until it sees
  /// NSWindowDidBecomeKeyNotification - it logs "LAAuthenticationView is not
  /// visible to user because NSApplication is not active" and pauses. Drop
  /// this and the Touch ID prompt silently waits for the human to click the
  /// panel first (measured 2026-08-04: 5804ms with a click, 2487ms with this
  /// line). Do not "simplify" it away.
  private func focusForPrompt() {
    panel?.makeKeyAndOrderFront(nil)
  }

  func status(_ text: String) {
    statusLabel.stringValue = text
    refit()
  }

  func hide() {
    slideOut()
  }

  func close() {
    clearAuthView()
    slideOut()
  }

  private func clearAuthView() {
    authView?.removeFromSuperview()
    authView = nil
  }

  /// Touch ID inside our panel, then the Secure Enclave signature on the SAME
  /// LAContext - so the key's .userPresence gate is already satisfied and the
  /// signature costs no second prompt (measured: ~180ms).
  func sign(id: Int, tag: String, message: Data, reason: String) {
    let safeTag = tag.replacingOccurrences(of: "/", with: "_")
    guard let blob = try? Data(contentsOf: keyDir.appendingPathComponent("\(safeTag).key")) else {
      writeLine(["event": "sign-result", "id": id, "error": "credential blob not found for tag \(tag)", "code": "ENOKEY"])
      return
    }

    promptStatus = "waiting for Touch ID approval…"
    statusLabel.textColor = .secondaryLabelColor
    show(reason: reason, status: promptStatus)
    // Arm the focus watch before taking focus, so a key status we lose
    // immediately is still reported.
    promptActive = true
    refocusAttempts = 0
    focusForPrompt() // must happen BEFORE evaluatePolicy - see focusForPrompt()

    let ctx = LAContext()
    activeContext = ctx
    // The embedded view cannot host a password sheet, so do not offer a
    // fallback affordance it is unable to honor.
    ctx.localizedFallbackTitle = ""

    // Biometry/companion only: per Apple's header the embedded view supports
    // just these policies, and .deviceOwnerAuthentication would fail anyway
    // when neither is available. If we cannot evaluate, say so precisely and
    // let the parent fall back to the system-sheet signer.
    let policy: LAPolicy = .deviceOwnerAuthenticationWithBiometricsOrCompanion
    var canError: NSError?
    guard ctx.canEvaluatePolicy(policy, error: &canError) else {
      promptActive = false
      status("Touch ID unavailable")
      writeLine([
        "event": "sign-result", "id": id,
        "error": "cannot evaluate biometrics/companion: \(canError?.localizedDescription ?? "unavailable")",
        "code": "EEMBEDUNAVAIL",
      ])
      return
    }

    // A fresh view per ceremony: LAAuthenticationView is permanently paired
    // with the LAContext given to its initializer, and an LAContext is
    // single-use. Only the slot is rebuilt - the panel itself persists, so
    // the human sees one continuous sheet across chained ceremonies.
    clearAuthView()
    // .regular rather than .large: at .large the fingerprint dominated the
    // sheet and crowded the reason line, which is the part that actually says
    // what is being approved.
    let view = LAAuthenticationView(context: ctx, controlSize: .regular)
    view.translatesAutoresizingMaskIntoConstraints = false
    authSlot.addSubview(view)
    NSLayoutConstraint.activate([
      view.centerXAnchor.constraint(equalTo: authSlot.centerXAnchor),
      view.centerYAnchor.constraint(equalTo: authSlot.centerYAnchor),
    ])
    refit() // the glyph may be taller than the slot's minimum
    panel?.displayIfNeeded()

    ctx.evaluatePolicy(policy, localizedReason: reason) { ok, laError in
      DispatchQueue.main.async {
        self.promptActive = false
        self.activeContext = nil
        self.statusLabel.textColor = .secondaryLabelColor
        self.clearAuthView()
        guard ok else {
          let name = laErrorName(laError)
          self.status("not approved (\(name))")
          writeLine([
            "event": "sign-result", "id": id,
            "error": "Touch ID / user presence check failed: \(name)", "code": name,
          ])
          return
        }
        do {
          let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
          let signature = try key.signature(for: message) // no second prompt
          self.status("approved")
          writeLine([
            "event": "sign-result", "id": id,
            "signature": signature.derRepresentation.base64EncodedString(),
          ])
        } catch {
          self.status("signing failed")
          writeLine([
            "event": "sign-result", "id": id,
            "error": "signing failed: \(error)", "code": "ESIGN",
          ])
        }
      }
    }
  }
}

func laErrorName(_ error: Error?) -> String {
  guard let la = error as? LAError else { return "unknown" }
  switch la.code {
  case .userCancel: return "userCancel"
  case .systemCancel: return "systemCancel"
  case .appCancel: return "appCancel"
  case .authenticationFailed: return "authenticationFailed"
  case .passcodeNotSet: return "passcodeNotSet"
  case .biometryNotAvailable: return "biometryNotAvailable"
  case .biometryNotEnrolled: return "biometryNotEnrolled"
  case .biometryLockout: return "biometryLockout"
  case .userFallback: return "userFallback"
  case .invalidContext: return "invalidContext"
  case .notInteractive: return "notInteractive"
  default: return "laError(\(la.code.rawValue))"
  }
}

final class Shell: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
  let webView: WKWebView
  var window: NSWindow?
  let hud = CeremonyHud()
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
    case "hud-show":
      hud.show(reason: msg["reason"] as? String ?? "Authorize a keybridge ceremony",
               status: msg["status"] as? String ?? "")
    case "hud-status":
      hud.status(msg["status"] as? String ?? "")
    case "hud-close":
      hud.close()
    case "sign":
      let id = msg["id"] as? Int ?? -1
      guard let tag = msg["tag"] as? String,
            let msgB64 = msg["message"] as? String,
            let message = Data(base64Encoded: msgB64) else {
        writeLine(["event": "sign-result", "id": id, "error": "sign requires tag and base64 message", "code": "EARGS"])
        return
      }
      hud.sign(id: id, tag: tag, message: message,
               reason: msg["reason"] as? String ?? "Authorize keybridge signature")
    case "surface":
      // Never stack two bottom-center panels: the web window takes over
      // (password login), so the HUD steps aside until the parent closes it.
      hud.hide()
      surface()
    case "hide":
      window?.orderOut(nil)
    case "close":
      // Small grace so the network process can flush freshly-set cookies to
      // the persistent store before we die - and long enough that the HUD's
      // slide-down finishes instead of being cut off by exit(). The parent
      // sends `hud-close` and `close` back to back, so the animation is
      // almost always still in flight when we get here.
      hud.close()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
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
