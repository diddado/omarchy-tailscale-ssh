import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar widget: a >_ icon that opens a filterable list of tailnet machines, each
// with a one-click SSH button and an inline form for setting its login user.
// All shelling out, config I/O and rule resolution lives in Service.qml; this
// file is presentation and the keyboard cursor model.
Panel {
  id: root
  moduleName: "io.github.diddado.tailscale-ssh"
  ipcTarget: "io.github.diddado.tailscale-ssh"
  manageIpc: false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // ---------------------------------------------------------------- theme
  // Prefer the bar's live theme values; fall back to the singletons when the
  // widget is rendered outside a bar.
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color barIconColor: tailssh.running ? barForeground : Qt.darker(barForeground, 1.55)

  // ---------------------------------------------------------------- cursor
  property string filterQuery: ""
  property int cursorIndex: 0
  property bool cursorActive: false

  // The flat, filtered, display-ordered list. Everything indexes into this.
  readonly property var visibleEntries: tailssh.flatEntries(filterQuery)
  readonly property var visibleGroups: tailssh.groupedEntries(filterQuery)

  readonly property bool focusFilterOnOpen: setting("focusFilterOnOpen", true) !== false

  // Quick-assign edit mode. -1 means no row is being edited. The key catcher
  // gates on this single flag rather than OR-ing each field's activeFocus:
  // focus handoff between fields momentarily drops activeFocus everywhere, and
  // a keystroke landing in that gap would drive the cursor instead of the form.
  property int editingIndex: -1
  property var editScopes: []
  property int editScopeIndex: 0
  readonly property var editScope: editScopeIndex >= 0 && editScopeIndex < editScopes.length
    ? editScopes[editScopeIndex] : null

  function editSelected() {
    var entry = selectedEntry()
    if (!entry) return
    openEditor(cursorIndex, entry)
  }

  function openEditor(index, entry) {
    editScopes = tailssh.scopesFor(entry)
    // Default to the broadest scope that is not the bare hostname — configuring
    // one member of a fleet almost always means configuring the fleet.
    editScopeIndex = 0
    editingIndex = index
    loadEditorFields()
  }

  function loadEditorFields() {
    var fields = tailssh.ruleFieldsFor(editScope)
    editUser = fields.user
    editPort = fields.port
    editCommand = fields.command
  }

  function closeEditor() {
    editingIndex = -1
    editScopes = []
    Qt.callLater(function () { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  function saveEditor() {
    tailssh.applyRule(editScope, { user: editUser, port: editPort, command: editCommand })
    closeEditor()
  }

  property string editUser: ""
  property int editPort: 0
  property string editCommand: ""

  function selectedEntry() {
    if (cursorIndex < 0 || cursorIndex >= visibleEntries.length) return null
    return visibleEntries[cursorIndex]
  }

  function clampCursor() {
    if (visibleEntries.length === 0) { cursorIndex = 0; return }
    if (cursorIndex < 0) cursorIndex = 0
    if (cursorIndex >= visibleEntries.length) cursorIndex = visibleEntries.length - 1
  }

  function moveCursor(delta) {
    if (visibleEntries.length === 0) return
    cursorActive = true
    cursorIndex = (cursorIndex + delta + visibleEntries.length) % visibleEntries.length
    // Rows just moved under the pointer; make the gate demand real motion
    // before hover is allowed to take the cursor back.
    pointerGate.reset()
    scrollCursorIntoView()
  }

  // Hover routes through here rather than each row painting its own highlight,
  // which is the CursorSurface contract: exactly one highlight on screen,
  // whether it was the mouse or the keyboard that put it there.
  function setCursor(index) {
    cursorActive = true
    cursorIndex = index
  }

  function activateCursor() {
    var entry = selectedEntry()
    if (!entry) return
    if (!entry.peer.Online) { tailssh.flash("That machine is offline"); return }
    tailssh.connect(entry)
    root.close()
  }

  onVisibleEntriesChanged: {
    clampCursor()
    pointerGate.reset()
  }

  onOpenedChanged: {
    if (!opened) return
    filterQuery = ""
    cursorIndex = 0
    cursorActive = false
    if (panelFlick) panelFlick.contentY = 0
    tailssh.refreshAll()
    Qt.callLater(function () {
      if (root.focusFilterOnOpen && filterField) filterField.forceActiveFocus()
      else if (keyCatcher) keyCatcher.forceActiveFocus()
    })
  }

  // Row items are direct children of their group's Column, so scroll-into-view
  // needs to find the right column first.
  function rowItemAt(index) {
    var seen = 0
    for (var g = 0; g < groupRepeater.count; g++) {
      var section = groupRepeater.itemAt(g)
      if (!section || !section.rowColumn) continue
      var children = section.rowColumn.children
      for (var i = 0; i < children.length; i++) {
        // A Repeater leaves its own item in the children list; skip anything
        // that is not one of our rows.
        if (!children[i] || children[i].rowIndex === undefined) continue
        if (seen === index) return children[i]
        seen++
      }
    }
    return null
  }

  function scrollCursorIntoView() {
    var item = rowItemAt(cursorIndex)
    if (!panelFlick || !item) return
    Qt.callLater(function () {
      if (!item) return
      var margin = Style.space(6)
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  Service {
    id: tailssh
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { tailssh.refreshAll(); return "ok" }
    function status(): string { return tailssh.statusText }
  }

  // ---------------------------------------------------------------- bar icon
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        TailscaleSshIcon {
          anchors.centerIn: parent
          iconSize: Style.space(11)
          color: root.barIconColor
          badgeColor: root.urgent
          crossed: !tailssh.running
          warning: tailssh.rulesError !== ""
        }
      }
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.MiddleButton) tailssh.refresh()
      else root.toggle()
    }
  }

  // ---------------------------------------------------------------- popup
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: root.focusFilterOnOpen ? filterField : keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // The catcher must stand down while any editor owns the keyboard, or it
      // eats every printable character before the field sees it.
      blocked: filterField.activeFocus || root.editingIndex >= 0

      onMoveRequested: function (dx, dy) {
        if (dy === 0) return
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (t) {
        var key = String(t).toLowerCase()
        if (key === "/") { filterField.forceActiveFocus() }
        else if (key === "e") root.editSelected()
        else if (key === "y") tailssh.copySshCommand(root.selectedEntry())
        else if (key === "c") tailssh.copyIp(root.selectedEntry())
        else if (key === "d") tailssh.copyDnsName(root.selectedEntry())
        else if (key === "r") tailssh.refreshAll()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          // ------------------------------------------------------ header
          // PanelHero, PanelSectionHeader and tooltipText are the shell's own
          // components: they render with Text.AutoText and a plugin cannot pin
          // them to PlainText. Qt renders a string that looks like markup as
          // rich text, and rich text loads <img src="...">, which is a real
          // request out of the shell process to a URL the string's author
          // chose. The tailnet name and every group name come from the network
          // or from a file, so each is stripped and capped on the way in.
          PanelHero {
            width: parent.width
            title: tailssh.tailnetName !== "" ? tailssh.plain(tailssh.tailnetName, 64) : "Tailscale SSH"
            meta: tailssh.plain(tailssh.statusText, 96)
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: tailssh.running ? 1.0 : 0.5
            iconComponent: Component {
              TailscaleSshIcon {
                iconSize: Style.font.display
                color: root.foreground
                badgeColor: root.urgent
                crossed: !tailssh.running
                warning: tailssh.rulesError !== ""
              }
            }
            trailingControl: Component {
              Row {
                spacing: Style.space(4)

                PanelActionButton {
                  iconText: "󰋖"
                  tooltipText: "Documentation"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: {
                    tailssh.openHelp()
                    root.close()
                  }
                }

                PanelActionButton {
                  iconText: "󰏫"
                  tooltipText: "Edit rules file"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: tailssh.editConfig()
                }

                PanelActionButton {
                  iconText: "󰑐"
                  tooltipText: "Refresh"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: tailssh.refreshAll()
                }
              }
            }
          }

          // Transient action feedback, plus the one error worth surfacing in
          // the panel: a rules file that no longer parses.
          Text {
            visible: text !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: {
              if (tailssh.configPathRejected) return "The configPath setting is not an absolute path; "
                  + "using the default rules file instead."
              if (tailssh.rulesError !== "") return "Rules file problem \u2014 "
                  + tailssh.rulesError + ". Previous rules are still in use; click the pencil to fix it."
              if (tailssh.actionStatus !== "") return tailssh.actionStatus
              if (tailssh.lastError !== "") return tailssh.lastError
              return ""
            }
            color: tailssh.rulesError !== "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          // ------------------------------------------------------ filter
          TextField {
            id: filterField
            width: parent.width
            foreground: root.foreground
            // Every text entry point carries an explicit ceiling. The filter
            // string is re-scanned against every machine on every keystroke.
            maximumLength: 128
            placeholderText: "Filter machines, tags, IPs…"
            text: root.filterQuery
            visible: tailssh.installed && tailssh.running

            onTextChanged: {
              root.filterQuery = text
              root.cursorIndex = 0
              root.cursorActive = text !== ""
            }
            onAccepted: root.activateCursor()

            // The catcher is blocked while this field has focus, so navigation
            // keys have to be re-offered here. Same pattern the built-in
            // Tailscale panel uses for its region search.
            Keys.onPressed: function (event) {
              if (event.key === Qt.Key_Down) { root.moveCursor(1); event.accepted = true; return }
              if (event.key === Qt.Key_Up) { root.moveCursor(-1); event.accepted = true; return }
              if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                root.activateCursor()
                event.accepted = true
                return
              }
              if (event.key === Qt.Key_Escape) {
                // Two-tier Escape: clear a filter first, close on the second press.
                if (root.filterQuery !== "") root.filterQuery = ""
                else root.close()
                event.accepted = true
                return
              }
              // Row actions, Alt-modified so they coexist with typing a filter.
              if (event.modifiers & Qt.AltModifier) {
                if (event.key === Qt.Key_E) { root.editSelected(); event.accepted = true }
                else if (event.key === Qt.Key_Y) { tailssh.copySshCommand(root.selectedEntry()); event.accepted = true }
                else if (event.key === Qt.Key_C) { tailssh.copyIp(root.selectedEntry()); event.accepted = true }
                else if (event.key === Qt.Key_D) { tailssh.copyDnsName(root.selectedEntry()); event.accepted = true }
                else if (event.key === Qt.Key_R) { tailssh.refreshAll(); event.accepted = true }
              }
            }
          }

          // ------------------------------------------------------ states
          Text {
            visible: !tailssh.installed
            width: parent.width
            textFormat: Text.PlainText
            text: "The tailscale CLI is not on PATH."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            visible: tailssh.installed && !tailssh.running
            width: parent.width
            textFormat: Text.PlainText
            text: "Tailscale is not connected."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          // Setup has never run. `omarchy plugin add` deliberately executes no
          // plugin code, so generating rules from the tailnet has to be offered
          // here rather than done at install time.
          Column {
            visible: tailssh.installed && tailssh.running && !tailssh.configured
            width: parent.width
            spacing: Style.space(10)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: tailssh.newTailnet
                ? "No rules for " + (tailssh.tailnetName !== "" ? tailssh.plain(tailssh.tailnetName, 64) : "this tailnet")
                : "No SSH rules yet"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: tailssh.newTailnet
                ? "Rules are kept per tailnet, because the machines change completely "
                  + "when you switch. Your other tailnets are untouched \u2014 setup will "
                  + "add a section for this one."
                : "Setup reads your tailnet, groups the machines it finds, and asks "
                  + "which user to log in as. It never guesses one."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Button {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "Run setup"
              iconText: "󰒓"
              focusable: true
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: {
                tailssh.runSetup()
                root.close()
              }
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "Machines are listed below regardless; without rules they use "
                  + tailssh.effectiveDefaultUser + "."
              color: Qt.darker(root.foreground, 2.1)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }
          }

          PanelSeparator {
            visible: tailssh.installed && tailssh.running && !tailssh.configured
            foreground: root.foreground
          }

          Text {
            visible: tailssh.installed && tailssh.running && root.visibleEntries.length === 0
            width: parent.width
            textFormat: Text.PlainText
            text: root.filterQuery === "" ? "No machines on this tailnet." : "No machines match that filter."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          // ------------------------------------------------------ machines
          Repeater {
            id: groupRepeater
            model: root.visibleGroups

            Column {
              id: section
              required property var modelData
              required property int index

              // The running count of rows before this group, so each row can
              // work out its index into the flat visibleEntries list.
              readonly property int baseIndex: {
                var n = 0
                for (var i = 0; i < index; i++) n += root.visibleGroups[i].items.length
                return n
              }
              property alias rowColumn: rows

              width: parent.width
              spacing: Style.space(10)

              PanelSeparator {
                visible: section.index > 0
                foreground: root.foreground
              }

              PanelSectionHeader {
                text: tailssh.plain(section.modelData.name, 64)
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              Column {
                id: rows
                width: parent.width
                spacing: Style.space(6)

                Repeater {
                  model: section.modelData.items
                  MachineRow {
                    required property var modelData
                    required property int index
                    width: rows.width
                    entry: modelData
                    rowIndex: section.baseIndex + index
                  }
                }
              }
            }
          }

          // ------------------------------------------------------ hint
          Text {
            visible: tailssh.installed && tailssh.running && root.visibleEntries.length > 0
            width: parent.width
            textFormat: Text.PlainText
            text: "enter ssh · alt+e configure · alt+y copy command · alt+c copy ip · esc close"
            color: Qt.darker(root.foreground, 2.1)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }
    }
  }

  // Keeps a stationary pointer from stealing the cursor when the list
  // re-filters or scrolls underneath it.
  PointerMoveGate { id: pointerGate }

  // ---------------------------------------------------------------- row
  component MachineRow: CursorSurface {
    id: machineRow
    required property var entry
    required property int rowIndex

    readonly property bool online: entry && entry.peer.Online
    readonly property bool editing: root.editingIndex === rowIndex
    readonly property string label: entry ? String(entry.target.label || entry.peer.HostName) : ""
    readonly property string account: {
      if (!entry) return ""
      var user = String(entry.target.user || "")
      var address = String(entry.target.address || "")
      return user === "" ? address : user + "@" + address
    }
    readonly property string detail:
      entry ? tailssh.rowDetail(entry.peer, entry.target) : ""

    hasCursor: root.cursorActive && root.cursorIndex === rowIndex
    foreground: root.foreground
    opacity: online || editing ? 1.0 : 0.55

    readonly property real baseHeight:
      Math.max(rowContent.implicitHeight, sshButton.implicitHeight) + Style.spacing.rowPaddingX
    implicitHeight: baseHeight + (editing ? editor.implicitHeight + Style.space(8) : 0)

    // Only over the row proper — clicks inside the editor must not connect.
    MouseArea {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      height: machineRow.baseHeight
      acceptedButtons: Qt.LeftButton
      hoverEnabled: true
      cursorShape: Qt.ArrowCursor
      onPositionChanged: function (mouse) {
        if (pointerGate.moved(machineRow, mouse)) root.setCursor(machineRow.rowIndex)
      }
      onClicked: {
        if (machineRow.editing) return
        root.setCursor(machineRow.rowIndex)
        root.activateCursor()
      }
    }

    RowLayout {
      id: mainRow
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      height: machineRow.baseHeight
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: tailssh.osIcon(machineRow.entry ? machineRow.entry.peer.OS : "")
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: machineRow.label
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: machineRow.detail
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      PanelActionButton {
        id: configureButton
        iconText: "󰒓"
        tooltipText: "Configure SSH user"
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onClicked: {
          if (machineRow.editing) root.closeEditor()
          else root.openEditor(machineRow.rowIndex, machineRow.entry)
        }
      }

      PanelActionButton {
        id: copyButton
        iconText: "󰆏"
        tooltipText: "Copy ssh command"
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onClicked: tailssh.copySshCommand(machineRow.entry)
      }

      PanelActionButton {
        id: sshButton
        iconText: "󰆍"
        tooltipText: machineRow.online
          ? "SSH as " + tailssh.plain(machineRow.account, 64)
          : "Offline"
        enabled: machineRow.online
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onClicked: {
          tailssh.connect(machineRow.entry)
          root.close()
        }
      }
    }

    // Quick-assign form, expanded under the row it belongs to — the same shape
    // the wifi panel uses for its passphrase prompt.
    Column {
      id: editor
      visible: machineRow.editing
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: mainRow.bottom
      anchors.leftMargin: Style.space(12)
      anchors.rightMargin: Style.space(10)
      anchors.topMargin: Style.space(4)
      spacing: Style.space(6)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Apply to"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      // Scope chips: prefix / tag / this machine. Only scopes that actually
      // apply to this machine are offered, so a stable one-off shows just one.
      ButtonGroup {
        id: scopeGroup
        visible: root.editScopes.length > 1
        // Chips get short labels — a generated hostname is far too long to sit
        // in a row of three and would push the group past the panel edge.
        options: {
          var out = []
          for (var i = 0; i < root.editScopes.length; i++) {
            var scope = root.editScopes[i]
            var text = tailssh.plain(scope.label, 48)
            if (scope.kind === "host") text = "this machine"
            else if (scope.kind === "tag") text = tailssh.plain(String(scope.value).replace(/^tag:/, ""), 48)
            out.push({ value: String(i), label: text })
          }
          return out
        }
        value: String(root.editScopeIndex)
        foreground: root.foreground
        fontFamily: root.fontFamily
        fontSize: Style.font.caption
        onChanged: function (v) {
          root.editScopeIndex = parseInt(v, 10) || 0
          root.loadEditorFields()
        }
      }

      Text {
        visible: root.editScopes.length === 1
        width: parent.width
        textFormat: Text.PlainText
        text: root.editScope ? String(root.editScope.label) : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Row {
        width: parent.width
        spacing: Style.space(6)

        TextField {
          id: userField
          width: (parent.width - Style.space(12)) * 0.44
          foreground: root.foreground
          maximumLength: 32
          placeholderText: "user (blank = " + tailssh.effectiveDefaultUser + ")"
          verticalPadding: Style.spacing.controlPaddingY
          text: root.editUser
          onTextChanged: root.editUser = text
          onAccepted: commandField.forceActiveFocus()
          Keys.onEscapePressed: root.closeEditor()
        }

        TextField {
          id: portField
          width: (parent.width - Style.space(12)) * 0.20
          foreground: root.foreground
          maximumLength: 5
          placeholderText: "port"
          verticalPadding: Style.spacing.controlPaddingY
          inputMethodHints: Qt.ImhDigitsOnly
          validator: IntValidator { bottom: 0; top: 65535 }
          text: root.editPort > 0 ? String(root.editPort) : ""
          onTextChanged: root.editPort = parseInt(text, 10) || 0
          onAccepted: root.saveEditor()
          Keys.onEscapePressed: root.closeEditor()
        }

        TextField {
          id: commandField
          width: (parent.width - Style.space(12)) * 0.36
          foreground: root.foreground
          maximumLength: 1024
          placeholderText: "on connect"
          verticalPadding: Style.spacing.controlPaddingY
          text: root.editCommand
          onTextChanged: root.editCommand = text
          onAccepted: root.saveEditor()
          Keys.onEscapePressed: root.closeEditor()
        }
      }

      Row {
        anchors.right: parent.right
        spacing: Style.space(6)

        Button {
          text: "Cancel"
          focusable: true
          foreground: root.foreground
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          verticalPadding: Style.space(3)
          onClicked: root.closeEditor()
        }

        Button {
          text: "Save"
          focusable: true
          bordered: true
          foreground: root.foreground
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          verticalPadding: Style.space(3)
          onClicked: root.saveEditor()
        }
      }
    }

    onEditingChanged: if (editing) Qt.callLater(function () { userField.forceActiveFocus() })
  }
}
