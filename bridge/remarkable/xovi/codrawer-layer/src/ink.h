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
//   2. `setCurrentLayer(ours)` and wait for `currentLayer` (2 s);
//   3. build every stroke's Line, `addDrawingLine` + `renderLineToTiles` each, and repaint the
//      whole viewport once (one e-ink refresh per commit);
//   4. wait for the scene to take the lines (`itemsBoundingRect` changes, at least 60 ms, at most
//      400 ms), then select the user's layer again, found by its name since indices move (2 s).
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
// - The write-back guard: a commit selects our layer for a few hundred ms, and a user stroke ending
//   meanwhile would land on it (xochitl has no meta-call that adds a line to a layer other than the
//   current one). So commits start only in a pause of the user's writing: no pen or finger down
//   (toolfollow.h, `userTouching`) and at least 800 ms since it lifted; and at most every 1.5 s, so
//   a streaming answer is committed in batches while the live overlay shows it (live.h). If the
//   pen comes down during a commit, the chain stops waiting and gives the user's layer back.
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
