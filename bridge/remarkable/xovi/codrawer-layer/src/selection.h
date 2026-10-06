// selection.h: what the user last lasso-selected on the visible page.
//
// # The problem
//
// "Ask about selection" (the dock, the selection menu) needs to say which ink the user circled.
// SceneController has no meta-call that returns the selected lines' ids (`cloneSelectedItems`
// returns opaque `std::shared_ptr<SceneItem>`s), but it signals `areaSelected(int, QRectF)` when a
// lasso selection settles and `selectionCleared()` when it goes, and `selectionItemCount`,
// `selectionContainsStroke` and `selectionContainsImage` describe it (meta-object dump,
// 3.29.0.149; guibor's object map, docs/investigations/smart-remarkable-integration.md). The
// extension remembers the last rect and sends it with an `ask_selection` action; the bridge
// resolves the line ids from its page snapshot (strokes whose points fall in the rect), the same
// ink the user circled once xochitl has saved it.
//
// The rect is as signalled. On the device it read `QRectF(-480.8,2982.8 209.9x331.9)` on a
// scrolled page (README, "Measured on the device"), i.e. page coordinates; `view_bbox` adds it
// mapped through the tile manager's `sceneToViewTransform`.
//
// # Threading
//
// GUI thread: the tick (selectionTick, from toolfollow's 2 s timer) connects to the followed
// view's controller whenever it changes; the signal handlers run on the GUI thread. 300 ms after
// `areaSelected` (the selection settles in the scene's own job) the selection is read and the
// settled hook runs; it runs again at 900 ms.
#pragma once

#include <QtCore/QRectF>
#include <QtCore/QString>

#include <functional>

namespace cdl {

struct Selection {
    bool containsStroke = false, containsImage = false;  // the controller's own, read 300 ms after
    QRectF viewRect;  // `rect` through the tile manager's sceneToViewTransform (view px)
    QString page;     // the page uuid it was made on
    int arg = -1;     // areaSelected's int (logged: which it is, layer or mode, is not yet known)
    QRectF rect;      // as signalled (page coordinates, see above)
    int count = 0;    // selectionItemCount
    qint64 atMs = 0;  // when areaSelected came (nowMs); 0 = never
};

// The last selection made in this run (cleared only by the next one).
const Selection &lastSelection();

// The tick's part: follow the followed view's SceneController (connect to `areaSelected` and
// `selectionCleared` when it changes).
void selectionTick();

// Sets the function called on the GUI thread 300 ms and 900 ms after each `areaSelected`
// (entry.cpp: make the injections that wait for the selection menu).
void setSelectionSettledHook(std::function<void()> fn);

}  // namespace cdl
