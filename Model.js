// Pure logic for the Tailscale SSH plugin: peer normalization from
// `tailscale status --json`, and the rule engine that decides which user (and
// port, args, command, label, group) a given machine should be reached with.
//
// Deliberately free of QML imports so `test/model.test.js` can exercise it
// under node. QML consumes it with `import "Model.js" as Model`; the
// module.exports tail at the bottom is what makes the node side work.

// ---------------------------------------------------------------- peer shape

function filterIPv4(ips) {
  var out = []
  for (var i = 0; i < (ips || []).length; i++) {
    var ip = String(ips[i] || "")
    if (/^100\./.test(ip)) out.push(ip)
  }
  return out
}

function filterIPv6(ips) {
  var out = []
  for (var i = 0; i < (ips || []).length; i++) {
    var ip = String(ips[i] || "")
    if (/^fd7a:115c:a1e0:/i.test(ip)) out.push(ip)
  }
  return out
}

// `tailscale status --json` reports DNSName with a trailing dot.
function cleanDnsName(value) {
  return String(value || "").replace(/\.$/, "")
}

function displayHostName(hostName, dnsName) {
  var host = String(hostName || "").trim()
  if (host !== "" && host.toLowerCase() !== "localhost") return host
  var dns = cleanDnsName(dnsName)
  if (dns !== "") return dns.split(".")[0]
  return "Unknown"
}

// Nerd Font glyphs, matching the built-in tailscale panel's vocabulary.
function osIcon(os) {
  var key = String(os || "").toLowerCase()
  if (key === "linux") return "󰌽"
  if (key === "macos" || key === "ios") return "󰀵"
  if (key === "windows") return "󰽲"
  if (key === "android") return "󰀲"
  return "󰟀"
}

// A Mullvad exit node is not a machine you would ever ssh into, so it never
// reaches the list. Same detection the built-in plugin uses.
function isMullvadPeer(peer) {
  if (!peer) return false
  var tags = peer.Tags || []
  for (var i = 0; i < tags.length; i++) {
    if (String(tags[i]) === "tag:mullvad") return true
  }
  return /\.mullvad\.ts\.net\.?$/i.test(String(peer.DNSName || ""))
}

function peerFromStatus(id, peer) {
  return {
    id: id,
    HostName: displayHostName(peer.HostName, peer.DNSName),
    DNSName: cleanDnsName(peer.DNSName),
    DisplayName: displayHostName(peer.HostName, peer.DNSName),
    TailscaleIPs: filterIPv4(peer.TailscaleIPs || []),
    TailscaleIPv6: filterIPv6(peer.TailscaleIPs || []),
    Online: peer.Online === true,
    OS: String(peer.OS || ""),
    Tags: peer.Tags || [],
    Self: peer.__self === true
  }
}

// Unlike the built-in plugin, offline peers are KEPT (flagged Online: false).
// An ephemeral instance that has stopped is worth seeing greyed out rather
// than silently vanishing from the list; the panel sorts it last and the
// showOffline setting hides it for anyone who disagrees.
function parseStatus(text) {
  var data
  try {
    data = JSON.parse(String(text || ""))
  } catch (e) {
    return { ok: false, unavailable: true, peers: [], error: String(e) }
  }
  if (!data || typeof data !== "object") {
    return { ok: false, unavailable: true, peers: [], error: "empty status" }
  }

  var self = data.Self || {}
  var backendState = String(data.BackendState || "Unknown")
  var peers = []

  var peerMap = data.Peer || {}
  for (var key in peerMap) {
    var raw = peerMap[key]
    if (!raw || isMullvadPeer(raw)) continue
    peers.push(peerFromStatus(key, raw))
  }

  // Your own machine is a legitimate ssh target from a rules point of view,
  // but sshing into localhost from its own bar is never what you meant.
  peers.sort(function (a, b) {
    if (a.Online !== b.Online) return a.Online ? -1 : 1
    return String(a.HostName).localeCompare(String(b.HostName))
  })

  return {
    ok: true,
    unavailable: false,
    backendState: backendState,
    running: backendState === "Running",
    needsLogin: backendState === "NeedsLogin",
    selfName: displayHostName(self.HostName, self.DNSName),
    tailnetName: data.CurrentTailnet ? String(data.CurrentTailnet.Name || "") : "",
    magicDnsSuffix: String(data.MagicDNSSuffix || ""),
    peers: peers
  }
}

