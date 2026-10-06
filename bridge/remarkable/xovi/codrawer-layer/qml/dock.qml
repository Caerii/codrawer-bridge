// The codrawer dock: one toolbar button that opens a small, non-modal list of actions.
//
// Instantiated at run time by codrawer-layer (src/inject.h) inside xochitl's own QQmlEngine and
// parented into xochitl's toolbar; nothing of xochitl's is changed. The extension sets `entries`
// (from /run/codrawer/dock.json, or its built-in list), `status` and `page`, and listens to
// `action(id)` and `opened()`. Selecting an entry emits `action(id)`; the extension sends it to
// the bridge as a `dock_action`, except `status`, which it answers here.
//
// Sizes are in xochitl's scene pixels (the Paper Pro's 1620 x 2160 portrait screen). On 3.29 the
// toolbar is a GridLayout ("toolbarLayout") of 112 x 112 ToolLoaders (redo is
// "editingToolLoader_redoButton"); inject.conf stacks the dock right after redo, so the layout
// gives it the next cell. `anchorItem` (set by the extension: the item it was stacked after)
// carries the toolbar's own state: when the toolbar collapses and hides redo, the dock hides too.
//
// # Looking and behaving like its neighbours
//
// xochitl's toolbar buttons are `ToolbarTool`s whose face is `ArkControls.ToolButton` (module
// `ark.controls`, xochitl's own design system; an IconButton of type primary_inverted, size
// Large): transparent with a black icon when idle, and a solid black cell with the icon inverted
// to white when "selected". Undo and redo show that look while the finger is down
// (`implicitlySelected: … || down`); the layers button keeps it while its panel is open. Neither
// changes the drawing tool: undo and redo never call the toolbar's `_select`, and the pen stays
// the selected tool. The dock does the same: it creates a real `ArkControls.ToolButton` (so the
// press feedback, timing and e-ink look are xochitl's own), binds its state to "selected" while it
// is pressed or the list is open, and never touches the toolbar's selection.
//
// The native button is created with Qt.createQmlObject inside a try, so a build without
// `ark.controls` (or a changed ToolButton) costs only the native look: the fallback below draws
// the same black cell with plain QtQuick, and nothing here fails to load (a load error in this
// file would trip boot/xovi.sh's XOVI_NO_INJECT gate and remove the dock).
//
// A tap that lands while the list is open closes it: the Popup closes itself on that press
// (CloseOnPressOutside), and `toggle` then ignores the click that follows within 400 ms, instead
// of opening the list again.
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

    // xochitl's ArkControls.ToolButton, or null when it could not be created (fallback face).
    property var nativeButton: null
    // The finger is on the button.
    readonly property bool down: nativeButton ? nativeButton.down : tap.pressed
    // The native "selected" look: while pressed, and while the list is open.
    readonly property bool highlighted: down || dock.visible
    // When the list last closed (ms), so the tap that closed it does not reopen it.
    property real closedAt: 0

    function toggle() {
        if (dock.visible) {
            dock.close();
            return;
        }
        if (Date.now() - closedAt < 400) return;
        root.opened();
        dock.open();
    }

    Component.onCompleted: {
        try {
            const b = Qt.createQmlObject(
                'import QtQuick\n' +
                'import ark.controls as ArkControls\n' +
                'ArkControls.ToolButton { focusPolicy: Qt.NoFocus; ditherOnDisabled: false }',
                root, "codrawer-dock-button");
            b.anchors.fill = root;
            b.z = 0;
            b.state = Qt.binding(function() { return !b.enabled ? "disabled" : (b.down || dock.visible ? "selected" : "idle"); });
            b.clicked.connect(root.toggle);
            nativeButton = b;
        } catch (e) {
            nativeButton = null;
        }
    }

    // Fallback face, only without the native button: the same black cell, no outline.
    Rectangle {
        anchors.fill: parent
        visible: !root.nativeButton
        color: root.highlighted ? "black" : "transparent"
    }
    MouseArea {
        id: tap
        anchors.fill: parent
        enabled: !root.nativeButton
        onClicked: root.toggle()
    }

    // The icon: a 48 px "c" in a ring (the toolbar's icon size), inverted with the cell.
    Item {
        z: 2
        anchors.centerIn: parent
        width: 48
        height: 48
        Rectangle {
            anchors.fill: parent
            radius: width / 2
            color: "transparent"
            border.color: root.highlighted ? "white" : "black"
            border.width: 3
        }
        Text {
            anchors.centerIn: parent
            text: "c"
            font.pixelSize: 34
            font.bold: true
            color: root.highlighted ? "white" : "black"
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
        onClosed: root.closedAt = Date.now()
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
