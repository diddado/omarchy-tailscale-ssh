// Rule-engine tests. Run with: node test/model.test.js
// No dependencies and no shell required — this is the fast feedback loop for
// anything in Model.js.

var Model = require("../Model.js")

var failures = 0
var checks = 0

function eq(actual, expected, label) {
  checks++
  var a = JSON.stringify(actual)
  var b = JSON.stringify(expected)
  if (a !== b) {
    failures++
    console.error("  FAIL " + label + "\n        expected: " + b + "\n        actual:   " + a)
  } else {
    console.log("  ok   " + label)
  }
}

function section(name) {
  console.log("\n" + name)
}

// Generic fixtures: a couple of stable machines plus two fleets of ephemeral
// instances whose hostnames carry a machine-generated suffix.
function peer(hostName, tags, online) {
  return {
    HostName: hostName,
    DNSName: hostName + ".example-net.ts.net",
    DisplayName: hostName,
    TailscaleIPs: ["100.64.0.1"],
    TailscaleIPv6: [],
    Online: online !== false,
    OS: "linux",
    Tags: tags || []
  }
}

var PEERS = {
  desktop: peer("desktop"),
  laptop: peer("laptop"),
  oldLaptop: peer("old-laptop", [], false),
  appPrimary: peer("app-primary", ["tag:role-primary"]),
  appSecondary: peer("app-secondary", ["tag:role-app"]),
  worker: peer("app-worker-i-0b1e031df86719510", ["tag:role-worker"]),
  workerOffline: peer("app-worker-i-06f8e962059c3d7a3", ["tag:role-worker"], false),
  media: peer("media-encoder-i-03a09331616e96f5d", ["tag:role-encoder"]),
  nas: peer("nas")
}

var CONFIG = {
  fallbackUser: "localuser",
  defaultUser: "localuser",
  connectVia: "dns",
  sshArgs: ["-o", "ServerAliveInterval=30"],
  rules: [
    { prefix: "app-", user: "ubuntu", group: "App tier" },
    { prefix: "app-worker-", user: "deploy", group: "Workers" },
    { prefix: "media-encoder-", user: "encoder", group: "Media" },
    { tag: "tag:role-primary", group: "Primaries", command: "journalctl --user -fu app" },
    { regex: "^app-(primary|secondary)$", sshArgs: ["-o", "StrictHostKeyChecking=accept-new"] },
    { host: "desktop", user: "chris", group: "Home", label: "Desktop" },
    { host: "laptop", user: "deploy", port: 2222, group: "Home" }
  ]
}

function resolve(p) {
  return Model.resolveTarget(p, CONFIG)
}

section("prefix rules cover ephemeral instances")
eq(resolve(PEERS.media).user, "encoder", "media-encoder-i-* -> encoder via prefix")
eq(resolve(PEERS.media).group, "Media", "prefix rule also sets the group")

section("longest prefix wins")
eq(resolve(PEERS.worker).user, "deploy",
   "app-worker-i-* -> deploy (longer prefix beats 'app-')")
eq(resolve(PEERS.worker).group, "Workers", "longer prefix's group wins too")

section("exact host beats prefix, and merges rather than replaces")
eq(resolve(PEERS.laptop).user, "deploy", "laptop -> deploy via exact host")
eq(resolve(PEERS.laptop).port, 2222, "exact host rule sets a non-standard port")
eq(resolve(PEERS.desktop).user, "chris", "desktop -> chris")
eq(resolve(PEERS.desktop).label, "Desktop", "exact host rule sets a display label")

section("tag rules")
eq(resolve(PEERS.appPrimary).group, "Primaries", "tag rule sets group")
eq(resolve(PEERS.appPrimary).user, "ubuntu",
   "tag rule leaves the user from the weaker prefix rule intact")
eq(resolve(PEERS.appPrimary).command, "journalctl --user -fu app", "tag rule sets a connect command")
eq(resolve(PEERS.appSecondary).group, "App tier",
   "a peer with a different tag falls back to the prefix rule's group")

section("regex rules")
eq(resolve(PEERS.appPrimary).sshArgs,
   ["-o", "ServerAliveInterval=30", "-o", "StrictHostKeyChecking=accept-new"],
   "regex rule appends to the global sshArgs rather than replacing them")
eq(resolve(PEERS.worker).sshArgs, ["-o", "ServerAliveInterval=30"],
   "a non-matching regex contributes nothing")

section("defaults")
eq(resolve(PEERS.nas).user, "localuser", "an unmatched host falls back to defaultUser")
eq(resolve(PEERS.nas).group, "", "an unmatched host has no group")
eq(Model.resolveTarget(PEERS.appSecondary, { fallbackUser: "someone", rules: [] }).user, "someone",
   "with no defaultUser, $USER is the fallback")

