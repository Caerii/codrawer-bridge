// codrawer's live overlay: agent ink appearing as it is written, and agents "thinking".
//
// Created by codrawer-layer (src/live.h) as a child of the visible DocumentView when there is
// something to show, and destroyed when it says `idle`; the extension calls the functions below
// in page units (the root is placed with the tile manager's transform, see below) and logs the
// `note` signal. Nothing here is drawn into the page and nothing is saved: when a stroke's native
// line has been committed (src/ink.h), the extension calls liveRemove and the overlay's copy goes.
//
// # The user's pen always wins
//
// xochitl's pen does not write where another item covers its scene: the first version of this
// overlay filled the view at z 1e6 (a zero-input Canvas) and the user's pen stopped writing
// everywhere until XOVI was turned off (device, 2026-10-07). So the overlay covers only what it
// draws: the root is zero-sized, and every drawing lives on its own small panel (one per live
// stroke, one per thinking doodle) that spans just that drawing; nothing takes input (`enabled:
// false`); when nothing is shown nothing is left, and the extension destroys the overlay. With
// several answers in flight in different places, the panels stay separate: no union over the page.
// tests/qml/live_test.qml and pending_test.qml check all of it.
//
// # Live ink
//
// Agent strokes reach the page natively only after they end, through a commit chain of
// 150-300 ms, so a reply used to appear a letter at a time. Here each stroke's points are played
// back as they stream in, at the speed they were written: every point carries its protocol
// timestamp, and each frame draws the stroke up to "now minus a short buffer", interpolating inside
// the segment it is in, so motion is continuous rather than jumping in point batches. Each panel is
// an e-paper Animation region (the fast waveform, created in a try like every xochitl module
// here); no Pen region: that waveform is the user's pen's own.
//
// # Thinking
//
// While an agent considers a request, a small piece of ink-thought plays where its answer will
// go, in its own e-paper Animation region of about 120 x 120 px (1-bit fast waveform, 10 frames a
// second, only that small region changing each frame; docs/investigations/codrawer-animate.md).
// Several can play at once, one per request, each with its own life. Three styles:
//
//   pen    (default) a nib idly doodling: it traces a slow curve made of incommensurate sines, so
//          it never repeats, and its trail is a comet of ink that thins and is erased at the tail
//   drop   a drop of ink that breathes: its edge is moved by smooth noise, it swells, splits in
//          two that drift apart and dry away, and begins again
//   glyph  the hand sketching and un-sketching a small spiral, then a question-mark flourish, with
//          the bell-shaped (lognormal) speed of a real hand stroke
//
// A doodle's life:
//
//   pending   started on the tablet the moment the user taps Ask (thinkPending), not when the
//             agent's first status arrives over the network (that took seconds on the device)
//   adopted   the agent's first `thinking` status (thinkStart with its id) takes the nearest
//             pending doodle and the doodle glides to the agent's spot; with no status in 8 s, a
//             calm "?" says so and the doodle goes
//   hand-off  the first live stroke near it: the nib leaves the doodle and travels on a curve to
//             where the stroke begins, the doodle dissolving behind it, and the stroke starts to
//             write as the nib arrives
//   cleared   the agent is writing or done: it waits up to 4 s for that first stroke, then flies to
//             the answer block's corner (when given) or dissolves where it is
//   done      never just vanishes: a drawn tick when answered and the doodle is still up, or the
//             agent's note as a brief caption; 120 s at most in all
//
// Everything stops while `paused` (the user's pen or finger is on the page) and resumes where it
// was, with the clock shifted, so nothing jumps; it also stops while all it draws is scrolled off
// screen.
//
// Frame cost is measured, not assumed: every 5 s of activity the overlay reports frames, the
// number of live doodles and strokes, and average paint time per frame.
import QtQuick

