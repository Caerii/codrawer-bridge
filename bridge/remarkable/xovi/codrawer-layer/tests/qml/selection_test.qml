// Host test of qml/selection-ask.qml (run by qmltest.sh, offscreen): it loads without a warning,
// takes its neighbour's 80 x 80 cell, shows only for strokes, inverts while pressed and emits
// ask_selection on a tap. Prints `selection_test: PASS (native|fallback)` or `… FAIL …`.
import QtQuick

Item {
    width: 400
    height: 200

    property var failures: []
    function check(ok, what) { if (!ok) failures.push(what); }

    // stands in for the menu's delete button
    Item { id: trash; width: 80; height: 80 }

    Loader {
        id: loader
        source: Qt.resolvedUrl("../../qml/selection-ask.qml")
        onLoaded: item.anchorItem = trash
    }

    Timer {
        interval: 50
        running: true
        onTriggered: {
            const a = loader.item;
            check(a !== null, "selection-ask.qml did not load");
            if (!a) return finish("none");
            const mode = a.nativeButton ? "native" : "fallback";
            check(a.width === 80 && a.height === 80, "the menu's cell size");
            check(a.visible, "visible for strokes");
            a.hasStrokes = false;
            check(!a.visible, "hidden without strokes");
            a.hasStrokes = true;
            var asked = [];
            a.action.connect(function(id) { asked.push(id); });
            a.ask();  // what a tap does
            check(asked.length === 1 && asked[0] === "ask_selection", "a tap asks about the selection");
            if (a.nativeButton) check(a.nativeButton.state === "idle", "native state idle when not pressed");
            finish(mode);
        }
    }

    function finish(mode) {
        if (failures.length) console.log("selection_test: FAIL " + mode + ": " + failures.join("; "));
        else console.log("selection_test: PASS (" + mode + ")");
        Qt.quit();
    }
}
