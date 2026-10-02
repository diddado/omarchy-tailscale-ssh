// Pure logic for the Tailscale SSH plugin: peer normalization from
// `tailscale status --json`, and the rule engine that decides which user (and
// port, args, command, label, group) a given machine should be reached with.
//
// Deliberately free of QML imports so `test/model.test.js` can exercise it
// under node. QML consumes it with `import "Model.js" as Model`; the
// module.exports tail at the bottom is what makes the node side work.

// ---------------------------------------------------------------- limits
//
// Everything parsed here arrives from somewhere else. `tailscale status --json`
// describes machines whose names and tags are chosen by whoever owns them, and
// the rules file is a plain-text document that any other process running as
// this user can rewrite. Both are consumed inside omarchy-shell, the one
// long-lived process on the desktop that hosts every other widget, so the byte
// ceilings the helpers in bin/ apply to the transport are only half the job: a
// megabyte of perfectly valid JSON still holds tens of thousands of objects, or
// one enormous string. These are the ceilings applied after parsing.
var LIMITS = {
  peers: 2000,
  tags: 32,
  addresses: 16,
  rules: 2000,
  tailnets: 64,
  sshArgs: 64,
  text: 512,      // hostnames, users, labels, groups, tags
  command: 1024,  // a connect command may reasonably be a short pipeline
  regex: 200      // a config pattern re-run against every machine name
}

// A string safe to keep and to show: control characters removed -- including
// the bidi overrides that let a label render as something other than what it
// says -- and the length capped.
function clamp(value, max) {
  var text = String(value === undefined || value === null ? "" : value)
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  var limit = max || LIMITS.text
  return text.length > limit ? text.slice(0, limit) : text
}

// For the shell's own components -- PanelHero, PanelSectionHeader, a tooltip --
// which render with Text.AutoText and cannot be pinned to Text.PlainText from a
// plugin. Qt sniffs a string that looks like markup and renders it as rich
// text, and rich text loads `<img src="...">`: a real request out of the shell
// process to a URL the string's author picked. A machine on a tailnet names
// itself, and a group name comes from a file, so both are such strings.
// Removing the three characters that can open a tag is what makes them safe.
function plain(value, max) {
  return clamp(value, max).replace(/[<>&]/g, "")
}

// Maps keyed by names that came from the network or from the config file. A
// plain object literal would let a machine or a rule named "__proto__" reach
// Object.prototype and change the behaviour of every object in the shell.
function emptyMap() {
  return Object.create(null)
}

var RESERVED_KEYS = { __proto__: true, constructor: true, prototype: true }

function safeKey(key) {
  return typeof key === "string" && key !== "" && !RESERVED_KEYS[key]
}

// ---------------------------------------------------------------- peer shape

// A peer declares its own address list, so the count is bounded as well as the
// pattern: a machine advertising ten thousand addresses must not become ten
// thousand strings held for the lifetime of the shell.
function filterIPs(ips, pattern) {
  var out = []
  var list = Array.isArray(ips) ? ips : []
  for (var i = 0; i < list.length && out.length < LIMITS.addresses; i++) {
    var ip = clamp(list[i], 64)
    if (pattern.test(ip)) out.push(ip)
  }
  return out
}

function filterIPv4(ips) {
  return filterIPs(ips, /^100\./)
}

function filterIPv6(ips) {
  return filterIPs(ips, /^fd7a:115c:a1e0:/i)
}

// `tailscale status --json` reports DNSName with a trailing dot.
function cleanDnsName(value) {
  return clamp(value, LIMITS.text).replace(/\.$/, "")
}

