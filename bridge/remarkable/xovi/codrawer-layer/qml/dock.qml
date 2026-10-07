// The codrawer dock: one toolbar button that opens a small panel of actions beside it.
//
// Instantiated at run time by codrawer-layer (src/inject.h) inside xochitl's own QQmlEngine and
// parented into xochitl's toolbar; nothing of xochitl's is changed. The extension sets `entries`
// (from /run/codrawer/dock.json, or its built-in list; an offer to go somewhere comes first,
// src/navigate.h), `status`, `page` and `badge` (an offer is waiting), and listens to
// `action(id)` and `opened()`. Selecting an entry emits `action(id)`; the extension sends it to
// the bridge as a `dock_action`, except `status`, which it answers here, and `goto_offer`, which
// it carries out (the user's tap is what lets it navigate).
//
// Sizes are in xochitl's scene pixels (the Paper Pro's 1620 x 2160 portrait screen). On 3.29 the
// toolbar is a GridLayout ("toolbarLayout") of 112 x 112 ToolLoaders (redo is
// "editingToolLoader_redoButton"); inject.conf stacks the dock right after redo, so the layout
// gives it the next cell. `anchorItem` (set by the extension: the item it was stacked after)
// carries the toolbar's own state: when the toolbar collapses and hides redo, the dock hides too.
//
// # The button
//
// xochitl's toolbar buttons are `ToolbarTool`s whose face is `ArkControls.ToolButton` (module
// `ark.controls`): transparent with a black icon when idle, a solid black cell with the icon
// inverted when "selected". Undo and redo show that look while pressed; the layers button keeps
// it while its panel is open. Neither changes the drawing tool. The dock creates a real
// `ArkControls.ToolButton` (Qt.createQmlObject in a try, with a plain-QtQuick fallback of the same
// look), binds it to "selected" while pressed or open, and never touches the toolbar's selection.
// Confirmed on the device (2026-10-06).
//
// # The panel
//
// xochitl's toolbar panels (the layers panel, the pen foldouts) are not Popups: a
// `ToolbarFoldout` is an ordinary child item of its button, shown and hidden, drawn as a white
// fill with a 2 px black border, no radius, no shadow, with a touch sink under it; its rows are
// 112 px high with 32 px padding and a 32 px Medium label (reMarkable Sans), black with the label
// inverted when selected or pressed, and 2 px black dividers (extracted xochitl QML, 6.0.105:
// ToolbarFoldout, ArkControls.FoldoutItem and the toolbar tokens). The panel below is drawn to
// that spec in plain QtQuick (ToolbarFoldout itself needs the toolbar's private state), as a child
// of the dock, so it lives in xochitl's item tree like theirs.
//
// The first version used a QtQuick.Controls Popup; on the device its white fills did not cover
// the page (the ruled lines showed through and each row looked like a loose overlay). A Popup is
// moved into the window's overlay, outside the item tree, where none of xochitl's e-paper screen
// mode regions (`xofm.libs.epaper` ScreenModeItem: Content for the page, Overlay for UI drawn on
// it) applies to it. The panel therefore marks itself as an Overlay region like xochitl's own
// on-canvas UI (created in a try: without it the panel still works). It does not touch the pen's
// input: a PenInputBlocker of ours (xofm.libs.peninput) went with the 2026-10-07 incident in which
// the user's pen stopped writing (the cause was live.qml covering the page; a blocker whose reach
// is not known is not worth that risk). While closed, nothing of the panel is visible or enabled;
// tests/qml/dock_test.qml checks it.
//
// The status reply is the panel's last row. A tap outside the open panel closes it (and is used up
// by that, as a menu's outside tap is); a tap on the button closes it too; an action closes it,
// `status` keeps it open to show the reply.
import QtQuick

