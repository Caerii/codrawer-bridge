// Host test of qml/live.qml playing a very fast hand (run by qmltest.sh, offscreen): agentd's
// "very fast" speed sends timestamped points in 50 ms frames. Checks that live strokes play at
// about 20 frames a second, that the head advances on nearly every frame while points are due
// (no jumps in batches), that the adaptive buffer grows when the stream stalls and shrinks back
// when it is steady, and that the answer's wall-clock time is reported against the hand's.
// Prints `fast_test: PASS (native|fallback) …` or `… FAIL …`.
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
    property real t0: 0         // the hand's clock (ms)
    property int sent: 0        // points sent so far
    property int moves: 0       // frames in which the head moved
    property int frames: 0      // frames observed while points were due
    property var lastHead: null
    property real maxBuffer: 0
    property real lastBuffer: 0
    property int shrinks: 0
    property real fpsFrom: 0
    property int drawnFrom: 0
    property string fps: ""

    readonly property int total: 280  // 7 s of hand at 25 ms a point

    // a fast cursive line: loops along x, 25 ms a point
    function point(i) {
        const th = i / 6;
        return [-600 + i * 4 + 14 * Math.cos(th), 900 - 12 * Math.sin(th), 0.6, t0 + i * 25];
    }

    Item { id: stage; anchors.fill: parent }

    Component.onCompleted: {
        live = comp.createObject(stage);
        live.note.connect(function(t) { top.notes.push(t); });
        t0 = Date.now();
    }

    // agentd's frames: every 50 ms, the next 2 points; one 400 ms stall in the middle
    Timer {
        interval: 50
        repeat: true
        running: true
        onTriggered: {
            const L = top.live;
            top.tick += 1;
            const stalled = top.tick >= 40 && top.tick < 48;
            if (!stalled && top.sent < top.total) {
                const n = top.tick >= 48 && top.sent < 2 * top.tick ? 10 : 2;  // after the stall: the backlog at once
                const pts = [];
                for (let k = 0; k < n && top.sent < top.total; ++k) pts.push(top.point(top.sent++));
                L.liveAdd("f1", pts, 4, "#1f6fe0");
                if (top.sent >= top.total) L.liveEnd("f1");
            }
            if (top.tick === 20) { top.fpsFrom = Date.now(); top.drawnFrom = L.framesDrawn; }
            if (top.tick === 40) {
                const secs = (Date.now() - top.fpsFrom) / 1000;
                const f = (L.framesDrawn - top.drawnFrom) / secs;
                top.fps = f.toFixed(1) + " fps";
                top.check(f >= 15, "live strokes at about 20 fps (" + top.fps + ")");
            }
            top.maxBuffer = Math.max(top.maxBuffer, L.bufferMs);
            if (top.lastBuffer && L.bufferMs < top.lastBuffer) top.shrinks += 1;
            top.lastBuffer = L.bufferMs;
            const s = L.strokes["f1"];
            if (s && top.tick > 4 && top.tick < 38) {
                top.frames += 1;
                const h = s.head || (s.idx >= 0 ? s.pts[s.idx] : null);
                if (h && top.lastHead && (h.x !== top.lastHead.x || h.y !== top.lastHead.y)) top.moves += 1;
                top.lastHead = h ? { x: h.x, y: h.y } : null;
            }
            if (top.tick === 200) finish();
        }
    }

    function finish() {
        const L = live;
        check(moves >= frames * 0.8, "the head moves on nearly every frame (" + moves + " of " + frames + ")");
        check(maxBuffer > 70, "the buffer grew in the stall (max " + maxBuffer + " ms)");
        check(shrinks > 0 && L.bufferMs <= L.bufferMax, "and shrank when steady (" + shrinks + " step(s), now " + L.bufferMs + " ms)");
        const s = L.strokes["f1"];
        check(s && s.idx === s.pts.length - 1, "the stroke played to its end");
        const report = notes.filter(function(n) { return n.indexOf("answer (none): 1 stroke(s) played in") === 0; });
        check(report.length === 1, "the answer's timing is reported once");
        const mode = L && L.animRegions ? "native" : "fallback";
        if (failures.length) console.log("fast_test: FAIL " + mode + ": " + failures.join("; ") + " NOTES " + notes.join(" / "));
        else console.log("fast_test: PASS (" + mode + ") " + fps + "; " + (report[0] || ""));
        Qt.quit();
    }
}
