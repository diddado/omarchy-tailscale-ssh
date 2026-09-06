import QtQuick
import qs.Commons
import qs.Ui

// Bar glyph: a ">_" shell prompt, drawn natively.
//
// The first attempt reused Tailscale's 3x3 dot grid with the lit dots forming a
// chevron. Rendered at 11px next to the real Tailscale widget the two were
// nearly indistinguishable, which defeats the point of a second icon. A prompt
// is unambiguous at bar size and says "terminal" without a legend.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  property bool crossed: false
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  readonly property real stroke: Math.max(1.5, iconSize * 0.12)
  readonly property real armLength: iconSize * 0.36
  // The chevron's point. Sits left of centre so the underscore has room.
  readonly property real vertexX: iconSize * 0.52
  readonly property real vertexY: iconSize * 0.42

  // Rotation is clockwise with y pointing down, so 225 aims up-left and 135
  // aims down-left. Both arms pivot on their left edge at the shared vertex.
  Rectangle {
    x: root.vertexX
    y: root.vertexY - root.stroke / 2
    width: root.armLength
    height: root.stroke
    radius: root.stroke / 2
    color: root.color
    transformOrigin: Item.Left
    rotation: 225
    antialiasing: true
  }

  Rectangle {
    x: root.vertexX
    y: root.vertexY - root.stroke / 2
    width: root.armLength
    height: root.stroke
    radius: root.stroke / 2
    color: root.color
    transformOrigin: Item.Left
    rotation: 135
    antialiasing: true
  }

  Rectangle {
    x: root.iconSize * 0.56
    y: root.iconSize * 0.78
    width: root.iconSize * 0.42
    height: root.stroke
    radius: root.stroke / 2
    color: root.color
    antialiasing: true
  }

  // Struck through when Tailscale is down, matching the built-in widget's
  // vocabulary so both icons mean the same thing at a glance.
  Rectangle {
    visible: root.crossed
    anchors.centerIn: parent
    width: parent.width * 1.22
    height: Math.max(2, parent.height * 0.14)
    radius: height / 2
    color: root.color
    rotation: -45
    antialiasing: true
  }

  BorderSurface {
    visible: root.warning
    width: Math.max(7, parent.width * 0.42)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    borderSpec: Border.flat(Color.popups.background, 1)

    Text {
      anchors.centerIn: parent
      // Literal, but pinned anyway: the invariant a reviewer can check is
      // "every Text in this tree names its format", not "every Text that
      // happens to hold a variable does".
      textFormat: Text.PlainText
      text: "!"
      color: Color.background
      font.family: Style.font.family
      font.pixelSize: Math.max(6, parent.height * 0.72)
      font.bold: true
    }
  }
}
