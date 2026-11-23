// The codrawer dock: an illuminated, Victorian-Gothic two-column e-paper toolbar panel.
//
// Left column (`codrawer-dock-panel`): actions & status (`codrawer status`, `Agent ink on/off`,
// `Practice coach`, `Ask about this page`, `Ask about selection`, `Forget this page's thread`,
// `Responder` health, and `status` footer).
// Right companion column (`codrawer-dock-studio`): personality & animation controls (`Persona`,
// `Thinking`, `Writing speed`, `Text size`, `Spacing`, `Autopilot`, `Memory`, `Model`), shown
// beside the left panel whenever any studio entries exist.
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

    function isStudioId(id) {
        return id === "agentd_persona" || id === "agentd_thinking_style" ||
               id === "agentd_writing_speed" || id === "agentd_text_size" ||
               id === "agentd_spacing" || id === "agentd_autopilot" ||
               id === "agentd_memory" || id === "agentd_model";
    }
    readonly property var leftEntries: {
        const out = [];
        for (let i = 0; i < entries.length; ++i) {
            if (!isStudioId(entries[i].id || "")) out.push(entries[i]);
        }
        return out;
    }
    readonly property var studioEntries: {
        const out = [];
        for (let i = 0; i < entries.length; ++i) {
            if (isStudioId(entries[i].id || "")) out.push(entries[i]);
        }
        return out;
    }

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

    // Reusable Victorian-Gothic entry row with custom 32 x 32 spline glyph + pill.
    component DockRow: Rectangle {
        id: drow
        required property var modelData
        required property int index
        required property var listRef
        width: parent ? parent.width : 540
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
            if (index <= 0 || !listRef) return false;
            const prev = listRef[index - 1];
            return (prev && prev.owner || "") !== (modelData.owner || "");
        }

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

        Canvas {
            id: glyph
            x: 22
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
                    ctx.lineWidth = 1.8;
                    ctx.beginPath(); ctx.arc(16, 16, 11, -0.35 * Math.PI, 0.35 * Math.PI); ctx.stroke();
                    ctx.beginPath(); ctx.arc(16, 16, 11, 0.65 * Math.PI, 1.35 * Math.PI); ctx.stroke();
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.arc(16, 16, 6.5, 0.1 * Math.PI, 1.6 * Math.PI); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(16, 2); ctx.lineTo(16, 7); ctx.moveTo(16, 25); ctx.lineTo(16, 30); ctx.stroke();
                    star4(16, 16, 3.2, 1.1);
                } else if (gid === "agent_ink") {
                    ctx.lineWidth = 1.8;
                    ctx.beginPath(); ctx.moveTo(7, 27); ctx.bezierCurveTo(10, 18, 17, 9, 26, 4);
                    ctx.bezierCurveTo(25, 13, 19, 20, 10, 24); ctx.closePath(); ctx.stroke();
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.moveTo(5, 29); ctx.bezierCurveTo(12, 20, 18, 12, 26, 4);
                    ctx.moveTo(15, 15); ctx.lineTo(12, 10); ctx.moveTo(19, 11); ctx.lineTo(17, 6.5);
                    ctx.moveTo(17, 17); ctx.lineTo(22, 16); ctx.stroke();
                    ctx.beginPath(); ctx.arc(5, 29, 1.5, 0, 2 * Math.PI); ctx.fill();
                } else if (gid === "practice_coach") {
                    ctx.lineWidth = 1.8;
                    ctx.beginPath(); ctx.arc(16, 6, 2.5, 0, 2 * Math.PI); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(14.5, 8); ctx.lineTo(7, 27); ctx.moveTo(17.5, 8); ctx.lineTo(25, 27); ctx.stroke();
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.arc(16, 10, 11, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();
                } else if (gid === "ask_page") {
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.moveTo(7, 5); ctx.bezierCurveTo(4, 5, 4, 9, 7, 9);
                    ctx.lineTo(22, 9); ctx.lineTo(22, 26); ctx.bezierCurveTo(25, 26, 25, 22, 22, 22);
                    ctx.moveTo(7, 5); ctx.lineTo(20, 5); ctx.moveTo(7, 9); ctx.lineTo(7, 26); ctx.lineTo(22, 26); ctx.stroke();
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.moveTo(10, 14); ctx.lineTo(18, 14); ctx.moveTo(10, 18); ctx.lineTo(16, 18); ctx.stroke();
                    star4(25, 23, 5.5, 1.6);
                } else if (gid === "ask_selection") {
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.setLineDash([3, 3]);
                    ctx.moveTo(14, 5); ctx.bezierCurveTo(23, 5, 24, 17, 15, 21);
                    ctx.bezierCurveTo(6, 24, 4, 12, 11, 6); ctx.stroke(); ctx.setLineDash([]);
                    star4(24.5, 23.5, 5.5, 1.6);
                } else if (gid === "agentd_persona") {
                    // Ornamental calligraphic crest / nib crown
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.moveTo(16, 4); ctx.bezierCurveTo(24, 8, 25, 20, 16, 28);
                    ctx.bezierCurveTo(7, 20, 8, 8, 16, 4); ctx.stroke();
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.arc(16, 14, 4, 0, 2 * Math.PI); ctx.stroke();
                    star4(16, 22, 3.0, 1.0);
                } else if (gid === "agentd_thinking_style") {
                    // Rising effervescent thought-bubbles
                    ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(10, 23, 2.5, 0, 2 * Math.PI); ctx.stroke();
                    ctx.beginPath(); ctx.arc(16, 16, 4.2, 0, 2 * Math.PI); ctx.stroke();
                    ctx.beginPath(); ctx.arc(23, 9, 5.5, 0, 2 * Math.PI); ctx.stroke();
                    star4(23, 9, 2.5, 0.8);
                } else if (gid === "agentd_autopilot") {
                    ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(16, 16, 10, 0.2 * Math.PI, 1.8 * Math.PI); ctx.stroke();
                    ctx.beginPath(); ctx.arc(24.5, 10.5, 2.2, 0, 2 * Math.PI); ctx.fill();
                    star4(16, 16, 4.5, 1.5);
                } else if (gid === "agentd_memory") {
                    ctx.lineWidth = 1.8;
                    ctx.beginPath(); ctx.moveTo(16, 16);
                    ctx.bezierCurveTo(10, 8, 3, 10, 3, 16); ctx.bezierCurveTo(3, 22, 10, 24, 16, 16);
                    ctx.bezierCurveTo(22, 8, 29, 10, 29, 16); ctx.bezierCurveTo(29, 22, 22, 24, 16, 16); ctx.stroke();
                    star4(16, 16, 3.5, 1.2);
                } else if (gid === "agentd_forget") {
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.moveTo(6, 11); ctx.lineTo(25, 11); ctx.moveTo(6, 16); ctx.lineTo(25, 16);
                    ctx.moveTo(6, 21); ctx.lineTo(25, 21); ctx.stroke();
                    ctx.lineWidth = 2.0;
                    ctx.beginPath(); ctx.moveTo(6, 26); ctx.bezierCurveTo(12, 20, 20, 12, 26, 6); ctx.stroke();
                } else if (gid === "agentd_text_size") {
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.moveTo(4, 24); ctx.lineTo(9.5, 11); ctx.lineTo(14, 24);
                    ctx.moveTo(5.8, 19.5); ctx.lineTo(12.2, 19.5);
                    ctx.moveTo(16, 24); ctx.lineTo(22, 6); ctx.lineTo(28, 24);
                    ctx.moveTo(18, 17.5); ctx.lineTo(26, 17.5); ctx.stroke();
                } else if (gid === "agentd_spacing") {
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.moveTo(5, 6); ctx.lineTo(27, 6); ctx.moveTo(5, 26); ctx.lineTo(27, 26); ctx.stroke();
                    ctx.lineWidth = 1.2;
                    ctx.beginPath(); ctx.moveTo(16, 9); ctx.lineTo(16, 23);
                    ctx.moveTo(12.5, 12.5); ctx.lineTo(16, 9); ctx.lineTo(19.5, 12.5);
                    ctx.moveTo(12.5, 19.5); ctx.lineTo(16, 23); ctx.lineTo(19.5, 19.5); ctx.stroke();
                } else if (gid === "agentd_writing_speed") {
                    ctx.lineWidth = 1.9;
                    ctx.beginPath();
                    ctx.moveTo(7, 8); ctx.quadraticCurveTo(14, 14, 17, 16); ctx.quadraticCurveTo(14, 18, 7, 24);
                    ctx.moveTo(16, 8); ctx.quadraticCurveTo(23, 14, 26, 16); ctx.quadraticCurveTo(23, 18, 16, 24);
                    ctx.stroke();
                    ctx.lineWidth = 1.0;
                    ctx.beginPath(); ctx.moveTo(3, 12); ctx.lineTo(9, 12); ctx.moveTo(2, 16); ctx.lineTo(11, 16);
                    ctx.moveTo(3, 20); ctx.lineTo(9, 20); ctx.stroke();
                } else if (gid === "agentd_model") {
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.moveTo(16, 3); ctx.lineTo(28, 16); ctx.lineTo(16, 29); ctx.lineTo(4, 16);
                    ctx.closePath(); ctx.stroke();
                    ctx.lineWidth = 1.0;
                    ctx.beginPath(); ctx.moveTo(16, 3); ctx.lineTo(16, 29); ctx.moveTo(4, 16); ctx.lineTo(28, 16);
                    ctx.arc(16, 16, 5.5, 0, 2 * Math.PI); ctx.stroke();
                    star4(16, 16, 3.0, 1.0);
                } else if (gid === "agentd_health") {
                    ctx.lineWidth = 1.7;
                    ctx.beginPath(); ctx.arc(16, 16, 11.5, 0, 2 * Math.PI); ctx.stroke();
                    ctx.lineWidth = 1.6;
                    if (bval === "degraded") {
                        ctx.beginPath(); ctx.moveTo(16, 10); ctx.lineTo(16, 17.5); ctx.stroke();
                        ctx.beginPath(); ctx.arc(16, 21.5, 1.5, 0, 2 * Math.PI); ctx.fill();
                    } else {
                        ctx.beginPath(); ctx.moveTo(8, 16); ctx.lineTo(12, 16); ctx.lineTo(14.5, 10.5);
                        ctx.lineTo(17.5, 21.5); ctx.lineTo(20, 16); ctx.lineTo(24, 16); ctx.stroke();
                    }
                } else if (gid === "goto_offer") {
                    ctx.lineWidth = 1.8;
                    ctx.beginPath(); ctx.moveTo(7, 25); ctx.lineTo(24, 8);
                    ctx.moveTo(14, 8); ctx.lineTo(24, 8); ctx.lineTo(24, 18); ctx.stroke();
                } else {
                    star4(16, 16, 6, 2);
                }
            }
        }

        Rectangle {
            id: pill
            objectName: "codrawer-dock-badge"
            visible: parent.badgeText !== ""
            anchors.verticalCenter: parent.verticalCenter
            anchors.right: parent.right
            anchors.rightMargin: 20
            width: visible ? pillText.implicitWidth + 24 : 0
            height: 36
            radius: 18
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
                font.pixelSize: 20
                font.weight: Font.Medium
                color: {
                    if (parent.parent.isOff || parent.parent.isDegraded) return rowTap.pressed ? "white" : "black";
                    return rowTap.pressed ? "black" : "white";
                }
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            anchors.left: glyph.right
            anchors.leftMargin: 16
            anchors.right: pill.visible ? pill.left : parent.right
            anchors.rightMargin: pill.visible ? 12 : 20
            text: modelData.label
            elide: Text.ElideRight
            font.family: "reMarkable Sans"
            font.pixelSize: 26
            font.weight: Font.Medium
            color: rowTap.pressed ? "white" : "black"
        }

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

    // Reusable Victorian-Gothic corner-fleuron frame overlay.
    component OrnateFrame: Item {
        anchors.fill: parent
        Rectangle {
            anchors.fill: parent
            color: "transparent"
            border.width: 2
            border.color: "black"
        }
        Canvas {
            anchors.fill: parent
            onWidthChanged: requestPaint()
            onHeightChanged: requestPaint()
            onPaint: {
                const ctx = getContext("2d");
                ctx.clearRect(0, 0, width, height);
                ctx.strokeStyle = "#000000";
                ctx.fillStyle = "#000000";
                ctx.lineCap = "round";
                const m = 6, s = 16;
                ctx.lineWidth = 1.0;
                ctx.beginPath();
                ctx.moveTo(m + s, m); ctx.lineTo(width - m - s, m);
                ctx.moveTo(m + s, height - m); ctx.lineTo(width - m - s, height - m);
                ctx.moveTo(m, m + s); ctx.lineTo(m, height - m - s);
                ctx.moveTo(width - m, m + s); ctx.lineTo(width - m, height - m - s);
                ctx.stroke();
                function corner(ox, oy, dx, dy) {
                    ctx.lineWidth = 1.1;
                    ctx.beginPath();
                    ctx.moveTo(ox + dx * s, oy);
                    ctx.bezierCurveTo(ox + dx * 6, oy, ox, oy + dy * 6, ox, oy + dy * s);
                    ctx.stroke();
                    ctx.lineWidth = 0.9;
                    ctx.beginPath();
                    ctx.moveTo(ox + dx * 2, oy + dy * 2);
                    ctx.quadraticCurveTo(ox + dx * 10, oy + dy * 4, ox + dx * 8, oy + dy * 9);
                    ctx.quadraticCurveTo(ox + dx * 6, oy + dy * 11, ox + dx * 4, oy + dy * 8);
                    ctx.stroke();
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

    // ── Left Column: Actions & Status ───────────────────────────────────────────────────────────
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
        width: 560
        height: rows.height
        color: "white"

        Rectangle { z: -1; x: 6; y: 6; width: parent.width; height: parent.height; color: "black" }
        MultiPointTouchArea { anchors.fill: parent }

        Column {
            id: rows
            width: panel.width

            Rectangle {
                width: rows.width
                height: 80
                color: mastTap.pressed ? "black" : "white"

                Canvas {
                    id: mastLogo
                    x: 22
                    anchors.verticalCenter: parent.verticalCenter
                    width: 44
                    height: 44
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
                        ctx.lineWidth = 1.4; ctx.strokeRect(3, 3, 38, 38);
                        ctx.lineWidth = 0.9; ctx.strokeRect(6, 6, 32, 32);
                        ctx.lineWidth = 2.5;
                        ctx.beginPath();
                        ctx.moveTo(30, 14.5);
                        ctx.bezierCurveTo(25, 9, 13, 12, 13, 22);
                        ctx.bezierCurveTo(13, 32, 25, 35, 31, 29.5);
                        ctx.stroke();
                        ctx.lineWidth = 1.3;
                        ctx.beginPath(); ctx.moveTo(30, 14.5); ctx.bezierCurveTo(34, 10.5, 30, 7, 24, 10); ctx.stroke();
                        ctx.beginPath(); ctx.arc(24.5, 34, 1.5, 0, 2 * Math.PI); ctx.fill();
                    }
                }

                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: mastLogo.right
                    anchors.leftMargin: 14
                    spacing: 1
                    Text {
                        text: "codrawer"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 27
                        font.weight: Font.DemiBold
                        font.letterSpacing: 1.8
                        color: mastTap.pressed ? "white" : "black"
                    }
                    Text {
                        text: "ACTIONS · STATUS"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 13
                        font.weight: Font.Medium
                        font.letterSpacing: 2.0
                        color: mastTap.pressed ? "white" : "black"
                    }
                }

                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.right: parent.right
                    anchors.rightMargin: 22
                    width: mastPillText.implicitWidth + 26
                    height: 34
                    radius: 17
                    color: "transparent"
                    border.width: 2
                    border.color: mastTap.pressed ? "white" : "black"
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

                Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 2; color: "black" }
                MouseArea { id: mastTap; anchors.fill: parent; onClicked: root.action("status") }
            }

            Repeater {
                model: root.leftEntries
                delegate: DockRow { width: rows.width; listRef: root.leftEntries }
            }

            Item {
                width: rows.width
                height: statusText.implicitHeight + 32
                visible: root.status.length > 0
                Rectangle { anchors.top: parent.top; width: parent.width; height: 2; color: "black" }
                Text {
                    id: statusText
                    x: 22
                    y: 16
                    width: parent.width - 44
                    text: root.status
                    wrapMode: Text.Wrap
                    font.family: "reMarkable Sans"
                    font.pixelSize: 22
                    color: "black"
                }
            }
        }

        OrnateFrame { z: 10 }
    }

    // ── Right Companion Column: Personality & Animation Controls ────────────────────────────────
    Rectangle {
        id: studioPanel
        objectName: "codrawer-dock-studio"
        z: 3
        visible: root.open && root.studioEntries.length > 0
        enabled: root.open && root.studioEntries.length > 0
        x: panel.x + panel.width + 16
        y: {
            const margin = 24;
            const maxLocalY = root.winH - height - margin - root.btnY;
            const minLocalY = margin - root.btnY;
            return Math.max(minLocalY, Math.min(panel.y, maxLocalY));
        }
        width: 500
        height: studioRows.height
        color: "white"

        Rectangle { z: -1; x: 6; y: 6; width: parent.width; height: parent.height; color: "black" }
        MultiPointTouchArea { anchors.fill: parent }

        Column {
            id: studioRows
            width: studioPanel.width

            Rectangle {
                width: studioRows.width
                height: 68
                color: "white"
                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    x: 22
                    spacing: 1
                    Text {
                        text: "atelier"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 25
                        font.weight: Font.DemiBold
                        font.letterSpacing: 1.8
                        color: "black"
                    }
                    Text {
                        text: "PERSONALITY · MOTION"
                        font.family: "reMarkable Sans"
                        font.pixelSize: 12
                        font.weight: Font.Medium
                        font.letterSpacing: 2.0
                        color: "black"
                    }
                }
                Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 2; color: "black" }
            }

            Repeater {
                model: root.studioEntries
                delegate: DockRow { width: studioRows.width; listRef: root.studioEntries }
            }
        }

        OrnateFrame { z: 10 }
    }
}