Item {
    id: root
    // Zero-sized, so the overlay covers nothing but what it draws, and it never takes input.
    //
    // Anchored to the paper: everything inside is in page units (x centred, y down from the top),
    // and the extension places this root with the tile manager's sceneToViewTransform (x, y = its
    // offset, scale = its zoom; src/live.h), again whenever that changes. So doodles and live
    // strokes stay where they are on the page while it scrolls or zooms, without repainting.
    x: 0
    y: 0
    width: 0
    height: 0
    scale: 1
    transformOrigin: Item.TopLeft
    z: 1000000
    enabled: false

    property bool paused: false
    // The page area on screen, in page units (set by the extension with the transform). While all
    // the overlay draws lies outside it, nothing moves: the clock stops, as when paused.
    property rect visibleArea: Qt.rect(-100000, -100000, 200000, 200000)
    property bool offscreen: false
    readonly property bool halted: paused || offscreen

    signal note(string text)
    // Nothing is shown or playing any more: the extension destroys the overlay.
    signal idle()
    // A pending doodle (thinkPending) waited its time and no agent answered.
    signal noAgent()

    readonly property int frameMs: 100     // 10 frames a second
    readonly property int bufferMs: 140    // playback runs this far behind the newest point
    readonly property int handoffMs: 700   // the nib's travel from a doodle to its answer
    readonly property int clearWaitMs: 4000
    readonly property int thinkMaxMs: 120000
    readonly property real thinkSize: 120
    readonly property real nearDoodle: 900  // page units: how far a stroke may begin from its doodle
    readonly property int pendingMs: 8000
    property int pendingLimitMs: pendingMs  // tests shorten it

    // The page's bounds in page units (the Paper Pro page; a longer page extends downwards).
    readonly property real pageLeft: -810
    readonly property real pageRight: 810

    // ---------------------------------------------------------------------------------------
    // State.

    property var strokes: ({})       // id -> live stroke
    property var doodles: ({})       // id -> thinking doodle
    property int pendingSeq: 0
    property real pausedTotal: 0     // ms spent halted (the clock ignores it)
    property real pausedAt: 0
    property int captionCount: 0

    // stats
    property int framesDrawn: 0
    property real paintMs: 0
    property real statsSince: 0

    function clock() { return Date.now() - pausedTotal; }

    onHaltedChanged: {
        if (halted) {
            pausedAt = Date.now();
        } else if (pausedAt > 0) {
            pausedTotal += Date.now() - pausedAt;
            pausedAt = 0;
        }
    }
    onVisibleAreaChanged: updateOffscreen()

    // ---------------------------------------------------------------------------------------
    // xochitl's modules, optional (created in tries: a missing module costs only the extra).

    function tryCreate(qml, parentItem, name) {
        try {
            return Qt.createQmlObject(qml, parentItem, name);
        } catch (e) {
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Rects (x0, y0, x1, y1).

    function rect(x0, y0, x1, y1) { return { x0: x0, y0: y0, x1: x1, y1: y1 }; }
    function grow(r, x, y, pad) {
        if (!r) return rect(x - pad, y - pad, x + pad, y + pad);
        return rect(Math.min(r.x0, x - pad), Math.min(r.y0, y - pad), Math.max(r.x1, x + pad), Math.max(r.y1, y + pad));
    }
    function union(a, b) {
        if (!a) return b;
        if (!b) return a;
        return rect(Math.min(a.x0, b.x0), Math.min(a.y0, b.y0), Math.max(a.x1, b.x1), Math.max(a.y1, b.y1));
    }
    function onScreen(r) {
        const v = visibleArea;
        return r && r.x0 < v.x + v.width && v.x < r.x1 && r.y0 < v.y + v.height && v.y < r.y1;
    }

    // ---------------------------------------------------------------------------------------
    // Panels: one small canvas per drawing, positioned in page units over just what it draws.

    component Panel: Item {
        id: panel
        objectName: "codrawer-live-panel"
        enabled: false
        visible: area !== null
        // its rect in page units, or null
        property var area: null
        // drawing jobs for the next paint, each function(ctx) in page units
        property var jobs: []
        // draws everything this panel shows (after the canvas is reallocated)
        property var redraw: null
        x: area ? area.x0 : 0
        y: area ? area.y0 : 0
        width: area ? area.x1 - area.x0 : 0
        height: area ? area.y1 - area.y0 : 0

        // Makes the panel cover r (grown by a margin), and no more than about four times it (a
        // doodle that glided or handed off shrinks back); a moved or resized canvas starts empty,
        // so everything is drawn again.
        function ensure(r) {
            if (!r) return;
            const m = 40;
            const need = (r.x1 - r.x0 + 2 * m) * (r.y1 - r.y0 + 2 * m);
            const a = area;
            const inside = a && r.x0 >= a.x0 && r.y0 >= a.y0 && r.x1 <= a.x1 && r.y1 <= a.y1;
            if (inside && (a.x1 - a.x0) * (a.y1 - a.y0) <= 4 * need) return;
            area = { x0: Math.floor(r.x0 - m), y0: Math.floor(r.y0 - m), x1: Math.ceil(r.x1 + m), y1: Math.ceil(r.y1 + m) };
            const rd = redraw;
            jobs = [function(ctx) {
                ctx.clearRect(panel.area.x0, panel.area.y0, panel.area.x1 - panel.area.x0, panel.area.y1 - panel.area.y0);
                if (rd) rd(ctx);
            }];
            canvas.requestPaint();
        }
        function push(job, dirty) {
            jobs.push(job);
            if (!area) return;
            const d = dirty || area;
            canvas.markDirty(Qt.rect(Math.floor(d.x0 - area.x0), Math.floor(d.y0 - area.y0),
                                     Math.ceil(d.x1 - d.x0) + 1, Math.ceil(d.y1 - d.y0) + 1));
        }

        Canvas {
            id: canvas
            objectName: "codrawer-live-canvas"
            anchors.fill: parent
            enabled: false
            renderTarget: Canvas.Image
            renderStrategy: Canvas.Immediate
            onPaint: (region) => {
                if (!panel.area) return;
                const t0 = Date.now();
                const ctx = getContext("2d");
                const js = panel.jobs;
                panel.jobs = [];
                ctx.save();
                ctx.translate(-panel.area.x0, -panel.area.y0);
                for (let i = 0; i < js.length; ++i) js[i](ctx);
                ctx.restore();
                root.paintMs += Date.now() - t0;
            }
        }
    }
    Component { id: panelComponent; Panel {} }

    // A panel with its own e-paper Animation region (xochitl's fast waveform for things that move),
    // when xochitl's module is there (`animRegions` says whether it was, for the tests).
    property bool animRegions: false
    function newPanel() {
        const p = panelComponent.createObject(root);
        const region = tryCreate('import QtQuick\nimport xofm.libs.epaper as Epaper\n' +
                                 'Epaper.ScreenModeItem { objectName: "codrawer-live-anim"; anchors.fill: parent; enabled: false; ' +
                                 'mode: Epaper.ScreenModeItem.Animation }', p, "codrawer-live-anim");
        animRegions = region !== null;
        return p;
    }

    // Off screen: something is shown and all of it lies outside visibleArea (a panel not yet
    // painted counts as on screen, so its first frame is drawn).
    function updateOffscreen() {
        let any = false, some = false;
        const on = function(p) { return !p.area || onScreen(p.area); };
        for (const id in strokes) { some = true; any = any || on(strokes[id].panel); }
        for (const id in doodles) { some = true; any = any || on(doodles[id].panel); }
        offscreen = some && !any;
    }

    // ---------------------------------------------------------------------------------------
    // Painting helpers.

    function paintItem(ctx, it) {
        ctx.strokeStyle = "black";
        ctx.fillStyle = "black";
        if (it.dot) {
            ctx.beginPath();
            ctx.arc(it.dot.x, it.dot.y, Math.max(0.5, it.r), 0, 2 * Math.PI);
            ctx.fill();
        } else if (it.fill) {
            ctx.beginPath();
            ctx.moveTo(it.fill[0].x, it.fill[0].y);
            for (let i = 1; i < it.fill.length; ++i) ctx.lineTo(it.fill[i].x, it.fill[i].y);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.lineWidth = it.width;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(it.pts[0].x, it.pts[0].y);
            for (let i = 1; i < it.pts.length; ++i) ctx.lineTo(it.pts[i].x, it.pts[i].y);
            ctx.stroke();
        }
    }

    function paintStroke(ctx, pts, width, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; ++i) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
    }

    // ---------------------------------------------------------------------------------------
    // Live ink: the API.

    // New points of stroke `id`: [[x, y, pressure, t ms (0: none)], ...] in page units; `width` in
    // page px; `color` "#rrggbb".
    function liveAdd(id, pts, width, color) {
        const now = clock();
        let s = strokes[id];
        if (!s) {
            s = { pts: [], width: width, color: color, t0: -1, local0: now,
                  drawn: [], head: null, idx: -1, ended: false, bbox: null, panel: newPanel() };
            const sref = s;
            s.panel.redraw = function(ctx) {
                const p = drawnPath(sref);
                if (p.length > 0) paintStroke(ctx, p.length > 1 ? p : [p[0], p[0]], sref.width, sref.color);
            };
            strokes[id] = s;
            if (pts.length > 0) s.local0 = Math.max(now, handOffNear(pts[0][0], pts[0][1]));
        }
        for (let i = 0; i < pts.length; ++i) {
            const p = pts[i];
            const arrival = now - s.local0;
            let due;
            if (p[3] > 0) {
                if (s.t0 < 0) s.t0 = p[3];
                due = p[3] - s.t0;
            } else {
                due = s.pts.length ? Math.max(s.pts[s.pts.length - 1].due, arrival) : 0;
            }
            if (s.pts.length && due < s.pts[s.pts.length - 1].due) due = s.pts[s.pts.length - 1].due;
            s.pts.push({ x: p[0], y: p[1], due: due });
            s.bbox = grow(s.bbox, p[0], p[1], width + 4);
        }
        s.panel.ensure(s.bbox);
        updateOffscreen();
        frames.start();
    }

    // The stroke has all its points.
    function liveEnd(id) {
        const s = strokes[id];
        if (s) s.ended = true;
    }

    // The native line is in the page: the overlay's copy goes.
    function liveRemove(id) {
        const s = strokes[id];
        if (!s) return;
        delete strokes[id];
        s.panel.area = null;  // hidden now (destroy is deferred)
        s.panel.destroy();
        checkIdle();
    }

    // What of stroke s is on its panel: its real points so far and the interpolated head.
    function drawnPath(s) {
        return s.head ? s.drawn.concat([s.head]) : s.drawn;
    }

    // Plays every stroke up to the current clock; draws the new parts.
    function stepStrokes(now) {
        for (const id in strokes) {
            const s = strokes[id];
            if (s.pts.length === 0) continue;
            const play = now - s.local0 - bufferMs;
            if (play < 0) continue;
            let idx = s.idx;
            while (idx + 1 < s.pts.length && s.pts[idx + 1].due <= play) ++idx;
            let head = null;
            if (idx >= 0 && idx + 1 < s.pts.length) {
                const a = s.pts[idx], b = s.pts[idx + 1];
                const f = b.due > a.due ? Math.min(1, (play - a.due) / (b.due - a.due)) : 1;
                head = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
            }
            // from where the last frame stopped (its interpolated head, or a real point) through
            // the points now due to this frame's head
            const start = s.head || (s.idx >= 0 ? s.pts[s.idx] : null);
            const segment = start ? [start] : [];
            for (let i = s.idx + 1; i <= idx; ++i) {
                segment.push(s.pts[i]);
                s.drawn.push(s.pts[i]);
            }
            if (head) segment.push(head);
            s.head = head;
            s.idx = idx;
            if (segment.length === 0 || (segment.length === 1 && start)) continue;
            const copy = segment.length === 1 ? [segment[0], segment[0]] : segment;
            let r = null;
            for (let i = 0; i < copy.length; ++i) r = grow(r, copy[i].x, copy[i].y, s.width + 2);
            const w = s.width, c = s.color;
            s.panel.push(function(ctx) { paintStroke(ctx, copy, w, c); }, r);
        }
    }

    function anyLiveActive() {
        for (const id in strokes) {
            const s = strokes[id];
            if (!s.ended || s.idx + 1 < s.pts.length) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------
    // Thinking: the API (one doodle per request id).

    // Where a doodle goes for an answer block (x, y, w, h in page units): its top left corner
    // when big enough, where the answer begins; else beside it, to the right when there is room.
    function spotFor(x, y, w, h) {
        const sz = thinkSize;
        let cx = x + sz / 2;
        if (w < sz) {
            cx = x + w + sz / 2 + 24;
            if (cx + sz / 2 > pageRight) cx = x - sz / 2 - 24;
        }
        cx = Math.max(pageLeft + sz / 2, Math.min(pageRight - sz / 2, cx));
        return { x: cx, y: Math.max(sz / 2, y + sz / 2) };
    }

    function newDoodle(id, cx, cy, style) {
        const d = { id: id, style: (style === "drop" || style === "glyph") ? style : "pen", cx: cx, cy: cy, t0: clock(),
                    trail: [], items: null, rect: null, handoff: null, clearAt: 0, target: null, frames: 0,
                    pending: false, move: null, noAgent: 0, done: null, panel: newPanel() };
        d.panel.redraw = function(ctx) { if (d.items) for (let i = 0; i < d.items.length; ++i) paintItem(ctx, d.items[i]); };
        doodles[id] = d;
        frames.start();
        return d;
    }

    // An agent's `thinking` for request `id` at its answer block: adopts the nearest pending doodle
    // (it glides there), or moves this request's doodle, or starts one.
    function thinkStart(id, x, y, w, h, style) {
        const now = clock();
        const at = spotFor(x, y, w, h);
        let d = doodles[id];
        if (!d) {
            let best = null, bestDist = 1e9;
            for (const k in doodles) {
                const c = doodles[k];
                if (!c.pending || c.handoff || c.noAgent || c.done) continue;
                const dist = Math.hypot(c.cx - at.x, c.cy - at.y);
                if (dist < bestDist && dist < 1200) { best = c; bestDist = dist; }
            }
            if (best) {
                delete doodles[best.id];
                note("thinking: " + best.id + " adopted by " + id + ", to " + Math.round(at.x) + "," + Math.round(at.y));
                best.id = id;
                best.pending = false;
                doodles[id] = best;
                d = best;
            }
        }
        if (d) {
            if (Math.abs(d.cx - at.x) > 0.5 || Math.abs(d.cy - at.y) > 0.5) d.move = { fx: d.cx, fy: d.cy, tx: at.x, ty: at.y, t0: now };
            d.pending = false;
            frames.start();
            return;
        }
        d = newDoodle(id, at.x, at.y, style);
        note("thinking: " + id + " " + d.style + " at " + Math.round(at.x) + "," + Math.round(at.y));
    }

    // Started on the tablet the moment the user taps Ask, before any agent has said a word: a
    // provisional doodle at the block (x, y, w, h) that the agent's first status adopts. Returns
    // its id.
    function thinkPending(x, y, w, h, style) {
        pendingSeq += 1;
        const id = "local-" + pendingSeq;
        const at = spotFor(x, y, w, h);
        const d = newDoodle(id, at.x, at.y, style);
        d.pending = true;
        note("thinking: " + id + " pending (no agent yet) at " + Math.round(at.x) + "," + Math.round(at.y));
        return id;
    }

    // The agent is writing or done with request `id`: hand off to its first live stroke, or after
    // 4 s fly to (tx, ty) (the answer block's corner, when given) or dissolve in place.
    function thinkClear(id, tx, ty) {
        const d = doodles[id];
        if (!d) return;
        if (!d.clearAt) d.clearAt = clock();
        if (typeof tx === "number" && typeof ty === "number") d.target = { x: tx, y: ty };
    }

    // The agent is done with request `id` (agent_status `done`). Never just vanish: with `ok` and
    // the doodle still up, it dissolves into a small tick; with !ok, `note` appears as a brief
    // caption at the spot. (x, y) page units: where the caption goes when no doodle is up.
    function thinkDone(id, ok, noteText, x, y) {
        const text = (typeof noteText === "string") ? noteText : "";
        const d = doodles[id];
        let at = d ? { x: d.cx - thinkSize / 2, y: d.cy + thinkSize / 2 } : null;
        if (!at && typeof x === "number" && typeof y === "number") at = { x: x, y: y };
        if (d && !d.handoff && !d.done) {
            d.done = { ok: ok !== false, t0: clock() };
            frames.start();
        }
        if (ok === false && text !== "" && at) showCaption(text, at.x, at.y);
    }

    function thinkEnd(id, why) {
        const d = doodles[id];
        if (!d) return;
        delete doodles[id];
        d.panel.area = null;
        d.panel.destroy();
        note("thinking: " + id + " ended (" + why + ") after " + d.frames + " frames");
        checkIdle();
    }

    // The first live stroke near a doodle that is not yet handing off: its nib flies to (x, y).
    // Returns when the stroke may start writing (clock ms; 0 for at once).
    function handOffNear(x, y) {
        let best = null, bestDist = nearDoodle;
        for (const k in doodles) {
            const d = doodles[k];
            if (d.noAgent || d.done) continue;
            const dist = Math.hypot(d.cx - x, d.cy - y);
            if (d.handoff && d.handoff.to && dist < bestDist) return d.handoff.t0 + handoffMs;  // its flight is on
            if (!d.handoff && dist < bestDist) { best = d; bestDist = dist; }
        }
        if (!best) return 0;
        const now = clock();
        const from = best.trail.length ? best.trail[best.trail.length - 1] : { x: best.cx, y: best.cy };
        best.handoff = { from: from, to: { x: x, y: y }, t0: now, path: [] };
        return now + handoffMs;
    }

    // ---------------------------------------------------------------------------------------
    // Thinking: the motion.

    // Smooth value noise in 2D, 0..1.
    function hash(i, j) {
        const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
        return s - Math.floor(s);
    }
    function noise(x, y) {
        const i = Math.floor(x), j = Math.floor(y);
        const fx = x - i, fy = y - j;
        const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
        const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }

    // The idle nib: incommensurate sines (never repeating), slowly breathing in size.
    function penAt(d, tau) {
        const R = thinkSize * 0.36 * (0.85 + 0.15 * Math.sin(tau * 0.21));
        const x = 0.62 * Math.sin(1.0 * tau + 0.3) + 0.38 * Math.sin(Math.SQRT2 * 1.7 * tau);
        const y = 0.62 * Math.sin(1.27 * tau) + 0.38 * Math.cos(1.618 * 1.3 * tau + 1.1);
        return { x: d.cx + R * x, y: d.cy + R * y };
    }

    // Lognormal speed profile: the share of a stroke drawn after fraction u of its time.
    function lognormalCdf(u) {
        if (u <= 0) return 0;
        if (u >= 1) return 1;
        const mu = -0.9, sigma = 0.45; // peak speed a third of the way in, like a hand
        const z = (Math.log(u) - mu) / (sigma * Math.SQRT2);
        // erf approximation (Abramowitz-Stegun 7.1.26)
        const t = 1 / (1 + 0.3275911 * Math.abs(z));
        const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
        const erf = z >= 0 ? y : -y;
        return Math.min(1, Math.max(0, 0.5 * (1 + erf) / 0.98));
    }

    // A tick at (cx, cy), drawn to fraction u (0..1) of its length.
    function tickPoints(cx, cy, u) {
        const a = { x: cx - 16, y: cy }, b = { x: cx - 4, y: cy + 13 }, c = { x: cx + 20, y: cy - 15 };
        const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
        const dd = u * (l1 + l2);
        if (dd <= l1) return [a, { x: a.x + (b.x - a.x) * dd / l1, y: a.y + (b.y - a.y) * dd / l1 }];
        const f = (dd - l1) / l2;
        return [a, b, { x: b.x + (c.x - b.x) * f, y: b.y + (c.y - b.y) * f }];
    }

    function spiralPoints(cx, cy) {
        const pts = [];
        for (let i = 0; i <= 60; ++i) {
            const th = i / 60 * 4.6 * Math.PI;
            const r = 3 + 2.4 * th;
            pts.push({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) });
        }
        return pts;
    }
    function questionPoints(cx, cy) {
        const pts = [];
        for (let i = 0; i <= 30; ++i) {  // the hook
            const th = Math.PI * (1.05 + 1.35 * i / 30);
            pts.push({ x: cx + 22 * Math.cos(th), y: cy - 16 + 20 * Math.sin(th) });
        }
        const last = pts[pts.length - 1];
        for (let i = 1; i <= 10; ++i) pts.push({ x: last.x + (cx - last.x) * i / 10, y: last.y + (cy + 14 - last.y) * i / 10 });
        return pts;
    }

    // The polylines (each [{x,y}], with widths) for doodle d at time tau (s); scale 0..1 for the
    // dissolve.
    function doodle(d, tau, scale) {
        const out = [];
        if (d.style === "pen") {
            const p = penAt(d, tau);
            d.trail.push(p);
            const keep = Math.max(0, Math.round(24 * scale));
            while (d.trail.length > keep) d.trail.shift();
            const n = d.trail.length;
            for (let i = 1; i < n; ++i) {
                const w = 0.8 + 3.2 * (i / n);  // thin at the tail, full at the nib
                out.push({ pts: [d.trail[i - 1], d.trail[i]], width: w });
            }
            if (n && scale > 0) out.push({ dot: d.trail[n - 1], r: 3 * scale });
        } else if (d.style === "drop") {
            const cycle = 5.0, ph = (tau % cycle) / cycle;
            const blobs = [];
            if (ph < 0.6) {
                blobs.push({ x: d.cx, y: d.cy, r: 4 + 20 * Math.sin(ph / 0.6 * Math.PI / 2) });
            } else {
                const q = (ph - 0.6) / 0.4, dd = 28 * q, r = 18 * (1 - q) * (1 - 0.4 * q);
                blobs.push({ x: d.cx - dd, y: d.cy + dd * 0.3, r: r });
                blobs.push({ x: d.cx + dd * 0.9, y: d.cy - dd * 0.4, r: r * 0.8 });
            }
            for (let b = 0; b < blobs.length; ++b) {
                const B = blobs[b], pts = [];
                if (B.r * scale < 0.8) continue;
                for (let i = 0; i <= 36; ++i) {
                    const th = i / 36 * 2 * Math.PI;
                    const n = noise(Math.cos(th) * 1.4 + tau * 0.5 + b * 7, Math.sin(th) * 1.4 - tau * 0.4);
                    const r = B.r * scale * (0.82 + 0.36 * n);
                    pts.push({ x: B.x + r * Math.cos(th), y: B.y + r * Math.sin(th) });
                }
                out.push({ fill: pts });
            }
        } else {  // glyph: sketch, hold, un-sketch; spiral then question mark
            const dur = 1.8, hold = 0.7, cycle = 2 * dur + hold + 0.4;
            const k = Math.floor(tau / cycle), t = tau - k * cycle;
            const shape = (k % 2 === 0) ? spiralPoints(d.cx, d.cy) : questionPoints(d.cx, d.cy);
            let a = 0, b = 0;
            if (t < dur) b = lognormalCdf(t / dur);
            else if (t < dur + hold) b = 1;
            else if (t < 2 * dur + hold) { a = lognormalCdf((t - dur - hold) / dur); b = 1; }
            const n = shape.length - 1;
            const i0 = Math.floor(a * n), i1 = Math.floor(b * n * scale + (1 - scale) * a * n);
            const part = shape.slice(i0, Math.max(i0, i1) + 1);
            if (part.length > 1) out.push({ pts: part, width: 2.6 });
            if (k % 2 === 1 && b >= 1 && a < 0.9) out.push({ dot: { x: d.cx, y: d.cy + 30 }, r: 3 * scale });
        }
        return out;
    }

    // One frame of doodle d.
    function stepDoodle(d, now) {
        const tau = (now - d.t0) / 1000;
        if (now - d.t0 > thinkMaxMs) return thinkEnd(d.id, "timeout");
        // adopted or moved: glide to the agent's spot (eased, 600 ms); the doodle keeps moving
        if (d.move) {
            const m = d.move, u = Math.min(1, (now - m.t0) / 600), e = u * u * (3 - 2 * u);
            d.cx = m.fx + (m.tx - m.fx) * e;
            d.cy = m.fy + (m.ty - m.fy) * e;
            if (u >= 1) d.move = null;
        }
        // nobody answered: dissolve the doodle (0.8 s), show a calm "?" (2.4 s), end
        if (d.pending && !d.noAgent && now - d.t0 > pendingLimitMs) {
            d.noAgent = now;
            note("thinking: " + d.id + " no agent answered in " + Math.round(pendingLimitMs / 1000) + " s");
            root.noAgent();
        }
        // done: dissolve the doodle (0.8 s); when answered, a tick is drawn in (2.4 s in all)
        if (d.done && !d.noAgent) {
            const since = now - d.done.t0;
            if (since > (d.done.ok ? 2400 : 800)) return thinkEnd(d.id, d.done.ok ? "done" : "done elsewhere");
            const extra = [];
            if (d.done.ok && since > 500) extra.push({ pts: tickPoints(d.cx, d.cy, Math.min(1, (since - 500) / 400)), width: 3 });
            return paintDoodle(d, doodle(d, tau, Math.max(0, 1 - since / 800)).concat(extra));
        }
        if (d.noAgent) {
            const since = now - d.noAgent;
            if (since > 3200) return thinkEnd(d.id, "no agent");
            const extra = [];
            if (since > 600) {
                extra.push({ pts: questionPoints(d.cx, d.cy), width: 2.6 });
                extra.push({ dot: { x: d.cx, y: d.cy + 30 }, r: 3 });
            }
            return paintDoodle(d, doodle(d, tau, Math.max(0, 1 - since / 800)).concat(extra));
        }
        if (d.clearAt && !d.handoff && now - d.clearAt > clearWaitMs) {
            d.handoff = { from: d.trail.length ? d.trail[d.trail.length - 1] : { x: d.cx, y: d.cy },
                          to: d.target || null, t0: now, path: [] };
        }
        let scale = 1;
        const items = [];
        if (d.handoff) {
            const h = d.handoff;
            const u = Math.min(1, (now - h.t0) / handoffMs);
            scale = 1 - u;
            if (h.to) {  // to the answer (or where the agent said it writes)
                // the nib's flight: a curve that leaves sideways, eased in and out
                const e = u * u * (3 - 2 * u);
                const mx = (h.from.x + h.to.x) / 2 - (h.to.y - h.from.y) * 0.25;
                const my = (h.from.y + h.to.y) / 2 + (h.to.x - h.from.x) * 0.25;
                const x = (1 - e) * (1 - e) * h.from.x + 2 * (1 - e) * e * mx + e * e * h.to.x;
                const y = (1 - e) * (1 - e) * h.from.y + 2 * (1 - e) * e * my + e * e * h.to.y;
                h.path.push({ x: x, y: y });
                while (h.path.length > 6) h.path.shift();
                for (let i = 1; i < h.path.length; ++i) items.push({ pts: [h.path[i - 1], h.path[i]], width: 0.8 + 2.4 * i / h.path.length });
                if (u < 1) items.push({ dot: { x: x, y: y }, r: 3 });
            }
            if (u >= 1) return thinkEnd(d.id, h.to ? "hand-off" : "cleared");
        }
        paintDoodle(d, doodle(d, tau, scale).concat(items));
    }

    // Queues one frame of doodle d: `all` replaces the last frame's items on its panel.
    function paintDoodle(d, all) {
        let r = null;
        for (let i = 0; i < all.length; ++i) {
            const it = all[i], pts = it.pts || it.fill || [it.dot];
            for (let j = 0; j < pts.length; ++j) r = grow(r, pts[j].x, pts[j].y, (it.width || it.r || 2) + 4);
        }
        // the panel covers the doodle's square and, during a hand-off, the flight to its target
        const home = rect(d.cx - thinkSize / 2, d.cy - thinkSize / 2, d.cx + thinkSize / 2, d.cy + thinkSize / 2);
        const h = d.handoff;
        d.panel.ensure(union(union(home, r), h && h.to ? rect(Math.min(h.from.x, h.to.x) - 24, Math.min(h.from.y, h.to.y) - 24,
                                                             Math.max(h.from.x, h.to.x) + 24, Math.max(h.from.y, h.to.y) + 24) : null));
        const dirty = union(d.rect, r);
        const p = d.panel;
        p.push(function(ctx) {
            if (dirty) ctx.clearRect(dirty.x0, dirty.y0, dirty.x1 - dirty.x0, dirty.y1 - dirty.y0);
            for (let i = 0; i < all.length; ++i) paintItem(ctx, all[i]);
        }, dirty);
        d.rect = r;
        d.items = all;
        d.frames += 1;
    }

    // ---------------------------------------------------------------------------------------
    // Captions: an agent's note at its spot (no input, 4 s, fading, never saved).

    Component {
        id: captionComponent
        Text {
            id: cap
            objectName: "codrawer-live-caption"
            enabled: false
            width: 560
            wrapMode: Text.Wrap
            font.pixelSize: 28
            color: "black"
            NumberAnimation on opacity {
                id: fade
                running: false
                to: 0
                duration: 600
                onFinished: root.captionGone(cap)
            }
            Timer { interval: 4000; running: true; onTriggered: fade.start() }
        }
    }

    function showCaption(text, x, y) {
        const c = captionComponent.createObject(root, { text: text, x: x, y: y });
        if (!c) return;
        captionCount += 1;
        note("caption: " + text);
    }

    function captionGone(c) {
        captionCount -= 1;
        c.destroy();
        checkIdle();
    }

    // ---------------------------------------------------------------------------------------
    // Idle.

    function isIdle() {
        return Object.keys(doodles).length === 0 && Object.keys(strokes).length === 0 && captionCount === 0;
    }

    // Nothing shown and nothing playing: tell the extension, which destroys the overlay (an idle
    // overlay must leave nothing over the page).
    function checkIdle() {
        if (!isIdle()) return;
        frames.stop();
        offscreen = false;
        root.idle();
    }

    Timer {
        id: frames
        interval: root.frameMs
        repeat: true
        running: false
        onTriggered: {
            root.updateOffscreen();
            if (root.halted) return;
            const now = root.clock();
            if (root.statsSince === 0) root.statsSince = now;
            root.stepStrokes(now);
            for (const id in root.doodles) root.stepDoodle(root.doodles[id], now);
            root.framesDrawn += 1;
            if (now - root.statsSince >= 5000) {
                root.note("frames " + root.framesDrawn + " in " + Math.round(now - root.statsSince) + " ms (" +
                          (root.framesDrawn * 1000 / (now - root.statsSince)).toFixed(1) + " fps), " +
                          Object.keys(root.doodles).length + " doodle(s), " + Object.keys(root.strokes).length +
                          " live stroke(s), paint " + (root.paintMs / Math.max(1, root.framesDrawn)).toFixed(1) + " ms/frame");
                root.framesDrawn = 0;
                root.paintMs = 0;
                root.statsSince = now;
            }
            if (Object.keys(root.doodles).length === 0 && !root.anyLiveActive()) {
                running = false;
                root.statsSince = 0;
            }
        }
    }
}
