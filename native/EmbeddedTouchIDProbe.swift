// keybridge M0 spike: Touch ID *inside our own window*.
//
// De-risks the Ceremony HUD (_docs/PRD-ceremony-hud.md) by answering the one
// question the whole design rests on: can `LAAuthenticationView` present the
// biometric prompt inside a NON-ACTIVATING panel of an ACCESSORY app - i.e.
// while some other app is frontmost - and can the very same `LAContext` then
// unlock a `.userPresence`-gated Secure Enclave key WITHOUT a second prompt?
//
// Today's signer (SecureEnclaveSigner.swift) has to activate itself and let
// the system present its own sheet, because macOS only shows that sheet for
// the frontmost process. If this probe works, that whole activation dance
// disappears from the happy path.
//
//   keybridge-embedded-probe --tag <tag> --message <base64>
//       [--reason <text>]        line rendered above the prompt (the view
//                                itself is non-textual - icon only)
//       [--policy biometrics|biometricsOrCompanion|companion|deviceOwner]
//       [--count N]              repeat N times (the repeated-publish flake)
//       [--control-size regular|large]
//       [--hold-ms N]            keep the panel up after the last attempt
//
// Emits one JSON object per line on stdout; every line carries the evidence
// that matters for the go/no-go call - `active` (did WE become the frontmost
// app?) and `frontmost` (who actually is). A run where every attempt
// succeeds with "active": false is the proof the PRD's R1 asks for.
//
// NOTE: this binary deliberately NEVER calls NSApplication.activate(). If a
// system sheet shows up anyway, the API did not do what we need.
import AppKit
import CryptoKit
import Foundation
import LocalAuthentication
import LocalAuthenticationEmbeddedUI

let launchDate = Date()

func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
  return a[i + 1]
}

func emit(_ obj: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(obj),
        let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func die(_ message: String, code: String? = nil) -> Never {
  var line: [String: Any] = ["event": "fatal", "error": message]
  if let code { line["code"] = code }
  emit(line)
  exit(1)
}

func ms(since: Date) -> Int { Int(Date().timeIntervalSince(since) * 1000) }

/// Who is frontmost right now - the whole point is that it is never us.
func frontmostName() -> String {
  NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
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

// The embedded view supports only biometry/companion policies;
// `.deviceOwnerAuthentication` is accepted "for convenience" but FAILS when
// neither biometry nor a watch is available (no password fallback in-view).
// That asymmetry is exactly what the PRD's R2 needs measured.
let policyName = arg("--policy") ?? "biometricsOrCompanion"
let policy: LAPolicy
switch policyName {
case "biometrics": policy = .deviceOwnerAuthenticationWithBiometrics
case "companion": policy = .deviceOwnerAuthenticationWithCompanion
case "biometricsOrCompanion": policy = .deviceOwnerAuthenticationWithBiometricsOrCompanion
case "deviceOwner": policy = .deviceOwnerAuthentication
default: die("unknown --policy \(policyName)")
}

guard let tag = arg("--tag"), let msgB64 = arg("--message") else {
  die("usage: keybridge-embedded-probe --tag <tag> --message <base64> [--reason <text>]")
}
guard let message = Data(base64Encoded: msgB64) else { die("invalid --message base64") }

let keyDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".keybridge/se-keys", isDirectory: true)
let blobURL = keyDir.appendingPathComponent("\(tag.replacingOccurrences(of: "/", with: "_")).key")
guard let blob = try? Data(contentsOf: blobURL) else { die("credential blob not found for tag \(tag)") }

let reason = arg("--reason") ?? "Authorize keybridge signature"
let count = Int(arg("--count") ?? "1") ?? 1
let holdMs = Int(arg("--hold-ms") ?? "600") ?? 600
let controlSize: NSControl.ControlSize = (arg("--control-size") == "large") ? .large : .regular

// MARK: - the HUD panel (same family as WebShell.swift's surfaced window)

/// Bottom-center, floating, NON-ACTIVATING, accessory app: it can appear over
/// whatever the user is doing without taking focus. This is the panel the real
/// Ceremony HUD will live in, minus the wizard.
final class ProbePanel {
  let panel: NSPanel
  private let statusLabel = NSTextField(labelWithString: "starting…")
  private let authSlot = NSView()
  private var authView: LAAuthenticationView?

  init(reason: String) {
    panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 418, height: 240),
                    styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
                    backing: .buffered, defer: false)
    panel.title = "keybridge"
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      panel.standardWindowButton(button)?.isHidden = true
    }
    panel.isMovableByWindowBackground = true
    panel.isReleasedWhenClosed = false
    panel.isFloatingPanel = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.hidesOnDeactivate = false
    panel.level = .floating
    panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]

    let title = NSTextField(labelWithString: "keybridge")
    title.font = .systemFont(ofSize: 11, weight: .semibold)
    title.textColor = .secondaryLabelColor

    // The embedded view is non-textual (icon only) - the reason MUST come
    // from the surrounding UI, or the user is approving a blank prompt.
    let reasonLabel = NSTextField(wrappingLabelWithString: reason)
    reasonLabel.font = .systemFont(ofSize: 13, weight: .medium)
    reasonLabel.alignment = .center

    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.alignment = .center

    authSlot.translatesAutoresizingMaskIntoConstraints = false
    authSlot.setContentHuggingPriority(.defaultLow, for: .vertical)

    let stack = NSStackView(views: [title, reasonLabel, authSlot, statusLabel])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 14
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    stack.translatesAutoresizingMaskIntoConstraints = false

    let content = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
    content.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      stack.topAnchor.constraint(equalTo: content.topAnchor),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor),
      authSlot.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
      authSlot.widthAnchor.constraint(greaterThanOrEqualToConstant: 64),
    ])
    panel.contentView = content
  }

  func show() {
    let size = panel.frame.size
    if let screen = NSScreen.main ?? NSScreen.screens.first {
      let v = screen.visibleFrame
      let x = v.midX - size.width / 2
      panel.setFrame(NSRect(x: x, y: v.minY + 24, width: size.width, height: size.height), display: true)
    }
    // Two different things, and the distinction is the whole spike:
    //  - orderFrontRegardless(): visible even though we are a background,
    //    never-activated accessory process.
    //  - makeKeyAndOrderFront(): make the panel the KEY window. On a
    //    `.nonactivatingPanel` this grants keyboard focus WITHOUT making
    //    keybridge the active app - and LocalAuthentication refuses to run the
    //    biometric mechanism until it sees NSWindowDidBecomeKeyNotification
    //    ("LAAuthenticationView is not visible to user because NSApplication
    //    is not active"). Ordering the panel front without making it key
    //    leaves the prompt armed-but-paused until the human clicks it.
    panel.orderFrontRegardless()
    if !CommandLine.arguments.contains("--no-make-key") {
      panel.makeKeyAndOrderFront(nil)
    }
  }

  func status(_ text: String) { statusLabel.stringValue = text }

  /// A fresh view per attempt: `LAAuthenticationView` is permanently paired
  /// with one `LAContext`, and an `LAContext` is single-use. The real HUD has
  /// to rebuild this slot for every ceremony too.
  func mountAuthView(context: LAContext) {
    authView?.removeFromSuperview()
    let view = LAAuthenticationView(context: context, controlSize: controlSize)
    view.translatesAutoresizingMaskIntoConstraints = false
    authSlot.addSubview(view)
    NSLayoutConstraint.activate([
      view.centerXAnchor.constraint(equalTo: authSlot.centerXAnchor),
      view.centerYAnchor.constraint(equalTo: authSlot.centerYAnchor),
    ])
    authView = view
    panel.displayIfNeeded()
  }

  func clearAuthView() {
    authView?.removeFromSuperview()
    authView = nil
  }
}

