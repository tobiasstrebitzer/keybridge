#!/usr/bin/env bash
# Reproduce and diagnose the "Touch ID sheet doesn't show on repeated
# prompts" flake WITHOUT npm: create a throwaway Secure Enclave key, then
# sign with it N times in a row (mimicking a chain of publishes), while
# capturing the macOS LocalAuthentication / coreauthd system log and the
# helper's own KEYBRIDGE_SE_DEBUG trace.
#
#   scripts/debug-touchid.sh [count] [delay-seconds]     # default: 3 signs, 2s apart
#
# Each sign should show the Touch ID sheet. If one only produces the
# "KeyBridge wants to use Touch ID" notification instead, the la-stream.log +
# sign-N.err files for that attempt hold the evidence.
set -euo pipefail

COUNT="${1:-3}"
DELAY="${2:-2}"
HELPER="$HOME/.keybridge/KeyBridge"
[ -x "$HELPER" ] || { echo "✗ $HELPER not found - run \`node src/cli.ts setup\` first" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$HOME/.keybridge/debug/touchid-$STAMP"
mkdir -p "$OUT"

echo "· streaming LocalAuthentication system log -> $OUT/la-stream.log" >&2
log stream --style compact \
  --predicate '(subsystem BEGINSWITH "com.apple.LocalAuthentication") OR (process CONTAINS[c] "coreauth") OR (process == "KeyBridge")' \
  > "$OUT/la-stream.log" 2>&1 &
LOGPID=$!
trap 'kill $LOGPID 2>/dev/null || true' EXIT

TAG="kb-debug-$$"
echo "· creating throwaway Secure Enclave key ($TAG - no prompt)" >&2
"$HELPER" create --tag "$TAG" > /dev/null

MSG=$(printf 'keybridge touch id debug' | base64)
FAILED=0
for i in $(seq 1 "$COUNT"); do
  echo "── sign $i/$COUNT - the Touch ID sheet should appear NOW ──" >&2
  START=$(date +%s)
  if KEYBRIDGE_SE_DEBUG=1 "$HELPER" sign --tag "$TAG" --message "$MSG" \
      --reason "keybridge debug prompt $i of $COUNT" \
      > "$OUT/sign-$i.json" 2> "$OUT/sign-$i.err"; then
    RESULT="ok"
  else
    RESULT="FAILED"; FAILED=$((FAILED + 1))
  fi
  echo "   $RESULT after $(( $(date +%s) - START ))s" >&2
  sed 's/^/   | /' "$OUT/sign-$i.err" >&2 || true
  [ "$i" -lt "$COUNT" ] && sleep "$DELAY"
done

rm -f "$HOME/.keybridge/se-keys/$TAG.key"
sleep 1
kill $LOGPID 2>/dev/null || true
trap - EXIT

echo >&2
echo "· done ($((COUNT - FAILED))/$COUNT signed) - full logs in $OUT" >&2
echo "· suspicious LocalAuthentication lines (if any):" >&2
grep -iE 'notInteractive|systemCancel|frontmost|could not|unable|denied|failed' "$OUT/la-stream.log" | tail -40 >&2 || true
