// Host test of qml/dock.qml (run by qmltest.sh, offscreen, no xochitl). It checks what can be
// checked without the tablet: the file loads without a warning, the native button is used when
// `ark.controls` exists (tests/qml/stub: a stand-in ToolButton) and the fallback face when it
// does not, the highlight follows the press and the open list, and the tap that closes the list
// does not reopen it. Prints `dock_test: PASS (native|fallback)` or `dock_test: FAIL …`.
import QtQuick

Item {
    id: top
    width: 800
    height: 600

    // stands in for the redo ToolLoader the dock is stacked after
    Item { id: redo; width: 112; height: 112 }

    property var failures: []
    function check(ok, what) { if (!ok) failures.push(what); }

    Loader {
        id: loader
        source: Qt.resolvedUrl("../../qml/dock.qml")
        onLoaded: {
            item.anchorItem = redo;
            item.entries = [{ id: "status", label: "codrawer status" }, { id: "ask_page", label: "Ask about this page" }];
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
            check(d.width === 112 && d.height === 112, "size follows the anchor item");
            check(!d.highlighted, "idle at start");
            if (d.nativeButton) check(d.nativeButton.state === "idle", "native state idle at start");

            var openedCount = 0;
            d.opened.connect(function() { openedCount++; });
            d.toggle();  // a tap: opens the list
            check(d.highlighted, "highlighted while the list is open");
            check(openedCount === 1, "opened() emitted once");
            if (d.nativeButton) check(d.nativeButton.state === "selected", "native state selected while open");
            d.toggle();  // a tap while open: closes it
            check(!d.highlighted, "not highlighted after closing");
            if (d.nativeButton) check(d.nativeButton.state === "idle", "native state idle after closing");
            d.toggle();  // the click right after a close does not reopen
            check(!d.highlighted && openedCount === 1, "a click right after closing does not reopen");
            finish(mode);
        }
    }

    function finish(mode) {
        if (failures.length) console.log("dock_test: FAIL " + mode + ": " + failures.join("; "));
        else console.log("dock_test: PASS (" + mode + ")");
        Qt.quit();
    }
}
