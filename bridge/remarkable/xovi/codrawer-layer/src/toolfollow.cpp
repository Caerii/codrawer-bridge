// toolfollow.cpp: see toolfollow.h.
#include "toolfollow.h"

#include "log.h"
#include "paths.h"
#include "qtmeta.h"
#include "scene.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QTimer>

#include <cstdio>
#include <sys/stat.h>
#include <utime.h>
#include <vector>

namespace cdl {

namespace {

struct ToolFollow {
    QPointer<QObject> pen;
    QPointer<QQuickItem> view;  // the DocumentView the handler belongs to
    QByteArray last;
    Relay *relay = nullptr;  // one per handler followed; deleted (disconnecting) on loss
    bool penDown = false;  // the write-back guard: between gestureStarted and gestureEnded
    qint64 penDownSince = 0;
};

ToolFollow &toolFollow() {
    static ToolFollow tf;
    return tf;
}

std::vector<std::function<void()>> &tickHooks() {
    static std::vector<std::function<void()>> h;
    return h;
}

std::function<void()> &userGestureHook() {
    static std::function<void()> h;
    return h;
}

std::vector<std::function<void(bool)>> &penListeners() {
    static std::vector<std::function<void(bool)>> l;
    return l;
}

// Line::Tool values (the `Line` gadget's enum on this build, logged by `dump`) as protocol words.
const char *toolWord(int tool) {
    switch (tool) {
    case 6: case 22: return "eraser";  // Eraser, MaskedEraser
    case 8: return "erase_area";       // EraseSection
    case 9: return "clear_page";       // ClearPage
    case 11: return "select";          // SelectionTool
    case 5: case 18: return "highlighter";
    case 23: return "shader";          // ShadingMarker
    case 10: return "zoom";            // ZoomTool
    default: return "pen";
    }
}

bool writeToolFile(const QByteArray &line) {
    mkdir(kRunDir, 0755);
    FILE *f = std::fopen(kToolTmp, "w");
    if (!f) return false;
    std::fwrite(line.constData(), 1, size_t(line.size()), f);
    std::fputc('\n', f);
    std::fclose(f);
    return std::rename(kToolTmp, kToolFile) == 0;
}

// Reads the two properties and writes the file if the line changed.
void toolChanged() {
    ToolFollow &tf = toolFollow();
    QByteArray line("none");
    if (tf.pen) {
        bool ok = false;
        const int tool = tf.pen->property("lineTool").toInt(&ok);
        const double thickness = tf.pen->property("lineThickness").toDouble();
        line = ok ? QByteArray(toolWord(tool)) + ' ' + QByteArray::number(thickness, 'g', 4) : QByteArray("unknown");
    }
    if (line == tf.last) return;
    logLine(QStringLiteral("tool: %1").arg(QString::fromLatin1(line)));
    writeToolFile(line);
    tf.last = line;
}

void forgetPen(const char *why) {
    ToolFollow &tf = toolFollow();
    if (tf.relay) {
        delete tf.relay;  // disconnects
        tf.relay = nullptr;
    }
    if (tf.pen || tf.view) logLine(QStringLiteral("tool: lost the pen handler (%1)").arg(QString::fromLatin1(why)));
    tf.pen = nullptr;
    tf.view = nullptr;
}

void followPen(QObject *pen, QQuickItem *view) {
    ToolFollow &tf = toolFollow();
    forgetPen("replaced");
    tf.pen = pen;
    tf.view = view;
    tf.relay = new Relay;
    int n = 0;
    for (const char *prop : {"lineTool", "lineThickness"}) {
        if (tf.relay->on(pen, Relay::notifyOf(pen, prop), [](void **) { toolChanged(); })) ++n;
    }
    tf.relay->on(pen, Relay::signalNamed(pen, "gestureStarted"), [](void **) {
        if (userGestureHook()) userGestureHook()();
        toolFollow().penDown = true;
        toolFollow().penDownSince = nowMs();
        for (auto &l : penListeners()) l(true);
    });
    tf.relay->on(pen, Relay::signalNamed(pen, "gestureEnded"), [](void **) {
        toolFollow().penDown = false;
        for (auto &l : penListeners()) l(false);
    });
    tf.relay->on(pen, Relay::signalNamed(pen, "destroyed"), [](void **) {
        QMetaObject::invokeMethod(QCoreApplication::instance(), [] { forgetPen("destroyed"); toolChanged(); }, Qt::QueuedConnection);
    });
    logLine(QStringLiteral("tool: following %1 (%2 notify signal(s))").arg(QString::fromLatin1(pen->metaObject()->className())).arg(n));
}

// The 2 s tick: rediscover if needed, the tool line, the heartbeat, then the hooks.
void toolTick() {
    ToolFollow &tf = toolFollow();
    if (tf.pen && (!tf.view || !tf.view->isVisible())) forgetPen("view hidden");
    if (!tf.pen) {
        const qint64 t0 = nowMs();
        for (const OpenPage &p : findDocumentViews()) {
            if (p.pen && p.view->isVisible()) {
                followPen(p.pen, p.view);
                logLine(QStringLiteral("tool: found in %1 ms").arg(nowMs() - t0));
                break;
            }
        }
    }
    toolChanged();
    if (utime(kToolFile, nullptr) != 0) writeToolFile(tf.last.isEmpty() ? QByteArray("none") : tf.last);
    for (auto &h : tickHooks()) h();
}

}  // namespace

void addTickHook(std::function<void()> fn) { tickHooks().push_back(std::move(fn)); }

void setUserGestureHook(std::function<void()> fn) { userGestureHook() = std::move(fn); }

void addPenListener(std::function<void(bool)> fn) { penListeners().push_back(std::move(fn)); }

void startToolFollow() {
    auto *t = new QTimer(QCoreApplication::instance());
    t->setInterval(kTickMs);
    QObject::connect(t, &QTimer::timeout, [] { toolTick(); });
    t->start();
    toolTick();
    logLine(QStringLiteral("tool: following the pen handler's lineTool into %1 (event-driven, %2 ms heartbeat)")
                .arg(QString::fromLatin1(kToolFile)).arg(kTickMs));
}

QQuickItem *followedView() { return toolFollow().view; }

QString visiblePageId() {
    ToolFollow &tf = toolFollow();
    return tf.view && tf.view->isVisible() ? tf.view->property("pageId").toString() : QString();
}

bool userTouching() {
    ToolFollow &tf = toolFollow();
    return tf.penDown && nowMs() - tf.penDownSince < 30000;
}

QByteArray toolLine() { return toolFollow().last; }

}  // namespace cdl