// ---------------------------------------------------------------- rule engine

// Specificity tiers. A rule matched at a higher tier overrides fields set by a
// lower one, so a broad `prefix` rule can supply the user while an exact `host`
// rule overrides only the port. Ordering the tiers this way (rather than
// first-match-wins) is what makes a fleet of ephemeral instances configurable
// with two lines while still allowing a one-off exception per machine.
var TIER_DEFAULTS = 0
var TIER_PREFIX = 1
var TIER_REGEX = 2
var TIER_TAG = 3
var TIER_HOST = 4

function asArray(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(String)
  // A convenience for hand-written config: "-i ~/.ssh/id_ed25519" splits on
  // whitespace. Anything needing an embedded space must use the array form.
  var text = String(value).trim()
  return text === "" ? [] : text.split(/\s+/)
}

function hostMatches(rule, peer) {
  var want = String(rule.host || "").toLowerCase().replace(/\.$/, "")
  if (want === "") return false
  var host = String(peer.HostName || "").toLowerCase()
  var dns = String(peer.DNSName || "").toLowerCase()
  // "desktop" should match desktop.example-net.ts.net, and the full DNS name
  // should match too, so both spellings work in a rules file.
  return want === host || want === dns || want === dns.split(".")[0]
}

function tagMatches(rule, peer) {
  var want = String(rule.tag || "")
  if (want === "") return false
  // Accept "prod-swarm" as shorthand for "tag:prod-swarm".
  var normalized = want.indexOf("tag:") === 0 ? want : "tag:" + want
  var tags = peer.Tags || []
  for (var i = 0; i < tags.length; i++) {
    if (String(tags[i]) === normalized) return true
  }
  return false
}

function regexMatches(rule, peer) {
  var pattern = String(rule.regex || "")
  if (pattern === "") return false
  try {
    return new RegExp(pattern).test(String(peer.HostName || ""))
  } catch (e) {
    // A malformed pattern must not take the whole panel down.
    return false
  }
}

function prefixMatches(rule, peer) {
  var prefix = String(rule.prefix || "")
  if (prefix === "") return false
  return String(peer.HostName || "").indexOf(prefix) === 0
}

// Returns every matching rule paired with its tier and a tiebreak weight,
// sorted weakest-first so a straight left-to-right merge yields the result.
function matchingRules(peer, rules) {
  var matches = []
  for (var i = 0; i < (rules || []).length; i++) {
    var rule = rules[i]
    if (!rule || typeof rule !== "object") continue

    if (hostMatches(rule, peer)) matches.push({ rule: rule, tier: TIER_HOST, weight: 0, order: i })
    else if (tagMatches(rule, peer)) matches.push({ rule: rule, tier: TIER_TAG, weight: 0, order: i })
    else if (regexMatches(rule, peer)) matches.push({ rule: rule, tier: TIER_REGEX, weight: 0, order: i })
    else if (prefixMatches(rule, peer)) {
      // Longest prefix wins: "app-worker-" must beat "app-".
      matches.push({ rule: rule, tier: TIER_PREFIX, weight: String(rule.prefix).length, order: i })
    }
  }

  matches.sort(function (a, b) {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.weight !== b.weight) return a.weight - b.weight
    return a.order - b.order
  })
  return matches
}

function mergeRule(into, rule) {
  var scalars = ["user", "port", "command", "label", "group", "address", "hidden"]
  for (var i = 0; i < scalars.length; i++) {
    var key = scalars[i]
    if (rule[key] !== undefined && rule[key] !== null) into[key] = rule[key]
  }
  // sshArgs accumulate rather than replace, so a global keepalive survives a
  // rule that only wants to add an identity file.
  into.sshArgs = into.sshArgs.concat(asArray(rule.sshArgs))
  return into
}

