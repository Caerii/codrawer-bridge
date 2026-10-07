// commands.cpp: see commands.h.
#include "commands.h"

#include "cmdline_qt.h"
#include "inject.h"
#include "layerprobe.h"
#include "log.h"
#include "navigate.h"
#include "paths.h"
#include "probes.h"
#include "toolfollow.h"
#include "watch.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QFile>

#include <unistd.h>

namespace cdl {

namespace {

// goto_doc doc=<uuid> [page=<uuid|index>] [region=x0,y0,x1,y1] [flash=0]: navigate.h, logged as
// `goto_doc: <reply>`.
void cmdGotoDoc(const QStringList &w) {
    gotoreq::Request g;
    g.doc = arg(w, "doc").toStdString();
    const QString page = arg(w, "page"), region = arg(w, "region");
    if (!gotoreq::isUuid(g.doc) || (!page.isEmpty() && !gotoreq::parsePage(page.toStdString(), g)) ||
        (!region.isEmpty() && !gotoreq::parseRegion(region.toStdString(), g.region))) {
        logLine(QStringLiteral("goto_doc: needs doc=<uuid> [page=<uuid|index>] [region=x0,y0,x1,y1] [flash=0]"));
        return;
    }
    g.hasRegion = !region.isEmpty();
    g.flash = g.hasRegion && arg(w, "flash") != QLatin1String("0");
    g.go = true;
    gotoDoc(g, [](const QString &r) { logLine(QStringLiteral("goto_doc: %1").arg(r)); });
}

// folder action=enter|up|home [id=<uuid>]
void cmdFolder(const QStringList &w) {
    folder(arg(w, "action"), arg(w, "id"), [](const QString &r) { logLine(QStringLiteral("folder: %1").arg(r)); });
}

}  // namespace

void runCommands(const QString &text) {
    for (const std::string &rawLine : cmdline::splitLines(text.toStdString())) {
        const std::string line = cmdline::trim(rawLine);
        const QStringList w = fromStdWords(cmdline::words(line));
        if (w.isEmpty()) continue;
        logLine(QStringLiteral("> %1").arg(QString::fromStdString(line)));
        const QString c = w.first();
        if (c == QLatin1String("dump")) cmdDump();
        else if (c == QLatin1String("linetest")) cmdLineTest();
        else if (c == QLatin1String("pencolor")) cmdPenColor(w);
        else if (c == QLatin1String("stroke")) cmdStroke(w);
        else if (c == QLatin1String("atomic")) cmdAtomic(w);
        else if (c == QLatin1String("layers")) cmdLayers(w);
        else if (c == QLatin1String("watch")) cmdWatch(w);
        else if (c == QLatin1String("unwatch")) cmdUnwatch();
        else if (c == QLatin1String("pending")) cmdPending(w);
        else if (c == QLatin1String("save")) cmdSave(w);
        else if (c == QLatin1String("dumpscene")) cmdDumpScene(w);
        else if (c == QLatin1String("tree")) cmdTree(w);
        else if (c == QLatin1String("textprobe")) cmdTextProbe(w);
        else if (c == QLatin1String("xform")) cmdXform(w);
        else if (c == QLatin1String("inject")) injectCommand(w);
        else if (c == QLatin1String("uninject")) uninjectCommand(w);
        else if (c == QLatin1String("goto_doc")) cmdGotoDoc(w);
        else if (c == QLatin1String("folder")) cmdFolder(w);
        else if (c == QLatin1String("tool")) logLine(QStringLiteral("tool: %1").arg(QString::fromLatin1(toolLine())));
        else logLine(QStringLiteral("unknown command %1").arg(c));
        logLine(QStringLiteral("< done %1").arg(c));
    }
}

void pollCommandFile() {
    for (;;) {
        usleep(250 * 1000);
        if (access(kCmd, F_OK) != 0) continue;
        QFile f(QString::fromLatin1(kCmd));
        if (!f.open(QIODevice::ReadOnly)) continue;
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        unlink(kCmd);
        QObject *app = QCoreApplication::instance();
        QMetaObject::invokeMethod(app, [text] { runCommands(text); }, Qt::QueuedConnection);
    }
}

}  // namespace cdl
