// probes.h: PROBES. The read-mostly debug commands of the command file, kept for the next OS.
//
// These are the experiments that established what the rest of the extension rests on
// (docs/investigations/native-multiplayer-layer.md, "Probe 0 / Probe 1"; keyboard-and-text.md;
// ui-automation.md). They stay because the next xochitl build will need them again: a changed
// layout, a renamed slot or a moved toolbar shows up here first. None runs unless written to
// /tmp/codrawer-layer/cmd (commands.h).
//
//   dump                         Probe 0: meta-objects of SceneController, the pen handler, tile
//                                manager, viewport, the pen-input pipeline (route 1's dead end,
//                                line.h), the Line gadget and Scene::LayerState; the layer list.
//   linetest                     builds a Line with the probe wave and reads it back; touches no
//                                scene.
//   pencolor page= argb=<hex>    writes penHandler.lineArgbCode, reads it back, and restores the
//                                previous value in the same job.
//   layers page=                 the page's layers and undo state.
//   stroke page= [argb=<hex>] [adopt=<n>] [restore=<n>]
//                                Probe 1: the hard-coded wave (120 points, fineliner) committed on
//                                "codrawer: test" through ink.h, verbose.
//   textprobe page=              the text API's state and the controller's text and image
//                                signatures (route A's ground truth, text.h).
//   tree [match=<sel>] [depth=n] the live item tree (scene.h logTree; depth 6, or 4 with match).
//   xform page=                  every view↔scene transform xochitl exposes for the page.
//
// The erase probe (watch, unwatch, pending, save, dumpscene) is watch.h.
//
// # Threading
//
// GUI thread (commands.cpp posts each command line there).
#pragma once

#include <QtCore/QStringList>

namespace cdl {

void cmdDump();
void cmdLineTest();
void cmdPenColor(const QStringList &w);
void cmdLayers(const QStringList &w);
void cmdStroke(const QStringList &w);
void cmdTextProbe(const QStringList &w);
void cmdTree(const QStringList &w);
void cmdXform(const QStringList &w);

}  // namespace cdl