// MARK: - run

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar

// If we ever become the active app, the premise is broken - record it loudly.
var becameActive = false
NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
                                       object: nil, queue: .main) { _ in
  becameActive = true
  emit(["event": "warning", "warning": "keybridge became the ACTIVE app - the embedded view should not require that"])
}

let hud = ProbePanel(reason: reason)

func runAttempt(_ n: Int) {
  let ctx = LAContext()
  // Suppress the fallback button: the embedded view cannot host a password
  // sheet, and `userFallback` is a state the HUD would have to hand off.
  ctx.localizedFallbackTitle = ""

  var canError: NSError?
  let can = ctx.canEvaluatePolicy(policy, error: &canError)
  emit([
    "event": "attempt",
    "n": n,
    "policy": policyName,
    "canEvaluate": can,
    "biometry": ctx.biometryType.rawValue,
    "canEvaluateError": canError.map { String(describing: $0) } ?? "",
    "active": app.isActive,
    "frontmost": frontmostName(),
  ])

  hud.status("attempt \(n)/\(count) - waiting for Touch ID…")
  hud.mountAuthView(context: ctx)

  let started = Date()
  // THE test: evaluate on the context that the view is paired with. If the
  // pairing works, the prompt renders in our panel and no system sheet or
  // "wants to use Touch ID" notification appears - even though another app
  // is frontmost and we never activated.
  ctx.evaluatePolicy(policy, localizedReason: reason) { ok, laError in
    DispatchQueue.main.async {
      let elapsed = ms(since: started)
      guard ok else {
        let name = laErrorName(laError)
        hud.status("attempt \(n) failed: \(name)")
        emit([
          "event": "result", "n": n, "ok": false, "ms": elapsed,
          "code": name,
          "error": laError.map { String(describing: $0) } ?? "no error object",
          "active": app.isActive, "frontmost": frontmostName(),
        ])
        finish(n)
        return
      }

      // Second half of the gate: does THIS context satisfy the SE key's
      // `.userPresence` access control without prompting again? If it does,
      // signing is silent and instant from here.
      let signStarted = Date()
      do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
        let signature = try key.signature(for: message)
        let signMs = ms(since: signStarted)
        hud.status("attempt \(n) signed ✓")
        emit([
          "event": "result", "n": n, "ok": true,
          "ms": elapsed, "signMs": signMs,
          // A second prompt would cost seconds; a silent unlock is milliseconds.
          "silentSign": signMs < 500,
          "signature": signature.derRepresentation.base64EncodedString(),
          "active": app.isActive, "frontmost": frontmostName(),
        ])
      } catch {
        hud.status("attempt \(n): auth ok, signing failed")
        emit([
          "event": "result", "n": n, "ok": false, "ms": elapsed,
          "code": "signFailed", "error": String(describing: error),
          "active": app.isActive, "frontmost": frontmostName(),
        ])
      }
      finish(n)
    }
  }
}

func finish(_ n: Int) {
  hud.clearAuthView()
  guard n < count else {
    emit(["event": "done", "attempts": count, "everBecameActive": becameActive])
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(holdMs)) { exit(0) }
    return
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(900)) { runAttempt(n + 1) }
}

DispatchQueue.main.async {
  hud.show()
  emit([
    "event": "panel",
    "visible": hud.panel.isVisible,
    "active": app.isActive,
    "frontmost": frontmostName(),
  ])
  // Let the panel actually paint before pairing the prompt to it.
  DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(250)) { runAttempt(1) }
}

app.run()
