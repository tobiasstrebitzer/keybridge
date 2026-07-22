// keybridge Secure Enclave signer (v2 PoC).
//
// A P-256 keypair whose private key is generated inside the Secure Enclave and
// gated so every signature requires user presence (Touch ID). Uses CryptoKit's
// SecureEnclave API with an on-disk *wrapped* key blob rather than the
// keychain - the blob is an opaque handle only this Mac's Secure Enclave can
// use, so no keychain-access-groups entitlement / provisioning profile is
// needed (a plain, even ad-hoc-signed, CLI works).
//
//   KeyBridge create --tag <tag>
//       -> generates an SE key, writes its blob under ~/.keybridge/se-keys/,
//          prints {"x": base64, "y": base64} of the public point
//   KeyBridge sign --tag <tag> --message <base64> --reason <text>
//       -> prompts for Touch ID, signs the message with ECDSA-P256/SHA-256,
//          prints {"signature": base64}  (DER - what WebAuthn expects)
//   KeyBridge probe
//       -> creates + discards a throwaway SE key; {"ok": true} if usable
//          (no Touch ID: key creation does not prompt)
//
// Output is always a single JSON object on stdout; errors -> {"error":"..."}
// (plus a "code" with the LAError name when user-presence evaluation failed).
// KEYBRIDGE_SE_DEBUG=1 (or --verbose) traces every step to stderr.
//
// macOS only presents the Touch ID sheet when the requesting process is
// frontmost; a background process gets a "KeyBridge wants to use Touch ID"
// NOTIFICATION the human must click instead - which reads as "the dialog
// never showed" (the exact repeated-publish flake). So `sign` runs as a
// briefly-activated accessory NSApplication and activates itself before every
// evaluation, and evaluates user presence EXPLICITLY (evaluatePolicy) so a
// presentation failure surfaces as a precise LAError instead of a silent
// 5-minute hang inside CryptoKit's signature call.

import Foundation
import CryptoKit
import LocalAuthentication
import AppKit

let launchDate = Date()
let debugEnabled = CommandLine.arguments.contains("--verbose")
    || (ProcessInfo.processInfo.environment["KEYBRIDGE_SE_DEBUG"] ?? "").isEmpty == false

func dlog(_ message: String) {
    guard debugEnabled else { return }
    let ms = Int(Date().timeIntervalSince(launchDate) * 1000)
    FileHandle.standardError.write("[KeyBridge \(ProcessInfo.processInfo.processIdentifier) +\(ms)ms] \(message)\n".data(using: .utf8)!)
}

func emit(_ json: String) { print(json) }

func jsonEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
}

func die(_ message: String, code: String? = nil) -> Never {
    let codePart = code.map { ",\"code\":\"\(jsonEscape($0))\"" } ?? ""
    emit("{\"error\":\"\(jsonEscape(message))\"\(codePart)}")
    exit(1)
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let keyDir: URL = {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent(".keybridge/se-keys", isDirectory: true)
}()

func blobURL(_ tag: String) -> URL {
    let safe = tag.replacingOccurrences(of: "/", with: "_")
    return keyDir.appendingPathComponent("\(safe).key")
}

func accessControl() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .userPresence],
        &error
    ) else {
        die("access control: \(error!.takeRetainedValue())")
    }
    return ac
}

func requireSecureEnclave() {
    guard SecureEnclave.isAvailable else { die("Secure Enclave not available on this Mac") }
}

// public point as (x, y) from a P-256 public key
func point(_ pub: P256.Signing.PublicKey) -> (x: Data, y: Data) {
    let rep = pub.x963Representation // 0x04 || X(32) || Y(32)
    let x = rep.subdata(in: 1 ..< 33)
    let y = rep.subdata(in: 33 ..< 65)
    return (x, y)
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

// The interactive path: activate, prove user presence, sign, exit. Runs on the
// main run loop (app.run()) because activation and LA presentation need one.
func runSign(blob: Data, message: Data, reason: String, app: NSApplication) {
    var attempt = 0

    func evaluate() {
        attempt += 1
        let ctx = LAContext()
        let frontmost = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
        dlog("attempt \(attempt): activating (frontmost was: \(frontmost))")
        app.activate(ignoringOtherApps: true)

        var canError: NSError?
        let can = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canError)
        dlog("canEvaluatePolicy=\(can) biometry=\(ctx.biometryType.rawValue) error=\(canError.map { String(describing: $0) } ?? "none")")

        // .deviceOwnerAuthentication matches the key's .userPresence gate
        // (biometry, watch, or password); a context that already evaluated it
        // satisfies the gate, so the signature below never re-prompts.
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, laError in
            if ok {
                dlog("user presence confirmed after \(Int(Date().timeIntervalSince(launchDate) * 1000))ms - signing")
                do {
                    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
                    let signature = try key.signature(for: message) // ECDSA/SHA-256, no second prompt
                    emit("{\"signature\":\"\(signature.derRepresentation.base64EncodedString())\"}")
                    exit(0)
                } catch {
                    die("signing failed: \(error)")
                }
            }
            let name = laErrorName(laError)
            dlog("evaluatePolicy failed: \(name) (\(laError.map { String(describing: $0) } ?? "no error object"))")
            // The two presentation flakes (the sheet could not be shown / the
            // system dismissed it) get one re-activated retry before failing.
            if attempt == 1 && (name == "systemCancel" || name == "notInteractive") {
                dlog("retrying once after re-activation")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { evaluate() }
                return
            }
            die("Touch ID / user presence check failed: \(name)", code: name)
        }
    }

    DispatchQueue.main.async { evaluate() }
}

guard CommandLine.arguments.count >= 2 else { die("usage: KeyBridge <create|sign|probe>") }
let command = CommandLine.arguments[1]

switch command {
case "create":
    requireSecureEnclave()
    guard let tag = arg("--tag") else { die("create requires --tag") }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl())
        try FileManager.default.createDirectory(at: keyDir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try key.dataRepresentation.write(to: blobURL(tag), options: [.atomic, .completeFileProtection])
        let (x, y) = point(key.publicKey)
        emit("{\"x\":\"\(x.base64EncodedString())\",\"y\":\"\(y.base64EncodedString())\"}")
    } catch {
        die("key generation failed: \(error)")
    }

case "sign":
    requireSecureEnclave()
    guard let tag = arg("--tag"), let msgB64 = arg("--message") else { die("sign requires --tag and --message") }
    let reason = arg("--reason") ?? "Authorize keybridge signature"
    guard let message = Data(base64Encoded: msgB64) else { die("invalid --message base64") }
    guard let blob = try? Data(contentsOf: blobURL(tag)) else { die("credential blob not found for tag") }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    runSign(blob: blob, message: message, reason: reason, app: app)
    app.run() // exits via exit() in runSign

case "probe":
    requireSecureEnclave()
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl())
        _ = point(key.publicKey)
        emit("{\"ok\":true}")
    } catch {
        die("probe failed: \(error)")
    }

default:
    die("unknown command \(command)")
}
