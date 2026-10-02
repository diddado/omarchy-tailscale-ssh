#!/usr/bin/bash
# Static invariants for the whole tree. Run with: bash test/audit.test.sh
#
# These are the properties that are easy to lose in a later edit and expensive
# to notice: one Text left on AutoText, one StdioCollector added back, one bare
# `cat` on a predictable path. Each is a grep, so it stays honest.

set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 1

checks=0
failures=0
ok() { checks=$((checks + 1)); printf '  ok   %s\n' "$1"; }
bad() { checks=$((checks + 1)); failures=$((failures + 1)); printf '  FAIL %s\n        %s\n' "$1" "${2-}"; }
section() { printf '\n%s\n' "$1"; }

# Passes when the pattern matches nothing in the plugin's own source.
forbid() {
  local label="$1" pattern="$2"; shift 2
  local hits
  # -H so a single-file search still prints the name, which keeps the
  # comment filter below anchored the same way in both cases.
  hits="$(grep -rHnE "$pattern" "$@" 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*(//|#)' || true)"
  [[ -z $hits ]] && ok "$label" || bad "$label" "$(printf '%s' "$hits" | head -3)"
}

QML=(Panel.qml Service.qml TailscaleSshIcon.qml)
SH=(bin/setup bin/tailscale-status scripts/dev-install.sh)

section "QML rendering sinks"
missing="$(python3 - <<'PY'
import re, glob
out = []
for f in sorted(glob.glob('**/*.qml', recursive=True)):
    src = open(f).read()
    for m in re.finditer(r'\b(Text|Label|TextEdit)\s*\{', src):
        i, depth = m.end(), 1
        while i < len(src) and depth:
            depth += (src[i] == '{') - (src[i] == '}'); i += 1
        if 'textFormat:' not in src[m.end():i]:
            out.append("%s:%d" % (f, src[:m.start()].count('\n') + 1))
print("\n".join(out))
PY
)"
[[ -z $missing ]] && ok "every Text, Label and TextEdit names its textFormat" \
                  || bad "every Text names its textFormat" "$missing"

# PanelHero, PanelSectionHeader and every tooltipText are rendered by the shell
# with Text.AutoText, which a plugin cannot pin to PlainText. Anything variable
# reaching one has to go through Model.plain first; a literal is fine as it is.
unstripped="$(python3 - <<'PY'
import re, glob

# The properties of host-owned components that end up in an AutoText sink.
HOST_BLOCKS = {"PanelHero": ("title", "meta"), "PanelSectionHeader": ("text",)}
out = []

def literal(value):
    return re.fullmatch(r'"[^"]*"', value.strip()) is not None

def stripped(value):
    return "plain(" in value

for f in sorted(glob.glob("*.qml")):
    src = open(f).read()
    lines = src.split("\n")
    for i, line in enumerate(lines):
        m = re.match(r"\s*tooltipText:\s*(.+)$", line)
        if m:
            value = m.group(1)
            # A value may wrap onto following lines; take the whole expression.
            j = i
            while not literal(value) and not stripped(value) and j + 1 < len(lines) \
                    and re.match(r"\s*[?:]", lines[j + 1]):
                j += 1
                value += " " + lines[j].strip()
            if not literal(value) and not stripped(value):
                out.append("%s:%d tooltipText" % (f, i + 1))
    for comp, props in HOST_BLOCKS.items():
        for m in re.finditer(r"\b%s\s*\{" % comp, src):
            k, depth = m.end(), 1
            while k < len(src) and depth:
                depth += (src[k] == "{") - (src[k] == "}")
                k += 1
            body = src[m.end():k]
            for prop in props:
                for pm in re.finditer(r"^\s*%s:\s*(.+)$" % prop, body, re.M):
                    value = pm.group(1)
                    if not literal(value) and not stripped(value):
                        line = src[:m.end() + pm.start()].count("\n") + 1
                        out.append("%s:%d %s.%s" % (f, line, comp, prop))
print("\n".join(out))
PY
)"
[[ -z $unstripped ]] && ok "host-rendered sinks take either a literal or a stripped value" \
                     || bad "host-rendered sinks are stripped" "$unstripped"

section "process output is bounded at the producer"
forbid "no StdioCollector anywhere" '^[^/]*\bStdioCollector\s*\{' "${QML[@]}"
forbid "no shell string is ever built for execution" '(execDetached|\.run)\(\s*"|"(ba)?sh",\s*"-l?c"' "${QML[@]}"
forbid "no bare interpreter name in a QML command" '"(bash|sh|python3?|jq|tailscale|wl-copy|mkdir|cat)"' "${QML[@]}"

