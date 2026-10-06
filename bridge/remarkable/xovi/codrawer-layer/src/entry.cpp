// entry.cpp: codrawer-layer, a XOVI extension inside xochitl: the entry point and the wiring.
//
// # What the extension is
//
// codrawer wants other participants' strokes (a phone, an agent) to appear natively on the
// reMarkable Paper Pro's open notebook page: on their own layer, saved in the page's `.rm`,
// undoable, synced, while the user keeps drawing with the real pen
// (docs/investigations/native-multiplayer-layer.md). This shared object is loaded into xochitl by
// XOVI's `xovi.so` (an `LD_PRELOAD`, started by boot/xovi.sh; docs/investigations/durable-install.md)
// and hooks no function: it finds xochitl's objects in the live item tree and calls their
// meta-methods by name on the GUI thread (qtmeta.h, scene.h).
//
// # The modules, in reading order (README.md has the map)
//
//   log, paths             one log line per fact; every path the extension touches
//   qtmeta, scene          meta-calls and signals without moc; finding the page and its layers
//   line_layout, line      xochitl's Line value, built from our points
//   ink                    the commit chain: our layer, addDrawingLine, the user's layer back
//   toolfollow             the visible pen handler: /run/codrawer/tool, the write-back guard
//   text                   text into the focused text box (replaceText, input method)
//   ink_protocol, inksock  the bridge's socket: agent ink, text, status, actions
//   selection, inject      the lasso follower; QML injected into xochitl (the dock), its actions
//   auto_rules, autostate, autoinput, grab, automation   UI automation and its guardrails
//   cmdline, commands, probes, watch                     the command file and the probes
//
// # Composition
//
// The modules' dependencies form no cycle (README.md, "Module map", draws the graph). Where a
// module must notify one that depends on it, it exposes a hook instead, set here before anything
// can fire it:
//
//   toolfollow's user gesture   → automation pauses for the user (autostate)
//   inksock's status line       → the injected UI refreshes
//   automation's clients change → the injected UI refreshes ("automation active")
//   selection settled           → the selection-menu injections are tried
//
// # Threading
//
// `_xovi_construct` runs while xochitl's process loads, before its QCoreApplication exists. It
// makes /tmp/codrawer-layer and starts the extension's own thread (`worker`), which waits for the
// application, then 3 s more, logs `ready (pid …)`, posts the GUI-thread start (tick hooks, tool
// following), starts the three socket threads (automation's two listeners, the ink socket), and
// becomes the command-file poller. Everything that touches Qt objects runs on the GUI thread.
//
// Build: build.sh (aarch64, Qt 6 headers). Install and use: README.md.

#include "automation.h"
#include "autostate.h"
#include "commands.h"
#include "inject.h"
#include "inksock.h"
#include "log.h"
#include "paths.h"
#include "selection.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>

#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace cdl {
namespace {

void wireHooks() {
    setUserGestureHook([] { pauseAutomationForUser(); });
    setBridgeStatusHook([] { refreshAllInjections(); });
    setAutoClientsChangedHook([] { refreshAllInjections(); });
    setSelectionSettledHook([] { createSelectionInjections(); });
}

void worker() {
    while (!QCoreApplication::instance()) usleep(200 * 1000);
    sleep(3);
    logLine(QStringLiteral("ready (pid %1), commands in %2").arg(getpid()).arg(QString::fromLatin1(kCmd)));
    wireHooks();
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] {
        addTickHook([] { selectionTick(); });
        addTickHook([] { injectTick(); });
        startToolFollow();
    }, Qt::QueuedConnection);
    std::thread(autoServer).detach();
    std::thread(autoTcpServer).detach();
    std::thread(inkServer).detach();
    pollCommandFile();
}

}  // namespace
}  // namespace cdl

// Exported explicitly: build.sh compiles with -fvisibility=hidden, and xovi finds the
// constructor by name in the dynamic symbol table (docs/investigations/native-erase.md §6: with
// it hidden, xovi loaded the extension and never called it).
extern "C" __attribute__((visibility("default"))) void _xovi_construct() {
    mkdir(cdl::kDir, 0700);
    std::thread(cdl::worker).detach();
}