section("tier precedence is exact > tag > regex > prefix")
var tiers = Model.matchingRules(PEERS.appPrimary, CONFIG.rules).map(function (m) {
  return m.rule.prefix || m.rule.regex || m.rule.tag || m.rule.host
})
eq(tiers, ["app-", "^app-(primary|secondary)$", "tag:role-primary"],
   "matches are ordered weakest-first for a left-to-right merge")

section("address resolution")
eq(resolve(PEERS.desktop).address, "desktop.example-net.ts.net", "connectVia dns uses MagicDNS")
eq(Model.resolveAddress(PEERS.desktop, "ip"), "100.64.0.1", "connectVia ip uses the 100.x address")
eq(Model.resolveAddress(PEERS.desktop, "hostname"), "desktop", "connectVia hostname uses the bare name")

section("argv construction")
eq(Model.sshArgv(PEERS.desktop, resolve(PEERS.desktop), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-desktop", "ssh",
    "-o", "ServerAliveInterval=30", "--", "chris@desktop.example-net.ts.net"],
   "plain login builds a flat argv vector, destination after --")
eq(Model.sshArgv(PEERS.laptop, resolve(PEERS.laptop), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-laptop", "ssh",
    "-p", "2222", "-o", "ServerAliveInterval=30", "--", "deploy@laptop.example-net.ts.net"],
   "a port lands as a separate -p argument")
eq(Model.sshArgv(PEERS.appPrimary, resolve(PEERS.appPrimary), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-app-primary", "ssh",
    "-o", "ServerAliveInterval=30", "-o", "StrictHostKeyChecking=accept-new",
    "-t", "--", "ubuntu@app-primary.example-net.ts.net", "journalctl --user -fu app"],
   "a connect command adds -t and trails the command as one argv element")

section("a connect command can opt into the remote login shell")
// `ssh host CMD` runs CMD under `$SHELL -c` -- no profile, so no locale and no
// profile PATH. Opting in asks for the login shell a bare `ssh host` would give.
eq(Model.remoteCommand("tmux new -A -s work", true),
   "exec \"$SHELL\" -l -c 'tmux new -A -s work'",
   "the command is wrapped and quoted into a single word")
eq(Model.remoteCommand("tmux new -A -s work", false), "tmux new -A -s work",
   "opting out leaves the command exactly as written")
eq(Model.remoteCommand("tmux new -A -s work", undefined), "tmux new -A -s work",
   "and so does saying nothing: off is the default")
eq(Model.remoteCommand("", true), "", "nothing to wrap when there is no command")

var LOGIN_CFG = {
  fallbackUser: "localuser",
  rules: [{ host: "build-runner", user: "ubuntu", command: "tmux new -A -s work", loginShell: true }]
}
var runner = peer("build-runner")
eq(Model.sshArgv(runner, Model.resolveTarget(runner, LOGIN_CFG), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-build-runner", "ssh",
    "-t", "--", "ubuntu@build-runner.example-net.ts.net",
    "exec \"$SHELL\" -l -c 'tmux new -A -s work'"],
   "only the trailing element changes; -t and -- stay where they were")

var OFF_CFG = {
  fallbackUser: "localuser",
  rules: [{ host: "build-runner", user: "ubuntu", command: "tmux new -A -s work" }]
}
eq(Model.sshArgv(runner, Model.resolveTarget(runner, OFF_CFG), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-build-runner", "ssh",
    "-t", "--", "ubuntu@build-runner.example-net.ts.net", "tmux new -A -s work"],
   "without the opt-in the vector is byte-identical to before the feature existed")

var BARE_CFG = { fallbackUser: "localuser", rules: [{ host: "nas", loginShell: true }] }
eq(Model.sshArgv(PEERS.nas, Model.resolveTarget(PEERS.nas, BARE_CFG), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-nas", "ssh",
    "--", "localuser@nas.example-net.ts.net"],
   "with no command it is a no-op: no -t, no trailing element")

section("the remote command cannot escape its quoting")
// The emitted form is a run of single-quoted spans joined by escaped quotes, so
// every input byte sits inside quotes and nothing is left in a position a shell
// would expand. This regex IS the proof: it admits only those two shapes.
var QUOTED = /^'([^']|'\\'')*'$/
var HOSTILE = [
  "echo it's fine",
  "'; id; echo '",
  "$(id)",
  "`id`",
  "a'b'c'd",
  "\"",
  "\\",
  "x; rm -rf ~"
]
for (var h = 0; h < HOSTILE.length; h++) {
  eq(QUOTED.test(Model.shellQuote(HOSTILE[h])), true,
     "quoted form is only quoted spans and escaped quotes: " + JSON.stringify(HOSTILE[h]))
}
eq(Model.remoteCommand("echo it's fine", true),
   "exec \"$SHELL\" -l -c 'echo it'\\''s fine'",
   "a single quote closes, escapes and reopens -- it cannot end the word")
