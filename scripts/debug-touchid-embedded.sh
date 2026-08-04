#!/usr/bin/env bash
# M0 spike for the Ceremony HUD (_docs/PRD-ceremony-hud.md): prove that
# `LAAuthenticationView` presents Touch ID INSIDE a non-activating panel of an
# accessory app, and that the same LAContext then unlocks a userPresence-gated
# Secure Enclave key without a second prompt.
#
#   scripts/debug-touchid-embedded.sh [count] [policy]
#       count   how many prompts in a row (default 2 - catches the
#               repeated-publish flake that plagued the system-sheet path)
#       policy  biometricsOrCompanion (default) | biometrics | companion |
#               deviceOwner
#
# The script deliberately brings ANOTHER app to the front first: the whole
# reason the HUD exists is that today's system sheet only shows for the
# frontmost process. Every attempt should succeed while "frontmost" is that
# other app and "active" is false.
#
# Go/no-go: `✓ GO` at the end means the PRD's R1 is answered yes.
set -euo pipefail

COUNT="${1:-2}"
POLICY="${2:-biometricsOrCompanion}"

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRC="$REPO_ROOT/native/EmbeddedTouchIDProbe.swift"
HELPER="$HOME/.keybridge/KeyBridge"
PROBE="$HOME/.keybridge/keybridge-embedded-probe"

[ -x "$HELPER" ] || { echo "✗ $HELPER not found - run \`node src/cli.ts setup\` first" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$HOME/.keybridge/debug/embedded-$STAMP"
mkdir -p "$OUT"

echo "· building probe (swiftc) -> $PROBE" >&2
swiftc -O "$SRC" -o "$PROBE"
codesign --force --sign - "$PROBE" 2>/dev/null || true

echo "· streaming LocalAuthentication system log -> $OUT/la-stream.log" >&2
log stream --style compact \
  --predicate '(subsystem BEGINSWITH "com.apple.LocalAuthentication") OR (process CONTAINS[c] "coreauth") OR (process CONTAINS[c] "keybridge-embedded-probe")' \
  > "$OUT/la-stream.log" 2>&1 &
LOGPID=$!

TAG="kb-embed-$$"
cleanup () {
  kill $LOGPID 2>/dev/null || true
  rm -f "$HOME/.keybridge/se-keys/$TAG.key"
}
trap cleanup EXIT

echo "· creating throwaway Secure Enclave key ($TAG - no prompt)" >&2
"$HELPER" create --tag "$TAG" > /dev/null

# Whoever is frontmost right now is already someone other than keybridge -
# usually the terminal running this script - so a pass proves the frontmost
# rule is no longer in play without us disturbing the user's desktop.
# (Do NOT `activate` an app to force this: `tell application "Finder" to
# activate` opens a stray Finder window when it has none.)
FRONT=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || echo "?")
echo "· frontmost app is: $FRONT (keybridge must NOT take this away)" >&2

MSG=$(printf 'keybridge embedded touch id spike' | base64)
echo "── $COUNT prompt(s), policy=$POLICY - they should appear IN the keybridge panel ──" >&2

set +e
"$PROBE" --tag "$TAG" --message "$MSG" --policy "$POLICY" --count "$COUNT" \
  --reason "\"KeyBridge\" is trying to publish keybridge@0.7.0 to npm as tstrebitzer" \
  | tee "$OUT/probe.jsonl"
STATUS=$?
set -e

sleep 1
kill $LOGPID 2>/dev/null || true

echo >&2
echo "· raw events: $OUT/probe.jsonl" >&2

# Verdict, computed from the probe's own evidence plus the system log.
#
# The criterion is NOT `NSApp.isActive` - a non-activating panel that takes key
# status flips that flag while the user's app stays frontmost, which is
# precisely the state we want. What actually matters:
#   1. every prompt succeeded,
#   2. the SE key unlocked silently (one prompt total, not two),
#   3. the user's frontmost app never changed to us,
#   4. LocalAuthentication never PAUSED the prompt waiting for activation -
#      that pause is the "human must click the panel first" failure mode.
node -e '
const fs = require("fs")
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n")
  .filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const results = lines.filter((l) => l.event === "result")
const ok = results.filter((r) => r.ok)
const fatal = lines.find((l) => l.event === "fatal")
const silent = ok.every((r) => r.silentSign)
const fronts = [...new Set(results.map((r) => r.frontmost))]
const stoleFocus = fronts.some((f) => /keybridge|probe/i.test(f))

let la = ""
try { la = fs.readFileSync(process.argv[2], "utf8") } catch {}
const stalled = /is not visible to user because .* is not active/.test(la)

console.error("")
if (fatal) { console.error("✗ NO-GO - probe failed to start: " + fatal.error); process.exit(1) }
console.error(`  prompts succeeded : ${ok.length}/${results.length}`)
console.error(`  latency per prompt: ${results.map((r) => r.ms + "ms").join(", ")}`)
console.error(`  SE sign was silent: ${ok.length ? (silent ? "yes - one prompt total" : "NO - the key re-prompted") : "n/a"}`)
console.error(`  frontmost stayed  : ${fronts.join(", ") || "?"}${stoleFocus ? "  <- WE STOLE FOCUS (bad)" : ""}`)
console.error(`  prompt armed at   : ${stalled ? "AFTER a click - LA paused it while inactive (bad)" : "once, immediately (no click needed)"}`)
for (const r of results.filter((r) => !r.ok)) console.error(`  ! attempt ${r.n}: ${r.code} - ${r.error}`)
console.error("")
const go = results.length > 0 && ok.length === results.length && silent && !stoleFocus && !stalled
console.error(go
  ? "✓ GO - embedded Touch ID arms itself in a non-activating panel; the HUD design holds"
  : "✗ NO-GO - see above; the PRD falls back to the system-sheet signer (§6.6)")
process.exit(go ? 0 : 1)
' "$OUT/probe.jsonl" "$OUT/la-stream.log" || STATUS=1

echo "· suspicious LocalAuthentication lines (if any):" >&2
grep -iE 'notInteractive|systemCancel|frontmost|could not|unable|denied|failed' "$OUT/la-stream.log" | tail -20 >&2 || true

exit $STATUS
