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
  property string magicDnsSuffix: ""
  property string selfName: ""
  property string lastError: ""
  property string actionStatus: ""

  // Raw peers from `tailscale status --json`, normalized by Model.js.
  property var peers: []
  // Peers paired with their resolved ssh target: [{ peer, target }].
  property var entries: []
  // The whole config file, holding one section per tailnet.
  property var configDoc: Model.emptyDocument()
  // Which tailnet we are actually on, learned from `tailscale status --json`.
  property string tailnetKey: ""
  // The flat view for the current tailnet, fed to the rule engine.
  readonly property var rulesConfig: Model.configForTailnet(configDoc, tailnetKey)
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
  // A configPath from shell.json is validated here rather than where it is
  // used. It has to be absolute -- bin/statefile refuses anything else, and a
  // value beginning with "-" would read as an option to the editor the pencil
  // button launches. An unusable override falls back to the default rather than
  // leaving the panel with no config at all.
  readonly property string configPathOverride: {
    var override = expandHome(String(setting("configPath", "")).trim())
    if (override === "" || override.charAt(0) !== "/") return ""
    if (/[\u0000-\u001f]/.test(override)) return ""
    return override
  }
  readonly property string configPath: configPathOverride === "" ? defaultConfigPath : configPathOverride
  readonly property bool configPathRejected: {
    var raw = String(setting("configPath", "")).trim()
    return raw !== "" && configPathOverride === ""
  }

  // The plugin's own directory, so the panel can launch bin/setup. The bar
  // injects only bar/moduleName/settings, never a source dir, so resolve it
  // from this file's own URL.
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, "")

  // Absolute interpreters, never a bare name. PATH is inherited from the shell
  // process and any other process running as this user can prepend to it, so a
  // bare `bash` or `python3` is a name someone else may get to resolve.
  readonly property string bashPath: "/usr/bin/bash"
  readonly property string pythonPath: "/usr/bin/python3"
  readonly property string statefileHelper: pluginDir + "/bin/statefile"
  readonly property string statusHelper: pluginDir + "/bin/tailscale-status"

  // The minimum a helper needs. clearEnvironment plus this drops BASH_ENV,
  // PYTHONPATH, LD_PRELOAD and everything else that rides in on an inherited
  // environment.
  readonly property var helperEnv: ({
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": Quickshell.env("HOME") || "",
    "XDG_RUNTIME_DIR": Quickshell.env("XDG_RUNTIME_DIR") || "",
    "LC_ALL": "C"
  })

  // Matches MAX_BYTES in bin/statefile and in bin/tailscale-status. Both cap at
  // the producer; this is the shell-side backstop that makes an overflow
  // visible rather than merely large.
  readonly property int maxHelperBytes: 1048576

  // Sanitizer for the shell's own components -- PanelHero, PanelSectionHeader,
  // a tooltip -- which render with Text.AutoText and cannot be pinned to
  // PlainText from a plugin.
  function plain(value, max) { return Model.plain(value, max) }

  // Setup has run when the config parsed and actually carries something.
  property bool configLoaded: false
  // Gated on knowing the tailnet too: until the first status poll lands we
  // cannot tell "no rules for this tailnet" from "we do not know which tailnet
  // this is yet", and flashing the setup prompt at every startup is wrong.
  readonly property bool tailnetKnown: tailnetKey !== ""
  readonly property bool configured: configLoaded && tailnetKnown
    && Model.hasTailnetConfig(configDoc, tailnetKey)
  // True when other tailnets are configured but this one is not — a switch to
  // an account we have never set up.
  readonly property bool newTailnet: configLoaded && tailnetKnown && !configured
    && Object.keys((configDoc && configDoc.tailnets) || {}).length > 0
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
  onTailnetKeyChanged: rebuildEntries()
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

  function rowDetail(peer, target) { return Model.rowDetail(peer, target) }

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
    // A machine names itself, so its hostname is not a value this plugin chose.
    // Model refuses one that would read to ssh as an option instead of a host,
    // and that refusal is reported rather than quietly worked around: a
    // repaired hostname would connect somewhere other than where you meant.
    if (entry.target.problem) {
      flash("Cannot connect: " + plain(entry.target.problem, 160))
      return
    }
    var argv = Model.sshArgv(entry.peer, entry.target, "org.omarchy.tailssh")
    if (argv.length === 0) {
      flash("Cannot connect: " + plain(entry.target.label, 64) + " has no usable ssh target")
      return
    }
    Util.execArgv(argv)
    flash("Connecting to " + plain(entry.target.label, 64) + "…")
  }

  // The value reaches wl-copy on stdin, as an argv array with no shell in the
  // middle. The previous form built a `bash -c "printf %s '...' | wl-copy"`
  // string; the quoting made it correct, but a command assembled as text is one
  // editing mistake away from being re-tokenized, and there is no reason to
  // construct one at all.
  property string _clipboardPending: ""
  property string _clipboardLabel: ""

  function copyToClipboard(value, label) {
    var text = Model.clamp(value, 4096)
    if (text === "") return
    if (clipboardProc.running) clipboardProc.signal(15)
    _clipboardPending = text
    _clipboardLabel = String(label || "")
    clipboardProc.command = ["/usr/bin/wl-copy"]
    clipboardProc.running = true
  }

  Process {
    id: clipboardProc
    running: false
    command: []
    stdinEnabled: true
    clearEnvironment: true
    environment: ({
      "PATH": "/usr/local/bin:/usr/bin:/bin",
      "XDG_RUNTIME_DIR": Quickshell.env("XDG_RUNTIME_DIR") || "",
      "WAYLAND_DISPLAY": Quickshell.env("WAYLAND_DISPLAY") || ""
    })
    onStarted: {
      write(root._clipboardPending)
      stdinEnabled = false
      root._clipboardPending = ""
    }
    // Reported after the fact, not before it: saying "Copied" when wl-clipboard
    // is not installed would be the panel making a claim it cannot support.
    onExited: function (exitCode) {
      if (exitCode === 0) root.flash("Copied " + root._clipboardLabel)
      else root.flash("Could not copy — is wl-clipboard installed?")
      root._clipboardLabel = ""
    }
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

  // FileView is a WATCHER here and nothing else: preload off and blockAllReads
  // on, so binding the path never opens the file. FileView follows symlinks,
  // reads the whole file with no ceiling, and would block on a FIFO planted at
  // a predictable path -- inside the process that draws every other widget on
  // the desktop. Every actual read goes through bin/statefile instead, which
  // opens once with O_NOFOLLOW|O_NONBLOCK, validates the descriptor it holds,
  // and reads a bounded number of bytes from that same descriptor.
  FileView {
    id: configWatcher
    path: root.configPath
    preload: false
    blockAllReads: true
    watchChanges: true
    printErrors: false
    // An editor save emits several inotify events; reading on each one meant
    // parsing the file mid-write. Settle first, then read once.
    onFileChanged: configDebounce.restart()
  }

  Timer {
    id: configDebounce
    interval: 150
    repeat: false
    onTriggered: root.reloadConfig()
  }

  // Armed when the reducer wants a second look: content that failed to parse is
  // only an error if it is still failing when the writer has finished.
  Timer {
    id: configRetry
    interval: 400
    repeat: false
    onTriggered: root.reloadConfig()
  }

  // ---- reading: bin/statefile read <path>
  //
  // Chunks are counted as they arrive and the producer is killed on overflow,
  // rather than collected whole and measured afterwards. StdioCollector would
  // hold the entire stream first, which puts the decision after the allocation
  // it is supposed to prevent.
  property string _readBuf: ""
  property int _readBytes: 0
  property bool _readOverflow: false
  property string _readErr: ""

  Process {
    id: readProc
    running: false
    command: []
    clearEnvironment: true
    environment: root.helperEnv
    stdout: SplitParser {
      splitMarker: ""
      onRead: function (chunk) {
        if (root._readOverflow) return
        root._readBytes += chunk.length
        if (root._readBytes > root.maxHelperBytes) {
          root._readOverflow = true
          root._readBuf = ""
          readProc.signal(15)
          readKill.restart()
          return
        }
        root._readBuf += chunk
      }
    }
    stderr: SplitParser {
      splitMarker: ""
      onRead: function (chunk) { root._readErr = Model.clamp(root._readErr + Model.clamp(chunk, 400), 400) }
    }
    onExited: function (exitCode) {
      readKill.stop()
      readDeadline.stop()
      var text = root._readBuf
      var overflow = root._readOverflow
      var err = root._readErr.replace(/^statefile:\s*/, "").trim()
      root._readBuf = ""
      root._readBytes = 0
      root._readOverflow = false
      root._readErr = ""

      if (overflow) {
        root.rulesError = "rules file is larger than " + root.maxHelperBytes + " bytes"
        root.configLoaded = true
        if (root._reloadPending) root.reloadConfig()
        return
      }
      // 3 is "not there yet", the normal state before setup has run. 1 means
      // the helper refused the file -- not a regular file, wrong owner, too
      // large. That is worth showing, not worth retrying into.
      if (exitCode === 1) {
        root.rulesError = Model.plain(err, 200) || "rules file was refused"
        root.configLoaded = true
        if (root._reloadPending) root.reloadConfig()
        return
      }
      // 3 means the file is not there yet; 0 means it is, and from then on the
      // inotify watcher is enough.
      if (exitCode === 0) root.configFileSeen = true
      root.applyConfig(exitCode === 0, exitCode === 0 ? text : "")
      if (root._reloadPending) root.reloadConfig()
    }
  }

  Timer {
    id: readDeadline
    interval: 5000
    repeat: false
    onTriggered: if (readProc.running) { readProc.signal(15); readKill.restart() }
  }

  Timer {
    id: readKill
    interval: 2000
    repeat: false
    onTriggered: if (readProc.running) readProc.signal(9)
  }

  // ---- writing: bin/statefile write <path>, document on stdin
  //
  // The helper creates an unpredictably named temporary in the destination
  // directory at mode 0600 before the first byte, fsyncs it and renames it into
  // place. rename(2) replaces a symlink at the destination instead of writing
  // through it, which a plain `>` or FileView.setText does not.
  property string _writePending: ""
  property string _writeQueued: ""
  property string _writeErr: ""

  Process {
    id: writeProc
    running: false
    command: []
    stdinEnabled: true
    clearEnvironment: true
    environment: root.helperEnv
    stderr: SplitParser {
      splitMarker: ""
      onRead: function (chunk) { root._writeErr = Model.clamp(root._writeErr + Model.clamp(chunk, 400), 400) }
    }
    onStarted: {
      write(root._writePending)
      stdinEnabled = false
      root._writePending = ""
    }
    onExited: function (exitCode) {
      writeKill.stop()
      writeDeadline.stop()
      if (exitCode !== 0) {
        var err = root._writeErr.replace(/^statefile:\s*/, "").trim()
        root.rulesError = Model.plain(err, 200) || "could not write the rules file"
        root.flash("Save failed")
      }
      root._writeErr = ""
      // Single-flight: a save made while one was in flight runs now, so two
      // fast edits cannot interleave two writers on the same file.
      if (root._writeQueued !== "") {
        var queued = root._writeQueued
        root._writeQueued = ""
        root.startWrite(queued)
      }
    }
  }

  Timer {
    id: writeDeadline
    interval: 5000
    repeat: false
    onTriggered: if (writeProc.running) { writeProc.signal(15); writeKill.restart() }
  }

  Timer {
    id: writeKill
    interval: 2000
    repeat: false
    onTriggered: if (writeProc.running) writeProc.signal(9)
  }

  function startWrite(text) {
    if (writeProc.running) { _writeQueued = text; return }
    _writePending = text
    _writeErr = ""
    writeProc.command = [pythonPath, "-I", statefileHelper, "write", configPath]
    writeProc.running = true
    writeDeadline.restart()
  }

  property string _lastConfigText: ""
  property string _pendingBadText: ""

  function applyConfig(readOk, text) {
    var next = Model.nextConfigState({
      lastText: _lastConfigText,
      error: rulesError,
      config: configDoc,
      loaded: configLoaded,
      pendingBadText: _pendingBadText
    }, { loaded: readOk, text: text })

    _lastConfigText = next.lastText
    _pendingBadText = next.pendingBadText
    rulesError = next.error
    // Same object when nothing changed, so this does not churn the entry list.
    configDoc = next.config
    configLoaded = next.loaded
    if (next.retry) configRetry.restart()
  }

  // Single-flight, but never a dropped change: a reload asked for while one is
  // in flight is remembered and run when that one lands. Returning early
  // instead would silently lose the edit the watcher had just seen.
  property bool _reloadPending: false

  function reloadConfig() {
    if (readProc.running) { _reloadPending = true; return }
    _reloadPending = false
    _readBuf = ""
    _readBytes = 0
    _readOverflow = false
    _readErr = ""
    readProc.command = [pythonPath, "-I", statefileHelper, "read", configPath]
    readProc.running = true
    readDeadline.restart()
  }

  // Loading the plugin reads; it does not create anything. The state directory
  // is created by bin/statefile on the first save, which is a deliberate user
  // action -- mounting a widget is not.
  Component.onCompleted: Qt.callLater(function () { root.reloadConfig() })

  // FileView cannot watch a file that does not exist yet, so until one does the
  // poll tick re-reads. The moment a read succeeds the watcher takes over and
  // this stands down for good -- it is a cold-start bridge, not a poll loop.
  property bool configFileSeen: false

  Timer {
    id: configColdStart
    interval: Math.max(5, root.refreshIntervalSec) * 1000
    repeat: true
    running: !root.configFileSeen
    onTriggered: root.reloadConfig()
  }

  Component.onDestruction: {
    // Nothing this plugin started outlives it.
    if (readProc.running) readProc.signal(15)
    if (writeProc.running) writeProc.signal(15)
    if (statusProcess.running) statusProcess.signal(15)
    if (clipboardProc.running) clipboardProc.signal(15)
  }

  function saveRules(nextRules) {
    if (!tailnetKnown) {
      flash("Waiting for Tailscale before saving")
      return
    }
    var nextDoc = Model.withTailnetRules(configDoc, tailnetKey, tailnetName, nextRules)
    var text = Model.serializeDocument(nextDoc)
    _lastConfigText = text
    _pendingBadText = ""
    rulesError = ""
    configDoc = nextDoc
    startWrite(text)
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

  readonly property string homepage: "https://github.com/diddado/omarchy-tailscale-ssh"

  function openHelp() {
    Util.execArgv(["omarchy-launch-browser", homepage])
  }

  // ---------------------------------------------------------------- polling
  // Everything the panel shows: the tailnet AND the rules. `refresh()` alone
  // only re-polls tailscale, which is why the refresh button could not clear a
  // stale rules error.
  function refreshAll() {
    reloadConfig()
    refresh()
  }

  function refresh() {
    if (statusProcess.running) return
    refreshing = true
    _statusBuf = ""
    _statusBytes = 0
    _statusOverflow = false
    _statusErr = ""
    // bin/tailscale-status, not the CLI directly: the helper runs it in its own
    // session under an absolute deadline, caps stdout at the producer and
    // bounds stderr separately.
    statusProcess.command = [bashPath, statusHelper]
    statusProcess.running = true
    pollWatchdog.restart()
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
    magicDnsSuffix = parsed.magicDnsSuffix
    tailnetKey = Model.tailnetKeyFromStatus(parsed)
    selfName = parsed.selfName
    peers = parsed.peers
    lastError = ""
    statusText = parsed.running
      ? (peers.length + (parsed.truncated ? "+" : "") + " machines · " + onlineCount + " online")
      : (parsed.needsLogin ? "Not logged in" : Model.plain(parsed.backendState, 64))
  }

  function resetUnavailable(text) {
    running = false
    peers = []
    statusText = String(text || "Unavailable")
  }

  // Chunk-counted rather than collected. A StdioCollector holds the whole of
  // stdout and stderr before any length check can run, so the guard would sit
  // after the allocation it exists to prevent -- inside the process that hosts
  // every other widget on the desktop.
  property string _statusBuf: ""
  property int _statusBytes: 0
  property bool _statusOverflow: false
  property string _statusErr: ""

  Process {
    id: statusProcess
    running: false
    command: []
    clearEnvironment: true
    environment: root.helperEnv
    stdout: SplitParser {
      splitMarker: ""
      onRead: function (chunk) {
        if (root._statusOverflow) return
        root._statusBytes += chunk.length
        if (root._statusBytes > root.maxHelperBytes) {
          root._statusOverflow = true
          root._statusBuf = ""
          statusProcess.signal(15)
          statusKill.restart()
          return
        }
        root._statusBuf += chunk
      }
    }
    stderr: SplitParser {
      splitMarker: ""
      onRead: function (chunk) { root._statusErr = Model.clamp(root._statusErr + Model.clamp(chunk, 400), 400) }
    }
    onExited: function (exitCode) {
      pollWatchdog.stop()
      statusKill.stop()
      root.refreshing = false

      var text = root._statusBuf
      var overflow = root._statusOverflow
      var err = Model.plain(root._statusErr.trim(), 200)
      root._statusBuf = ""
      root._statusBytes = 0
      root._statusOverflow = false
      root._statusErr = ""

      if (overflow) {
        root.resetUnavailable("Status response too large")
        root.lastError = "tailscale status exceeded " + root.maxHelperBytes + " bytes"
        return
      }
      if (exitCode === 0) {
        root.installed = true
        root.applyStatus(text)
        return
      }
      // 127 is the helper saying it could not find the CLI at any of the
      // absolute paths it will accept; anything else means tailscaled is not
      // answering yet.
      root.installed = exitCode !== 127
      root.resetUnavailable(root.installed ? "Disconnected" : "Tailscale not installed")
      root.lastError = err
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
  // `running = false` reaches only the wrapper, so the escalation is explicit:
  // TERM, a short grace, then KILL. The helper puts the CLI in its own session
  // under `timeout -k`, so the signal reaches the whole group rather than just
  // the process this one holds a handle to.
  Timer {
    id: pollWatchdog
    interval: 15000
    repeat: false
    onTriggered: if (statusProcess.running) { statusProcess.signal(15); statusKill.restart() }
  }

  Timer {
    id: statusKill
    interval: 2000
    repeat: false
    onTriggered: if (statusProcess.running) statusProcess.signal(9)
  }
}