eq(Model.remoteCommand("$(id)", true), "exec \"$SHELL\" -l -c '$(id)'",
   "command substitution is inert inside single quotes")

var hostilePeer = peer("build-runner")
var hostileArgv = Model.sshArgv(hostilePeer, Model.resolveTarget(hostilePeer, {
  fallbackUser: "localuser",
  rules: [{ host: "build-runner", command: "'; id; echo '", loginShell: true }]
}), "x")
eq(hostileArgv.length, 7,
   "quoting never adds an argv element, however many quotes the command carries")

section("loginShell merges like every other field")
function resolveLogin(rules) {
  var p = peer("app-worker-i-0b1e031df86719510")
  return Model.resolveTarget(p, { fallbackUser: "u", rules: rules }).loginShell
}
eq(resolveLogin([{ prefix: "app-", loginShell: true }]), true, "a prefix rule can turn it on")
eq(resolveLogin([{ prefix: "app-", loginShell: true },
                 { host: "app-worker-i-0b1e031df86719510", loginShell: false }]), false,
   "and an exact host can turn it back off -- explicit false beats an inherited true")
eq(resolveLogin([]), false, "unmentioned resolves to off")
eq(Model.sanitizeRule({ host: "x", loginShell: "yes" }).loginShell, false,
   "only a literal true counts; a hand-edited \"yes\" is not consent")
eq(Object.prototype.hasOwnProperty.call(Model.sanitizeRule({ host: "x" }), "loginShell"), false,
   "absent stays absent, so inherit is distinguishable from explicit false")
var lsDoc = Model.withTailnetRules(Model.emptyDocument(), "t.ts.net", "t",
                                   [{ host: "x", loginShell: true }])
eq(Model.configForTailnet(Model.parseConfigDocument(Model.serializeDocument(lsDoc)).doc,
                          "t.ts.net").rules,
   [{ host: "x", loginShell: true }], "it survives a serialize/parse round trip")

section("the editor round-trips the login-shell box")
var EDIT_SCOPE = { kind: "host", value: "build-runner" }
var ticked = Model.upsertRule([], EDIT_SCOPE, { user: "ubuntu", port: 0, command: "btop", loginShell: true })
eq(ticked, [{ host: "build-runner", user: "ubuntu", command: "btop", loginShell: true }],
   "ticking the box writes the key")
eq(Model.ruleFieldsFor(ticked, EDIT_SCOPE),
   { user: "ubuntu", port: 0, command: "btop", loginShell: true },
   "and the form reads it back")
eq(Model.upsertRule(ticked, EDIT_SCOPE, { user: "ubuntu", port: 0, command: "btop", loginShell: false }),
   [{ host: "build-runner", user: "ubuntu", command: "btop" }],
   "unticking removes the key rather than parking an explicit false")
eq(Model.upsertRule([{ host: "nas", loginShell: true }], { kind: "host", value: "nas" },
                    { user: "", port: 0, command: "", loginShell: false }),
   [], "a rule left holding only its matcher is dropped entirely")
eq(Model.ruleFieldsFor([], EDIT_SCOPE), { user: "", port: 0, command: "", loginShell: false },
   "a scope with no rule yet reads back unticked")
// The editor sends only user/port/command. Without loginShell in RULE_FIELDS,
// sanitizeRules would silently drop a hand-written opt-in on the next Save.
eq(Model.upsertRule([{ host: "build-runner", command: "btop", loginShell: true }],
                    EDIT_SCOPE, { user: "ubuntu", port: 0, command: "btop" }),
   [{ host: "build-runner", command: "btop", loginShell: true, user: "ubuntu" }],
   "a hand-written opt-in survives a save that never mentions it")

section("a machine cannot name itself into an ssh option or a shell")
// Hostnames are chosen by whoever owns the machine, so they are the input this
// plugin trusts least. Each of these is refused outright rather than quoted:
// ssh reads argv with getopt, so "-oProxyCommand=..." in the destination slot
// is a command, and a repaired hostname would connect somewhere unintended.
function targetFor(name, extra) {
  var p = peer(name)
  var cfg = { fallbackUser: "localuser", rules: extra || [] }
  return { peer: p, target: Model.resolveTarget(p, cfg) }
}

var evil = targetFor("evil$(id)host")
eq(Model.sshArgv(evil.peer, evil.target, "x"), [],
   "a hostname with shell syntax is refused, not quoted")
