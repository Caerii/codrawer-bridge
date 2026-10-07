// toolfollow.h: following the visible page's pen handler: the tool file, the visible page, and
// the write-back guard.
//
// # The problem
//
// The bridge sees the pen only through evdev, which tells the Marker's eraser *end* apart
// (BTN_TOOL_RUBBER, sent as brush `eraser`) but not the toolbar. With the toolbar's Eraser
// selected, the tip erases in xochitl while the bridge streamed it as ink. The tool the tip
// draws with is the pen handler's `lineTool` (PenInputLineHandler, notify `lineToolChanged`):
// `Eraser` while the toolbar eraser is selected, and `lineThickness` is then the eraser's
// thickness, its size squared (sizes 1/2/3 give 1/4/9; DocumentView QML, native-erase.md §1).
// The erase probe on the device (3.29.0.149, 2026-10-06, native-erase.md §6) saw
// `strokeCompleted` with tool=6 eraser=1 thickness=4 for the toolbar eraser used with the tip,
// and thickness=5.76 for the eraser end.
//
// # How
//
// Event-driven since 2026-10-06 (the first version polled every 100 ms; README "Measured on the
// device" has the idle cost). The extension connects to the notify signals of the visible pen
// handler's `lineTool` and `lineThickness` and writes one line, `<tool> <thickness>`, to
// /run/codrawer/tool by rename, only when it changes. One 2 s GUI-thread timer (the tick) does
// the rest:
//
//   - discovery: only while no handler is known (none yet, or the old one was destroyed or its
//     DocumentView hidden by another document) is the item tree walked (scene.h: a walk costs
//     tens of milliseconds of GUI time);
//   - the heartbeat: `utime()` on the file, so its mtime stays inside the bridge's 3 s freshness
//     window (toolhint, Go and Rust: both re-read the file when its mtime changes, and a stale or
//     missing file means "unknown", so a stock or hung xochitl leaves the bridge as before);
//   - the tick hooks, in the order they were added (entry.cpp adds the selection follower and
//     the injections).
//
// The tool word is one of `eraser` (Eraser, MaskedEraser), `erase_area` (EraseSection),
// `clear_page`, `select`, `highlighter`, `shader`, `zoom` or `pen`; `none` when no document is
// open, `unknown` when `lineTool` does not read as a number. /run is tmpfs: nothing survives a
// reboot.
//
// The same handler gives two more things other modules rest on:
//
//   - the followed view: the DocumentView whose pen handler is followed, the extension's notion
//     of "the visible page" for text, the selection, the dock's actions and automation;
//   - the write-back guard: the pen handler's `gestureStarted` … `gestureEnded` brackets the
//     user's pen or finger on the page. Agent ink and text wait while it is set
//     (ink.h, text.h), so nothing is committed under the user's hand. `gestureStarted` also
//     calls the user-gesture hook (entry.cpp: automation pauses for the user).
//
// # Threading
//
// GUI thread only: the timer, the signal handlers, and every function below.
#pragma once

#include <QtCore/QByteArray>
#include <QtCore/QString>
#include <QtQuick/QQuickItem>

#include <functional>

namespace cdl {

// Starts the tick (every kTickMs) and runs it once; logs `tool: following the pen handler's
// lineTool into /run/codrawer/tool (event-driven, 2000 ms heartbeat)`. Call once, on the GUI
// thread, after the hooks are in place; runs for the life of xochitl.
void startToolFollow();

constexpr int kTickMs = 2000;

// Adds `fn` to the work the 2 s tick does after its own (in the order added).
void addTickHook(std::function<void()> fn);

// Sets the function called on the GUI thread at every `gestureStarted` of the followed pen
// handler, before the write-back guard is set.
void setUserGestureHook(std::function<void()> fn);

// Adds `fn`, called on the GUI thread with true at every `gestureStarted` and false at every
// `gestureEnded` of the followed pen handler (live.h pauses its overlay).
void addPenListener(std::function<void(bool down)> fn);

// The DocumentView whose pen handler is followed, or null. It may be hidden; callers check
// `isVisible()` (as every caller does).
QQuickItem *followedView();

// The followed view's `pageId` if it is visible, else an empty string.
QString visiblePageId();

// Whether the user's pen or finger is on the page now: a `gestureStarted` without its
// `gestureEnded`. One older than 30 s (a lost end signal) stops counting, so a missed end
// cannot block agent ink for good.
bool userTouching();

// Milliseconds since the user's pen or finger last left the page (very large before the first
// time). ink.h commits only in a pen-up gap of at least 800 ms.
qint64 msSincePenUp();

// The last line written to /run/codrawer/tool (`pen 2`, `eraser 4`, `none`, …); empty before the
// first tick.
QByteArray toolLine();

}  // namespace cdl
