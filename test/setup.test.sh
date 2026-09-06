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

gen() { ./bin/setup --print --status-file "test/fixtures/$1.json"; }
rules() { gen "$1" | jq -c '.rules'; }

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
  "$(gen ephemeral | jq -c '[.rules[] | select(.prefix == "app-worker-")]')" \
  '[{"prefix":"app-worker-","group":"App Worker"}]'
check "a LONE ephemeral machine still gets a prefix rule, not a host stub" \
  "$(gen ephemeral | jq -c '[.rules[] | select(.prefix == "media-encoder-")] | length')" \
  '1'
check "no ephemeral machine is written as an exact host rule" \
  "$(gen ephemeral | jq -c '[.rules[] | select(.host? // "" | test("-i-[0-9a-f]{8,}$"))] | length')" \
  '0'

echo
echo "prefix clustering"
check "a prefix covering several stable machines earns a rule" \
  "$(gen tagged | jq -c '[.rules[] | select(.prefix == "app-")] | length')" \
  '1'
check "unrelated stable machines get exact-host stubs" \
  "$(rules flat)" \
  '[{"host":"desktop"},{"host":"nas"},{"host":"router"}]'
check "a machine covered by a prefix is not also given a host stub" \
  "$(gen tagged | jq -c '[.rules[] | select(.host? == "app-primary")] | length')" \
  '0'

echo
echo "tags"
check "a tag on two or more machines earns a rule" \
  "$(gen tagged | jq -c '[.rules[] | select(.tag == "tag:role-app")] | length')" \
  '1'
check "a tag on a single machine does not" \
  "$(gen tagged | jq -c '[.rules[] | select(.tag? == "tag:role-primary")] | length')" \
  '0'

echo
echo "usernames are never invented"
check "no generated rule sets a user" \
  "$(gen ephemeral | jq -c '[.rules[] | select(has("user"))] | length')" \
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
  "$(gen mullvad | jq -c '[.rules[] | select((.host? // "") | test("mullvad"))] | length')" \
  '0'

echo
echo "embedded reference block"
check "the config carries a _readme reference" \
  "$(gen flat | jq -r '._readme | length > 5')" \
  'true'
check "it names the tmux recipe, which is the option people ask about" \
  "$(gen flat | jq -r '[._readme[] | select(test("tmux new -A"))] | length')" \
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
echo "config shape"
check "carries a version stamp" "$(gen flat | jq -r '.version')" '1'
check "seeds a keepalive" "$(gen flat | jq -c '.sshArgs')" '["-o","ServerAliveInterval=30"]'

echo
if [[ $fail -eq 0 ]]; then
  echo "PASS — $pass/$((pass + fail)) checks"
  exit 0
else
  echo "FAIL — $pass/$((pass + fail)) checks"
  exit 1
fi