eq(evil.target.problem !== "", true, "and the panel is told why")
eq(Model.sshCommandText(evil.peer, evil.target), "",
   "there is no ssh command text to copy for a refused target")

var dashHost = targetFor("x", [{ prefix: "x", address: "-oProxyCommand=curl evil.example" }])
eq(Model.sshArgv(dashHost.peer, dashHost.target, "x"), [],
   "an address that is really an ssh option is refused")

var dashUser = targetFor("x", [{ prefix: "x", user: "-oProxyCommand=id" }])
eq(Model.sshArgv(dashUser.peer, dashUser.target, "x"), [],
   "a login user that is really an ssh option is refused")

var spaced = targetFor("host -e touch /tmp/pwned")
eq(Model.sshArgv(spaced.peer, spaced.target, "x"), [],
   "a hostname carrying a space and a flag is refused outright")

// omarchy-launch-tui expands --app-id=$APP_ID unquoted, so the window id may
// carry nothing that can word-split or glob -- even for a hostname that is
// otherwise a perfectly legal ssh destination.
var bracketed = targetFor("a:b[c]")
var bracketArgv = Model.sshArgv(bracketed.peer, bracketed.target, "org.omarchy.tailssh")
eq(bracketArgv.length > 0, true, "a bracketed name is still a usable destination")
eq(/^--app-id=[A-Za-z0-9._-]+$/.test(bracketArgv[1]), true,
   "but the window id it produces cannot word-split or glob")

// Clamping happens where the JSON is parsed, so this goes through parseStatus.
var controlStatus = Model.parseStatus(JSON.stringify({
  BackendState: "Running",
  Peer: { a: { HostName: "host\u0007\u202ename", Online: true } }
}))
eq(/[\u0000-\u001f\u202a-\u202e]/.test(controlStatus.peers[0].HostName), false,
   "control and bidi characters are stripped from a hostname on the way in")

section("bounds hold after the byte cap")
var many = { BackendState: "Running", MagicDNSSuffix: "example-net.ts.net", Peer: {} }
for (var b = 0; b < 3000; b++) {
  many.Peer["k" + b] = { HostName: "h" + b, DNSName: "h" + b + ".example-net.ts.net.", Online: true }
}
var bounded = Model.parseStatus(JSON.stringify(many))
eq(bounded.peers.length, 2000, "the peer list stops at the ceiling")
eq(bounded.truncated, true, "and says that it did")

var longName = Model.parseStatus(JSON.stringify({
  BackendState: "Running",
  Peer: { a: { HostName: new Array(5000).join("z"), Online: true } }
}))
eq(longName.peers[0].HostName.length <= 512, true, "a single enormous hostname is capped")

var manyTags = Model.parseStatus(JSON.stringify({
  BackendState: "Running",
  Peer: { a: { HostName: "t", Online: true, Tags: new Array(500).join(",").split(",").map(function (_, i) { return "tag:" + i }) } }
}))
eq(manyTags.peers[0].Tags.length <= 32, true, "a machine cannot advertise unbounded tags")

section("a rules file cannot reach Object.prototype")
var polluted = Model.parseConfigDocument(JSON.stringify({
  version: 2,
  tailnets: { "__proto__": { rules: [{ host: "x", user: "root" }] }, "real.ts.net": { rules: [] } }
}))
eq(({}).rules, undefined, "a tailnet named __proto__ does not touch Object.prototype")
eq(polluted.doc.tailnets["real.ts.net"] !== undefined, true, "the real tailnet still parses")

var pollutedRule = Model.upsertRule([{ "__proto__": "x", host: "a" }],
                                    { kind: "host", value: "a" }, { user: "root" })
eq(({}).user, undefined, "upsertRule does not pollute the prototype either")
eq(Array.isArray(pollutedRule), true, "and still returns a rules array")

section("hidden and filtering")
var hiddenCfg = { fallbackUser: "localuser", rules: [{ prefix: "old-", hidden: true }] }
eq(Model.resolveTarget(PEERS.oldLaptop, hiddenCfg).hidden, true, "hidden: true is honored")
var entry = { peer: PEERS.worker, target: resolve(PEERS.worker) }
eq(Model.matchesFilter(entry, "worker"), true, "filter matches hostname")
eq(Model.matchesFilter(entry, "role-worker"), true, "filter matches tag")
eq(Model.matchesFilter(entry, "worker deploy"), true, "space-separated terms all must match")
eq(Model.matchesFilter(entry, "worker nope"), false, "a non-matching term rejects")

section("grouping")
var entries = Object.keys(PEERS).map(function (k) {
  return { peer: PEERS[k], target: resolve(PEERS[k]) }
})
var groups = Model.groupPeers(entries, true)
eq(groups[groups.length - 1].name, "OFFLINE", "offline machines collect in a trailing group")
eq(Model.groupPeers(entries, false).some(function (g) { return g.name === "OFFLINE" }), false,
   "showOffline: false drops them entirely")

