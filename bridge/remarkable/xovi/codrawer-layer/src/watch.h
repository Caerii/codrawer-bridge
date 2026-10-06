// watch.h: PROBE. The erase probe: watching strokes, erasures and saves without hooking anything.
//
// # The problem (docs/investigations/native-erase.md)
//
// The page's true state reaches codrawer only when xochitl saves the `.rm` (seconds to a minute
// after the user pauses), so an erase shows late everywhere but on the tablet. xochitl's QML
// commits an erase in `DocumentView.onStrokeCompleted`: when the pen lifts, a stroke whose
// `isEraserTool` is true goes to `SceneController::eraseWithLine(Line)` (the scene job splits the
// lines it covers), and the Line carries the eraser's exact path and thickness. Saves are
// xochitl's own `StoreLines` jobs on the `DocumentWorker`, which reports them with
// `linesStored(page, pageId, size)`.
//
// # The commands (all read-only except `save`, which asks xochitl to save)
//
//   watch page=<uuid> [full=1]   connects a logging receiver (Spy) to the pen handler's
//                                `strokeCompleted(Line)` (decoded by line.h's describeLine; eraser
//                                paths, or every path with full=1, written to a file),
//                                `gestureStarted/Ended`, and every signal of the page's
//                                SceneController, its DocumentWorker (except the noisy
//                                `tileReady`), the QmlDocumentWrapper and the DocumentLockManager.
//   unwatch                      disconnects everything `watch` connected.
//   pending page=<uuid>          logs the document's pending-store state.
//   save page=<uuid> via=<r>     asks xochitl to store pending lines now, through one of its own
//                                meta-methods (cmdSave lists them), and logs the state before and
//                                after; with `watch` on, `worker.linesStored` shows whether it worked.
//   dumpscene page=<uuid>        SceneController::dumpScene(), xochitl's debug slot.
//
// Results on the device: native-erase.md §6 (154 signals hooked, xochitl stayed up; both erasers
// reach `strokeCompleted` with their path).
//
// # Threading
//
// Commands run on the GUI thread. The Spy's `qt_metacall` runs in whichever thread emitted the
// signal (DocumentWorker signals come from its thread), so its hook table is guarded by a mutex
// and the formatting reads only the signal's arguments. It is rate-limited to 20 lines per signal
// per second; the overflow is counted and reported in the next window.
#pragma once

#include <QtCore/QStringList>

namespace cdl {

void cmdWatch(const QStringList &w);
void cmdUnwatch();
void cmdPending(const QStringList &w);
void cmdSave(const QStringList &w);
void cmdDumpScene(const QStringList &w);

}  // namespace cdl
