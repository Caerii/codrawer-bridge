// The codrawer dock: one toolbar button that opens a small, non-modal list of actions.
//
// Instantiated at run time by codrawer-layer (src/inject.h) inside xochitl's own
// QQmlEngine and parented into xochitl's toolbar; nothing of xochitl's is changed. The extension
// sets `entries` (from /run/codrawer/dock.json, or its built-in list), `status` and `page`, and
// listens to `action(id)` and `opened()`. Selecting an entry emits `action(id)`; the extension
// sends it to the bridge as a `dock_action`, except `status`, which it answers here.
//
// Sizes are in xochitl's scene pixels (the Paper Pro's 1620 x 2160 portrait screen). On 3.29 the
// toolbar is a GridLayout ("toolbarLayout") of 112 x 112 ToolLoaders (redo is
// "editingToolLoader_redoButton"); inject.conf stacks the dock right after redo, so the layout
// gives it the next cell. `anchorItem` (set by the extension: the item it was stacked after)
// carries the toolbar's own state: when the toolbar collapses and hides redo, the dock hides too.
import QtQuick
import QtQuick.Controls

Item {
    id: root
    property var entries: []
    property string status: ""
    property string page: ""
    property var anchorItem: null
    signal action(string id)
    signal opened()

    implicitWidth: anchorItem ? anchorItem.width : 112
    implicitHeight: anchorItem ? anchorItem.height : 112
    width: implicitWidth
    height: implicitHeight
    visible: anchorItem ? anchorItem.visible : true

    Rectangle {
        id: face
        anchors.centerIn: parent
        width: Math.min(root.width, root.height) * 0.62
        height: width
        radius: width / 2
        color: tap.pressed || dock.visible ? "black" : "white"
        border.color: "black"
        border.width: 3
        Text {
            anchors.centerIn: parent
            text: "c"
            font.pixelSize: parent.height * 0.62
            font.bold: true
            color: face.color === "black" ? "white" : "black"
        }
    }

    MouseArea {
        id: tap
        anchors.fill: parent
        onClicked: {
            if (dock.visible) { dock.close(); return; }
            root.opened();
            dock.open();
        }
    }

    Popup {
        id: dock
        // Beside the button, away from the toolbar's edge; kept on screen.
        x: root.width + 8
        y: 0
        width: 520
        padding: 0
        modal: false
        focus: false
        closePolicy: Popup.CloseOnPressOutside | Popup.CloseOnEscape
        background: Rectangle { color: "white"; border.color: "black"; border.width: 3; radius: 6 }

        contentItem: Column {
            width: dock.width
            Repeater {
                model: root.entries
                delegate: Rectangle {
                    width: dock.width
                    height: 92
                    color: rowTap.pressed ? "black" : "white"
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.left: parent.left
                        anchors.leftMargin: 28
                        text: modelData.label
                        font.pixelSize: 34
                        color: rowTap.pressed ? "white" : "black"
                    }
                    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: "#888888" }
                    MouseArea {
                        id: rowTap
                        anchors.fill: parent
                        onClicked: {
                            root.action(modelData.id);
                            if (modelData.id !== "status") dock.close();
                        }
                    }
                }
            }
            Text {
                width: dock.width - 56
                x: 28
                topPadding: 16
                bottomPadding: 16
                visible: root.status.length > 0
                text: root.status
                wrapMode: Text.Wrap
                font.pixelSize: 26
                color: "#444444"
            }
        }
    }
}
