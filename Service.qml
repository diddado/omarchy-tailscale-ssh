import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Everything that talks to the outside world: polling `tailscale status`,
// watching the rules file, and launching ssh terminals. Panel.qml stays
// presentation-only and reads state off this object.
Item {
  id: root

  // Injected from the panel, which receives it from the bar (the widget's
  // inline entry in shell.json, minus its id).
  property var settings: ({})

  // ---------------------------------------------------------------- state
  property bool installed: true
  property bool running: false
  property bool refreshing: false
  property string backendState: "Unknown"
  property string statusText: "Checking…"
  property string tailnetName: ""
  property string selfName: ""
  property string lastError: ""
  property string actionStatus: ""

  // Raw peers from `tailscale status --json`, normalized by Model.js.
  property var peers: []
  // Peers paired with their resolved ssh target: [{ peer, target }].
  property var entries: []
  property var rulesConfig: ({ ok: true, error: "", defaultUser: "", sshArgs: [], rules: [] })
  property string rulesError: ""

  readonly property string userName: Quickshell.env("USER") || Quickshell.env("LOGNAME") || ""
  // What a machine logs in as when no rule names a user.
  readonly property string effectiveDefaultUser: String(rulesConfig.defaultUser || "") || userName

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 30, 5, 3600)
  readonly property bool showOffline: setting("showOffline", true) !== false

  // Config lives under XDG state, next to how the first-party weather panel
  // keeps its location (`~/.local/state/omarchy/settings/weather.json`). It
  // deliberately does NOT live in the plugin directory: that tree is under a
  // recursive inotify watch, and any write there makes the shell tear this
  // plugin down and rebuild it mid-save. State also survives `omarchy refresh
  // shell`, plugin disable/enable, and remove/re-add — none of which is true of
  // settings stored inline in shell.json.
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy/settings"
  readonly property string defaultConfigPath: stateDir + "/io.github.diddado.tailscale-ssh.json"
  readonly property string configPath: {
    var override = String(setting("configPath", "")).trim()
    return override === "" ? defaultConfigPath : expandHome(override)
  }

  // The plugin's own directory, so the panel can launch bin/setup. The bar
  // injects only bar/moduleName/settings, never a source dir, so resolve it
  // from this file's own URL.
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, "")

  // Setup has run when the config parsed and actually carries something.
  property bool configLoaded: false
  readonly property bool configured: configLoaded && (
    (rulesConfig.rules && rulesConfig.rules.length > 0) || String(rulesConfig.defaultUser || "") !== "")
  readonly property string connectVia: {
    // The rules file wins over the widget setting, so the whole SSH story can
    // live in one file if you prefer.
    var fromRules = rulesConfig && rulesConfig.connectVia ? String(rulesConfig.connectVia) : ""
    if (fromRules !== "") return fromRules
    return String(setting("connectVia", "dns"))
  }

  readonly property int onlineCount: {
    var n = 0
    for (var i = 0; i < peers.length; i++) if (peers[i].Online) n++
    return n
  }

  // ---------------------------------------------------------------- settings
  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    return n
  }

  function expandHome(path) {
    var text = String(path || "")
    if (text.indexOf("~/") === 0) return Quickshell.env("HOME") + text.slice(1)
    return text
  }

  // ---------------------------------------------------------------- resolution
  // Rebuilt whenever either input changes: the peer list or the rules. Kept as
  // one derived array so the panel never resolves a rule during a paint.
  function rebuildEntries() {
    var config = {
      defaultUser: String(rulesConfig.defaultUser || ""),
      sshArgs: rulesConfig.sshArgs || [],
      rules: rulesConfig.rules || [],
      connectVia: connectVia,
      fallbackUser: userName
    }
    var next = []
    for (var i = 0; i < peers.length; i++) {
      var peer = peers[i]
      var target = Model.resolveTarget(peer, config)
      if (target.hidden) continue
      next.push({ peer: peer, target: target })
    }
    entries = next
  }

  onPeersChanged: rebuildEntries()
  onRulesConfigChanged: rebuildEntries()
  onConnectViaChanged: rebuildEntries()

  function groupedEntries(query) {
    var filtered = []
    for (var i = 0; i < entries.length; i++) {
      if (Model.matchesFilter(entries[i], query)) filtered.push(entries[i])
    }
    return Model.groupPeers(filtered, showOffline)
  }

  // Flat list in display order, so the keyboard cursor can index it directly.
  function flatEntries(query) {
    var groups = groupedEntries(query)
    var flat = []
    for (var g = 0; g < groups.length; g++) {
      for (var i = 0; i < groups[g].items.length; i++) flat.push(groups[g].items[i])
    }
    return flat
  }

  function osIcon(os) { return Model.osIcon(os) }

  function sshCommandText(entry) {
    if (!entry) return ""
    return Model.sshCommandText(entry.peer, entry.target)
  }

  // ---------------------------------------------------------------- actions
  // Builds an argv vector and runs it without a shell parsing step. Hostnames,
  // users and sshArgs all come from config or the tailnet, so none of it may
  // be interpolated into a string a shell would re-tokenize — Util.execArgv
  // exists precisely for this.
  function connect(entry) {
    if (!entry) return
    var argv = Model.sshArgv(entry.peer, entry.target, "org.omarchy.tailssh")
    Util.execArgv(argv)
    flash("Connecting to " + entry.target.label + "…")
  }

  function copyToClipboard(value, label) {
    var text = String(value || "")
    if (text === "") return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(text) + " | wl-copy"])
    flash("Copied " + label)
  }

  function copySshCommand(entry) {
    if (!entry) return
    copyToClipboard(sshCommandText(entry), "ssh command")
  }

  function copyIp(entry) {
    if (!entry) return
    var ips = entry.peer.TailscaleIPs || []
    if (ips.length === 0) return
    copyToClipboard(ips[0], entry.target.label + " IP")
  }

  function copyDnsName(entry) {
    if (!entry) return
    copyToClipboard(entry.peer.DNSName, entry.target.label + " DNS name")
  }

  function flash(message) {
    actionStatus = String(message || "")
    actionStatusTimer.restart()
  }

  Timer {
    id: actionStatusTimer
    interval: 2200
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  // ---------------------------------------------------------------- config file

  // watchChanges picks up edits made by bin/setup or by $EDITOR while the panel
  // is open. applyConfig compares before assigning, so this plugin's own writes
  // coming back through the watcher settle instead of looping.
  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    // First run: the file does not exist yet. Without this branch configLoaded
    // never flips and the panel would never show the setup prompt.
    onLoadFailed: root.applyConfig("")
    onFileChanged: reload()
  }

  property string _lastConfigText: ""

  function applyConfig(text) {
    var raw = String(text || "")
    if (raw === _lastConfigText) {
      configLoaded = true
      return
    }
    var parsed = Model.parseRules(raw)
    if (!parsed.ok && raw.trim() !== "") {
      // Hold the last good rules rather than dropping every user mapping while
      // the file is halfway through a hand edit.
      rulesError = parsed.error
      configLoaded = true
      return
    }
    rulesError = ""
    _lastConfigText = raw
    rulesConfig = parsed
    configLoaded = true
  }

  // FileView will not create parent directories, so mkdir has to land first and
  // the initial read is deferred a tick behind it.
  Process {
    id: ensureDirProc
    command: []
    running: false
  }

  Component.onCompleted: {
    ensureDirProc.command = ["mkdir", "-p", root.stateDir]
    ensureDirProc.running = true
    Qt.callLater(function () { configFile.reload() })
  }

  function saveRules(nextRules) {
    var next = {
      defaultUser: rulesConfig.defaultUser,
      connectVia: rulesConfig.connectVia,
      sshArgs: rulesConfig.sshArgs,
      rules: nextRules
    }
    var text = Model.serializeConfig(next)
    _lastConfigText = text
    rulesConfig = Model.parseRules(text)
    configFile.setText(text)
    flash("Saved")
  }

  // ---- quick-assign helpers, thin wrappers so Panel.qml never touches Model.js

  function scopesFor(entry) {
    if (!entry) return []
    return Model.ruleScopes(entry.peer, rulesConfig)
  }

  function ruleFieldsFor(scope) {
    if (!scope) return { user: "", port: 0, command: "" }
    return Model.ruleFieldsFor(rulesConfig.rules || [], scope)
  }

  function applyRule(scope, fields) {
    if (!scope) return
    saveRules(Model.upsertRule(rulesConfig.rules || [], scope, fields))
  }

  function runSetup() {
    Util.execArgv(["omarchy-launch-tui", "--app-id=org.omarchy.tailssh-setup", pluginDir + "/bin/setup"])
  }

  function editConfig() {
    Util.execArgv(["omarchy-launch-config-editor", configPath])
  }

  // ---------------------------------------------------------------- polling
  function refresh() {
    if (statusProcess.running) return
    refreshing = true
    statusProcess.command = ["tailscale", "status", "--json"]
    statusProcess.running = true
    if (!pollWatchdog.running) pollWatchdog.start()
  }

  function applyStatus(text) {
    var parsed = Model.parseStatus(text)
    if (!parsed.ok) {
      resetUnavailable("Disconnected")
      return
    }
    backendState = parsed.backendState
    running = parsed.running
    tailnetName = parsed.tailnetName
    selfName = parsed.selfName
    peers = parsed.peers
    lastError = ""
    statusText = parsed.running
      ? (peers.length + " machines · " + onlineCount + " online")
      : (parsed.needsLogin ? "Not logged in" : parsed.backendState)
  }

  function resetUnavailable(text) {
    running = false
    peers = []
    statusText = String(text || "Unavailable")
  }

  Process {
    id: statusProcess
    running: false
    command: []
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function (exitCode) {
      root.refreshing = false
      if (exitCode === 0) {
        root.installed = true
        root.applyStatus(String(statusStdout.text || ""))
      } else {
        var err = String(statusStderr.text || "").trim()
        // Exit 127 is "command not found" from the shell layer; anything else
        // means tailscaled is not answering yet.
        root.installed = exitCode !== 127
        root.resetUnavailable(root.installed ? "Disconnected" : "Tailscale not installed")
        root.lastError = err
      }
    }
  }

  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // After a cold boot the first poll usually lands before tailscaled is up.
  // Poll quickly until it answers, then stand down.
  Timer {
    id: startupRamp
    property int ticks: 0
    interval: 2000
    repeat: true
    running: true
    onTriggered: {
      ticks += 1
      if (root.running || ticks >= 15) startupRamp.running = false
      else root.refresh()
    }
  }

  // A wedged `tailscale status` must not leave the panel spinning forever.
  Timer {
    id: pollWatchdog
    interval: 15000
    repeat: false
    onTriggered: if (statusProcess.running) statusProcess.running = false
  }
}
