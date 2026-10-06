// A stand-in for xochitl's ArkControls.ToolButton (IconButton → ButtonBase → T.Button), with
// the members dock.qml uses: down, clicked, enabled, focusPolicy, ditherOnDisabled, and the
// states idle / selected / disabled. Its face is the native one's: black when "selected".
import QtQuick
import QtQuick.Templates as T

T.Button {
    id: b
    property bool ditherOnDisabled: true
    property url iconSource
    states: [State { name: "idle" }, State { name: "selected" }, State { name: "disabled" }]
    background: Rectangle { color: b.state === "selected" ? "black" : "transparent" }
}