function displayHostName(hostName, dnsName) {
  var host = clamp(hostName, LIMITS.text).trim()
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

function clampTags(tags) {
  var out = []
  var list = Array.isArray(tags) ? tags : []
  for (var i = 0; i < list.length && out.length < LIMITS.tags; i++) {
    var tag = clamp(list[i], LIMITS.text)
    if (tag !== "") out.push(tag)
  }
  return out
}

// Every field here is chosen by whoever owns the machine, so every field is
// clamped on the way in rather than at each of the places it is later shown.
function peerFromStatus(id, peer) {
  return {
    id: clamp(id, LIMITS.text),
    HostName: displayHostName(peer.HostName, peer.DNSName),
    DNSName: cleanDnsName(peer.DNSName),
    DisplayName: displayHostName(peer.HostName, peer.DNSName),
    TailscaleIPs: filterIPv4(peer.TailscaleIPs),
    TailscaleIPv6: filterIPv6(peer.TailscaleIPs),
    Online: peer.Online === true,
    OS: clamp(peer.OS, 32),
    Tags: clampTags(peer.Tags),
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
  var backendState = clamp(data.BackendState, 64) || "Unknown"
  var peers = []

  // Stops at the ceiling instead of collecting everything and slicing after:
  // slicing frees nothing, and the objects are built one per iteration.
  var peerMap = (data.Peer && typeof data.Peer === "object") ? data.Peer : {}
  var truncated = false
  for (var key in peerMap) {
    if (peers.length >= LIMITS.peers) { truncated = true; break }
    var raw = peerMap[key]
    if (!raw || typeof raw !== "object" || isMullvadPeer(raw)) continue
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
    tailnetName: data.CurrentTailnet ? clamp(data.CurrentTailnet.Name, LIMITS.text) : "",
    magicDnsSuffix: clamp(data.MagicDNSSuffix, LIMITS.text),
    truncated: truncated,
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

// sshArgs accumulate across rule tiers, so an unbounded array here becomes an
// unbounded argv at connect time. Both the count and each element are capped.
function asArray(value) {
  if (value === undefined || value === null) return []
  var list
  if (Array.isArray(value)) {
    list = value
  } else {
    // A convenience for hand-written config: "-i ~/.ssh/id_ed25519" splits on
    // whitespace. Anything needing an embedded space must use the array form.
    var text = clamp(value, LIMITS.command).trim()
    list = text === "" ? [] : text.split(/\s+/)
  }
  var out = []
  for (var i = 0; i < list.length && out.length < LIMITS.sshArgs; i++) {
    out.push(clamp(list[i], LIMITS.text))
  }
  return out
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

// Compiled patterns are cached and their source is length-capped. A `regex`
// rule is the one place the config file gets to run an algorithm against a
// string the network supplied, and it is re-run for every machine on every
// rebuild inside the shell process, so the work is kept small at both ends:
// a bounded pattern against an already-bounded hostname.
// Bounded, because this lives for the lifetime of the shell: a rules file
// rewritten with fresh patterns would otherwise grow the cache forever. Past
// the ceiling it is dropped whole rather than evicted one entry at a time --
// recompiling a handful of bounded patterns is cheaper than tracking ages.
var regexCache = emptyMap()
var regexCacheSize = 0

function compileRegex(pattern) {
  if (pattern.length > LIMITS.regex) return null
  if (Object.prototype.hasOwnProperty.call(regexCache, pattern)) return regexCache[pattern]
  if (regexCacheSize >= LIMITS.rules) {
    regexCache = emptyMap()
    regexCacheSize = 0
  }
  var compiled = null
  try {
    compiled = new RegExp(pattern)
  } catch (e) {
    // A malformed pattern must not take the whole panel down.
    compiled = null
  }
  regexCache[pattern] = compiled
  regexCacheSize++
  return compiled
}

function regexMatches(rule, peer) {
  var pattern = clamp(rule.regex, LIMITS.regex + 1)
  if (pattern === "") return false
  var compiled = compileRegex(pattern)
  if (!compiled) return false
  compiled.lastIndex = 0
  return compiled.test(clamp(peer.HostName, LIMITS.text))
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
  var list = Array.isArray(rules) ? rules : []
  var count = Math.min(list.length, LIMITS.rules)
  for (var i = 0; i < count; i++) {
    var rule = list[i]
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
  var scalars = ["user", "port", "command", "label", "group", "address", "hidden", "loginShell"]
  for (var i = 0; i < scalars.length; i++) {
    var key = scalars[i]
    // hasOwnProperty, not a truthiness test: a rules file is JSON, and JSON.parse
    // makes "__proto__" an own property, so an inherited value must never be
    // mistaken for one this rule actually set.
    if (!Object.prototype.hasOwnProperty.call(rule, key)) continue
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
    loginShell: false,
    sshArgs: []
  }

  // Tier 0: file-level defaults.
  mergeRule(resolved, {
    user: cfg.defaultUser || undefined,
    sshArgs: cfg.sshArgs
  })

  var matches = matchingRules(peer, cfg.rules)
  for (var i = 0; i < matches.length; i++) mergeRule(resolved, matches[i].rule)

  if (!resolved.user) resolved.user = clamp(cfg.fallbackUser, LIMITS.text)
  if (!resolved.address) resolved.address = resolveAddress(peer, cfg.connectVia)
  if (!resolved.label) resolved.label = clamp(peer.HostName, LIMITS.text)
  // Every field a rule may have set is re-clamped here rather than trusted from
  // the file: resolveTarget is the single point every consumer goes through.
  resolved.user = clamp(resolved.user, LIMITS.text)
  resolved.address = clamp(resolved.address, LIMITS.text)
  resolved.label = clamp(resolved.label, LIMITS.text)
  resolved.group = clamp(resolved.group, LIMITS.text)
  resolved.command = clamp(resolved.command, LIMITS.command)
  resolved.port = parseInt(resolved.port, 10)
  if (!isFinite(resolved.port) || resolved.port < 0 || resolved.port > 65535) resolved.port = 0
  resolved.hidden = resolved.hidden === true
  resolved.loginShell = resolved.loginShell === true
  resolved.matchedRuleCount = matches.length
  resolved.problem = targetProblem(resolved)

  return resolved
}

// ---------------------------------------------------------------- ssh argv

// ssh parses its argv with getopt, so a destination beginning with "-" is read
// as an option and not as a host: `ssh -lroot` sets the login user, and the
// same trick reaches -o, which is how a hostname becomes a command. Machines
// name themselves on a tailnet, so a hostname is not a value this plugin chose.
// Two things close that: the destination goes after "--", and it is validated
// besides -- refused, never repaired, because a hostname quietly rewritten into
// something acceptable would connect somewhere other than where you meant.
var DESTINATION_RE = /^[A-Za-z0-9_.:\[\]][A-Za-z0-9_.:\[\]-]*$/
var SSH_USER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/

// The window id is interpolated into `xdg-terminal-exec --app-id=$APP_ID` by
// omarchy-launch-tui, unquoted, one process away from here. Holding it to a
// charset that cannot word-split or glob is this plugin's job, not that
// script's: a fix that relies on someone else quoting is the boundary moved
// rather than closed.
function windowAppId(prefix, hostName) {
  var id = String(prefix || "") + "-" + clamp(hostName, 64)
  id = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 64)
  return id === "" ? "org.omarchy.tailssh" : id
}

// "" when the target is usable, otherwise why it is not. The panel shows this
// instead of connecting.
function targetProblem(target) {
  var address = String(target.address || "")
  var user = String(target.user || "")
  if (address === "") return "no address to connect to"
  if (address.length > 253 || !DESTINATION_RE.test(address)) {
    return "\u201c" + plain(address, 64) + "\u201d is not a usable ssh destination"
  }
  if (user !== "" && (user.length > 32 || !SSH_USER_RE.test(user))) {
    return "\u201c" + plain(user, 64) + "\u201d is not a usable ssh login user"
  }
  var args = target.sshArgs || []
  for (var i = 0; i < args.length; i++) {
    if (String(args[i]).indexOf("\n") !== -1) return "sshArgs contain a newline"
  }
  return ""
}

// The argv handed to Util.execArgv. Built as a vector, never a string: every
// element here originates in a config file or on the tailnet, so none of it may
// be interpolated into something a shell would re-tokenize. Returns [] when the
// target does not validate -- the caller reports target.problem rather than
// connecting to a best guess.
// POSIX single-quoting, and the only place in the tree that does it. Splitting
// on ' and emitting '...'\''...' leaves every input byte inside a quoted span:
// the one region outside quotes is the two-character \' , which holds no input.
// So a value carrying a quote cannot escape -- closing the quote is exactly what
// the escape already did, immediately before reopening it.
function shellQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

// `ssh host CMD` makes sshd run `$SHELL -c CMD` -- a non-login, non-interactive
// shell, so /etc/profile and ~/.profile never run and the session has no locale
// and no profile PATH. A plain `ssh host` gets a login shell and does. Opting in
// asks for the second from the first.
//
// "$SHELL" rather than bash: sshd always sets it from the passwd entry, and
// hardcoding bash would source a profile the user has never seen (or none at
// all, on a host without bash). The command was already a remote shell program
// by design, so quoting it into one word grants it nothing it did not have.
function remoteCommand(command, loginShell) {
  var text = String(command === undefined || command === null ? "" : command)
  if (text === "" || loginShell !== true) return text
  return 'exec "$SHELL" -l -c ' + shellQuote(text)
}

function sshArgv(peer, target, appIdPrefix) {
  if (targetProblem(target) !== "") return []

  var host = String(target.address || "")
  var user = String(target.user || "")
  var appId = windowAppId(appIdPrefix || "org.omarchy.tailssh", peer.HostName)

  var argv = ["omarchy-launch-tui", "--app-id=" + appId, "ssh"]
  if (target.port > 0) argv.push("-p", String(target.port))
  argv = argv.concat(target.sshArgs || [])
  if (target.command) argv.push("-t")
  // Everything after this point is data, not flags.
  argv.push("--")
  argv.push(user === "" ? host : user + "@" + host)
  if (target.command) argv.push(remoteCommand(target.command, target.loginShell))
  return argv
}

// The human-readable equivalent, for the "copy ssh command" action and the
// row caption. Not used to execute anything -- but it is pasted into a
// terminal by hand, so it is quoted with the same care as if it were.
function sshCommandText(peer, target) {
  var argv = sshArgv(peer, target, "")
  if (argv.length === 0) return ""
  var parts = argv.slice(2)
  return parts.map(function (part) {
    return /^[A-Za-z0-9@:._\/-]+$/.test(part) ? part : shellQuote(part)
  }).join(" ")
}

// ---------------------------------------------------------------- rules file

// A rule is data from a file. Only the keys the engine understands survive, and
// each is coerced to the type and the length the engine expects -- so a
// 10 MB `label`, a `port` of "1e9", or a key called "__proto__" cannot travel
// any further than this function.
var RULE_MATCHERS = ["host", "tag", "regex", "prefix"]
var RULE_FIELDS = ["user", "port", "command", "label", "group", "address", "hidden", "sshArgs",
                   "loginShell"]

function sanitizeRule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  var rule = {}
  var i, key
  for (i = 0; i < RULE_MATCHERS.length; i++) {
    key = RULE_MATCHERS[i]
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    var matcher = clamp(raw[key], key === "regex" ? LIMITS.regex : LIMITS.text)
    if (matcher !== "") rule[key] = matcher
  }
  for (i = 0; i < RULE_FIELDS.length; i++) {
    key = RULE_FIELDS[i]
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    var value = raw[key]
    if (value === undefined || value === null) continue
    if (key === "port") {
      var port = parseInt(value, 10)
      if (isFinite(port) && port > 0 && port <= 65535) rule.port = port
    } else if (key === "hidden" || key === "loginShell") {
      // Only a literal true, mirroring hidden: a hand-edited "yes" must not
      // read as consent to change how the command is run.
      rule[key] = value === true
    } else if (key === "sshArgs") {
      var args = asArray(value)
      if (args.length > 0) rule.sshArgs = args
    } else {
      rule[key] = clamp(value, key === "command" ? LIMITS.command : LIMITS.text)
    }
  }
  return rule
}

function sanitizeRules(raw) {
  var out = []
  var list = Array.isArray(raw) ? raw : []
  for (var i = 0; i < list.length && out.length < LIMITS.rules; i++) {
    var rule = sanitizeRule(list[i])
    if (rule) out.push(rule)
  }
  return out
}

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
    defaultUser: clamp(raw.defaultUser, LIMITS.text),
    connectVia: clamp(raw.connectVia, 16),
    sshArgs: asArray(raw.sshArgs),
    rules: sanitizeRules(raw.rules)
  }
}

// Groups peers for display. Online first, offline last, each sorted by label;
// groups are ordered by first appearance in the rules file so the config
// author controls the reading order.
function groupPeers(entries, showOffline) {
  var groups = []
  // Keys are group names from the rules file; a plain {} would let a group
  // called "__proto__" reach Object.prototype.
  var byName = emptyMap()

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    if (entry.target.hidden) continue
    if (!entry.peer.Online && showOffline === false) continue

    var name = entry.peer.Online ? (entry.target.group || "MACHINES") : "OFFLINE"
    if (!Object.prototype.hasOwnProperty.call(byName, name)) {
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
  // sanitizeRule rather than a blind key copy: this array is about to be
  // serialized back to disk, so anything the engine does not understand -- a
  // "__proto__" key included -- has no business surviving the round trip.
  var next = sanitizeRules(rules)

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
    if (!Object.prototype.hasOwnProperty.call(fields, key) || !safeKey(key)) continue
    var value = fields[key]
    // false counts as blank: both booleans in the schema default to false, so
    // an unticked box should remove the key rather than park a dead rule that
    // says nothing. An explicit false is still honoured when written by hand.
    var blank = value === undefined || value === null || value === "" || value === 0 ||
                value === false
    if (blank) delete target[key]
    else target[key] = value
  }

  // A rule carrying nothing but its matcher does no work; drop it so repeated
  // clearing does not accumulate dead entries.
  var meaningful = false
  for (var check in target) {
    if (Object.prototype.hasOwnProperty.call(target, check) && check !== scope.kind) meaningful = true
  }

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
        command: String(r.command || ""),
        loginShell: r.loginShell === true
      }
    }
  }
  return { user: "", port: 0, command: "", loginShell: false }
}

