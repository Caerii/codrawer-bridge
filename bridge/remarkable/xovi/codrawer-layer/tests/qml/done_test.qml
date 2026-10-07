// Host test of qml/live.qml's endings (run by qmltest.sh, offscreen): `done` never just vanishes.
// Answered with the doodle still up: it dissolves into a drawn tick, then goes. Not answered here,
// with a note: the note shows as a caption (no input) for 4 s, fades, and only then is the overlay
// idle. Prints `done_test: PASS (native|fallback)` or `… FAIL …`.
import QtQuick

Item {
    id: top
    width: 1620
    height: 2160

    property var failures: []
    function check(ok, what) { if (!ok) failures.push(what); }

    property var comp: Qt.createComponent(Qt.resolvedUrl("../../qml/live.qml"))
    property var live: null
    property int tick: 0
    property int idles: 0
    property bool sawTick: false

    // the one doodle playing, or null
    function only(L) { const k = Object.keys(L.doodles); return k.length ? L.doodles[k[0]] : null; }

    function find(item, name) {
        if (item.objectName === name) return item;
        for (let i = 0; i < item.children.length; ++i) {
            const f = find(item.children[i], name);
            if (f) return f;
        }
        return null;
    }

    Item { id: stage; anchors.fill: parent }

    Component.onCompleted: {
        live = comp.createObject(stage);
        live.idle.connect(function() { top.idles += 1; });
        live.thinkStart("q1", -300, 400, 400, 200, "pen");
    }

    Timer {
        interval: 100
        repeat: true
        running: true
        onTriggered: {
            const L = top.live;
            top.tick += 1;
            const t = top.tick;
            if (t === 5) L.thinkDone("q1", true, "", undefined, undefined);
            if (t >= 12 && t <= 20 && top.only(L) && top.only(L).items)
                top.sawTick = top.sawTick || top.only(L).items.some(function(it) { return it.width === 3; });
            if (t === 32) {
                top.check(top.sawTick, "answered: a tick was drawn");
                top.check(top.only(L) === null && top.idles === 1, "answered: then gone, idle");
                // not answered here: the agent's note at its spot (the overlay may be idle)
                L.thinkDone("q1", false, "Answered on your glasses", -300, 640);
                const c = top.find(L, "codrawer-live-caption");
                top.check(c && c.visible && c.text === "Answered on your glasses", "the note is shown");
                top.check(c && !c.enabled, "the caption takes no input");
                top.check(!L.isIdle(), "not idle while the note shows");
            }
            if (t === 85) {
                const c = top.find(L, "codrawer-live-caption");
                top.check(!c || !c.visible, "the note faded");
                top.check(top.idles === 2, "idle after the note");
                finish();
            }
        }
    }

    function finish() {
        const mode = live && live.animRegions ? "native" : "fallback";
        if (failures.length) console.log("done_test: FAIL " + mode + ": " + failures.join("; "));
        else console.log("done_test: PASS (" + mode + ")");
        Qt.quit();
    }
}