Item {
    id: root
    property var entries: []
    property string status: ""
    property string page: ""
    property bool badge: false
    property var anchorItem: null
    signal action(string id)
    signal opened()

    implicitWidth: anchorItem ? anchorItem.width : 112
    implicitHeight: anchorItem ? anchorItem.height : 112
    width: implicitWidth
    height: implicitHeight
    visible: anchorItem ? anchorItem.visible : true
    // above the neighbouring toolbar cells while the panel is open, as a ToolLoader with an open
    // foldout is
    z: open ? 1 : 0

    // The panel is showing.
    property bool open: false
    // xochitl's ArkControls.ToolButton, or null when it could not be created (fallback face).
    property var nativeButton: null
    // The finger is on the button.
    readonly property bool down: nativeButton ? nativeButton.down : tap.pressed
    // The native "selected" look: while pressed, and while the panel is open.
    readonly property bool highlighted: down || open

    function toggle() {
        if (open) {
            open = false;
            return;
        }
        const p = root.mapToItem(null, 0, 0);  // the catcher covers the window from here
        outside.x = -p.x;
        outside.y = -p.y;
        root.opened();
        open = true;
    }

    // Creates `qml` as a child of `parentItem`; null (and nothing logged) when xochitl lacks a
    // module or a property, so a changed build costs only the native extra.
    function tryCreate(qml, parentItem, name) {
        try {
            return Qt.createQmlObject(qml, parentItem, name);
        } catch (e) {
            return null;
        }
    }

    Component.onCompleted: {
        const b = tryCreate('import QtQuick\n' +
                            'import ark.controls as ArkControls\n' +
                            'ArkControls.ToolButton { focusPolicy: Qt.NoFocus; ditherOnDisabled: false }',
                            root, "codrawer-dock-button");
        if (b) {
            b.anchors.fill = root;
            b.z = 0;
            b.state = Qt.binding(function() { return !b.enabled ? "disabled" : (b.down || root.open ? "selected" : "idle"); });
            b.clicked.connect(root.toggle);
            nativeButton = b;
        }
        tryCreate('import QtQuick\nimport xofm.libs.epaper as Epaper\n' +
                  'Epaper.ScreenModeItem { objectName: "codrawer-dock-screenmode"; anchors.fill: parent; mode: Epaper.ScreenModeItem.Overlay }',
                  panel, "codrawer-dock-screenmode");
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

    // The icon: a 48 px "c" in a ring (the toolbar's icon size), inverted with the cell, with a
    // dot when an offer waits.
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
        Rectangle {
            visible: root.badge
            width: 16
            height: 16
            radius: 8
            x: parent.width - 10
            y: -6
            color: root.highlighted ? "white" : "black"
        }
    }

    // While open: a tap anywhere outside the panel and the button closes it.
    MouseArea {
        id: outside
        objectName: "codrawer-dock-outside"
        z: -1
        visible: root.open
        enabled: root.open
        width: root.Window.width > 0 ? root.Window.width : 1620
        height: root.Window.height > 0 ? root.Window.height : 2160
        onPressed: root.open = false
    }

    // The panel, beside the button (a ToolbarFoldout's place for the left toolbar).
    Rectangle {
        id: panel
        objectName: "codrawer-dock-panel"
        z: 3
        visible: root.open
        enabled: root.open
        x: root.width
        y: 0
        width: 520
        height: rows.height
        color: "white"

        MultiPointTouchArea { anchors.fill: parent }  // taps on the panel never reach the page

        Column {
            id: rows
            width: panel.width
            Repeater {
                model: root.entries
                delegate: Rectangle {
                    required property var modelData
                    required property int index
                    width: rows.width
                    height: 112
                    color: rowTap.pressed ? "black" : "white"
                    // an agent's badge (dock_entries `badge`): its text in an outlined pill at the
                    // row's end; true shows "on"; false, "", "off" and none show nothing
                    readonly property string badgeText: {
                        const b = modelData.badge;
                        if (b === true) return "on";
                        if (typeof b !== "string" || b === "" || b === "off") return "";
                        return b;
                    }
                    Rectangle {
                        id: pill
                        objectName: "codrawer-dock-badge"
                        visible: parent.badgeText !== ""
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.right: parent.right
                        anchors.rightMargin: 32
                        width: visible ? pillText.implicitWidth + 32 : 0
                        height: 48
                        radius: 24
                        color: rowTap.pressed ? "white" : "black"
                        Text {
                            id: pillText
                            anchors.centerIn: parent
                            text: parent.parent.badgeText
                            font.family: "reMarkable Sans"
                            font.pixelSize: 24
                            font.weight: Font.Medium
                            color: rowTap.pressed ? "black" : "white"
                        }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.left: parent.left
                        anchors.right: pill.visible ? pill.left : parent.right
                        anchors.leftMargin: 32
                        anchors.rightMargin: pill.visible ? 16 : 32
                        text: modelData.label
                        elide: Text.ElideRight
                        font.family: "reMarkable Sans"
                        font.pixelSize: 32
                        font.weight: Font.Medium
                        color: rowTap.pressed ? "white" : "black"
                    }
                    Rectangle {  // the divider below each row
                        anchors.bottom: parent.bottom
                        width: parent.width
                        height: 2
                        color: "black"
                    }
                    MouseArea {
                        id: rowTap
                        anchors.fill: parent
                        onClicked: {
                            root.action(modelData.id);
                            // status and a row with a badge (a setting that cycles on tap: its
                            // new value shows here) keep the panel open; any other row closes it
                            if (modelData.id !== "status" && modelData.badge === undefined) root.open = false;
                        }
                    }
                }
            }
            // the status reply: the panel's last row
            Item {
                width: rows.width
                height: statusText.implicitHeight + 48
                visible: root.status.length > 0
                Text {
                    id: statusText
                    x: 32
                    y: 24
                    width: parent.width - 64
                    text: root.status
                    wrapMode: Text.Wrap
                    font.family: "reMarkable Sans"
                    font.pixelSize: 28
                    color: "black"
                }
            }
        }

        // the 2 px border, over the rows (ToolbarFoldout's Border)
        Rectangle {
            anchors.fill: parent
            z: 10
            color: "transparent"
            border.width: 2
            border.color: "black"
        }
    }
}
