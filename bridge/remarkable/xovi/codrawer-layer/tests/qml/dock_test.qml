// Host test of qml/dock.qml (run by qmltest.sh, offscreen, no xochitl). It checks what can be
// checked without the tablet: the file loads without a warning; the native button, e-paper hint
// hint are used when their modules exist (tests/qml/stub: stand-ins) and skipped
// silently when they do not; the highlight follows the press and the open panel; the panel is an
// opaque item in the tree with one 112 px row per entry plus the status row; a status tap keeps it
// open, an action closes it; the badge shows; an agent's entries (with a badge pill) render
// below the built-ins, update in place and go with their owner. Prints `dock_test: PASS (native|fallback)` or
// `dock_test: FAIL …`.
import QtQuick

Item {
    id: top
    width: 1620
    height: 2160

    // stands in for the redo ToolLoader the dock is stacked after
    Item {
        id: redo
        width: 112
        height: 112
        // what the real ToolLoader exposes: toolbar.penInput.surfaceManager
        property QtObject toolbar: QtObject {
            property QtObject penInput: QtObject { property QtObject surfaceManager: QtObject {} }
        }
    }

    property var failures: []
    function check(ok, what) { if (!ok) failures.push(what); }

    function findAll(item, name, out) {
        if (item.objectName === name) out.push(item);
        for (let i = 0; i < item.children.length; ++i) findAll(item.children[i], name, out);
        return out;
    }
    // a visible Text showing exactly `t`
    function findText(item, t) {
        if (item.visible && item.text === t) return item;
        for (let i = 0; i < item.children.length; ++i) {
            const f = findText(item.children[i], t);
            if (f) return f;
        }
        return null;
    }

    function find(item, name) {
        if (item.objectName === name) return item;
        for (let i = 0; i < item.children.length; ++i) {
            const f = find(item.children[i], name);
            if (f) return f;
        }
        return null;
    }

    Loader {
        id: loader
        source: Qt.resolvedUrl("../../qml/dock.qml")
        onLoaded: {
            item.anchorItem = redo;
            item.entries = [{ id: "status", label: "codrawer status" }, { id: "ask_page", label: "Ask about this page" }];
            item.status = "codrawer rust bridge: connected, agent ink on";
        }
    }

    Timer {
        interval: 50
        running: true
        onTriggered: {
            const d = loader.item;
            check(loader.status === Loader.Ready && d !== null, "dock.qml did not load");
            if (!d) return finish("none");
            const mode = d.nativeButton ? "native" : "fallback";
            const panel = find(d, "codrawer-dock-panel");
            check(panel !== null, "the panel is an item in the tree (not a Popup in the overlay)");
            check(d.width === 112 && d.height === 112, "size follows the anchor item");
            // the pen guard: closed, nothing of the dock but its 112 px button is visible or takes input
            const outside = find(d, "codrawer-dock-outside");
            check(panel && !panel.visible && !panel.enabled, "closed: the panel is hidden and disabled");
            check(outside && !outside.visible && !outside.enabled, "closed: the outside catcher is hidden and disabled");
            check(!d.highlighted && !d.open, "idle at start");
            if (d.nativeButton) check(d.nativeButton.state === "idle", "native state idle at start");
            if (mode === "native") {
                check(find(panel, "codrawer-dock-screenmode") !== null, "e-paper Overlay region on the panel");
            }

            var actions = [];
            d.action.connect(function(id) { actions.push(id); });
            var openedCount = 0;
            d.opened.connect(function() { openedCount++; });
            d.toggle();  // a tap: opens the panel
            check(d.open && d.highlighted && openedCount === 1, "open, highlighted, opened() once");
            if (d.nativeButton) check(d.nativeButton.state === "selected", "native state selected while open");
            if (panel) {
                check(panel.visible && panel.color == "#ffffff", "an opaque white panel");
                check(panel.height >= 2 * 112 + 48, "one 112 px row per entry plus the status row");
            }
            d.action("status");  // what a status row tap emits; the dock keeps itself open
            check(d.open, "status keeps the panel open");
            d.toggle();  // a tap on the button while open: closes it
            check(!d.open && !d.highlighted, "closed by the button");
            check(!panel.visible && !panel.enabled && !outside.visible && !outside.enabled, "closed again: nothing over the page");
            if (d.nativeButton) check(d.nativeButton.state === "idle", "native state idle after closing");
            d.badge = true;
            check(d.badge, "badge settable");

            // an agent's entries below the built-ins (src/inject.cpp withOwners), updating live
            d.entries = [{ id: "status", label: "codrawer status" }, { id: "ask_page", label: "Ask about this page" },
                         { id: "agentd_memory", label: "Memory: page thread", badge: "on", owner: "agentd" },
                         { id: "agentd_forget", label: "Forget this page's thread", owner: "agentd" }];
            d.toggle();
            check(findText(panel, "Ask about this page") && findText(panel, "Memory: page thread"), "the agent's rows below the built-ins");
            const pills = findAll(panel, "codrawer-dock-badge", []).filter(function(p) { return p.visible; });
            check(pills.length === 1, "one badge shown (" + pills.length + ")");
            d.entries = [{ id: "status", label: "codrawer status" }, { id: "ask_page", label: "Ask about this page" },
                         { id: "agentd_memory", label: "Memory: off", badge: "off", owner: "agentd" },
                         { id: "agentd_forget", label: "Forget this page's thread", owner: "agentd" }];
            check(findAll(panel, "codrawer-dock-badge", []).filter(function(p) { return p.visible; }).length === 0, "badge off hides it");
            check(findText(panel, "Memory: off"), "the label updates in place");
            // a tap on the agent's row sends its id and closes the panel
            const row = findText(panel, "Forget this page's thread");
            d.action("agentd_forget");
            check(actions.indexOf("agentd_forget") >= 0, "the agent's id is sent");
            // the owner went: its rows go
            d.entries = [{ id: "status", label: "codrawer status" }, { id: "ask_page", label: "Ask about this page" }];
            check(!findText(panel, "Memory: off"), "rows removed with their owner");
            d.toggle();
            check(!panel.visible && !panel.enabled && !outside.visible && !outside.enabled, "closed: nothing over the page");
            finish(mode);
        }
    }

    function finish(mode) {
        if (failures.length) console.log("dock_test: FAIL " + mode + ": " + failures.join("; "));
        else console.log("dock_test: PASS (" + mode + ")");
        Qt.quit();
    }
}
