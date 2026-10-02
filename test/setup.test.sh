#!/bin/bash
# Generator tests for bin/setup. Run with: bash test/setup.test.sh
# Uses only bash + jq, matching bin/setup's own dependencies.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pass=0
fail=0

check() { # description  actual  expected
  if [[ $2 == "$3" ]]; then
    echo "  ok   $1"
    pass=$((pass + 1))
  else
    echo "  FAIL $1"
    echo "        expected: $3"
    echo "        actual:   $2"
    fail=$((fail + 1))
  fi
}

EMPTY_OUT="$(mktemp -u)"
gen() { ./bin/setup --print --status-file "test/fixtures/$1.json" --output "$EMPTY_OUT"; }
# Rules for the one tailnet the fixture describes.
rules() { gen "$1" | jq -c '[.tailnets[].rules] | add // []'; }
genrules() { gen "$1" | jq -c '[.tailnets[].rules] | add // []'; }

echo
echo "valid JSON for every fixture"
for f in test/fixtures/*.json; do
  name="$(basename "$f" .json)"
  if gen "$name" | jq empty 2>/dev/null; then
    echo "  ok   $name produces valid JSON"
    pass=$((pass + 1))
  else
    echo "  FAIL $name produced invalid JSON"
    fail=$((fail + 1))
  fi
done

echo
echo "ephemeral machines are matched by prefix, never by hostname"
check "a fleet with generated names becomes one prefix rule" \
  "$(gen ephemeral | jq -c '[.tailnets[].rules[] | select(.prefix == "app-worker-")]')" \
  '[{"prefix":"app-worker-","group":"App Worker"}]'
check "a LONE ephemeral machine still gets a prefix rule, not a host stub" \
  "$(gen ephemeral | jq -c '[.tailnets[].rules[] | select(.prefix == "media-encoder-")] | length')" \
  '1'
check "no ephemeral machine is written as an exact host rule" \
  "$(gen ephemeral | jq -c '[.tailnets[].rules[] | select(.host? // "" | test("-i-[0-9a-f]{8,}$"))] | length')" \
  '0'

echo
echo "prefix clustering"
check "a prefix covering several stable machines earns a rule" \
  "$(gen tagged | jq -c '[.tailnets[].rules[] | select(.prefix == "app-")] | length')" \
  '1'
check "unrelated stable machines get exact-host stubs" \
  "$(rules flat)" \
  '[{"host":"desktop"},{"host":"nas"},{"host":"router"}]'
check "a machine covered by a prefix is not also given a host stub" \
  "$(gen tagged | jq -c '[.tailnets[].rules[] | select(.host? == "app-primary")] | length')" \
  '0'

echo
echo "tags"
check "a tag on two or more machines earns a rule" \
  "$(gen tagged | jq -c '[.tailnets[].rules[] | select(.tag == "tag:role-app")] | length')" \
  '1'
check "a tag on a single machine does not" \
  "$(gen tagged | jq -c '[.tailnets[].rules[] | select(.tag? == "tag:role-primary")] | length')" \
  '0'

echo
echo "usernames are never invented"
check "no generated rule sets a user" \
  "$(gen ephemeral | jq -c '[.tailnets[].rules[] | select(has("user"))] | length')" \
  '0'
check "defaultUser is the local account, not a guess" \
  "$(gen flat | jq -r '.defaultUser')" \
  "${USER:-$(id -un)}"

echo
echo "edge cases"
check "an empty tailnet yields a valid, empty ruleset rather than an error" \
  "$(rules empty)" \
  '[]'
check "a single-machine tailnet works" \
  "$(rules single)" \
  '[{"host":"desktop"}]'
check "mullvad exit nodes are never offered as ssh targets" \
  "$(gen mullvad | jq -c '[.tailnets[].rules[] | select((.host? // "") | test("mullvad"))] | length')" \
  '0'

echo
echo "embedded reference block"
check "the config carries a _readme reference" \
  "$(gen flat | jq -r '._readme | length > 5')" \
  'true'
check "it names the tmux recipe, which is the option people ask about" \
  "$(gen flat | jq -r '[._readme[] | select(test("tmux new -A"))] | length')" \
  '1'
# The escape hatch must never ship undocumented in the very file people edit.
check "it names the loginShell opt-in" \
  "$(gen flat | jq -r '[._readme[] | select(test("loginShell"))] | length')" \
  '1'
# The block is duplicated between Model.js and bin/setup because bash cannot
# import the JS and node is not a runtime dependency. This is the guard.
if command -v node >/dev/null; then
  check "bin/setup and Model.js emit an identical reference block" \
    "$(gen flat | jq -S -c '._readme')" \
    "$(node -e 'process.stdout.write(JSON.stringify(require("./Model.js").CONFIG_HELP))' | jq -S -c '.')"
else
  echo "  skip node not present; cannot compare against Model.js"
fi

echo
echo "multiple tailnets"
TMPCFG="$(mktemp)"; trap 'rm -f "$TMPCFG"' EXIT

./bin/setup --yes --status-file test/fixtures/ephemeral.json --output "$TMPCFG" >/dev/null
check "first run creates a section for the connected tailnet" \
  "$(jq -c '.tailnets | keys' "$TMPCFG")" \
  '["example-net.ts.net"]'

./bin/setup --yes --status-file test/fixtures/other-tailnet.json --output "$TMPCFG" >/dev/null
check "setting up a second tailnet keeps the first" \
  "$(jq -c '.tailnets | keys | sort' "$TMPCFG")" \
  '["example-net.ts.net","other-net.ts.net"]'
check "the first tailnet's rules are untouched" \
  "$(jq -c '[.tailnets["example-net.ts.net"].rules[] | select(.prefix == "app-worker-")] | length' "$TMPCFG")" \
  '1'
check "the second tailnet gets its own machines" \
  "$(jq -c '[.tailnets["other-net.ts.net"].rules[].host] | sort' "$TMPCFG")" \
  '["gateway","vault"]'
check "each tailnet records its display name" \
  "$(jq -r '.tailnets["other-net.ts.net"].name' "$TMPCFG")" \
  'other.org'

echo
echo "an old flat config is preserved, never reattributed"
V1="$(mktemp)"
cat >"$V1" <<'V1EOF'
{ "version": 1, "defaultUser": "someone", "rules": [ { "host": "legacy-box", "user": "root" } ] }
V1EOF
./bin/setup --yes --status-file test/fixtures/other-tailnet.json --output "$V1" >/dev/null
check "a v1 file is rewritten as a v2 document" "$(jq -r '.version' "$V1")" '2'
check "with a section for the tailnet that was connected" \
  "$(jq -c '.tailnets | keys' "$V1")" \
  '["other-net.ts.net"]'
# Which tailnet a flat v1 file was written for is not knowable, so its rules are
# neither adopted nor discarded -- they are carried through untouched.
check "unattributed rules from the old schema are preserved, not misfiled" \
  "$(jq -c '[.rules[].host]' "$V1")" \
  '["legacy-box"]'
check "and are not claimed by the connected tailnet" \
  "$(jq -c '[.tailnets["other-net.ts.net"].rules[] | select(.host == "legacy-box")] | length' "$V1")" \
  '0'
check "an existing defaultUser is preserved, not overwritten" \
  "$(jq -r '.defaultUser' "$V1")" 'someone'
rm -f "$V1"

echo
echo "config shape"
check "carries a version stamp" "$(gen flat | jq -r '.version')" '2'
check "seeds a keepalive" "$(gen flat | jq -c '.sshArgs')" '["-o","ServerAliveInterval=30"]'

echo
if [[ $fail -eq 0 ]]; then
  echo "PASS — $pass/$((pass + fail)) checks"
  exit 0
else
  echo "FAIL — $pass/$((pass + fail)) checks"
  exit 1
fi
