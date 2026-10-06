// codrawer's live overlay: agent ink appearing as it is written, and the agent "thinking".
//
// Created by codrawer-layer (src/live.h) as a child of the visible DocumentView, filling it; the
// extension calls the functions below with view coordinates (it maps page units through the tile
// manager's transform) and logs the `note` signal. Nothing here is drawn into the page and
// nothing is saved: when a stroke's native line has been committed (src/ink.h), the extension
// calls liveRemove and the overlay's copy goes.
//
// # Live ink
//
// Agent strokes reach the page natively only after they end, through a commit chain of
// 150-300 ms, so a reply used to appear a letter at a time. Here each stroke's points are played
// back as they stream in, at the speed they were written: every point carries its protocol
// timestamp, and each frame draws the stroke up to "now minus a short buffer", interpolating inside
// the segment it is in, so motion is continuous rather than jumping in point batches. The stroke's
// region is marked an e-paper Pen region (xochitl's own fast waveform for ink,
// docs/investigations/codrawer-animate.md), created in a try like every xochitl module here.
//
// # Thinking
//
// While an agent considers a selection, a small piece of ink-thought plays beside it, in an
// e-paper Animation region of about 120 x 120 px (1-bit fast waveform, 10 frames a second, only
// that small region changing each frame), at the top left of the spot the answer will take (or
// beside a small selection). Three styles:
//
//   pen    (default) a nib idly doodling: it traces a slow curve made of incommensurate sines, so
//          it never repeats, and its trail is a comet of ink that thins and is erased at the tail
//   drop   a drop of ink that breathes: its edge is moved by smooth noise, it swells, splits in
//          two that drift apart and dry away, and begins again
//   glyph  the hand sketching and un-sketching a small spiral, then a question-mark flourish, with
//          the bell-shaped (lognormal) speed of a real hand stroke
//
// When the answer's first live stroke arrives, the thinking flows into it: the nib leaves the
// doodle and travels on a curve to where the answer begins, the doodle dissolving behind it, and
// the stroke starts to write as the nib arrives. A `clear` (the agent is writing or done) waits up
// to 4 s for that first stroke, then the doodle dissolves on its own; it also ends after 120 s.
//
// Everything stops while `paused` (the user's pen or finger is on the page) and resumes where it
// was, with the clock shifted, so nothing jumps.
//
// Frame cost is measured, not assumed: every 5 s of activity the overlay reports frames drawn,
// average paint time and, when xochitl's EPFramebuffer is reachable, its framebufferUpdated count.
import QtQuick