// The address actually passed to ssh. MagicDNS by default: it is stable across
// an instance's IP changes and is what tailnet DNS is for.
function resolveAddress(peer, connectVia) {
  var mode = String(connectVia || "dns")
  if (mode === "ip") {
    if (peer.TailscaleIPs && peer.TailscaleIPs.length > 0) return peer.TailscaleIPs[0]
    return String(peer.DNSName || peer.HostName || "")
  }
  if (mode === "hostname") return String(peer.HostName || "")
  if (peer.DNSName) return String(peer.DNSName)
  if (peer.TailscaleIPs && peer.TailscaleIPs.length > 0) return peer.TailscaleIPs[0]
  return String(peer.HostName || "")
}

// config: { defaultUser, sshArgs, rules, connectVia, fallbackUser }
// fallbackUser is $USER, supplied by the QML side via Quickshell.env.
function resolveTarget(peer, config) {
  var cfg = config || {}
  var resolved = {
    user: "",
    port: 0,
    command: "",
    label: "",
    group: "",
    address: "",
    hidden: false,
    sshArgs: []
  }

  // Tier 0: file-level defaults.
  mergeRule(resolved, {
    user: cfg.defaultUser || undefined,
    sshArgs: cfg.sshArgs
  })

  var matches = matchingRules(peer, cfg.rules)
  for (var i = 0; i < matches.length; i++) mergeRule(resolved, matches[i].rule)

  if (!resolved.user) resolved.user = String(cfg.fallbackUser || "")
  if (!resolved.address) resolved.address = resolveAddress(peer, cfg.connectVia)
  if (!resolved.label) resolved.label = String(peer.HostName || "")
  resolved.port = parseInt(resolved.port, 10) || 0
  resolved.hidden = resolved.hidden === true
  resolved.matchedRuleCount = matches.length

  return resolved
}

// The argv handed to Util.execArgv. Built as a vector, never a string: every
// element here originates in a config file or the tailnet, so none of it may
// be interpolated into something a shell would re-tokenize.
function sshArgv(peer, target, appIdPrefix) {
  var host = String(target.address || "")
  var user = String(target.user || "")
  var appId = String(appIdPrefix || "org.omarchy.tailssh") + "-" + String(peer.HostName || "host")

  var argv = ["omarchy-launch-tui", "--app-id=" + appId, "ssh"]
  if (target.port > 0) argv.push("-p", String(target.port))
  argv = argv.concat(target.sshArgs || [])
  if (target.command) argv.push("-t")
  argv.push(user === "" ? host : user + "@" + host)
  if (target.command) argv.push(String(target.command))
  return argv
}

// The human-readable equivalent, for the "copy ssh command" action and the
// row caption. Not used to execute anything.
function sshCommandText(peer, target) {
  var argv = sshArgv(peer, target, "")
  var parts = argv.slice(2)
  return parts.map(function (part) {
    return /[^A-Za-z0-9@:._\/-]/.test(part) ? "'" + part.replace(/'/g, "'\\''") + "'" : part
  }).join(" ")
}

// ---------------------------------------------------------------- rules file

function parseRules(text) {
  var raw
  try {
    raw = JSON.parse(String(text || ""))
  } catch (e) {
    return { ok: false, error: String(e), defaultUser: "", sshArgs: [], rules: [] }
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "rules file is not an object", defaultUser: "", sshArgs: [], rules: [] }
  }
  return {
    ok: true,
    error: "",
    defaultUser: String(raw.defaultUser || ""),
    connectVia: raw.connectVia ? String(raw.connectVia) : "",
    sshArgs: asArray(raw.sshArgs),
    rules: Array.isArray(raw.rules) ? raw.rules : []
  }
}

// Groups peers for display. Online first, offline last, each sorted by label;
// groups are ordered by first appearance in the rules file so the config
// author controls the reading order.
function groupPeers(entries, showOffline) {
  var groups = []
  var byName = {}

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    if (entry.target.hidden) continue
    if (!entry.peer.Online && showOffline === false) continue

    var name = entry.peer.Online ? (entry.target.group || "MACHINES") : "OFFLINE"
    if (!byName[name]) {
      byName[name] = { name: name, offline: !entry.peer.Online, items: [] }
      groups.push(byName[name])
    }
    byName[name].items.push(entry)
  }

  groups.sort(function (a, b) {
    if (a.offline !== b.offline) return a.offline ? 1 : -1
    return 0
  })
  for (var g = 0; g < groups.length; g++) {
    groups[g].items.sort(function (a, b) {
      return String(a.target.label).localeCompare(String(b.target.label))
    })
  }
  return groups
}

