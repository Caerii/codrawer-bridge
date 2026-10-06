// commands.h: the command file, /tmp/codrawer-layer/cmd: the probes' control channel.
//
// A file of command lines (`verb key=value …`, cmdline.h's grammar) written to
// /tmp/codrawer-layer/cmd is read and removed by the extension's own thread, which polls for it
// every 250 ms, and its lines run in order on the GUI thread, because calling Qt Quick off the
// GUI thread crashes xochitl (inkling, smart_remarkable). Each line is logged as `> <line>`
// before and `< done <verb>` after. Every command is one short GUI-thread job (or starts a chain
// of them, `stroke`), well inside xochitl's 60 s watchdog.
//
// Commands that change the scene name the page they expect (`page=<uuid>`) and are refused
// unless the visible DocumentView and its controller are on that page (scene.h, findOpenPage).
//
//   probes.h    dump linetest pencolor layers stroke textprobe tree xform
//   watch.h     watch unwatch pending save dumpscene
//   inject.h    inject uninject
//   navigate.h  goto_doc doc=<uuid> [page=] [region=x0,y0,x1,y1] [flash=0], folder action=enter|up|home [id=]
//   tool        logs the line last written to /run/codrawer/tool
//
// Anything else logs `unknown command <verb>`.
#pragma once

#include <QtCore/QString>

namespace cdl {

// Runs the command lines in `text`. GUI thread.
void runCommands(const QString &text);

// The polling loop of the extension's own thread: never returns.
void pollCommandFile();

}  // namespace cdl