// The reference block written into the top of the config file as "_readme".
// It lives in the file itself so someone editing the JSON has the options in
// front of them without having to remember where the plugin came from.
// bin/setup emits the same text; test/setup.test.sh asserts the two match.
var CONFIG_HELP = [
  "Tailscale SSH rules. Edits apply immediately - no restart.",
  "Full docs: https://github.com/diddado/omarchy-tailscale-ssh",
  "",
  "Rules are kept per tailnet, under \"tailnets\", keyed by MagicDNS suffix.",
  "The machines change completely when you switch accounts, so rules written",
  "for one tailnet would be meaningless on another. Switching to a tailnet with",
  "no section here makes the panel offer to set it up; your other sections are",
  "never touched.",
  "",
  "\"defaultUser\" and \"sshArgs\" at the top level apply to every tailnet; a",
  "tailnet may override defaultUser and adds to sshArgs.",
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
  "  loginShell  true runs that command through the remote login shell, so",
  "           $PATH and the locale match a normal ssh session",
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

// The caption under a row. The row title is already the hostname, so repeating
// "user@hostname.tailnet.ts.net" spends the whole line on something the reader
// can see directly above — and elision then hides the facts that are actually
// exceptional (a tag, a non-standard port, a command that runs on connect).
// The address is shown only when it is NOT simply the machine's own DNS name,
// i.e. when connectVia or an `address` override has changed it.
function rowDetail(peer, target) {
  var parts = []
  var user = String(target.user || "")
  var address = String(target.address || "")
  var dnsName = String(peer.DNSName || "")

  if (address !== "" && address !== dnsName) parts.push(user === "" ? address : user + "@" + address)
  else if (user !== "") parts.push(user)

  var tags = peer.Tags || []
  if (tags.length > 0) parts.push(String(tags[0]))
  if (target.port > 0) parts.push("port " + target.port)
  if (target.command) parts.push("\u21a6 " + String(target.command))
  return parts.join(" \u00b7 ")
}

// The row's own tailnet address, on its own line under the caption. Both lists
// were already filtered to the tailnet's ranges and clamped in peerFromStatus,
// so this only chooses which one to show: the 100.x address a peer is reached
// by, and the fd7a: one only on a tailnet with no IPv4 at all.
function rowAddress(peer) {
  if (!peer) return ""
  // Duck-typed on .length, never Array.isArray: these lists reach here after a
  // round trip through a QML `property var`, which hands JS back a
  // QVariantList-backed object that Array.isArray reports as false. The same
  // reason rowDetail reads `peer.Tags || []`.
  var v4 = peer.TailscaleIPs || []
  if (v4.length > 0) return String(v4[0])
  var v6 = peer.TailscaleIPv6 || []
  if (v6.length > 0) return String(v6[0])
  return ""
}

// ---------------------------------------------------- multi-tailnet document

// The config file holds one section per tailnet, because the machines you can
// see change completely when you switch. Rules written for one tailnet are
// meaningless on another, and silently applying them would be worse than
// having none.
//
// Keyed on MagicDNSSuffix rather than the tailnet's display name: it is unique,
// stable across a rename, and — unlike `tailscale switch --list`, which needs
// root or an operator grant — it is readable from an unprivileged
// `tailscale status --json`. Two accounts sharing a tailnet see the same
// machines and correctly share a section.
function tailnetKeyFromStatus(status) {
  if (!status) return ""
  var suffix = String(status.magicDnsSuffix || "")
  if (suffix !== "") return suffix
  // A tailnet with MagicDNS off still has a name worth keying on.
  return String(status.tailnetName || "")
}

function emptyTailnetConfig() {
  return { name: "", defaultUser: "", sshArgs: [], rules: [] }
}

// Normalizes both schemas into one shape. A v1 file is flat — one unnamed set
// of rules — which is exactly a single-tailnet config whose owner we cannot
// know from the file alone; `configForTailnet` adopts it for whichever tailnet
// is connected when it is first read.
function parseConfigDocument(text) {
  var raw
  try {
    raw = JSON.parse(String(text || ""))
  } catch (e) {
    return { ok: false, error: String(e), doc: emptyDocument() }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config file is not an object", doc: emptyDocument() }
  }

  var doc = {
    version: 2,
    defaultUser: clamp(raw.defaultUser, LIMITS.text),
    connectVia: clamp(raw.connectVia, 16),
    sshArgs: asArray(raw.sshArgs),
    tailnets: emptyMap(),
    unassignedRules: null
  }

  if (raw.tailnets && typeof raw.tailnets === "object" && !Array.isArray(raw.tailnets)) {
    var seen = 0
    for (var key in raw.tailnets) {
      if (!Object.prototype.hasOwnProperty.call(raw.tailnets, key)) continue
      if (seen >= LIMITS.tailnets) break
      if (!safeKey(key) || key.length > LIMITS.text) continue
      var entry = raw.tailnets[key]
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      seen++
      doc.tailnets[key] = {
        name: clamp(entry.name, LIMITS.text),
        defaultUser: clamp(entry.defaultUser, LIMITS.text),
        connectVia: clamp(entry.connectVia, 16),
        sshArgs: asArray(entry.sshArgs),
        rules: sanitizeRules(entry.rules)
      }
    }
  } else if (Array.isArray(raw.rules)) {
    // Not attributed to any tailnet: we cannot know which one it was written
    // for. Carried through so it is never silently lost -- bounded like every
    // other rule list, since it is rewritten back out on the next save.
    doc.unassignedRules = sanitizeRules(raw.rules)
  }

  return { ok: true, error: "", doc: doc }
}

function emptyDocument() {
  return {
    version: 2, defaultUser: "", connectVia: "", sshArgs: [],
    tailnets: emptyMap(), unassignedRules: null
  }
}

function hasTailnetConfig(doc, key) {
  if (!doc || !key || !doc.tailnets) return false
  return Object.prototype.hasOwnProperty.call(doc.tailnets, key)
}

// The flat view the rule engine consumes, with document-level values acting as
// defaults beneath the per-tailnet ones. sshArgs concatenate for the same
// reason they do across rule tiers: a global keepalive should survive a tailnet
// that only wants to add an identity file.
function configForTailnet(doc, key) {
  var flat = {
    ok: true,
    error: "",
    name: "",
    defaultUser: String((doc && doc.defaultUser) || ""),
    connectVia: String((doc && doc.connectVia) || ""),
    sshArgs: ((doc && doc.sshArgs) || []).slice(),
    rules: []
  }
  if (!doc) return flat

  var entry = hasTailnetConfig(doc, key) ? doc.tailnets[key] : null
  if (!entry) return flat

  flat.name = String(entry.name || "")
  if (entry.defaultUser) flat.defaultUser = String(entry.defaultUser)
  if (entry.connectVia) flat.connectVia = String(entry.connectVia)
  flat.sshArgs = flat.sshArgs.concat(entry.sshArgs || [])
  flat.rules = entry.rules || []
  return flat
}

// Returns a NEW document with this tailnet's rules replaced. Every other
// tailnet is carried through untouched — switching accounts must never cost
// you the config for the one you switched away from.
function withTailnetRules(doc, key, name, rules) {
  var base = doc || emptyDocument()
  var next = {
    version: 2,
    defaultUser: String(base.defaultUser || ""),
    connectVia: String(base.connectVia || ""),
    sshArgs: (base.sshArgs || []).slice(),
    tailnets: emptyMap(),
    unassignedRules: base.unassignedRules || null
  }
  for (var k in (base.tailnets || {})) {
    var e = base.tailnets[k]
    if (!e) continue
    next.tailnets[k] = {
      name: e.name, defaultUser: e.defaultUser, connectVia: e.connectVia,
      sshArgs: (e.sshArgs || []).slice(), rules: (e.rules || []).slice()
    }
  }

  if (!safeKey(key)) return next
  var existing = Object.prototype.hasOwnProperty.call(next.tailnets, key)
    ? next.tailnets[key]
    : { name: "", defaultUser: "", connectVia: "", sshArgs: [] }
  next.tailnets[key] = {
    name: clamp(name || existing.name, LIMITS.text),
    defaultUser: existing.defaultUser || "",
    connectVia: existing.connectVia || "",
    sshArgs: (existing.sshArgs || []).slice(),
    rules: sanitizeRules(rules)
  }
  return next
}

function serializeDocument(doc) {
  var out = {
    _readme: CONFIG_HELP,
    version: 2,
    defaultUser: String(doc.defaultUser || ""),
    sshArgs: doc.sshArgs || [],
    tailnets: {}
  }
  if (doc.connectVia) out.connectVia = String(doc.connectVia)
  if (doc.unassignedRules) out.rules = doc.unassignedRules
  for (var k in (doc.tailnets || {})) {
    var e = doc.tailnets[k]
    if (!e || !safeKey(k)) continue
    var entry = { name: e.name || "", rules: e.rules || [] }
    if (e.defaultUser) entry.defaultUser = e.defaultUser
    if (e.connectVia) entry.connectVia = e.connectVia
    if (e.sshArgs && e.sshArgs.length > 0) entry.sshArgs = e.sshArgs
    out.tailnets[k] = entry
  }
  return JSON.stringify(out, null, 2) + "\n"
}

// ---------------------------------------------------- config load reducer

// Deciding what to do with a config read is genuinely stateful, and getting it
// wrong is how a stale parse error ends up latched on screen. It lives here,
// pure and testable, rather than in QML.
//
// The load-bearing idea: an editor save is not one atomic event. A file being
// rewritten and a file that is genuinely broken look *identical* at the instant
// you read one. The only way to tell them apart is to look again. So a failed
// parse is provisional — it becomes an error only if the same bytes are still
// invalid on a second read.
//
// prev:     { lastText, error, config, loaded, pendingBadText }
// incoming: { loaded: bool, text: string }   loaded:false means the read failed
// returns prev's shape plus `retry`, asking the caller to re-read shortly.
function nextConfigState(prev, incoming) {
  var state = {
    lastText: (prev && prev.lastText) || "",
    error: (prev && prev.error) || "",
    config: (prev && prev.config) || emptyDocument(),
    loaded: !!(prev && prev.loaded),
    pendingBadText: (prev && prev.pendingBadText) || "",
    retry: false
  }

  var readOk = !incoming || incoming.loaded !== false
  var raw = String((incoming && incoming.text) || "")

  // A failed read, or a file that is momentarily empty, is almost always a
  // rename-style save in progress — not a user who deleted their rules. Hold
  // what we have and look again. Without this, a save briefly wipes the list.
  if (!readOk || raw.trim() === "") {
    state.loaded = true
    // Nothing to preserve on first run: an absent config is the normal
    // pre-setup state, not something to retry over.
    state.retry = state.lastText !== ""
    return state
  }

  // The same bytes we already adopted. Any error still showing came from a read
  // of a half-written file, so it demonstrably does not describe the current
  // content — clear it. Skipping this is what latched the error.
  if (raw === state.lastText) {
    state.error = ""
    state.pendingBadText = ""
    state.loaded = true
    return state
  }

  var parsed = parseConfigDocument(raw)
  if (parsed.ok) {
    state.config = parsed.doc
    state.lastText = raw
    state.error = ""
    state.pendingBadText = ""
    state.loaded = true
    return state
  }

  // Invalid. Keep the previous rules either way — a broken file should never
  // cost you the config that was working a moment ago.
  state.loaded = true
  state.retry = state.pendingBadText !== raw
  if (!state.retry) state.error = parsed.error   // still invalid on a second look
  state.pendingBadText = raw
  return state
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
    CONFIG_HELP: CONFIG_HELP,
    nextConfigState: nextConfigState,
    shellQuote: shellQuote,
    remoteCommand: remoteCommand,
    rowDetail: rowDetail,
    rowAddress: rowAddress,
    tailnetKeyFromStatus: tailnetKeyFromStatus,
    parseConfigDocument: parseConfigDocument,
    emptyDocument: emptyDocument,
    hasTailnetConfig: hasTailnetConfig,
    configForTailnet: configForTailnet,
    withTailnetRules: withTailnetRules,
    serializeDocument: serializeDocument,
    LIMITS: LIMITS,
    clamp: clamp,
    plain: plain,
    sanitizeRule: sanitizeRule,
    sanitizeRules: sanitizeRules,
    targetProblem: targetProblem,
    windowAppId: windowAppId
  }
}
