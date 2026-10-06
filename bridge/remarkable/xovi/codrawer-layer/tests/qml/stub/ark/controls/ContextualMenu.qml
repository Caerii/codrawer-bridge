// A stand-in for xochitl's ArkControls.ContextualMenu with its inline Button (a ButtonBase with
// the paper states idle / selected), as selection-ask.qml uses it.
import QtQuick
import QtQuick.Templates as T

Item {
    component Button: T.Button {
        id: b
        states: [State { name: "idle" }, State { name: "selected" }]
        background: Rectangle { color: b.state === "selected" ? "black" : "white" }
    }
}
