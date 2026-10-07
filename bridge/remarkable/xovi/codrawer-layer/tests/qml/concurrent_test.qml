// Host test of qml/live.qml with several answers in flight (run by qmltest.sh, offscreen): two Asks
// tapped on two selections and a third request the agent starts by itself, so three doodles play
// at once, each on its own small panel at its own spot. Each agent status adopts the pending doodle
// nearest its spot (not another's); a live stroke hands off only the doodle beside it, while the
// others keep thinking; `done` ticks only its own; the overlay is idle only when all are gone. The
// pen guard holds with three panels up (no input, nothing over the far page, no union over the
// page). Frame rate and paint cost with three doodles are measured and printed (the device logs the
// same numbers in its `live: frames …` line). Prints `concurrent_test: PASS (native|fallback) …`
// or `… FAIL …`.
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
    property var notes: []
    property var ids: []
    property var framesAt: ({})
    property real measureFrom: 0
    property real paintFrom: 0
    property int drawnFrom: 0
    property string fps: ""

    function findAll(item, name, out) {
        if (item.objectName === name) out.push(item);
        for (let i = 0; i < item.children.length; ++i) findAll(item.children[i], name, out);
        return out;
    }
    function shown(L) { return findAll(L, "codrawer-live-canvas", []).filter(function(c) { return c.visible; }); }

    function stroke(x, y, t0) {
        const pts = [];
        for (let i = 0; i < 30; ++i) pts.push([x + i * 4, y + 8 * Math.sin(i / 4), 0.6, t0 + i * 25]);
        return pts;
    }

    Item { id: stage; anchors.fill: parent }

    Component.onCompleted: {
        live = comp.createObject(stage);
        live.note.connect(function(t) { top.notes.push(t); });
        live.idle.connect(function() { top.idles += 1; });
        // the two taps, on two selections far apart (page units, x centred)
        ids = [live.thinkPending(-600, 300, 300, 120, "pen"), live.thinkPending(100, 1300, 400, 160, "pen")];
        check(ids[0] !== ids[1] && Object.keys(live.doodles).length === 2, "each tap its own pending doodle");
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
                // agent B answers the second selection first: it adopts that doodle, not the first
                L.thinkStart("B", 100, 1380, 400, 200, "drop");
                L.thinkStart("A", -600, 380, 300, 200, "glyph");
                L.thinkStart("C", 300, 200, 300, 200, "glyph");  // a request with no tap: a new doodle
                const ks = Object.keys(L.doodles).sort().join(",");
                top.check(ks === "A,B,C", "three doodles, keyed by request (" + ks + ")");
                top.check(L.doodles.A && L.doodles.A.style === "pen" && L.doodles.A.cx < 0, "A adopted the first selection's doodle");
                top.check(L.doodles.B && L.doodles.B.style === "pen" && L.doodles.B.cy > 1000, "B adopted the second selection's doodle");
                top.check(L.doodles.C && L.doodles.C.style === "glyph", "C started its own");
            }
            if (t === 10) {
                for (const k of ["A", "B", "C"]) top.framesAt[k] = L.doodles[k].frames;
                top.measureFrom = Date.now();
                top.paintFrom = L.paintMs;
                top.drawnFrom = L.framesDrawn;
            }
            if (t === 30) {
                // two seconds of three doodles: the frame rate, and every doodle moving
                const secs = (Date.now() - top.measureFrom) / 1000;
                const frames = L.framesDrawn - top.drawnFrom;
                top.fps = (frames / secs).toFixed(1) + " fps, paint " + ((L.paintMs - top.paintFrom) / Math.max(1, frames)).toFixed(1) + " ms/frame with 3 doodles";
                top.check(frames / secs >= 7, "about 10 fps with three doodles (" + top.fps + ")");
                for (const k of ["A", "B", "C"]) top.check(L.doodles[k].frames - top.framesAt[k] >= 14, k + " kept moving");
                // the pen guard with three up: three small panels, nothing over the far page
                const cs = top.shown(L);
                top.check(cs.length === 3, "three panels (" + cs.length + ")");
                top.check(!L.enabled && L.width === 0 && L.height === 0, "the root covers nothing, takes no input");
                for (let i = 0; i < cs.length; ++i) {
                    const c = cs[i];
                    top.check(!c.enabled && !c.parent.enabled, "a panel takes no input");
                    top.check(c.width < 400 && c.height < 400, "a panel spans only its doodle (" + c.width + "x" + c.height + ")");
                }
                // A's answer starts writing beside A: only A hands off
                L.thinkClear("A", -600, 380);
                L.liveAdd("a1", top.stroke(-590, 400, Date.now()), 4, "#1f6fe0");
                L.liveEnd("a1");
                top.check(L.doodles.A.handoff && !L.doodles.B.handoff && !L.doodles.C.handoff, "only A hands off");
                // C is done
                L.thinkDone("C", true, "", undefined, undefined);
                top.check(L.doodles.C.done && !L.doodles.B.done, "only C is done");
            }
            if (t === 58) {
                top.check(L.doodles.A === undefined, "A handed off and went");
                top.check(L.doodles.C === undefined, "C ticked and went");
                top.check(L.doodles.B && !L.doodles.B.handoff && L.doodles.B.frames > top.framesAt.B + 40, "B still thinking");
                L.liveRemove("a1");
                top.check(top.idles === 0, "not idle while B thinks");
                L.thinkDone("B", false, "Answered on your glasses", 100, 1600);
            }
            if (t === 118) {
                top.check(Object.keys(L.doodles).length === 0 && top.shown(L).length === 0, "all gone");
                top.check(top.idles === 1, "idle once, when the last went (" + top.idles + ")");
                finish();
            }
        }
    }

    function finish() {
        const mode = live && live.animRegions ? "native" : "fallback";
        if (failures.length) console.log("concurrent_test: FAIL " + mode + ": " + failures.join("; ") + " NOTES " + notes.slice(0, 14).join(" / "));
        else console.log("concurrent_test: PASS (" + mode + ") " + fps);
        Qt.quit();
    }
}
