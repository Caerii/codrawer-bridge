// Host test of qml/live.qml (run by qmltest.sh, offscreen): for each thinking style, a short
// scene (thinking beside a selection, then an answer stroke streamed in with timestamps, the
// hand-off, the stroke's end and removal), checking the overlay's behaviour, and, with
// `--capture=<dir>` among the arguments, saving each frame as <dir>/<style>-NNN.png for a preview
// (qmltest.sh --preview turns them into GIFs). Prints `live_test: PASS (<native|fallback>)` or
// `live_test: FAIL …`.
import QtQuick

Item {
    id: top
    width: 1620
    height: 2160

    property var failures: []
    function check(ok, what) { if (!ok) failures.push(what); }

    property string captureDir: {
        const args = Qt.application.arguments;
        for (let i = 0; i < args.length; ++i) if (args[i].indexOf("--capture=") === 0) return args[i].substring(10);
        return "";
    }

    property var notes: []
    property var styles: ["pen", "drop", "glyph"]
    property int styleIndex: 0
    property int tick: 0
    property var live: null
    property var answer: []
    property int framesAtPause: -1
    property int idleCount: 0

    function find(item, name) {
        if (item.objectName === name) return item;
        for (let i = 0; i < item.children.length; ++i) {
            const f = find(item.children[i], name);
            if (f) return f;
        }
        return null;
    }

    function findAll(item, name, out) {
        if (item.objectName === name) out.push(item);
        for (let i = 0; i < item.children.length; ++i) findAll(item.children[i], name, out);
        return out;
    }

    // An answer's first stroke: a looping cursive "e" then a tail, 40 points, 25 ms apart.
    function answerStroke(x, y, t0) {
        const pts = [];
        for (let i = 0; i < 40; ++i) {
            const th = i / 39 * 2.6 * Math.PI;
            pts.push([x + i * 2.2 + 14 * Math.cos(th + Math.PI), y - 12 * Math.sin(th), 0.6, t0 + i * 25]);
        }
        return pts;
    }

    // created straight into `stage` (the view), unsized, as the extension parents it into the
    // DocumentView without resizing it
    property var liveComponent: Qt.createComponent(Qt.resolvedUrl("../../qml/live.qml"))

    function startStyle() {
        if (live) live.destroy();
        live = liveComponent.createObject(stage);
        if (!live) return;
        live.note.connect(function(t) { top.notes.push(t); });
        live.idle.connect(function() { top.idleCount += 1; });
        tick = 0;
        // the selection: a 200 x 160 box at (500, 600) view px
        live.thinkStart("q1", 500, 600, 200, 160, styles[styleIndex]);
    }

    Item { id: stage; anchors.fill: parent }

    Component.onCompleted: startStyle()

    Timer {
        interval: 100
        repeat: true
        running: true
        onTriggered: {
            const style = top.styles[top.styleIndex];
            const L = top.live;
            if (!L) { top.check(false, "live.qml did not load"); return top.finish(); }
            top.tick += 1;
            const t = top.tick;
            if (t === 20) {
                top.check(L.doodles.q1 && L.doodles.q1.frames > 10, style + ": thinking draws frames");
                top.check(L.doodles.q1 && L.doodles.q1.rect && (L.doodles.q1.rect.x1 - L.doodles.q1.rect.x0) < 200, style + ": thinking stays small");
                top.framesAtPause = L.doodles.q1 ? L.doodles.q1.frames : -1;
                L.paused = true;
            }
            if (t === 23) {
                top.check(L.doodles.q1 && L.doodles.q1.frames === top.framesAtPause, style + ": nothing moves while paused");
                L.paused = false;
            }
            if (t === 30) {
                L.thinkClear("q1", 560, 880);  // the agent says "writing" there; the first stroke follows
                top.answer = top.answerStroke(560, 900, Date.now());
                L.liveAdd("a1", top.answer.slice(0, 15), 4, "#1f6fe0");
                top.check(L.doodles.q1 && L.doodles.q1.handoff !== null, style + ": the first live stroke starts the hand-off");
            }
            if (t === 32) L.liveAdd("a1", top.answer.slice(15, 40), 4, "#1f6fe0");
            if (t === 33) L.liveEnd("a1");
            if (t === 25 || t === 35) {
                // the pen guard while active: nothing takes input, the root covers nothing, and
                // every canvas covers only what it draws, never the whole page
                const cs = top.findAll(L, "codrawer-live-canvas", []).filter(function(c) { return c.visible; });
                top.check(cs.length >= 1 && cs.length <= (t === 25 ? 1 : 2), style + ": one panel per drawing (" + cs.length + ")");  // the doodle may have handed off by t 35 (slow with --capture)
                top.check(!L.enabled && cs.every(function(c) { return !c.enabled && !c.parent.enabled; }), style + ": the overlay takes no input");
                top.check(L.width === 0 && L.height === 0, style + ": the root covers nothing");
                for (let i = 0; i < cs.length; ++i) {
                    const c = cs[i], at = c.mapToItem(stage, 0, 0);
                    top.check(c.width > 0 && c.width < 800 && c.height < 800, style + ": a canvas covers only its drawing (" + c.width + "x" + c.height + ")");
                    top.check(!(at.x <= 1500 && 1500 < at.x + c.width && at.y <= 2000 && 2000 < at.y + c.height), style + ": the far page is uncovered");
                }
            }
            if (t === 52) {
                top.check(L.doodles.q1 === undefined, style + ": thinking ended after the hand-off");
                const s = L.strokes["a1"];
                top.check(s && s.idx === s.pts.length - 1, style + ": the stroke played to its end");
                L.liveRemove("a1");
                top.check(L.strokes["a1"] === undefined, style + ": removed after the commit");
                // idle: everything hidden, and the extension told (it destroys the overlay)
                const cs = top.findAll(L, "codrawer-live-canvas", []).filter(function(c) { return c.visible; });
                top.check(top.idleCount === top.styleIndex + 1, style + ": idle signalled once");
                top.check(cs.length === 0, style + ": idle leaves nothing over the page");
            }
            if (top.captureDir !== "" && t <= 55) {
                // the whole view, as the overlay now spans only what it draws
                const path = top.captureDir + "/" + style + "-" + ("00" + t).slice(-3) + ".png";
                stage.grabToImage(function(r) { r.saveToFile(path); });
            }
            if (t === 58) {
                top.styleIndex += 1;
                if (top.styleIndex >= top.styles.length) return top.finish();
                top.startStyle();
            }
        }
    }

    function finish() {
        const mode = live && live.animRegions ? "native" : "fallback";
        check(notes.some(function(n) { return n.indexOf("hand-off") >= 0; }), "notes report the hand-off");
        if (failures.length) console.log("live_test: FAIL " + mode + ": " + failures.join("; ") + " NOTES " + notes.slice(0, 12).join(" / "));
        else console.log("live_test: PASS (" + mode + ") notes: " + notes.length);
        Qt.quit();
    }
}
