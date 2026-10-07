// layerprobe.h: PROBE. Can a line be added to our layer without moving the user off theirs?
//
// # The question
//
// Agent ink lands on "codrawer: agent" through ink.h's commit chain: select our layer, wait until
// xochitl reports it selected, add the lines, then select the user's layer again. While our layer
// is selected the user's next stroke would land on it (xochitl picks a stroke's layer at pen-up:
// `onStrokeCompleted: controller.addDrawingLine(stroke)` in the extracted QML, 00f9bf52 line 791),
// so the chain waits for an 800 ms pen gap and gives the layer back at the next pen-down
// (ink.cpp, kPenGapMs). There is no Line API with a layer argument on 3.29.0.149 (only SceneItems
// have layer-indexed slots: cloneAddAndSelectItems(int, …), moveSelectedItems(int, …)),
// docs/investigations/native-multiplayer-layer.md.
//
// The chain polls `currentLayer` after setCurrentLayer instead of assuming the change is
// immediate, and xochitl's scene work runs as queued jobs (its DocumentWorker). If both
// `setCurrentLayer` and `addDrawingLine` only queue work that the scene runs later, in call order,
// then calling setCurrentLayer(ours), addDrawingLine(line), setCurrentLayer(user) in one GUI-thread
// job (no event-loop turn between them, so no user stroke can complete in between) would put the
// line on our layer and leave the user's layer selected: an atomic commit, with no window at all.
// If instead addDrawingLine uses whichever layer is current when it runs, the line lands on the
// user's layer. This probe tells the two apart, on "codrawer: test" only.
//
// # The command
//
//   atomic page=<uuid>   refused unless the page is open, "codrawer: test" exists on it (make it
//                        with `stroke page=…`), it is not the selected layer, and the pen and
//                        fingers have been off the page for 800 ms. In one GUI job it calls
//                        setCurrentLayer(test), addDrawingLine(probe line), renderLineToTiles,
//                        setCurrentLayer(user), logging `currentLayer` right after each call; it
//                        then logs every change of `currentLayer` (its notify signal) for 2 s, the
//                        value after the first event-loop turn and at 2 s, and the layer list.
//
// The probe line is a wave (x −560…−140, y 435…525 page units: below `stroke`'s), red
// (ff d0 20 20), so a page dump finds it by colour. Which layer it landed on is decided after
// `save page=… via=…`, from the saved .rm file (`codrawer-bridge -page-dump`): the log only shows
// what xochitl reported. The verdict line is `atomic: reported …` with the readings.
//
// # Threading
//
// GUI thread (commands.cpp posts each command line there).
#pragma once

#include <QtCore/QStringList>

namespace cdl {

void cmdAtomic(const QStringList &w);

}  // namespace cdl