section("status parsing")
var status = Model.parseStatus(JSON.stringify({
  BackendState: "Running",
  MagicDNSSuffix: "example-net.ts.net",
  CurrentTailnet: { Name: "example.com" },
  Self: { HostName: "old-acer", DNSName: "old-acer.example-net.ts.net." },
  Peer: {
    "nodekey:a": { HostName: "desktop", DNSName: "desktop.example-net.ts.net.", TailscaleIPs: ["100.1.2.3", "fd7a:115c:a1e0::1"], Online: true, OS: "linux" },
    "nodekey:b": { HostName: "gone", DNSName: "gone.example-net.ts.net.", TailscaleIPs: ["100.1.2.4"], Online: false, OS: "linux" },
    "nodekey:c": { HostName: "mullvad-se", DNSName: "se.mullvad.ts.net.", TailscaleIPs: ["100.1.2.5"], Online: true, Tags: ["tag:mullvad"] }
  }
}))
eq(status.ok, true, "valid status parses")
eq(status.tailnetName, "example.com", "tailnet name is extracted")
eq(status.peers.length, 2, "mullvad exit nodes are excluded")
eq(status.peers.map(function (p) { return p.HostName }), ["desktop", "gone"],
   "offline peers are kept and sorted last")
eq(status.peers[0].TailscaleIPs, ["100.1.2.3"], "IPs are filtered to the 100.x v4 address")
eq(status.peers[0].DNSName, "desktop.example-net.ts.net", "the trailing dot is stripped")
eq(Model.parseStatus("not json").ok, false, "malformed JSON returns ok: false rather than throwing")
eq(Model.parseStatus("").ok, false, "empty output returns ok: false")

section("rules file parsing")
eq(Model.parseRules('{"defaultUser":"a","sshArgs":"-o X=1","rules":[{"host":"h"}]}'),
   { ok: true, error: "", defaultUser: "a", connectVia: "", sshArgs: ["-o", "X=1"], rules: [{ host: "h" }] },
   "a string sshArgs is split on whitespace as a convenience")
eq(Model.parseRules("{bad json").ok, false, "a malformed rules file degrades rather than throwing")
eq(Model.resolveTarget(PEERS.desktop, { rules: [{ regex: "([", user: "x" }], fallbackUser: "localuser" }).user,
   "localuser", "a malformed regex is ignored instead of breaking resolution")

section("ephemeral detection")
eq(Model.stablePrefix("app-worker-i-0b1e031df86719510"), "app-worker-",
   "an AWS-style instance id reduces to its stable prefix")
eq(Model.stablePrefix("media-encoder-i-03a09331616e96f5d"), "media-encoder-",
   "a lone ephemeral machine still yields a prefix")
eq(Model.stablePrefix("db-primary"), "", "a stable name yields no prefix")
eq(Model.stablePrefix("app-3f2a1b9c4d5e"), "app-", "a long bare hex tail counts as ephemeral")
// The threshold is deliberately conservative: short tails are far more likely to
// be deliberate names than generated ones, and a false positive would hide a
// real machine behind a prefix rule the user never asked for.
eq(Model.stablePrefix("web-2024"), "", "a short numeric tail is a name, not an id")
eq(Model.stablePrefix("rack-4f"), "", "a short hex tail is a name, not an id")
eq(Model.isEphemeral("desktop"), false, "an ordinary name is not ephemeral")

section("quick-assign scopes")
eq(Model.ruleScopes(PEERS.worker, CONFIG).map(function (x) { return x.kind + ":" + x.value }),
   ["prefix:app-worker-", "tag:tag:role-worker", "host:app-worker-i-0b1e031df86719510"],
   "an existing prefix rule is preferred over a derived one, and host is last")
eq(Model.ruleScopes(PEERS.nas, { rules: [] }).map(function (x) { return x.kind }),
   ["host"],
   "a stable, untagged machine offers only the host scope")
eq(Model.ruleScopes(PEERS.media, { rules: [] }).map(function (x) { return x.kind + ":" + x.value })[0],
   "prefix:media-encoder-",
   "with no rules yet, the prefix scope is derived from the ephemeral name")

section("writing rules from the form")
eq(Model.upsertRule([], { kind: "prefix", value: "app-" }, { user: "ubuntu", port: 0, command: "" }),
   [{ prefix: "app-", user: "ubuntu" }],
   "a new rule keeps only the fields that were filled in")
