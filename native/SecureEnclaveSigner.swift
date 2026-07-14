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
// Output is always a single JSON object on stdout; errors -> {"error":"..."}.

import Foundation
import CryptoKit
import LocalAuthentication

func emit(_ json: String) { print(json) }

func die(_ message: String) -> Never {
    let escaped = message.replacingOccurrences(of: "\\", with: "\\\\")
                         .replacingOccurrences(of: "\"", with: "\\\"")
    emit("{\"error\":\"\(escaped)\"}")
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
    let ctx = LAContext()
    ctx.localizedReason = reason
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
        let signature = try key.signature(for: message) // triggers Touch ID; ECDSA/SHA-256
        emit("{\"signature\":\"\(signature.derRepresentation.base64EncodedString())\"}")
    } catch {
        die("signing failed: \(error)")
    }

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