section "shell helpers resolve executables absolutely"
forbid "no command -v resolution of anything that runs" '\bcommand -v\b' "${SH[@]}"
forbid "no unbounded read of a predictable path" '^\s*(cat|head -c [0-9]+) +"?\$(OUTPUT|STATUS_FILE)' "${SH[@]}"
forbid "no mktemp outside the destination directory" '\bmktemp\b(?! -d)' bin/setup
forbid "no mkdir -p on a path that is then trusted" '\bmkdir -p\b' bin/setup

section "no agent instruction files ship in the installable tree"
found=""
for f in AGENTS.md CLAUDE.md GEMINI.md .claude .codex .agents .gemini .cursor; do
  [[ -e $f ]] && found="$found $f"
done
[[ -z $found ]] && ok "none present" || bad "none present" "found:$found"

section "repository hygiene"
big="$(find . -path ./.git -prune -o -type f -size +512k -print 2>/dev/null || true)"
[[ -z $big ]] && ok "no file exceeds the scanner's 512 KiB text limit" || bad "no oversized file" "$big"

nul="$(grep -rlP '\x00' --include='*.qml' --include='*.js' --include='*.sh' --include='*.json' . 2>/dev/null || true)"
[[ -z $nul ]] && ok "no NUL byte in a source file" || bad "no NUL byte" "$nul"

[[ -f preview.png ]] && ok "preview.png is present at the root" || bad "preview.png present" "missing"
[[ -f LICENSE ]] && ok "a licence file is present" || bad "licence present" "missing"

id_manifest="$(python3 -c 'import json;print(json.load(open("manifest.json"))["id"])')"
grep -q "$id_manifest" README.md && ok "the manifest id appears in the README" \
                                 || bad "manifest id in README" "$id_manifest"
grep -q "moduleName: \"$id_manifest\"" Panel.qml && ok "Panel moduleName matches the manifest id" \
                                                 || bad "moduleName matches" "$id_manifest"
grep -q "ipcTarget: \"$id_manifest\"" Panel.qml && ok "ipcTarget matches the manifest id" \
                                                || bad "ipcTarget matches" "$id_manifest"
grep -q "omarchy plugin remove $id_manifest" README.md \
  && ok "the README documents the real removal command" \
  || bad "README removal command" "not found"

section "no hard-coded home paths"
forbid "nothing refers to a specific user's home" '/home/[a-z]' "${QML[@]}" "${SH[@]}" Model.js manifest.json

section "a closed stdin is reopened before the next write"
# onStarted sets stdinEnabled = false to deliver EOF. That is an imperative
# assignment over an initial value, so it never comes back by itself: without a
# reset in startWrite, the second save of a session blocks the helper in read()
# until the deadline kills it, and the save is lost. Cost a release to find once.
if grep -qE '^\s*writeProc\.stdinEnabled = true' Service.qml; then
  ok "startWrite reopens stdin before running the helper"
else
  bad "startWrite reopens stdin before running the helper" \
      "writeProc.stdinEnabled = true is missing; only the first save of a session will work"
fi

section "the remote command is quoted in exactly one place"
# The '"'"' idiom is subtle enough that a second, slightly-different copy is how
# quoting bugs actually ship. One definition, reused.
quoters="$(grep -cE "replace\(/'/g" Model.js || true)"
[[ $quoters == 1 ]] && ok "shellQuote is the only POSIX quoter in Model.js" \
                    || bad "shellQuote is the only POSIX quoter in Model.js" \
                           "found $quoters definitions, expected 1"

# Asserting the string is not the same as proving the property. Hand each
# hostile value to a real shell and require it back byte for byte: equality
# proves the quoting is lossless AND that nothing expanded on the way through.
if command -v node >/dev/null; then
  roundtrip_failures=""
  while IFS= read -r raw; do
    payload="$(node -e 'process.stdout.write(require("./Model.js").shellQuote(process.argv[1]))' "$raw")"
    got="$(bash -c "printf %s $payload")"
    [[ $got == "$raw" ]] || roundtrip_failures+="$raw -> $got"$'\n'
  done <<'HOSTILE'
echo it's fine
'; id; echo '
$(id)
`id`
a'b'c'd
"
\
x; rm -rf ~
HOSTILE
  [[ -z $roundtrip_failures ]] && ok "every quoted command survives a real shell unchanged" \
                               || bad "every quoted command survives a real shell unchanged" \
                                      "$(printf '%s' "$roundtrip_failures" | head -3)"
else
  echo "  skip node not present; cannot round-trip shellQuote"
fi

printf '\n'
if [[ $failures -eq 0 ]]; then
  printf 'PASS — %d/%d checks\n' "$checks" "$checks"
else
  printf 'FAIL — %d/%d checks\n' "$((checks - failures))" "$checks"
  exit 1
fi
