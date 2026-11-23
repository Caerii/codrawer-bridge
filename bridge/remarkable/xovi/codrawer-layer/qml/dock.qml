// The codrawer dock: an illuminated, Victorian-Gothic e-paper toolbar button and action panel.
//
// Instantiated at run time by codrawer-layer (src/inject.h) inside xochitl's own QQmlEngine and
// parented into xochitl's toolbar; nothing of xochitl's is changed. The extension sets `entries`
// (from /run/codrawer/dock.json, or its built-in list; an offer to go somewhere comes first,
// src/navigate.h), `status`, `page` and `badge` (an offer is waiting), and listens to
// `action(id)` and `opened()`. Selecting an entry emits `action(id)`; the extension sends it to
// the bridge as a `dock_action`, except `status`, which it answers here, and `goto_offer`, which
// it carries out (the user's tap is what lets it navigate).
//
// Sizes are in xochitl's scene pixels (the Paper Pro's 1620 x 2160 portrait screen). On 3.29/3.30
// the toolbar is a GridLayout ("toolbarLayout") of 112 x 112 ToolLoaders (redo is
// "editingToolLoader_redoButton"); inject.conf stacks the dock right after redo, so the layout
// gives it the next cell. `anchorItem` (set by the extension: the item it was stacked after)
// carries the toolbar's own state: when the toolbar collapses and hides redo, the dock hides too.
//
// # Design
//
// Built for crisp 1-bit high-contrast e-paper craftsmanship:
//   - Viewport-clamped vertical placement: `panel.y` adjusts upward from the button's screen Y
//     so even a full 12-entry panel never clips off the bottom of the 2160 px display.
//   - Illuminated Victorian-Gothic framing: 2 px outer frame + 6 px architectural drop-edge +
//     1 px inner hairline + parametric Bézier corner fleurons (acanthus scrolls & diamond pips).
//   - Illuminated Masthead (80 px): double-ruled cartouche with a flourished calligraphic "C",
//     feathered hairline spurs, and an ornamental diamond-and-scrollwork divider.
//   - Parametric Spline Iconography (32 x 32): every entry renders a custom multi-weight Bézier
//     glyph with delicate secondary hairlines, inverting cleanly on press.
//   - ScreenModeItem Overlay hint + closed-state pen guard (verified by tests/qml/dock_test.qml).
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
    z: open ? 1 : 0

    property bool open: false
    property var nativeButton: null
    readonly property bool down: nativeButton ? nativeButton.down : tap.pressed
    readonly property bool highlighted: down || open

    property real btnX: 0
    property real btnY: 0
    readonly property real winW: root.Window.width > 0 ? root.Window.width : 1620
    readonly property real winH: root.Window.height > 0 ? root.Window.height : 2160

    function toggle() {
        if (open) {
            open = false;
            return;
        }
        const p = root.mapToItem(null, 0, 0);
        btnX = p.x;
        btnY = p.y;
        outside.x = -p.x;
        outside.y = -p.y;
        root.opened();
        open = true;
    }

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

    // Toolbar button emblem: double-ringed cartouche + "c" + offer dot.
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

    // Outside tap catcher: covers the full window while open.
    MouseArea {
        id: outside
        objectName: "codrawer-dock-outside"
        z: -1
        visible: root.open
        enabled: root.open
        width: root.winW
        height: root.winH
        onPressed: root.open = false
    }

    // Main panel, anchored beside the button and clamped within [24, winH - height - 24].
    Rectangle {
        id: panel
        objectName: "codrawer-dock-panel"
        z: 3
        visible: root.open
        enabled: root.open
        x: root.width + 8
        y: {
            const margin = 24;
            const maxLocalY = root.winH - height - margin - root.btnY;
            const minLocalY = margin - root.btnY;
            return Math.max(minLocalY, Math.min(0, maxLocalY));
        }
        width: 604
        height: rows.height
        color: "white"

        // Hard 1-bit architectural offset shadow (6 px right & down).
        Rectangle {
            z: -1
            x: 6
            y: 6
            width: parent.width
            height: parent.height
            color: "black"
        }

        MultiPointTouchArea { anchors.fill: parent }  // taps on the panel never reach the page

        Column {
            id: rows
            width: panel.width

            // ── Illuminated Masthead (80 px) ────────────────────────────────────────────────────
            Rectangle {
                id: masthead
                width: rows.width
                height: 80
                color: mastTap.pressed ? "black" : "white"

                // Illuminated calligraphic "C" cartouche with feathered Bézier flourishes.
                Canvas {
                    id: mastLogo
                    x: 24
                    anchors.verticalCenter: parent.verticalCenter
                    width: 46
                    height: 46
                    property bool inv: mastTap.pressed
                    onInvChanged: requestPaint()
                    onPaint: {
                        const ctx = getContext("2d");
                        ctx.clearRect(0, 0, width, height);
                        const fg = inv ? "#ffffff" : "#000000";
                        ctx.strokeStyle = fg;
                        ctx.fillStyle = fg;
                        ctx.lineCap = "round";
                        ctx.lineJoin = "round";

                        // Outer gothic diamond-cornered cartouche
                        ctx.lineWidth = 1.4;
                        ctx.strokeRect(3, 3, 40, 40);
                        ctx.lineWidth = 0.9;
                        ctx.strokeRect(6, 6, 34, 34);
                        // Corner diamond pips
                        const cs = [[3,3],[43,3],[3,43],[43,43]];
                        for (let i = 0; i < cs.length; i++) {
                            ctx.beginPath();
                            ctx.arc(cs[i][0], cs[i][1], 1.6, 0, 2 * Math.PI);
                            ctx.fill();
                        }

                        // Calligraphic illuminated "C" spine (double-stroked)
                        ctx.lineWidth = 2.6;
                        ctx.beginPath();
                        ctx.moveTo(31, 15);
                        ctx.bezierCurveTo(26, 9, 13, 12, 13, 23);
                        ctx.bezierCurveTo(13, 34, 26, 37, 32, 31);
                        ctx.stroke();

                        // Inner parallel hairline along the spine
                        ctx.lineWidth = 1.0;
                        ctx.beginPath();
                        ctx.moveTo(28, 16);
                        ctx.bezierCurveTo(24, 12.5, 16.5, 15, 16.5, 23);
                        ctx.bezierCurveTo(16.5, 31, 24, 33.5, 28.5, 30);
                        ctx.stroke();

                        // Swept upper ascender curl + feathered spur
                        ctx.lineWidth = 1.4;
                        ctx.beginPath();
                        ctx.moveTo(31, 15);
                        ctx.bezierCurveTo(35, 11, 31, 7, 25, 10);
                        ctx.moveTo(31, 15);
                        ctx.lineTo(35, 17.5);
                        ctx.stroke();

                        // Lower curled finial + ink bead
                        ctx.beginPath();
                        ctx.moveTo(32, 31);
                        ctx.bezierCurveTo(35, 34, 31, 38, 26, 35.5);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.arc(25.5, 35.5, 1.5, 0, 2 * Math.PI);
                        ctx.fill();

                        // Tiny 4-point star inside the bowl
                        ctx.beginPath();
                        ctx.moveTo(25, 20.5);
                        ctx.lineTo(25.8, 22.2);
                        ctx.lineTo(27.5, 23);
                        ctx.lineTo(25.8, 23.8);
                        ctx.lineTo(25, 25.5);
                        ctx.lineTo(24.2, 23.8);
                        ctx.lineTo(22.5, 23);
                        ctx.lineTo(24.2, 22.2);
                        ctx.closePath();
                        ctx.fill();
                    }
                }

                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: mastLogo.right
                    anchors.leftMargin: 16
                    spacing: 1
                    Text {
                        text: "codrawer"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 28
                        font.weight: Font.DemiBold
                        font.letterSpacing: 2.0
                        color: mastTap.pressed ? "white" : "black"
                    }
                    Text {
                        text: "ATELIER · PAPER PRO"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 13
                        font.weight: Font.Medium
                        font.letterSpacing: 2.2
                        color: mastTap.pressed ? "white" : "black"
                    }
                }

                // Double-ruled Victorian "status" cartouche pill.
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.right: parent.right
                    anchors.rightMargin: 24
                    width: mastPillText.implicitWidth + 28
                    height: 36
                    radius: 18
                    color: "transparent"
                    border.width: 2
                    border.color: mastTap.pressed ? "white" : "black"
                    Rectangle {
                        anchors.fill: parent
                        anchors.margins: 3
                        radius: 15
                        color: "transparent"
                        border.width: 1
                        border.color: mastTap.pressed ? "white" : "black"
                    }
                    Text {
                        id: mastPillText
                        anchors.centerIn: parent
                        text: "status"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 19
                        font.weight: Font.Medium
                        color: mastTap.pressed ? "white" : "black"
                    }
                }

                // Ornamental masthead rule with center diamond.
                Canvas {
                    anchors.bottom: parent.bottom
                    width: parent.width
                    height: 8
                    property bool inv: mastTap.pressed
                    onInvChanged: requestPaint()
                    onPaint: {
                        const ctx = getContext("2d");
                        ctx.clearRect(0, 0, width, height);
                        const fg = inv ? "#ffffff" : "#000000";
                        ctx.strokeStyle = fg;
                        ctx.fillStyle = fg;
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(0, 6.5);
                        ctx.lineTo(width, 6.5);
                        ctx.stroke();
                        const cx = width / 2;
                        ctx.beginPath();
                        ctx.moveTo(cx, 1);
                        ctx.lineTo(cx + 6, 4.5);
                        ctx.lineTo(cx, 7.5);
                        ctx.lineTo(cx - 6, 4.5);
                        ctx.closePath();
                        ctx.fill();
                        ctx.beginPath();
                        ctx.arc(cx - 16, 4.5, 1.5, 0, 2 * Math.PI);
                        ctx.arc(cx + 16, 4.5, 1.5, 0, 2 * Math.PI);
                        ctx.fill();
                    }
                }

                MouseArea {
                    id: mastTap
                    anchors.fill: parent
                    onClicked: root.action("status")
                }
            }

            // ── Entries ─────────────────────────────────────────────────────────────────────────
            Repeater {
                model: root.entries
                delegate: Rectangle {
                    required property var modelData
                    required property int index
                    width: rows.width
                    height: 76
                    color: rowTap.pressed ? "black" : "white"

                    readonly property string entryId: modelData.id || ""
                    readonly property bool isOff: modelData.badge === "off" || modelData.badge === false
                    readonly property bool isDegraded: entryId === "agentd_health" && modelData.badge === "degraded"
                    readonly property string badgeText: {
                        const b = modelData.badge;
                        if (b === true) return "on";
                        if (b === false) return "off";
                        if (typeof b !== "string" || b === "") return "";
                        return b.replace(/_/g, " ");
                    }
                    readonly property bool sectionBreak: {
                        if (index <= 0) return false;
                        const prev = root.entries[index - 1];
                        return (prev && prev.owner || "") !== (modelData.owner || "");
                    }

                    // Section divider with centered diamond finial when owner group changes.
                    Canvas {
                        visible: parent.sectionBreak
                        anchors.top: parent.top
                        width: parent.width
                        height: 6
                        property bool inv: rowTap.pressed
                        onInvChanged: requestPaint()
                        onPaint: {
                            const ctx = getContext("2d");
                            ctx.clearRect(0, 0, width, height);
                            const fg = inv ? "#ffffff" : "#000000";
                            ctx.strokeStyle = fg;
                            ctx.fillStyle = fg;
                            ctx.lineWidth = 2;
                            ctx.beginPath();
                            ctx.moveTo(0, 1.5);
                            ctx.lineTo(width, 1.5);
                            ctx.stroke();
                            const cx = width / 2;
                            ctx.beginPath();
                            ctx.moveTo(cx - 5, 1.5);
                            ctx.lineTo(cx, 5);
                            ctx.lineTo(cx + 5, 1.5);
                            ctx.closePath();
                            ctx.fill();
                        }
                    }

                    // Parametric 32 x 32 calligraphic spline glyph per entry ID.
                    Canvas {
                        id: glyph
                        x: 24
                        anchors.verticalCenter: parent.verticalCenter
                        width: 32
                        height: 32
                        property string gid: parent.entryId
                        property bool inv: rowTap.pressed
                        property string bval: parent.badgeText
                        onGidChanged: requestPaint()
                        onInvChanged: requestPaint()
                        onBvalChanged: requestPaint()
                        onPaint: {
                            const ctx = getContext("2d");
                            ctx.clearRect(0, 0, width, height);
                            const fg = inv ? "#ffffff" : "#000000";
                            ctx.strokeStyle = fg;
                            ctx.fillStyle = fg;
                            ctx.lineCap = "round";
                            ctx.lineJoin = "round";

                            function star4(cx, cy, rOuter, rInner) {
                                ctx.beginPath();
                                ctx.moveTo(cx, cy - rOuter);
                                ctx.lineTo(cx + rInner, cy - rInner);
                                ctx.lineTo(cx + rOuter, cy);
                                ctx.lineTo(cx + rInner, cy + rInner);
                                ctx.lineTo(cx, cy + rOuter);
                                ctx.lineTo(cx - rInner, cy + rInner);
                                ctx.lineTo(cx - rOuter, cy);
                                ctx.lineTo(cx - rInner, cy - rInner);
                                ctx.closePath();
                                ctx.fill();
                            }

                            if (gid === "status") {
                                // Astrolabe signal reticle with cardinal hairlines
                                ctx.lineWidth = 1.8;
                                ctx.beginPath();
                                ctx.arc(16, 16, 11, -0.35 * Math.PI, 0.35 * Math.PI);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.arc(16, 16, 11, 0.65 * Math.PI, 1.35 * Math.PI);
                                ctx.stroke();
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.arc(16, 16, 6.5, 0.1 * Math.PI, 1.6 * Math.PI);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.moveTo(16, 2); ctx.lineTo(16, 7);
                                ctx.moveTo(16, 25); ctx.lineTo(16, 30);
                                ctx.stroke();
                                star4(16, 16, 3.2, 1.1);
                            } else if (gid === "agent_ink") {
                                // Feathered Victorian quill & split nib
                                ctx.lineWidth = 1.8;
                                ctx.beginPath();
                                ctx.moveTo(7, 27);
                                ctx.bezierCurveTo(10, 18, 17, 9, 26, 4);
                                ctx.bezierCurveTo(25, 13, 19, 20, 10, 24);
                                ctx.closePath();
                                ctx.stroke();
                                // Quill rachis & feather barbs
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.moveTo(5, 29);
                                ctx.bezierCurveTo(12, 20, 18, 12, 26, 4);
                                ctx.moveTo(15, 15); ctx.lineTo(12, 10);
                                ctx.moveTo(19, 11); ctx.lineTo(17, 6.5);
                                ctx.moveTo(17, 17); ctx.lineTo(22, 16);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.arc(5, 29, 1.5, 0, 2 * Math.PI);
                                ctx.fill();
                            } else if (gid === "practice_coach") {
                                // Victorian drafting compass with hinge crown & arc
                                ctx.lineWidth = 1.8;
                                ctx.beginPath();
                                ctx.arc(16, 6, 2.5, 0, 2 * Math.PI);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.moveTo(14.5, 8); ctx.lineTo(7, 27);
                                ctx.moveTo(17.5, 8); ctx.lineTo(25, 27);
                                ctx.stroke();
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.arc(16, 10, 11, 0.25 * Math.PI, 0.75 * Math.PI);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.moveTo(16, 2); ctx.lineTo(16, 3.5);
                                ctx.stroke();
                            } else if (gid === "ask_page") {
                                // Illuminated scrolled folio + starburst
                                ctx.lineWidth = 1.7;
                                ctx.beginPath();
                                ctx.moveTo(7, 5);
                                ctx.bezierCurveTo(4, 5, 4, 9, 7, 9);
                                ctx.lineTo(22, 9);
                                ctx.lineTo(22, 26);
                                ctx.bezierCurveTo(25, 26, 25, 22, 22, 22);
                                ctx.moveTo(7, 5); ctx.lineTo(20, 5);
                                ctx.moveTo(7, 9); ctx.lineTo(7, 26); ctx.lineTo(22, 26);
                                ctx.stroke();
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.moveTo(10, 14); ctx.lineTo(18, 14);
                                ctx.moveTo(10, 18); ctx.lineTo(16, 18);
                                ctx.stroke();
                                star4(25, 23, 5.5, 1.6);
                            } else if (gid === "ask_selection") {
                                // Calligraphic dashed lasso flourish + starburst
                                ctx.lineWidth = 1.7;
                                ctx.beginPath();
                                ctx.setLineDash([3, 3]);
                                ctx.moveTo(14, 5);
                                ctx.bezierCurveTo(23, 5, 24, 17, 15, 21);
                                ctx.bezierCurveTo(6, 24, 4, 12, 11, 6);
                                ctx.stroke();
                                ctx.setLineDash([]);
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.moveTo(11, 21);
                                ctx.bezierCurveTo(9, 25, 6, 27, 4, 25);
                                ctx.stroke();
                                star4(24.5, 23.5, 5.5, 1.6);
                            } else if (gid === "agentd_memory") {
                                // Interlaced lemniscate knot with diamond clasp
                                ctx.lineWidth = 1.8;
                                ctx.beginPath();
                                ctx.moveTo(16, 16);
                                ctx.bezierCurveTo(10, 8, 3, 10, 3, 16);
                                ctx.bezierCurveTo(3, 22, 10, 24, 16, 16);
                                ctx.bezierCurveTo(22, 8, 29, 10, 29, 16);
                                ctx.bezierCurveTo(29, 22, 22, 24, 16, 16);
                                ctx.stroke();
                                ctx.lineWidth = 1.0;
                                ctx.beginPath();
                                ctx.arc(9.5, 16, 2, 0, 2 * Math.PI);
                                ctx.arc(22.5, 16, 2, 0, 2 * Math.PI);
                                ctx.stroke();
                                star4(16, 16, 3.5, 1.2);
                            } else if (gid === "agentd_forget") {
                                // Ruled lines crossed by a serifed calligraphic slash
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.moveTo(6, 11); ctx.lineTo(25, 11);
                                ctx.moveTo(6, 16); ctx.lineTo(25, 16);
                                ctx.moveTo(6, 21); ctx.lineTo(25, 21);
                                ctx.stroke();
                                ctx.lineWidth = 2.0;
                                ctx.beginPath();
                                ctx.moveTo(6, 26);
                                ctx.bezierCurveTo(12, 20, 20, 12, 26, 6);
                                ctx.stroke();
                                ctx.lineWidth = 1.1;
                                ctx.beginPath();
                                ctx.moveTo(4, 24); ctx.lineTo(8, 28);
                                ctx.moveTo(24, 4); ctx.lineTo(28, 8);
                                ctx.stroke();
                            } else if (gid === "agentd_text_size") {
                                // Serif calligraphic Aa with baseline flourish
                                ctx.lineWidth = 1.7;
                                ctx.beginPath();
                                ctx.moveTo(4, 24); ctx.lineTo(9.5, 11); ctx.lineTo(14, 24);
                                ctx.moveTo(5.8, 19.5); ctx.lineTo(12.2, 19.5);
                                ctx.moveTo(16, 24); ctx.lineTo(22, 6); ctx.lineTo(28, 24);
                                ctx.moveTo(18, 17.5); ctx.lineTo(26, 17.5);
                                ctx.stroke();
                                ctx.lineWidth = 1.0;
                                ctx.beginPath();
                                ctx.moveTo(3, 24); ctx.lineTo(6, 24);
                                ctx.moveTo(14.5, 24); ctx.lineTo(17.5, 24);
                                ctx.moveTo(26.5, 24); ctx.lineTo(29.5, 24);
                                ctx.moveTo(4, 27.5); ctx.bezierCurveTo(12, 26, 20, 29, 28, 27);
                                ctx.stroke();
                            } else if (gid === "agentd_spacing") {
                                // Ornamental leading bars with diamond finials & arrows
                                ctx.lineWidth = 1.7;
                                ctx.beginPath();
                                ctx.moveTo(5, 6); ctx.lineTo(27, 6);
                                ctx.moveTo(5, 26); ctx.lineTo(27, 26);
                                ctx.stroke();
                                ctx.lineWidth = 1.2;
                                ctx.beginPath();
                                ctx.moveTo(16, 9); ctx.lineTo(16, 23);
                                ctx.moveTo(12.5, 12.5); ctx.lineTo(16, 9); ctx.lineTo(19.5, 12.5);
                                ctx.moveTo(12.5, 19.5); ctx.lineTo(16, 23); ctx.lineTo(19.5, 19.5);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.arc(4.5, 6, 1.5, 0, 2 * Math.PI);
                                ctx.arc(27.5, 6, 1.5, 0, 2 * Math.PI);
                                ctx.arc(4.5, 26, 1.5, 0, 2 * Math.PI);
                                ctx.arc(27.5, 26, 1.5, 0, 2 * Math.PI);
                                ctx.fill();
                            } else if (gid === "agentd_writing_speed") {
                                // Winged calligraphic chevrons with feathered speed trails
                                ctx.lineWidth = 1.9;
                                ctx.beginPath();
                                ctx.moveTo(7, 8);
                                ctx.quadraticCurveTo(14, 14, 17, 16);
                                ctx.quadraticCurveTo(14, 18, 7, 24);
                                ctx.moveTo(16, 8);
                                ctx.quadraticCurveTo(23, 14, 26, 16);
                                ctx.quadraticCurveTo(23, 18, 16, 24);
                                ctx.stroke();
                                ctx.lineWidth = 1.0;
                                ctx.beginPath();
                                ctx.moveTo(3, 12); ctx.lineTo(9, 12);
                                ctx.moveTo(2, 16); ctx.lineTo(11, 16);
                                ctx.moveTo(3, 20); ctx.lineTo(9, 20);
                                ctx.stroke();
                            } else if (gid === "agentd_model") {
                                // Gothic rose-window prism with radial tracery
                                ctx.lineWidth = 1.7;
                                ctx.beginPath();
                                ctx.moveTo(16, 3);
                                ctx.lineTo(28, 16);
                                ctx.lineTo(16, 29);
                                ctx.lineTo(4, 16);
                                ctx.closePath();
                                ctx.stroke();
                                ctx.lineWidth = 1.0;
                                ctx.beginPath();
                                ctx.moveTo(16, 3); ctx.lineTo(16, 29);
                                ctx.moveTo(4, 16); ctx.lineTo(28, 16);
                                ctx.arc(16, 16, 5.5, 0, 2 * Math.PI);
                                ctx.stroke();
                                star4(16, 16, 3.0, 1.0);
                            } else if (gid === "agentd_health") {
                                // Double-ringed filigree pulse medallion
                                ctx.lineWidth = 1.7;
                                ctx.beginPath();
                                ctx.arc(16, 16, 11.5, 0, 2 * Math.PI);
                                ctx.stroke();
                                ctx.lineWidth = 1.0;
                                ctx.beginPath();
                                ctx.arc(16, 16, 8.8, 0, 2 * Math.PI);
                                ctx.stroke();
                                ctx.lineWidth = 1.6;
                                if (bval === "degraded") {
                                    ctx.beginPath();
                                    ctx.moveTo(16, 10); ctx.lineTo(16, 17.5);
                                    ctx.stroke();
                                    ctx.beginPath();
                                    ctx.arc(16, 21.5, 1.5, 0, 2 * Math.PI);
                                    ctx.fill();
                                } else {
                                    ctx.beginPath();
                                    ctx.moveTo(8, 16); ctx.lineTo(12, 16);
                                    ctx.lineTo(14.5, 10.5); ctx.lineTo(17.5, 21.5);
                                    ctx.lineTo(20, 16); ctx.lineTo(24, 16);
                                    ctx.stroke();
                                }
                            } else if (gid === "goto_offer") {
                                // Ornate feathered compass-rose arrow
                                ctx.lineWidth = 1.8;
                                ctx.beginPath();
                                ctx.moveTo(7, 25); ctx.lineTo(24, 8);
                                ctx.moveTo(14, 8); ctx.lineTo(24, 8); ctx.lineTo(24, 18);
                                ctx.stroke();
                                ctx.lineWidth = 1.0;
                                ctx.beginPath();
                                ctx.moveTo(6, 22); ctx.lineTo(10, 26);
                                ctx.stroke();
                            } else {
                                ctx.lineWidth = 1.5;
                                star4(16, 16, 6, 2);
                            }
                        }
                    }

                    // Value / state pill on the right.
                    Rectangle {
                        id: pill
                        objectName: "codrawer-dock-badge"
                        visible: parent.badgeText !== ""
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.right: parent.right
                        anchors.rightMargin: 24
                        width: visible ? pillText.implicitWidth + 28 : 0
                        height: 38
                        radius: 19
                        color: {
                            if (parent.isOff || parent.isDegraded) return rowTap.pressed ? "black" : "white";
                            return rowTap.pressed ? "white" : "black";
                        }
                        border.width: (parent.isOff || parent.isDegraded) ? 2 : 0
                        border.color: rowTap.pressed ? "white" : "black"
                        Text {
                            id: pillText
                            anchors.centerIn: parent
                            text: parent.parent.badgeText
                            font.family: "reMarkable Sans"
                            font.pixelSize: 21
                            font.weight: Font.Medium
                            color: {
                                if (parent.parent.isOff || parent.parent.isDegraded) return rowTap.pressed ? "white" : "black";
                                return rowTap.pressed ? "black" : "white";
                            }
                        }
                    }

                    // Row label.
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.left: glyph.right
                        anchors.leftMargin: 18
                        anchors.right: pill.visible ? pill.left : parent.right
                        anchors.rightMargin: pill.visible ? 16 : 24
                        text: modelData.label
                        elide: Text.ElideRight
                        font.family: "reMarkable Sans"
                        font.pixelSize: 27
                        font.weight: Font.Medium
                        color: rowTap.pressed ? "white" : "black"
                    }

                    // Fine hairline divider below each row.
                    Rectangle {
                        anchors.bottom: parent.bottom
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        height: 1
                        color: "black"
                    }

                    MouseArea {
                        id: rowTap
                        anchors.fill: parent
                        onClicked: {
                            root.action(modelData.id);
                            if (modelData.id !== "status" && modelData.badge === undefined) root.open = false;
                        }
                    }
                }
            }

            // ── Status reply footer ─────────────────────────────────────────────────────────────
            Item {
                width: rows.width
                height: statusText.implicitHeight + 34
                visible: root.status.length > 0
                Rectangle {
                    anchors.top: parent.top
                    width: parent.width
                    height: 2
                    color: "black"
                }
                Text {
                    id: statusText
                    x: 24
                    y: 17
                    width: parent.width - 48
                    text: root.status
                    wrapMode: Text.Wrap
                    font.family: "reMarkable Sans"
                    font.pixelSize: 23
                    color: "black"
                }
            }
        }

        // Outer 2 px crisp frame + parametric Bézier corner fleurons.
        Rectangle {
            anchors.fill: parent
            z: 10
            color: "transparent"
            border.width: 2
            border.color: "black"
        }

        Canvas {
            id: frameOrnament
            anchors.fill: parent
            z: 11
            onWidthChanged: requestPaint()
            onHeightChanged: requestPaint()
            onPaint: {
                const ctx = getContext("2d");
                ctx.clearRect(0, 0, width, height);
                ctx.strokeStyle = "#000000";
                ctx.fillStyle = "#000000";
                ctx.lineWidth = 1.0;
                ctx.lineCap = "round";

                const m = 6;
                const s = 16;  // fleuron reach
                // Inner hairline segments stopping cleanly at the corner fleurons
                ctx.beginPath();
                ctx.moveTo(m + s, m); ctx.lineTo(width - m - s, m);
                ctx.moveTo(m + s, height - m); ctx.lineTo(width - m - s, height - m);
                ctx.moveTo(m, m + s); ctx.lineTo(m, height - m - s);
                ctx.moveTo(width - m, m + s); ctx.lineTo(width - m, height - m - s);
                ctx.stroke();

                // Four symmetric parametric Bézier corner fleurons + diamond pips
                function corner(ox, oy, dx, dy) {
                    ctx.lineWidth = 1.1;
                    ctx.beginPath();
                    ctx.moveTo(ox + dx * s, oy);
                    ctx.bezierCurveTo(ox + dx * 6, oy, ox, oy + dy * 6, ox, oy + dy * s);
                    ctx.stroke();
                    // Inner botanical curl
                    ctx.lineWidth = 0.9;
                    ctx.beginPath();
                    ctx.moveTo(ox + dx * 2, oy + dy * 2);
                    ctx.quadraticCurveTo(ox + dx * 10, oy + dy * 4, ox + dx * 8, oy + dy * 9);
                    ctx.quadraticCurveTo(ox + dx * 6, oy + dy * 11, ox + dx * 4, oy + dy * 8);
                    ctx.stroke();
                    // Corner pip
                    ctx.beginPath();
                    ctx.arc(ox + dx * 2, oy + dy * 2, 1.5, 0, 2 * Math.PI);
                    ctx.fill();
                }
                corner(m, m, 1, 1);
                corner(width - m, m, -1, 1);
                corner(m, height - m, 1, -1);
                corner(width - m, height - m, -1, -1);
            }
        }
    }
}
