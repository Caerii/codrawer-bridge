// "Ask" in xochitl's selection menu: the row of buttons beside a lasso selection.
//
// Created by codrawer-layer (src/inject.h) right after a lasso (inject.conf `when=selection`), as
// the last button of the live menu's row; nothing of xochitl's is changed. On 3.29.0.149 the menu
// is a SelectionContextualMenu ("selectionHandlerMenu", 324 x 84) holding a ButtonRow of four
// 80 x 80 Buttons (cut, copy, convert, delete), each a 48 px icon at 16,16 over a background
// Rectangle (`tree match=class:SelectionContextualMenu depth=4`, 2026-10-06); inject.conf stacks
// this one after the delete button. A tap emits `action("ask_selection")`, which the extension
// sends exactly as the dock's "Ask about selection" (dock_action ask_selection with the lasso's
// bbox, items and contents; source "selection"), so an agent answers it unchanged. The selection is
// left as it is.
//
// It shows only when the selection holds strokes (`hasStrokes`, set by the extension from
// SceneController.selectionContainsStroke): there is nothing to ask about an image alone. It does
// not depend on agent ink being on: asking writes nothing on the page by itself, and the answer may
// go to another surface; with no bridge connected the tap is logged and dropped, like the dock's.
//
// The face is xochitl's own menu button (`ArkControls.ContextualMenu.Button`, created in a try,
// pressed = "selected": black with the icon inverted) with our icon drawn over it: the dock's small
// "c" ring. Without that component the same look is drawn in plain QtQuick.
import QtQuick

Item {
    id: root
    property var entries: []
    property string status: ""
    property string page: ""
    property bool hasStrokes: true
    property var anchorItem: null
    signal action(string id)
    signal opened()

    // the menu's own cell, as its neighbours (the anchor is the delete button)
    implicitWidth: anchorItem && anchorItem.width > 0 ? anchorItem.width : 80
    implicitHeight: anchorItem && anchorItem.height > 0 ? anchorItem.height : 80
    width: implicitWidth
    height: implicitHeight
    visible: hasStrokes

    property var nativeButton: null
    readonly property bool down: nativeButton ? nativeButton.down : tap.pressed

    function ask() { root.action("ask_selection"); }

    Component.onCompleted: {
        try {
            const b = Qt.createQmlObject('import QtQuick\nimport ark.controls as ArkControls\n' +
                                         'ArkControls.ContextualMenu.Button { focusPolicy: Qt.NoFocus }',
                                         root, "codrawer-selection-ask-button");
            b.anchors.fill = root;
            b.z = 0;
            b.state = Qt.binding(function() { return b.down ? "selected" : "idle"; });
            b.clicked.connect(root.ask);
            nativeButton = b;
        } catch (e) {
            nativeButton = null;
        }
    }

    // fallback face: white, black while pressed (the menu's paper states)
    Rectangle {
        anchors.fill: parent
        visible: !root.nativeButton
        color: root.down ? "black" : "white"
    }
    MouseArea {
        id: tap
        anchors.fill: parent
        enabled: !root.nativeButton
        onClicked: root.ask()
    }

    // the icon, 48 px like the row's: the dock's "c" ring, inverted while pressed
    Item {
        z: 2
        anchors.centerIn: parent
        width: 48
        height: 48
        Rectangle {
            anchors.fill: parent
            radius: width / 2
            color: "transparent"
            border.color: root.down ? "white" : "black"
            border.width: 3
        }
        Text {
            anchors.centerIn: parent
            text: "c"
            font.pixelSize: 34
            font.bold: true
            color: root.down ? "white" : "black"
        }
    }
}