eq(Model.upsertRule([{ prefix: "app-", user: "ubuntu" }], { kind: "prefix", value: "app-" }, { port: 2222 }),
   [{ prefix: "app-", user: "ubuntu", port: 2222 }],
   "an existing rule is merged, not replaced")
eq(Model.upsertRule([{ prefix: "app-", user: "ubuntu" }], { kind: "prefix", value: "app-" }, { user: "" }),
   [],
   "clearing the last field drops the rule instead of pinning an empty user")
eq(Model.upsertRule([{ host: "a", user: "x" }], { kind: "host", value: "b" }, { user: "y" }),
   [{ host: "a", user: "x" }, { host: "b", user: "y" }],
   "an unrelated rule is untouched")
var before = [{ prefix: "app-", user: "ubuntu" }]
Model.upsertRule(before, { kind: "prefix", value: "app-" }, { user: "changed" })
eq(before, [{ prefix: "app-", user: "ubuntu" }], "the input array is not mutated")

section("form shows what the rule sets, not what resolves")
eq(Model.ruleFieldsFor(CONFIG.rules, { kind: "prefix", value: "app-worker-" }),
   { user: "deploy", port: 0, command: "", loginShell: false },
   "reads back the rule's own fields")
eq(Model.ruleFieldsFor(CONFIG.rules, { kind: "host", value: "app-worker-i-0b1e031df86719510" }),
   { user: "", port: 0, command: "", loginShell: false },
   "a scope with no rule yet reads back blank, so saving cannot pin an inherited user")

section("config serialization")
var serialized = JSON.parse(Model.serializeConfig({ defaultUser: "me", rules: [{ host: "a" }] }))
delete serialized._readme
eq(serialized,
   { version: 1, defaultUser: "me", sshArgs: [], rules: [{ host: "a" }] },
   "round-trips with a version stamp")

section("in-file reference block")
var withHelp = JSON.parse(Model.serializeConfig({ rules: [] }))
eq(Object.keys(withHelp)[0], "_readme", "the reference sits at the top of the file where it is read first")
eq(withHelp._readme.length > 5, true, "it is substantial enough to configure from")
eq(withHelp._readme.some(function (l) { return /tmux new -A/.test(l) }), true,
   "it spells out the tmux-on-connect recipe")
eq(withHelp._readme.some(function (l) { return /github\.com/.test(l) }), true,
   "it names where the plugin came from, so the docs are findable")
// Rewritten on every save rather than preserved, so it cannot go stale against
// the installed version. parseRules must therefore ignore it.
eq(Model.parseRules(Model.serializeConfig({ defaultUser: "me", rules: [{ host: "a" }] })).rules,
   [{ host: "a" }], "the reference block does not leak into the parsed rules")

// ---------------------------------------------------------------------------
// Config load reducer. These are the regression tests for a stale "JSON.parse:
// Parse error" that stayed on screen after an editor save, while the rules it
// complained about were loaded and working. An editor save fires several
// inotify events; each triggered a read, and reads that landed mid-write were
// treated as authoritative.

function fresh() {
  return { lastText: "", error: "", config: Model.emptyDocument(), loaded: false, pendingBadText: "" }
}
function feed(state, text, readOk) {
  return Model.nextConfigState(state, { loaded: readOk !== false, text: text })
}

var KEY = "tailA.ts.net"
function docText(rules) {
  return Model.serializeDocument(
    Model.withTailnetRules(Model.emptyDocument(), KEY, "acme.com", rules))
}
// The reducer stores the whole document; rules are read back per tailnet.
function rulesOf(state) { return Model.configForTailnet(state.config, KEY).rules }

var CFG_A = docText([{ prefix: "app-" }])
var CFG_B = docText([{ prefix: "app-", user: "ubuntu" }])
var TRUNCATED = CFG_B.slice(0, 200)

section("config reducer: a save is read cleanly")
var st = feed(fresh(), CFG_A)
eq(st.error, "", "a valid file loads without error")
eq(rulesOf(st).length, 1, "and its rules are adopted")

section("config reducer: partial read, then the final good read")
st = feed(feed(feed(fresh(), CFG_A), TRUNCATED), CFG_B)
eq(st.error, "", "no error survives")
eq(rulesOf(st)[0].user, "ubuntu", "the edit is adopted")

section("config reducer: reloads complete out of order, partial lands last")
st = feed(feed(feed(fresh(), CFG_A), CFG_B), TRUNCATED)
eq(st.error, "", "a late partial read does not raise an error")
eq(rulesOf(st)[0].user, "ubuntu", "and does not disturb the adopted rules")

section("config reducer: save reproduces the previous bytes")
st = feed(feed(feed(fresh(), CFG_A), TRUNCATED), CFG_A)
eq(st.error, "", "re-reading the already-adopted bytes clears a stale error")
eq(rulesOf(st).length, 1, "rules intact")

