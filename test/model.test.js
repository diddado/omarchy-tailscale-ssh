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
    { tag: "tag:role-primary", group: "Primaries", command: "sudo systemctl status app" },
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
eq(resolve(PEERS.appPrimary).command, "sudo systemctl status app", "tag rule sets a connect command")
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
    "-o", "ServerAliveInterval=30", "chris@desktop.example-net.ts.net"],
   "plain login builds a flat argv vector")
eq(Model.sshArgv(PEERS.laptop, resolve(PEERS.laptop), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-laptop", "ssh",
    "-p", "2222", "-o", "ServerAliveInterval=30", "deploy@laptop.example-net.ts.net"],
   "a port lands as a separate -p argument")
eq(Model.sshArgv(PEERS.appPrimary, resolve(PEERS.appPrimary), "org.omarchy.tailssh"),
   ["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-app-primary", "ssh",
    "-o", "ServerAliveInterval=30", "-o", "StrictHostKeyChecking=accept-new",
    "-t", "ubuntu@app-primary.example-net.ts.net", "sudo systemctl status app"],
   "a connect command adds -t and trails the command as one argv element")

section("shell metacharacters stay inert")
var evil = peer("evil$(id)host")
var evilArgv = Model.sshArgv(evil, Model.resolveTarget(evil, { fallbackUser: "localuser", rules: [] }), "x")
eq(evilArgv[evilArgv.length - 1], "localuser@evil$(id)host.example-net.ts.net",
   "a hostname with shell syntax stays a single literal argv element")

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
   { user: "deploy", port: 0, command: "" },
   "reads back the rule's own fields")
eq(Model.ruleFieldsFor(CONFIG.rules, { kind: "host", value: "app-worker-i-0b1e031df86719510" }),
   { user: "", port: 0, command: "" },
   "a scope with no rule yet reads back blank, so saving cannot pin an inherited user")

section("config serialization")
eq(JSON.parse(Model.serializeConfig({ defaultUser: "me", rules: [{ host: "a" }] })),
   { version: 1, defaultUser: "me", sshArgs: [], rules: [{ host: "a" }] },
   "round-trips with a version stamp")

console.log("\n" + (failures === 0 ? "PASS" : "FAIL") + " — " + (checks - failures) + "/" + checks + " checks")
process.exit(failures === 0 ? 0 : 1)