function matchesFilter(entry, query) {
  var q = String(query || "").trim().toLowerCase()
  if (q === "") return true
  var haystack = [
    entry.peer.HostName,
    entry.peer.DNSName,
    entry.target.label,
    entry.target.group,
    entry.target.user,
    (entry.peer.TailscaleIPs || []).join(" "),
    (entry.peer.Tags || []).join(" ")
  ].join(" ").toLowerCase()
  // Space-separated terms all have to match, so "worker ubuntu" narrows.
  var terms = q.split(/\s+/)
  for (var i = 0; i < terms.length; i++) {
    if (haystack.indexOf(terms[i]) === -1) return false
  }
  return true
}

// ---------------------------------------------------- quick-assign scopes

// A trailing token that looks machine-generated — an AWS-style instance id or a
// long hex/alphanumeric blob. Machines named this way are replaced rather than
// restarted, so a rule keyed to the exact hostname is worthless: the stable
// prefix is the only thing worth writing down. Kept in sync with the same
// detection in bin/setup.
var EPHEMERAL_TAIL = /^(i-)?[0-9a-f]{8,}$|^[0-9a-z]{12,}$/

function stablePrefix(hostName) {
  var tokens = String(hostName || "").split("-")
  for (var i = 1; i < tokens.length; i++) {
    // An instance id like "i-0b1e..." spans two tokens, so test the joined tail.
    if (EPHEMERAL_TAIL.test(tokens.slice(i).join("-"))) return tokens.slice(0, i).join("-") + "-"
  }
  return ""
}

function isEphemeral(hostName) {
  return stablePrefix(hostName) !== ""
}

// The scopes a rule can be written at for one machine, weakest first. Offered by
// the panel's quick-assign form so a fleet can be configured from any one of its
// members. A scope is only offered when it actually applies to this machine.
function ruleScopes(peer, config) {
  var scopes = []
  var host = String(peer.HostName || "")

  // Prefer a prefix that already has a rule; otherwise derive one from an
  // ephemeral name. A stable one-off machine gets no prefix scope.
  var existing = ""
  var rules = (config && config.rules) || []
  for (var i = 0; i < rules.length; i++) {
    var p = rules[i] && rules[i].prefix ? String(rules[i].prefix) : ""
    if (p !== "" && host.indexOf(p) === 0 && p.length > existing.length) existing = p
  }
  var prefix = existing || stablePrefix(host)
  if (prefix !== "") scopes.push({ kind: "prefix", value: prefix, label: prefix + "*" })

  var tags = peer.Tags || []
  for (var t = 0; t < tags.length; t++) {
    scopes.push({ kind: "tag", value: String(tags[t]), label: String(tags[t]) })
  }

  scopes.push({ kind: "host", value: host, label: host })
  return scopes
}

// Merge `fields` into the rule matching `scope`, creating it if absent. Returns a
// NEW array — QML does not observe in-place mutation of an array property, and
// the whole config is rewritten on save anyway.
//
// A blank field REMOVES that key rather than storing "", so clearing the user in
// the form falls back to the next-weakest rule instead of pinning an empty user.
function upsertRule(rules, scope, fields) {
  var next = (rules || []).map(function (r) {
    var copy = {}
    for (var k in r) copy[k] = r[k]
    return copy
  })

  var found = -1
  for (var i = 0; i < next.length; i++) {
    if (next[i][scope.kind] !== undefined && String(next[i][scope.kind]) === String(scope.value)) {
      found = i
      break
    }
  }

  var target = found === -1 ? {} : next[found]
  if (found === -1) target[scope.kind] = scope.value

  for (var key in fields) {
    var value = fields[key]
    var blank = value === undefined || value === null || value === "" || value === 0
    if (blank) delete target[key]
    else target[key] = value
  }

  // A rule carrying nothing but its matcher does no work; drop it so repeated
  // clearing does not accumulate dead entries.
  var meaningful = false
  for (var check in target) if (check !== scope.kind) meaningful = true

  if (found === -1) {
    if (meaningful) next.push(target)
  } else if (!meaningful) {
    next.splice(found, 1)
  }
  return next
}