section("config reducer: file briefly absent during a rename-style save")
st = feed(feed(fresh(), CFG_A), "", false)
eq(rulesOf(st).length, 1, "a failed read never drops the loaded rules")
eq(st.error, "", "and is not reported as an error")
eq(st.retry, true, "it asks to look again")
eq(feed(fresh(), "", false).retry, false,
   "but an absent config on first run is the normal pre-setup state, not a retry")

section("config reducer: a genuinely broken file")
st = feed(feed(fresh(), CFG_A), TRUNCATED)
eq(st.error, "", "one bad read is provisional, not an error")
eq(st.retry, true, "it asks for a second look")
eq(rulesOf(st).length, 1, "the working rules stay loaded meanwhile")
var confirmed = feed(st, TRUNCATED)
eq(confirmed.error !== "", true, "the same bad bytes twice is a real error")
eq(confirmed.retry, false, "and stops retrying")
eq(rulesOf(confirmed).length, 1, "even then the last good rules are kept")

section("config reducer: recovering from a broken file")
eq(feed(confirmed, CFG_B).error, "", "fixing the file clears the error")
eq(rulesOf(feed(confirmed, CFG_B))[0].user, "ubuntu", "and adopts the fix")

section("config reducer: an empty file is not an empty ruleset")
st = feed(feed(fresh(), CFG_A), "   \n")
eq(rulesOf(st).length, 1, "whitespace-only content is treated as mid-write")

section("row caption shows what is exceptional, not what is already on screen")
var capPeer = { HostName: "app-worker-i-0b1e031df86719510",
                DNSName: "app-worker-i-0b1e031df86719510.example-net.ts.net",
                Tags: ["tag:role-worker"] }
eq(Model.rowDetail(capPeer, { user: "ubuntu", address: capPeer.DNSName, port: 0, command: "" }),
   "ubuntu \u00b7 tag:role-worker",
   "the machine's own DNS name is dropped — the row title already says it")
eq(Model.rowDetail(capPeer, { user: "ubuntu", address: capPeer.DNSName, port: 0, command: "tmux new -A -s work" }),
   "ubuntu \u00b7 tag:role-worker \u00b7 \u21a6 tmux new -A -s work",
   "so a connect command stays visible instead of being elided off the end")
eq(Model.rowDetail(capPeer, { user: "ubuntu", address: "100.64.0.5", port: 2222, command: "" }),
   "ubuntu@100.64.0.5 \u00b7 tag:role-worker \u00b7 port 2222",
   "an address that is NOT the machine's DNS name is shown, since it is a real override")
eq(Model.rowDetail({ HostName: "nas", DNSName: "nas.example-net.ts.net", Tags: [] },
                   { user: "", address: "nas.example-net.ts.net", port: 0, command: "" }),
   "", "a machine with nothing notable gets no caption clutter")

section("row address line")
eq(Model.rowAddress({ TailscaleIPs: ["100.64.0.5"], TailscaleIPv6: ["fd7a:115c:a1e0::5"] }),
   "100.64.0.5", "the 100.x address, which is how the machine is actually reached")
eq(Model.rowAddress({ TailscaleIPs: [], TailscaleIPv6: ["fd7a:115c:a1e0::5"] }),
   "fd7a:115c:a1e0::5", "falls back to IPv6 on a tailnet with no IPv4")
eq(Model.rowAddress({ TailscaleIPs: [], TailscaleIPv6: [] }), "",
   "and the line disappears rather than showing an empty placeholder")
eq(Model.rowAddress(null), "", "a row with no peer yet asks for nothing")
eq(Model.rowAddress({ TailscaleIPs: { length: 1, 0: "100.64.0.9" } }), "100.64.0.9",
   "array-LIKE, not an Array: what a QML property var hands back, and what Array.isArray misses")

// ---------------------------------------------------------------------------
// Multiple tailnets. Rules are meaningless across tailnets — the machines are
// entirely different — so each gets its own section, and switching accounts
// must never disturb the one you switched away from.

section("identifying a tailnet")
eq(Model.tailnetKeyFromStatus({ magicDnsSuffix: "tailA.ts.net", tailnetName: "acme.com" }),
   "tailA.ts.net",
   "keyed on MagicDNSSuffix: unique, survives a rename, readable without root")
eq(Model.tailnetKeyFromStatus({ magicDnsSuffix: "", tailnetName: "acme.com" }), "acme.com",
   "falls back to the name when MagicDNS is off")
eq(Model.tailnetKeyFromStatus({}), "", "and is empty when we do not know yet")

section("sections are independent")
var docA = Model.withTailnetRules(Model.emptyDocument(), "tailA.ts.net", "acme.com",
                                  [{ prefix: "app-", user: "ubuntu" }])
