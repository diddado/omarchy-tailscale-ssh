#!/usr/bin/bash
# Regression tests for bin/statefile, the one place this plugin reads and writes
# the rules file. Run with: bash test/statefile.test.sh
#
# Each case here is a concrete attack another process running as this user can
# mount against a predictable path, not a hypothetical: plant a symlink, plant a
# FIFO, grow the file, hard-link it, widen the directory. The plugin must refuse
# every one of them and must never write through a name it did not create.

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
STATEFILE="$HERE/../bin/statefile"

checks=0
failures=0

ok() { checks=$((checks + 1)); printf '  ok   %s\n' "$1"; }
bad() { checks=$((checks + 1)); failures=$((failures + 1)); printf '  FAIL %s\n        %s\n' "$1" "${2-}"; }

expect_rc() {
  local want="$1" label="$2"; shift 2
  local rc=0
  "$@" >/dev/null 2>&1 || rc=$?
  [[ $rc == "$want" ]] && ok "$label" || bad "$label" "expected exit $want, got $rc"
}

section() { printf '\n%s\n' "$1"; }

# A private scratch tree under $HOME, plus a decoy outside it that must survive.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/statefile-test.XXXXXXXX")"
HOMEWORK="$HOME/.cache/statefile-test.$$"
DECOY="$WORK/decoy"
mkdir -p "$HOMEWORK"
printf 'this file must survive\n' >"$DECOY"
trap 'rm -rf -- "$WORK" "$HOMEWORK"' EXIT

section "a write publishes by rename, so a planted symlink is replaced"
ln -sfn "$DECOY" "$HOMEWORK/rules.json"
printf '{"version":2}' | "$STATEFILE" write "$HOMEWORK/rules.json" >/dev/null 2>&1
if [[ "$(cat "$DECOY")" == "this file must survive" ]]; then
  ok "the file the symlink pointed at is untouched"
else
  bad "the file the symlink pointed at is untouched" "it was written through"
fi
[[ -L $HOMEWORK/rules.json ]] \
  && bad "the destination is a real file afterwards" "still a symlink" \
  || ok "the destination is a real file afterwards"
[[ "$(stat -c %a "$HOMEWORK/rules.json")" == "600" ]] \
  && ok "created 0600, not chmod'd to it afterwards" \
  || bad "created 0600" "mode is $(stat -c %a "$HOMEWORK/rules.json")"

section "a read is bound to the descriptor it validated"
ln -sfn /etc/passwd "$HOMEWORK/link.json"
expect_rc 1 "a symlink is refused rather than followed" \
  "$STATEFILE" read "$HOMEWORK/link.json"

mkfifo "$HOMEWORK/fifo.json"
# Without O_NONBLOCK this open would hang forever, before any type check runs --
# inside the process that draws the whole desktop. The timeout is the assertion.
rc=0
timeout 5 "$STATEFILE" read "$HOMEWORK/fifo.json" >/dev/null 2>&1 || rc=$?
[[ $rc == 1 ]] && ok "a FIFO is refused without blocking" \
               || bad "a FIFO is refused without blocking" "exit $rc (124 means it hung)"

printf '{"a":1}' >"$HOMEWORK/linked.json"
ln "$HOMEWORK/linked.json" "$HOMEWORK/hardlink.json"
expect_rc 1 "a hard-linked file is refused" \
  "$STATEFILE" read "$HOMEWORK/linked.json"

section "size is capped at the producer, not after the read"
python3 -c "open('$HOMEWORK/big.json','w').write('x' * (2 << 20))"
expect_rc 1 "a file past the ceiling is refused, not truncated into shape" \
  "$STATEFILE" read "$HOMEWORK/big.json"

section "the path itself is validated"
expect_rc 1 "a relative path is refused" "$STATEFILE" read "rules.json"
expect_rc 1 "a traversal component is refused" "$STATEFILE" read "$HOME/../etc/passwd"
expect_rc 3 "an absent file reports absent, not broken" "$STATEFILE" read "$HOMEWORK/nope.json"

section "a directory symlink in the chain is refused, never repaired"
mkdir -p "$WORK/elsewhere"
ln -sfn "$WORK/elsewhere" "$HOMEWORK/via-link"
expect_rc 1 "a symlinked parent directory is refused" \
  "$STATEFILE" write "$HOMEWORK/via-link/rules.json"
[[ -e $WORK/elsewhere/rules.json ]] \
  && bad "nothing was written through it" "a file appeared in the linked directory" \
  || ok "nothing was written through it"

section "another account's write access to the directory is revoked, every time"
# Read and execute bits do not expose a 0600 file, so they are left alone --
# ~/.local/state is legitimately 0755. What is revoked is the ability of anyone
# else to create, rename or unlink a name in the directory holding the file.
chmod 777 "$HOMEWORK"
printf '{"version":2}' | "$STATEFILE" write "$HOMEWORK/rules.json" >/dev/null 2>&1
mode="$(stat -c %a "$HOMEWORK")"
[[ $(( 8#$mode & 8#022 )) -eq 0 ]] \
  && ok "group and other write are removed on the next write (mode $mode)" \
  || bad "group and other write are removed" "mode is $mode"

chmod 755 "$HOMEWORK"
printf '{"version":2}' | "$STATEFILE" write "$HOMEWORK/rules.json" >/dev/null 2>&1
[[ "$(stat -c %a "$HOMEWORK")" == "755" ]] \
  && ok "a merely readable directory is left as the user set it" \
  || bad "a readable directory is left alone" "mode is $(stat -c %a "$HOMEWORK")"

section "only a JSON object is ever written"
expect_rc 1 "invalid JSON is refused" bash -c "printf 'nope' | '$STATEFILE' write '$HOMEWORK/rules.json'"
expect_rc 1 "a JSON array is refused" bash -c "printf '[1,2]' | '$STATEFILE' write '$HOMEWORK/rules.json'"
expect_rc 1 "an oversized payload is refused" \
  bash -c "python3 -c \"import sys; sys.stdout.write('{\\\"a\\\":\\\"' + 'x'*(2<<20) + '\\\"}')\" | '$STATEFILE' write '$HOMEWORK/rules.json'"

printf '\n'
if [[ $failures -eq 0 ]]; then
  printf 'PASS — %d/%d checks\n' "$checks" "$checks"
else
  printf 'FAIL — %d/%d checks\n' "$((checks - failures))" "$checks"
  exit 1
fi
