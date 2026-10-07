// Host test of qml/live.qml's pending doodle (run by qmltest.sh, offscreen): started at once on
// a tap, adopted by the agent's first status (it glides there, stays the same doodle), and, when no
// agent answers in time, a "?" and then nothing at all, with `noAgent` and `idle` signalled. The
// pen guard holds throughout (no input, the root covers nothing). Prints `pending_test: PASS
// (native|fallback)` or `… FAIL …`.
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
    property int noAgents: 0
    property int idles: 0
    property real startCx: 0
    property int offFrames: -1

    function find(item, name) {
        if (item.objectName === name) return item;
        for (let i = 0; i < item.children.length; ++i) {
            const f = find(item.children[i], name);
            if (f) return f;
        }
        return null;
    }

    Item { id: stage; anchors.fill: parent }

    function make() {
        if (live) live.destroy();
        live = comp.createObject(stage);
        live.pendingLimitMs = 1500;
        live.noAgent.connect(function() { top.noAgents += 1; });
        live.idle.connect(function() { top.idles += 1; });
    }

    Component.onCompleted: {
        make();
        live.thinkPending(400, 500, 300, 120, "pen");  // the tap: at once
        check(live.think && live.think.pending, "pending at once");
        startCx = live.think.cx;
    }

    Timer {
        interval: 100
        repeat: true
        running: true
        onTriggered: {
            const L = top.live;
            top.tick += 1;
            const t = top.tick;
            if (t === 3) {
                top.check(L.think.frames > 0, "the pending doodle draws before any agent speaks");
                L.thinkStart(500, 1200, 400, 200, "glyph");  // the agent's status: adopt
                top.check(L.think && !L.think.pending && L.think.move, "adopted, gliding");
                top.check(L.think.style === "pen", "the same doodle (style kept)");
            }
            if (t === 12) {
                top.check(L.think && Math.abs(L.think.cx - (500 + 60)) < 1, "arrived at the agent's spot");
                // anchored to the paper: the extension moves and scales the root with the page
                const c = top.find(L, "codrawer-live-canvas");
                L.x = 100; L.y = -50; L.scale = 0.5;  // a scroll and a zoom
                const at = c.mapToItem(stage, 0, 0);
                top.check(Math.abs(at.x - (100 + L.area.x0 * 0.5)) < 0.5 && Math.abs(at.y - (-50 + L.area.y0 * 0.5)) < 0.5,
                          "the canvas follows the page (" + at.x + "," + at.y + ")");
                L.x = 0; L.y = 0; L.scale = 1;
                // scrolled wholly away: nothing moves
                L.visibleArea = Qt.rect(-810, 20000, 1620, 2160);
                top.offFrames = L.think.frames;
            }
            if (t === 15) {
                top.check(L.halted && L.think.frames === top.offFrames, "scrolled away: no frames");
                L.visibleArea = Qt.rect(-810, 0, 1620, 2160);
                top.check(!L.enabled && L.width === 0, "no input, root covers nothing");
                top.check(top.noAgents === 0, "no 'no agent' once adopted");
                L.thinkEnd("test");
                // the second tap, this time nobody answers
                L.thinkPending(400, 500, 300, 120, "pen");
            }
            if (t === 33) {  // 1.8 s later: past the 1.5 s limit
                top.check(top.noAgents === 1, "noAgent signalled once");
                top.check(L.think && L.think.noAgent > 0, "showing the '?'");
            }
            if (t === 70) {  // 1.5 s to the "?", 3.2 s of it
                top.check(L.think === null, "gone after the '?'");
                top.check(top.idles >= 1, "idle signalled: nothing left over the page");
                finish();
            }
        }
    }

    function finish() {
        const mode = live && live.animRegion ? "native" : "fallback";
        if (failures.length) console.log("pending_test: FAIL " + mode + ": " + failures.join("; "));
        else console.log("pending_test: PASS (" + mode + ")");
        Qt.quit();
    }
}