var docAB = Model.withTailnetRules(docA, "tailB.ts.net", "other.org", [{ host: "nas", user: "root" }])
eq(Object.keys(docAB.tailnets).sort(), ["tailA.ts.net", "tailB.ts.net"],
   "adding a tailnet keeps the existing one")
eq(Model.configForTailnet(docAB, "tailA.ts.net").rules, [{ prefix: "app-", user: "ubuntu" }],
   "the first tailnet's rules are untouched")
eq(Model.configForTailnet(docAB, "tailB.ts.net").rules, [{ host: "nas", user: "root" }],
   "and the second gets its own")
eq(Model.configForTailnet(docAB, "tailC.ts.net").rules, [],
   "an unknown tailnet gets nothing rather than someone else's rules")
eq(Model.hasTailnetConfig(docAB, "tailC.ts.net"), false, "and reports itself unconfigured")
eq(Model.hasTailnetConfig(docAB, "tailB.ts.net"), true, "a configured one reports configured")
eq(Model.hasTailnetConfig(docAB, ""), false, "an unknown current tailnet is never 'configured'")

section("editing one tailnet does not touch another")
var edited = Model.withTailnetRules(docAB, "tailB.ts.net", "other.org", [{ host: "nas", user: "admin" }])
eq(Model.configForTailnet(edited, "tailA.ts.net").rules, [{ prefix: "app-", user: "ubuntu" }],
   "the other tailnet survives an edit")
eq(Model.configForTailnet(docAB, "tailB.ts.net").rules[0].user, "root",
   "and the input document is not mutated")

section("document-level defaults sit beneath per-tailnet values")
var withDefaults = Model.parseConfigDocument(JSON.stringify({
  version: 2, defaultUser: "me", sshArgs: ["-o", "ServerAliveInterval=30"],
  tailnets: { "tailA.ts.net": { name: "acme.com", sshArgs: ["-i", "key.pem"], rules: [] },
              "tailB.ts.net": { name: "other.org", defaultUser: "admin", rules: [] } }
})).doc
eq(Model.configForTailnet(withDefaults, "tailA.ts.net").defaultUser, "me",
   "a tailnet with no user of its own inherits the document default")
eq(Model.configForTailnet(withDefaults, "tailB.ts.net").defaultUser, "admin",
   "and overrides it when it has one")
eq(Model.configForTailnet(withDefaults, "tailA.ts.net").sshArgs,
   ["-o", "ServerAliveInterval=30", "-i", "key.pem"],
   "sshArgs concatenate, so a global keepalive survives a per-tailnet key")

section("an old flat config is never attributed to a tailnet")
// Which tailnet a v1 file was written for is not recorded and not inferable:
// matching its rules against the machines in front of you gives false
// positives whenever someone names machines similarly on two tailnets, which
// is exactly what people do. So it is preserved, never adopted.
var v1 = JSON.stringify({ version: 1, defaultUser: "me", rules: [{ prefix: "app-", user: "ubuntu" }] })
var v1doc = Model.parseConfigDocument(v1).doc
eq(v1doc.unassignedRules, [{ prefix: "app-", user: "ubuntu" }], "the flat rules are kept aside")
eq(Model.hasTailnetConfig(v1doc, "tailA.ts.net"), false, "no tailnet claims them")
eq(Model.configForTailnet(v1doc, "tailA.ts.net").rules, [], "and none of them leak into a tailnet")
eq(JSON.parse(Model.serializeDocument(v1doc)).rules, [{ prefix: "app-", user: "ubuntu" }],
   "they survive a rewrite untouched, so nothing is silently destroyed")
var afterSetup = Model.withTailnetRules(v1doc, "tailA.ts.net", "acme.com", [{ host: "nas" }])
eq(Model.configForTailnet(afterSetup, "tailA.ts.net").rules, [{ host: "nas" }],
   "configuring a tailnet does not pull them in")
eq(afterSetup.unassignedRules, [{ prefix: "app-", user: "ubuntu" }], "and still does not drop them")

section("serialization round-trip")
var round = Model.parseConfigDocument(Model.serializeDocument(docAB)).doc
eq(Object.keys(round.tailnets).sort(), ["tailA.ts.net", "tailB.ts.net"], "both sections survive")
eq(Model.configForTailnet(round, "tailA.ts.net").rules, [{ prefix: "app-", user: "ubuntu" }],
   "with their rules")
eq(JSON.parse(Model.serializeDocument(docAB))._readme.length > 5, true,
   "and the reference block is still there")


console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " — " + (checks - failures) + "/" + checks + " checks")
process.exit(failures === 0 ? 0 : 1)