Item {
    id: root
    anchors.fill: parent
    z: 1000000

    property bool paused: false
    signal note(string text)

    readonly property int frameMs: 100     // 10 frames a second
    readonly property int bufferMs: 140    // playback runs this far behind the newest point
    readonly property int handoffMs: 700   // the nib's travel from the doodle to the answer
    readonly property int clearWaitMs: 4000
    readonly property int thinkMaxMs: 120000
    readonly property real thinkSize: 120

    // ---------------------------------------------------------------------------------------
    // State.

    property var strokes: ({})       // id -> stroke
    property var think: null         // the thinking state, or null
    property var queue: []           // drawing jobs for the next paint
    property real pausedTotal: 0     // ms spent paused (the clock ignores it)
    property real pausedAt: 0
    property real holdUntil: 0       // live playback waits for the hand-off until then (clock ms)

    // stats
    property int framesDrawn: 0
    property real paintMs: 0
    property int fbUpdates: 0
    property real statsSince: 0

    function clock() { return Date.now() - pausedTotal; }

    onPausedChanged: {
        if (paused) {
            pausedAt = Date.now();
        } else if (pausedAt > 0) {
            pausedTotal += Date.now() - pausedAt;
            pausedAt = 0;
        }
    }

    // ---------------------------------------------------------------------------------------
    // xochitl's modules, optional (created in tries: a missing module costs only the extra).

    function tryCreate(qml, parentItem, name) {
        try {
            return Qt.createQmlObject(qml, parentItem, name);
        } catch (e) {
            return null;
        }
    }

    property var penRegion: null
    property var animRegion: null
    Component.onCompleted: {
        penRegion = tryCreate('import QtQuick\nimport xofm.libs.epaper as Epaper\n' +
                              'Epaper.ScreenModeItem { objectName: "codrawer-live-pen"; visible: false; mode: Epaper.ScreenModeItem.Pen }',
                              root, "codrawer-live-pen");
        animRegion = tryCreate('import QtQuick\nimport xofm.libs.epaper as Epaper\n' +
                               'Epaper.ScreenModeItem { objectName: "codrawer-live-anim"; visible: false; mode: Epaper.ScreenModeItem.Animation }',
                               root, "codrawer-live-anim");
        tryCreate('import QtQuick\nimport xofm.libs.epaper\n' +
                  'Connections { ignoreUnknownSignals: true; target: typeof EPFramebuffer !== "undefined" ? EPFramebuffer : null\n' +
                  '  function onFramebufferUpdated(r) { root.fbUpdates += 1; } }',
                  root, "codrawer-live-fbstats");
    }

    function placeRegion(region, r) {
        if (!region) return;
        region.visible = r !== null;
        if (!r) return;
        region.x = r.x0;
        region.y = r.y0;
        region.width = Math.max(1, r.x1 - r.x0);
        region.height = Math.max(1, r.y1 - r.y0);
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
    function intersects(a, b) { return a && b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }

    // ---------------------------------------------------------------------------------------
    // Live ink: the API.

    // New points of stroke `id`: [[x, y, pressure, t ms (0: none)], ...] in view px; `width` in
    // view px; `color` "#rrggbb".
    function liveAdd(id, pts, width, color) {
        const now = clock();
        let s = strokes[id];
        if (!s) {
            s = { pts: [], width: width, color: color, t0: -1, local0: Math.max(now, holdUntil),
                  drawn: [], head: null, idx: -1, ended: false, bbox: null };
            strokes[id] = s;
            if (think && !think.handoff && pts.length > 0) handOff(pts[0][0], pts[0][1]);
            if (holdUntil > now) s.local0 = holdUntil;
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
        updateRegions();
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
        repaint(s.bbox);
        updateRegions();
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
            drawPolyline(segment, s.width, s.color);
        }
    }

    // What of stroke s is on the canvas: its real points so far and the interpolated head.
    function drawnPath(s) {
        return s.head ? s.drawn.concat([s.head]) : s.drawn;
    }

    function anyLiveActive() {
        for (const id in strokes) {
            const s = strokes[id];
            if (!s.ended || s.idx + 1 < s.pts.length) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------
    // Thinking: the API.

    // Start at the spot the answer will take (x, y, w, h in view px: agent_status's bbox, the
    // reserved answer block, or the selection when agent ink is off). style: pen | drop | glyph.
    function thinkStart(x, y, w, h, style) {
        const now = clock();
        const sz = thinkSize;
        // in the block's top left corner when it is big enough, where the answer begins; else
        // beside it, to the right when there is room, level with its top
        let cx = x + sz / 2;
        if (w < sz) {
            cx = x + w + sz / 2 + 24;
            if (cx + sz / 2 > root.width) cx = x - sz / 2 - 24;
        }
        cx = Math.max(sz / 2, Math.min(root.width - sz / 2, cx));
        const cy = Math.max(sz / 2, Math.min(root.height - sz / 2, y + sz / 2));
        if (think) repaint(think.rect);
        think = { style: (style === "drop" || style === "glyph") ? style : "pen", cx: cx, cy: cy, t0: now,
                  trail: [], rect: null, handoff: null, clearAt: 0, target: null, frames: 0 };
        note("thinking: " + think.style + " at " + Math.round(cx) + "," + Math.round(cy));
        frames.start();
    }

    // The agent is writing or done: hand off to the first live stroke, or after 4 s fly to (tx, ty)
    // (the answer block's corner, when the agent said where it writes) or dissolve in place.
    function thinkClear(tx, ty) {
        if (!think) return;
        if (!think.clearAt) think.clearAt = clock();
        if (typeof tx === "number" && typeof ty === "number") think.target = { x: tx, y: ty };
    }

    // The nib leaves the doodle for (x, y), where the answer begins.
    function handOff(x, y) {
        const now = clock();
        const from = think.trail.length ? think.trail[think.trail.length - 1] : { x: think.cx, y: think.cy };
        think.handoff = { from: from, to: { x: x, y: y }, t0: now, path: [] };
        holdUntil = now + handoffMs;
    }

    function thinkEnd(why) {
        if (!think) return;
        repaint(think.rect);
        note("thinking: ended (" + why + ") after " + think.frames + " frames");
        think = null;
        updateRegions();
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
    function penAt(tau) {
        const R = thinkSize * 0.36 * (0.85 + 0.15 * Math.sin(tau * 0.21));
        const x = 0.62 * Math.sin(1.0 * tau + 0.3) + 0.38 * Math.sin(Math.SQRT2 * 1.7 * tau);
        const y = 0.62 * Math.sin(1.27 * tau) + 0.38 * Math.cos(1.618 * 1.3 * tau + 1.1);
        return { x: think.cx + R * x, y: think.cy + R * y };
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

    // The polylines (each [{x,y}], with widths) for the doodle at time tau (s); scale 0..1 for the
    // dissolve.
    function doodle(tau, scale) {
        const out = [];
        if (think.style === "pen") {
            const p = penAt(tau);
            think.trail.push(p);
            const keep = Math.max(0, Math.round(24 * scale));
            while (think.trail.length > keep) think.trail.shift();
            const n = think.trail.length;
            for (let i = 1; i < n; ++i) {
                const w = 0.8 + 3.2 * (i / n);  // thin at the tail, full at the nib
                out.push({ pts: [think.trail[i - 1], think.trail[i]], width: w });
            }
            if (n && scale > 0) out.push({ dot: think.trail[n - 1], r: 3 * scale });
        } else if (think.style === "drop") {
            const cycle = 5.0, ph = (tau % cycle) / cycle;
            const blobs = [];
            if (ph < 0.6) {
                blobs.push({ x: think.cx, y: think.cy, r: 4 + 20 * Math.sin(ph / 0.6 * Math.PI / 2) });
            } else {
                const q = (ph - 0.6) / 0.4, d = 28 * q, r = 18 * (1 - q) * (1 - 0.4 * q);
                blobs.push({ x: think.cx - d, y: think.cy + d * 0.3, r: r });
                blobs.push({ x: think.cx + d * 0.9, y: think.cy - d * 0.4, r: r * 0.8 });
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
            const shape = (k % 2 === 0) ? spiralPoints(think.cx, think.cy) : questionPoints(think.cx, think.cy);
            let a = 0, b = 0;
            if (t < dur) b = lognormalCdf(t / dur);
            else if (t < dur + hold) b = 1;
            else if (t < 2 * dur + hold) { a = lognormalCdf((t - dur - hold) / dur); b = 1; }
            const n = shape.length - 1;
            const i0 = Math.floor(a * n), i1 = Math.floor(b * n * scale + (1 - scale) * a * n);
            const part = shape.slice(i0, Math.max(i0, i1) + 1);
            if (part.length > 1) out.push({ pts: part, width: 2.6 });
            if (k % 2 === 1 && b >= 1 && a < 0.9) out.push({ dot: { x: think.cx, y: think.cy + 30 }, r: 3 * scale });
        }
        return out;
    }

    function stepThink(now) {
        if (!think) return;
        const tau = (now - think.t0) / 1000;
        if (now - think.t0 > thinkMaxMs) return thinkEnd("timeout");
        if (think.clearAt && !think.handoff && now - think.clearAt > clearWaitMs) {
            think.handoff = { from: think.trail.length ? think.trail[think.trail.length - 1] : { x: think.cx, y: think.cy },
                              to: think.target || null, t0: now, path: [] };
        }
        let scale = 1;
        const items = [];
        if (think.handoff) {
            const h = think.handoff;
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
            if (u >= 1) return thinkEnd(h.to ? "hand-off" : "cleared");
        }
        const all = doodle(tau, scale).concat(items);
        let r = null;
        for (let i = 0; i < all.length; ++i) {
            const it = all[i], pts = it.pts || it.fill || [it.dot];
            for (let j = 0; j < pts.length; ++j) r = grow(r, pts[j].x, pts[j].y, (it.width || it.r || 2) + 4);
        }
        const dirty = union(think.rect, r);
        const t = think;
        queue.push(function(ctx) {
            clearAndRestore(ctx, dirty, t);
            for (let i = 0; i < all.length; ++i) paintItem(ctx, all[i]);
        });
        think.rect = r;
        think.frames += 1;
        markDirtyRect(dirty);
        placeRegion(animRegion, union(r, think.handoff && think.handoff.to ? rect(think.handoff.to.x - 8, think.handoff.to.y - 8, think.handoff.to.x + 8, think.handoff.to.y + 8) : null));
    }

    // ---------------------------------------------------------------------------------------
    // Painting. All drawing happens in onPaint from queued jobs; the canvas keeps what it drew.

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

    // Clears `r` and redraws the live strokes' drawn parts inside it (thinking `except` is redrawn
    // by its caller).
    function clearAndRestore(ctx, r, except) {
        if (!r) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        ctx.clip();
        ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        for (const id in strokes) {
            const s = strokes[id];
            const path = drawnPath(s);
            if (path.length > 0 && intersects(s.bbox, r)) paintStroke(ctx, path.length > 1 ? path : [path[0], path[0]], s.width, s.color);
        }
        ctx.restore();
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

    function drawPolyline(pts, width, color) {
        const copy = pts.slice();
        if (copy.length === 1) copy.push(copy[0]);
        let r = null;
        for (let i = 0; i < copy.length; ++i) r = grow(r, copy[i].x, copy[i].y, width + 2);
        queue.push(function(ctx) { paintStroke(ctx, copy, width, color); });
        markDirtyRect(r);
    }

    // Repaints `r` without the overlay's removed parts (a stroke gone, the thinking ended).
    function repaint(r) {
        if (!r) return;
        queue.push(function(ctx) { clearAndRestore(ctx, r, null); });
        markDirtyRect(r);
    }

    function markDirtyRect(r) {
        if (!r) return;
        ink.markDirty(Qt.rect(Math.floor(r.x0), Math.floor(r.y0), Math.ceil(r.x1 - r.x0) + 1, Math.ceil(r.y1 - r.y0) + 1));
    }

    function updateRegions() {
        let r = null;
        for (const id in strokes) r = union(r, strokes[id].bbox);
        placeRegion(penRegion, r);
        if (!think) placeRegion(animRegion, null);
    }

    Canvas {
        id: ink
        objectName: "codrawer-live-canvas"
        anchors.fill: parent
        renderTarget: Canvas.Image
        renderStrategy: Canvas.Immediate
        onPaint: (region) => {
            const t0 = Date.now();
            const ctx = getContext("2d");
            const jobs = root.queue;
            root.queue = [];
            for (let i = 0; i < jobs.length; ++i) jobs[i](ctx);
            root.paintMs += Date.now() - t0;
        }
    }

    Timer {
        id: frames
        interval: root.frameMs
        repeat: true
        running: false
        onTriggered: {
            if (root.paused) return;
            const now = root.clock();
            if (root.statsSince === 0) root.statsSince = now;
            root.stepStrokes(now);
            root.stepThink(now);
            root.framesDrawn += 1;
            if (now - root.statsSince >= 5000) {
                root.note("frames " + root.framesDrawn + " in " + Math.round(now - root.statsSince) + " ms (" +
                          (root.framesDrawn * 1000 / (now - root.statsSince)).toFixed(1) + " fps), paint " +
                          (root.paintMs / Math.max(1, root.framesDrawn)).toFixed(1) + " ms/frame, framebuffer updates " +
                          root.fbUpdates);
                root.framesDrawn = 0;
                root.paintMs = 0;
                root.fbUpdates = 0;
                root.statsSince = now;
            }
            if (!root.think && !root.anyLiveActive()) {
                running = false;
                root.statsSince = 0;
            }
        }
    }
}
