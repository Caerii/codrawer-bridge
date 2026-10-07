// Host test of qml/live.qml's doodle placement (run by qmltest.sh, offscreen): the doodle starts
// at the spot the tablet proposed and does not move when the agent confirms it; otherwise the nib
// travels once, on an arc, in 300-500 ms, and later corrections are ignored; a spot off screen
// parks the nib at the screen edge with a cue until it scrolls into view; each answer is reported
// once, keyed by its request; the Animation regions are dropped while the pen is down. Prints
// `choreo_test: PASS (native|fallback)` or `… FAIL …`.
import QtQuick

Item {
    id: top
    width: 1620
    height: 2160

    property var failures: []
    function check(ok, what) { if (!ok) failures.push(what); }

    property var comp: Qt.createComponent(Qt.resolvedUrl("../../qml/live.qml"))
    property var live: null
    property var notes: []
    property int tick: 0
    property var path: []
    property real moveStart: 0
    property real arrivedAt: 0

    function findAll(item, name, out) {
        if (item.objectName === name) out.push(item);
        for (let i = 0; i < item.children.length; ++i) findAll(item.children[i], name, out);
        return out;
    }

    Item { id: stage; anchors.fill: parent }

    Component.onCompleted: {
        live = comp.createObject(stage);
        live.note.connect(function(t) { top.notes.push(t); });
        live.visibleArea = Qt.rect(-810, 0, 1620, 2160);
        // two taps: A's spot will be confirmed, B's will be moved
        live.thinkPending(-500, 500, 600, 200, "pen");
        live.thinkPending(100, 1200, 600, 200, "pen");
    }

    Timer {
        interval: 50
        repeat: true
        running: true
        onTriggered: {
            const L = top.live;
            top.tick += 1;
            const t = top.tick;
            if (t === 4) {
                L.thinkStart("A", -495, 505, 600, 200, "glyph");  // 5 units off: confirmed
                const a = L.doodles.A;
                check(a && !a.move && !a.final, "A confirmed: no move");
                check(top.notes.some(function(n) { return n.indexOf("A spot confirmed") >= 0; }), "A's confirmation noted");
                L.thinkStart("B", 100, 1450, 600, 200, "pen");    // 250 units lower: one arc
                const b = L.doodles.B;
                check(b && b.move && b.move.ms >= 300 && b.move.ms <= 500, "B travels once, 300-500 ms (" + (b && b.move ? b.move.ms : "-") + ")");
                top.moveStart = Date.now();
            }
            const b = L.doodles.B;
            if (t > 4 && t < 24 && b) {
                top.path.push({ x: b.cx, y: b.cy });
                if (!b.move && !top.arrivedAt) top.arrivedAt = Date.now();
            }
            if (t === 24) {
                check(top.arrivedAt > 0 && top.arrivedAt - top.moveStart <= 700, "B arrived within the move's time");
                check(b && Math.abs(b.cy - (1450 + 60)) < 1 && Math.abs(b.cx - (100 + 60)) < 1, "B at the agent's spot");
                // the arc leaves sideways: some point off the straight line
                let off = 0;
                for (let i = 0; i < top.path.length; ++i) off = Math.max(off, Math.abs(top.path[i].x - 160));
                check(off > 5, "B's path is an arc (max " + Math.round(off) + " units sideways)");
                // corrections: a large one is ignored (moves only once), a small one too
                L.thinkStart("B", 100, 1650, 600, 200, "pen");
                L.thinkStart("B", 110, 1460, 600, 200, "pen");
                check(!b.move && Math.abs(b.cy - 1510) < 1, "B never moves twice");
                // C: a spot off screen parks at the edge with a cue
                L.thinkStart("C", -300, 400, 600, 200, "pen");
                L.visibleArea = Qt.rect(-810, 0, 1620, 1000);
                L.thinkStart("C", -300, 400, 600, 200, "pen");  // same spot: stays
                L.thinkPending(-300, 600, 600, 200, "pen");
                const pid = Object.keys(L.doodles).filter(function(k) { return k.indexOf("local-") === 0 && L.doodles[k].pending; })[0];
                L.thinkStart("D", -300, 3000, 600, 200, "pen");  // far below the screen
                const d = L.doodles.D;
                check(d && d.parked && d.parked.cue.indexOf("below") >= 0, "D parks at the screen edge, cue below");
                check(d && d.cy <= 1000, "D's nib waits at the edge, not off screen");
                check(pid !== undefined, "a pending doodle to adopt");
            }
            if (t === 40) {
                const d = L.doodles.D;
                check(d && !d.move && d.parked, "D waits at the edge");
                L.visibleArea = Qt.rect(-810, 2600, 1620, 1000);  // the user scrolls to it
            }
            if (t === 60) {
                const d = L.doodles.D;
                check(d && Math.abs(d.cy - 3060) < 1 && !d.parked, "D went on to its spot when it showed");
                // an answer: reported once, keyed by its request, after its done
                L.visibleArea = Qt.rect(-810, 0, 1620, 2160);
                L.thinkClear("A", -495, 505);
                const t0 = Date.now();
                const pts = [];
                for (let i = 0; i < 10; ++i) pts.push([-480 + i * 6, 520, 0.6, t0 + i * 25]);
                L.liveAdd("s1", pts, 4, "#1f6fe0");
                L.liveEnd("s1");
                L.thinkDone("A", true, "", undefined, undefined);
                // the pen down: the regions go (native route), and come back
                L.paused = true;
                const regions = findAll(L, "codrawer-live-anim", []);
                check(regions.every(function(r) { return !r.visible; }), "no Animation region shown while the pen is down");
                L.paused = false;
                check(regions.every(function(r) { return r.visible || !r.parent.visible; }), "regions back when it lifts");
            }
            if (t === 90) {
                const lines = top.notes.filter(function(n) { return n.indexOf("answer A: 1 stroke(s) played in") === 0; });
                check(lines.length === 1, "answer A reported once (" + lines.length + ")");
                check(!top.notes.some(function(n) { return n.indexOf("live: ") === 0; }), "no doubled prefix");
                finish();
            }
        }
    }

    function finish() {
        const mode = live && live.animRegions ? "native" : "fallback";
        if (failures.length) console.log("choreo_test: FAIL " + mode + ": " + failures.join("; ") + " NOTES " + notes.join(" / "));
        else console.log("choreo_test: PASS (" + mode + ")");
        Qt.quit();
    }
}
