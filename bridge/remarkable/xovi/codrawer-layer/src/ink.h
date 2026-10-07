// ink.h: committing strokes onto the visible page, on a layer of their own.
//
// # The problem
//
// A stroke from an agent (or the `stroke` probe) must land on the page the user is looking at,
// on its own named layer, saved, undoable, while the user keeps drawing, and leave the user's
// own layer selected afterwards. xochitl's QML commits a pen stroke with
// `SceneController::addDrawingLine(Line)` and renders it with
// `SceneTileManager::renderLineToTiles(Line)`; both are meta-methods (qtmeta.h), and line.h
// builds the Line.
//
// # What the device taught (3.29.0.149, 2026-10-06)
//
// SceneController's layer slots do not take effect inside the GUI-thread job that calls them.
// `addLayer()` returned with `layerCount` unchanged, and the new layer (with `currentLayer` moved
// onto it) appeared a few milliseconds later, once the scene's own job had run
// (native-multiplayer-layer.md, "Probe 1: results", item 2). A commit is therefore a chain of
// short GUI-thread steps, each waiting (waitFor: 20 ms polls, never blocking) until the
// controller reports the previous step's effect:
//
//   1. find the layer by name; if it is missing, `addLayer()`, wait for `layerCount` to grow
//      (3 s), then `setLayerName(new, name)` and wait until `layerName(new)` reads it back (2 s);
//   2. build every stroke's Line, then `setCurrentLayer(ours)`;
//   3. the moment `currentLayer` reads ours (its notify signal, on the next turn of the event
//      loop; a 20 ms poll as a fallback, 2 s at most), `addDrawingLine` every Line and at once
//      `setCurrentLayer(user's)`, the user's layer found by its name since indices move;
//   4. once `currentLayer` reads the user's again (2 s), `renderLineToTiles` each Line and repaint
//      just their part of the view (one e-ink refresh per commit).
//
// # The commit window
//
// The `atomic` probe (layerprobe.h, device 2026-10-07) settled what can be done: `addDrawingLine`
// adds to whichever layer `currentLayer` reads when it is called (a line added right after asking
// for our layer landed on the user's), and `setCurrentLayer` takes effect about 14 ms after it is
// asked for (its notify: our layer at +14 ms, the user's again at +27 ms). So no commit is free of
// a window, but the window can be made as short as the scene allows: steps 2-4 above keep our
// layer selected only from the notify that shows it to the notify that shows the user's again,
// with nothing in between but the `addDrawingLine` calls. Every commit logs that window
// (`ink: window N ms �`, with running mean and max). A user stroke misfiles only if it ends (pen-up,
// when xochitl adds it to the current layer) inside the window.
//
// Placement: `addDrawingLine` takes the Line in page coordinates, exactly as the `.rm` file stores
// them; nothing is mapped. Measured 2026-10-06 (item 4 of the same section): on a page scrolled to
// view offset [810, −196], an unmapped probe wave given at x −564…−136, y 281…379 was saved at
// x −560…−140, y 285…375 (the same place, within the pen's width), while ink first mapped scene →
// view through the tile manager's `sceneToViewTransform` was saved shifted by exactly that offset;
// at zoom 0.75, offset [810, 0], unmapped agent ink landed on target. With `verbose`, the view
// transform is still logged (`ink: view offset … (not applied …)`), so an OS that changes this
// shows up in the log.
//
// # Safety
//
// - Every step first checks that the page it started on is still the visible one; if the user
//   turned the page, the chain stops and, if it can, puts the user's layer back.
// - The only scene changes are `addLayer`, `setLayerName` on the layer this extension created,
//   `setCurrentLayer`, and `addDrawingLine` into that layer. A page with 32 layers gets no more.
// - The write-back guard: a user stroke ending inside the window would land on our layer (xochitl
//   has no meta-call that adds a line to a layer other than the current one). Commits run in the
//   user's pen-up gaps and while the pen is down and has been moving for 150 ms (a pen-up within
//   the next few tens of ms is unlikely then; quick pen-ups are dots and short ticks, which end
//   within 150 ms of their pen-down), never in a gesture's first 150 ms; and at most every 1.5 s,
//   so a streaming answer is committed in batches while the live overlay shows it (live.h).
// - The safety net: every user stroke that completes (the pen handler's `strokeCompleted`,
//   toolfollow.h) while a window is open is logged loudly; when `currentLayer` reads ours at that
//   moment it is counted as misfiled (`ink: WARNING � misfiled N`), else as a near miss. Nothing
//   moves a Line between layers, so it stays where it went.
// - Jobs run one at a time. Jobs queued meanwhile for the same page and layer are merged into one
//   commit (up to kMaxBatch strokes), so a burst of agent strokes costs one select/restore, not
//   one per stroke. At most kMaxQueue jobs wait; beyond that a job is refused with `err busy`.
//
// # Threading
//
// GUI thread only: enqueueInk, every step and every `done` callback.
#pragma once

#include "line.h"

#include <QtCore/QList>
#include <QtCore/QString>

#include <functional>

namespace cdl {

// The layers this extension owns, found by these exact names so that a restart of xochitl (or of
// the extension) finds the same layer again instead of adding another.
QString kTestLayer();   // "codrawer: test": the probes, and the socket's layer "test"
QString kAgentLayer();  // "codrawer: agent": agent ink (the socket's layer "agent")

// One stroke to commit.
struct InkStroke {
    int tool = 17;               // Line::Tool (17 Finelinerv2)
    quint32 argb = 0xff000000u;
    double thickness = 2.0;      // xochitl's pen size (the toolbar's 1/2/3 are 1.0/2.0/3.0)
    QList<RmPoint> pts;          // page coordinates
};

// One commit request: strokes for one page and one of our layers.
struct InkJob {
    QString page;                // the page uuid the strokes are for; must be the visible page
    QString layer;               // kAgentLayer() or kTestLayer(), nothing else
    QList<InkStroke> strokes;
    int adopt = -1;              // probe only: name this layer (the last, not the first) instead of adding one
    int restore = -1;            // probe only: select this layer afterwards, not the one selected now
    bool verbose = false;        // log every step and the Line bytes (the probes)
    // The verdict, on the GUI thread: "ok <n>" or "err <reason>". Also logged as `ink: <verdict>
    // (<n> stroke(s), layer "<name>", <ms> ms)`.
    std::function<void(const QString &)> done;
};

constexpr int kMaxQueue = 256;  // pending jobs; beyond this a job is refused with "err busy"

// Queues `job` and starts the commit chain if it is idle. GUI thread.
void enqueueInk(InkJob job);

}  // namespace cdl
