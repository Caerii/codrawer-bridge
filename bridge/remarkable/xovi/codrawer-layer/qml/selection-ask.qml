// "Ask agent" in xochitl's selection menu (the bar that appears over a lasso selection).
//
// Created by codrawer-layer right after a lasso (inject.conf `when=selection`), as a child of the
// live SelectionContextualMenu; nothing of xochitl's is changed. guibor's smart_remarkable puts a
// real ArkControls.ContextualMenu.Button there with a QMD patch; this is the run-time version.
// It rolls out inert first (`inert=1`: a tap is only logged), then active, when a tap sends
// `dock_action` id `ask_selection` with the lasso's bounds (src/inject.h, "Actions").
//
// Plain QtQuick only, so it cannot fail on a removed theme token. Sizes are scene px; it takes the
// menu's height and sits after the stock buttons when the menu is a row.
import QtQuick

Item {
    id: root
    property var entries: []
    property string status: ""
    property string page: ""
    property var anchorItem: null
    signal action(string id)
    signal opened()

    implicitHeight: parent ? parent.height : 96
    implicitWidth: label.implicitWidth + 48
    width: implicitWidth
    height: implicitHeight

    Rectangle {
        anchors.fill: parent
        color: tap.pressed ? "black" : "white"
        border.color: "black"
        border.width: 2
        radius: 8
    }
    Text {
        id: label
        anchors.centerIn: parent
        text: "Ask agent"
        font.pixelSize: 30
        color: tap.pressed ? "white" : "black"
    }
    MouseArea {
        id: tap
        anchors.fill: parent
        onClicked: root.action("ask_selection")
    }
}