// The fields the quick-assign form should show for a scope: what that rule
// already sets, NOT the fully resolved values. Showing resolved values would
// make an inherited user look like it was set on this rule, and saving would
// then pin it.
function ruleFieldsFor(rules, scope) {
  for (var i = 0; i < (rules || []).length; i++) {
    var r = rules[i]
    if (r[scope.kind] !== undefined && String(r[scope.kind]) === String(scope.value)) {
      return {
        user: String(r.user || ""),
        port: parseInt(r.port, 10) || 0,
        command: String(r.command || "")
      }
    }
  }
  return { user: "", port: 0, command: "" }
}

// The reference block written into the top of the config file as "_readme".
// It lives in the file itself so someone editing the JSON has the options in
// front of them without having to remember where the plugin came from.
// bin/setup emits the same text; test/setup.test.sh asserts the two match.
var CONFIG_HELP = [
  "Tailscale SSH rules. Edits apply immediately - no restart.",
  "Full docs: https://github.com/diddado/omarchy-tailscale-ssh",
  "",
  "Each rule needs exactly one matcher:",
  "  host    exact machine name, or its full MagicDNS name (case-insensitive)",
  "  tag     a Tailscale ACL tag; the 'tag:' prefix is optional",
  "  regex   JavaScript regex tested against the machine name",
  "  prefix  machine-name prefix; the LONGEST match wins",
  "",
  "Rules MERGE weakest-to-strongest, rather than first-match-wins:",
  "  defaults < prefix < regex < tag < host",
  "So a prefix rule can set the user for a whole fleet while an exact host rule",
  "overrides only that machine's port. Fields you do not mention are inherited.",
  "sshArgs accumulate across tiers instead of replacing.",
  "",
  "Optional on any rule:",
  "  user     SSH login user",
  "  port     passed as ssh -p",
  "  sshArgs  extra flags, e.g. [\"-i\", \"~/.ssh/id_ed25519\"]",
  "  command  run this instead of a login shell; ssh -t is added for you.",
  "           e.g. \"tmux new -A -s work\" attaches to the session named work,",
  "           creating it first if it does not exist yet.",
  "  label    friendlier display name in the panel",
  "  group    section heading to file the machine under",
  "  address  override what ssh actually connects to",
  "  hidden   true drops the machine from the list",
  "",
  "Top level: defaultUser, sshArgs, connectVia (dns|ip|hostname), rules.",
  "",
  "Re-run setup any time to regenerate groups from your tailnet:",
  "  ~/.config/omarchy/plugins/io.github.diddado.tailscale-ssh/bin/setup"
]

// Always re-emits _readme rather than preserving whatever was there: it is
// documentation, not user data, so keeping it in step with the installed
// version beats respecting an edit to it.
function serializeConfig(config) {
  return JSON.stringify({
    _readme: CONFIG_HELP,
    version: 1,
    defaultUser: String(config.defaultUser || ""),
    connectVia: config.connectVia ? String(config.connectVia) : undefined,
    sshArgs: config.sshArgs || [],
    rules: config.rules || []
  }, null, 2) + "\n"
}

if (typeof module !== "undefined") {
  module.exports = {
    filterIPv4: filterIPv4,
    filterIPv6: filterIPv6,
    cleanDnsName: cleanDnsName,
    displayHostName: displayHostName,
    osIcon: osIcon,
    isMullvadPeer: isMullvadPeer,
    peerFromStatus: peerFromStatus,
    parseStatus: parseStatus,
    asArray: asArray,
    matchingRules: matchingRules,
    resolveAddress: resolveAddress,
    resolveTarget: resolveTarget,
    sshArgv: sshArgv,
    sshCommandText: sshCommandText,
    parseRules: parseRules,
    groupPeers: groupPeers,
    matchesFilter: matchesFilter,
    stablePrefix: stablePrefix,
    isEphemeral: isEphemeral,
    ruleScopes: ruleScopes,
    upsertRule: upsertRule,
    ruleFieldsFor: ruleFieldsFor,
    serializeConfig: serializeConfig,
    CONFIG_HELP: CONFIG_HELP
  }
}
