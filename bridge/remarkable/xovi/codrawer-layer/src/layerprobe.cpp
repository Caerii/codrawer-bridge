// layerprobe.cpp: see layerprobe.h. PROBE code.
#include "layerprobe.h"

#include "cmdline_qt.h"
#include "ink.h"
#include "line.h"
#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QTimer>

#include <algorithm>
#include <cmath>

namespace cdl {

namespace {

constexpr int kQuietMs = 800;    // the pen gap ink.cpp waits for (kPenGapMs), required here too
constexpr int kWatchMs = 2000;   // how long currentLayer's changes are logged after the job
constexpr quint32 kArgb = 0xffd02020u;  // the probe line's colour, for the page dump

// The probe line: stroke's wave (probes.cpp) 150 page units lower, 120 points, fineliner size 2.
QList<RmPoint> probeLine() {
    QList<RmPoint> pts;
    constexpr int n = 120;
    for (int i = 0; i < n; ++i) {
        const double t = double(i) / (n - 1);
        const double dy = 45.0 * 3 * 2 * M_PI * std::cos(t * 3 * 2 * M_PI);
        const double taper = std::min(1.0, std::min(t, 1.0 - t) * 10.0);
        RmPoint p;
        p.x = float(-560.0 + 420.0 * t);
        p.y = float(480.0 + 45.0 * std::sin(t * 3 * 2 * M_PI));
        p.speed = quint16(12);
        p.width = quint16(16);
        p.direction = linelayout::directionByte(std::atan2(dy, 420.0));
        p.pressure = quint8(60 + std::lround(160 * taper));
        pts << p;
    }
    return pts;
}

int current(QObject *c) { return c ? c->property("currentLayer").toInt() : -1; }

}  // namespace

void cmdAtomic(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;  // logs why
    QObject *c = p.controller;
    const int test = findLayer(c, kTestLayer());
    const int user = current(c);
    if (test < 0) {
        logLine(QStringLiteral("atomic: refused: no \"%1\" layer on this page (make it with `stroke page=%2`)")
                    .arg(kTestLayer(), p.pageId));
        return;
    }
    if (user == test || layerNameAt(c, user).startsWith(QLatin1String("codrawer:"))) {
        logLine(QStringLiteral("atomic: refused: the selected layer %1 \"%2\" is ours (a commit in flight?)")
                    .arg(user).arg(layerNameAt(c, user)));
        return;
    }
    if (userTouching() || msSincePenUp() < kQuietMs) {
        logLine(QStringLiteral("atomic: refused: the pen or a finger is on the page, or was %1 ms ago").arg(msSincePenUp()));
        return;
    }
    QVariant line;
    if (!buildLine(/*Finelinerv2*/ 17, kArgb, 2.0, probeLine(), line, false)) {
        logLine(QStringLiteral("atomic: refused: the Line did not build"));
        return;
    }
    logLayers(c, "before atomic");
    const QVariant boundsBefore = c->property("itemsBoundingRect");

    // Watch every change of currentLayer from here on (the notify signal), with its time.
    auto *relay = new Relay;
    const qint64 t0 = nowMs();
    QPointer<QObject> cp(c);
    const bool watching = relay->on(c, Relay::notifyOf(c, "currentLayer"), [cp, t0](void **) {
        logLine(QStringLiteral("atomic: +%1 ms currentLayer changed to %2").arg(nowMs() - t0).arg(current(cp)));
    });
    if (!watching) logLine(QStringLiteral("atomic: currentLayer has no notify signal; readings only"));

    // The one GUI job: no event-loop turn between these calls, so no user stroke can complete
    // between them.
    const bool a = invoke(c, "setCurrentLayer", {test});
    const int r1 = current(c);
    const bool b = invoke(c, "addDrawingLine", {line});
    const int r2 = current(c);
    const bool d = p.tiles && invoke(p.tiles, "renderLineToTiles", {line});
    const bool e = invoke(c, "setCurrentLayer", {user});
    const int r3 = current(c);
    logLine(QStringLiteral("atomic: in one job: setCurrentLayer(%1) %2 -> currentLayer %3; addDrawingLine %4 -> %5; "
                           "renderLineToTiles %6; setCurrentLayer(%7) %8 -> %9")
                .arg(test).arg(a ? "ok" : "FAILED").arg(r1).arg(b ? "ok" : "FAILED").arg(r2)
                .arg(d ? "ok" : "no").arg(user).arg(e ? "ok" : "FAILED").arg(r3));

    QTimer::singleShot(0, QCoreApplication::instance(), [cp, t0] {
        logLine(QStringLiteral("atomic: +%1 ms (next event-loop turn) currentLayer %2").arg(nowMs() - t0).arg(current(cp)));
    });
    QTimer::singleShot(kWatchMs, QCoreApplication::instance(), [cp, relay, t0, test, user, r1, r3, boundsBefore] {
        delete relay;
        if (!cp) {
            logLine(QStringLiteral("atomic: the page closed before the readings were done"));
            return;
        }
        const int fin = current(cp);
        logLine(QStringLiteral("atomic: +%1 ms currentLayer %2; itemsBoundingRect %3 -> %4")
                    .arg(nowMs() - t0).arg(fin).arg(show(boundsBefore), show(cp->property("itemsBoundingRect"))));
        logLayers(cp, "after atomic");
        logLine(QStringLiteral("atomic: reported: user's layer %1 %2 at the end; setCurrentLayer(%3) %4 within the job "
                               "(read %5, then %6 after the restore). Where the line landed: save, then -page-dump "
                               "(red ff d0 20 20, y 435-525)")
                    .arg(user).arg(fin == user ? "selected" : "NOT selected").arg(test)
                    .arg(r1 == test ? "took effect at once" : "did not show").arg(r1).arg(r3));
        if (fin != user) {
            // never leave the user on our layer
            invoke(cp, "setCurrentLayer", {user});
            logLine(QStringLiteral("atomic: selected the user's layer %1 again").arg(user));
        }
    });
}

}  // namespace cdl
