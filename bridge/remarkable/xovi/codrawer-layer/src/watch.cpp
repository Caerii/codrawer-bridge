// watch.cpp: see watch.h. PROBE code.
#include "watch.h"

#include "cmdline_qt.h"
#include "line.h"
#include "log.h"
#include "qtmeta.h"
#include "scene.h"

#include <QtCore/QMetaMethod>
#include <QtCore/QMutex>
#include <QtCore/QPointer>
#include <QtCore/QRectF>

#include <algorithm>
#include <cstring>

namespace cdl {

namespace {

// ---------------------------------------------------------------------------------------------
// The logging receiver.

// One signal argument for the log. Only types we can format without side effects are read;
// everything else is named.
QString showArg(const QMetaType &t, void *p, bool full) {
    if (!p) return QStringLiteral("<null>");
    if (qstrcmp(t.name(), "Line") == 0) return describeLine(p, full);
    if (t.flags() & QMetaType::PointerToQObject) {
        QObject *o = *static_cast<QObject **>(p);
        return o ? QStringLiteral("%1(%2)").arg(QString::fromLatin1(o->metaObject()->className())).arg(quintptr(o), 0, 16)
                 : QStringLiteral("null");
    }
    if (t.flags() & QMetaType::IsEnumeration) {
        qint64 v = 0;
        std::memcpy(&v, p, std::min<qsizetype>(t.sizeOf(), 8));
        return QStringLiteral("%1(%2)").arg(QString::fromLatin1(t.name())).arg(v);
    }
    switch (t.id()) {
    case QMetaType::Bool: case QMetaType::Int: case QMetaType::UInt: case QMetaType::LongLong:
    case QMetaType::ULongLong: case QMetaType::Double: case QMetaType::Float: case QMetaType::QString:
    case QMetaType::QRectF: case QMetaType::QRect: case QMetaType::QPointF: case QMetaType::QSizeF:
        return show(QVariant(t, p));
    default:
        return QStringLiteral("<%1>").arg(QString::fromLatin1(t.name()));
    }
}

// Each hooked signal is one extra method of this object: QObject's own methods come first, then
// hook 0, 1, … (QMetaObject::connect by index, as QSignalSpy does; qtmeta.h's Relay is the same
// device for functions).
class Spy : public QObject {
public:
    struct Hook {
        QPointer<QObject> sender;
        int signalIndex = -1;
        QMetaMethod signal;
        QByteArray label;
        bool full = false;
        qint64 windowMs = 0;  // rate limit: at most kPerSecond lines per signal per second
        int inWindow = 0;
        int suppressed = 0;
    };
    static constexpr int kPerSecond = 20;

    bool hook(QObject *sender, const QMetaMethod &sig, const QByteArray &label, bool full = false) {
        QMutexLocker lock(&mutex_);
        const int slot = QObject::staticMetaObject.methodCount() + int(hooks_.size());
        Hook h;
        h.sender = sender;
        h.signalIndex = sig.methodIndex();
        h.signal = sig;
        h.label = label;
        h.full = full;
        hooks_.append(h);
        if (!QMetaObject::connect(sender, sig.methodIndex(), this, slot, Qt::DirectConnection)) {
            hooks_.removeLast();
            return false;
        }
        return true;
    }

    int unhookAll() {
        QMutexLocker lock(&mutex_);
        const int base = QObject::staticMetaObject.methodCount();
        int n = 0;
        for (int i = 0; i < hooks_.size(); ++i) {
            if (hooks_[i].sender && QMetaObject::disconnect(hooks_[i].sender, hooks_[i].signalIndex, this, base + i)) ++n;
        }
        hooks_.clear();
        return n;
    }

    int count() {
        QMutexLocker lock(&mutex_);
        return int(hooks_.size());
    }

    int qt_metacall(QMetaObject::Call call, int id, void **a) override {
        id = QObject::qt_metacall(call, id, a);
        if (id < 0 || call != QMetaObject::InvokeMetaMethod) return id;
        fire(id, a);
        return -1;
    }

private:
    void fire(int id, void **a) {
        QString text;
        {
            QMutexLocker lock(&mutex_);
            if (id >= hooks_.size()) return;
            Hook &h = hooks_[id];
            const qint64 now = nowMs();
            if (now - h.windowMs >= 1000) {
                if (h.suppressed) text = QStringLiteral("(%1 more %2 in the last second) ").arg(h.suppressed).arg(QString::fromLatin1(h.signal.name()));
                h.windowMs = now;
                h.inWindow = 0;
                h.suppressed = 0;
            }
            if (++h.inWindow > kPerSecond) {
                ++h.suppressed;
                return;
            }
            QStringList args;
            for (int i = 0; i < h.signal.parameterCount(); ++i) {
                args << QStringLiteral("%1=%2").arg(QString::fromLatin1(h.signal.parameterNames().value(i)),
                                                     showArg(h.signal.parameterMetaType(i), a[i + 1], h.full));
            }
            text += QStringLiteral("signal %1.%2(%3)").arg(QString::fromLatin1(h.label), QString::fromLatin1(h.signal.name()), args.join(QStringLiteral(", ")));
        }
        logLine(text);
    }

    QMutex mutex_;
    QList<Hook> hooks_;
};

// Created on first use by a command, so on the GUI thread; lives as long as xochitl.
Spy *spy() {
    static Spy *s = new Spy;
    return s;
}

// Hooks every signal `o`'s own classes declare (stopping at Qt's base classes), except `skip`.
int hookAllSignals(QObject *o, const char *label, std::initializer_list<const char *> skip = {}) {
    if (!o) return 0;
    int n = 0;
    for (const QMetaObject *m = o->metaObject(); m; m = m->superClass()) {
        const QByteArray cls = m->className();
        if (cls == "QObject" || cls == "QQuickItem" || cls == "QQuickPaintedItem") break;
        for (int i = m->methodOffset(); i < m->methodCount(); ++i) {
            const QMetaMethod mm = m->method(i);
            if (mm.methodType() != QMetaMethod::Signal) continue;
            bool skipped = false;
            for (const char *s : skip) skipped = skipped || mm.name() == s;
            if (skipped) {
                logLine(QStringLiteral("   skip %1.%2 (noisy)").arg(QString::fromLatin1(label), QString::fromLatin1(mm.methodSignature())));
                continue;
            }
            if (spy()->hook(o, mm, label)) {
                ++n;
                logLine(QStringLiteral("   hook %1.%2").arg(QString::fromLatin1(label), QString::fromLatin1(mm.methodSignature())));
            }
        }
    }
    return n;
}

int hookSignal(QObject *o, const char *label, const char *name, bool full = false) {
    if (!o) return 0;
    const QMetaObject *mo = o->metaObject();
    for (int i = 0; i < mo->methodCount(); ++i) {
        const QMetaMethod mm = mo->method(i);
        if (mm.methodType() == QMetaMethod::Signal && mm.name() == name && spy()->hook(o, mm, label, full)) {
            logLine(QStringLiteral("   hook %1.%2").arg(QString::fromLatin1(label), QString::fromLatin1(mm.methodSignature())));
            return 1;
        }
    }
    logLine(QStringLiteral("   %1 has no signal %2").arg(QString::fromLatin1(label), QString::fromLatin1(name)));
    return 0;
}

// ---------------------------------------------------------------------------------------------
// The document's objects.

// The open page's DocumentWorker (SceneController.worker), document wrapper and lock manager.
struct DocObjects {
    QObject *worker = nullptr;
    QObject *wrapper = nullptr;
    QObject *locks = nullptr;
};

DocObjects docObjects(const OpenPage &p) {
    DocObjects d;
    if (p.controller && p.controller->metaObject()->indexOfProperty("worker") >= 0) {
        d.worker = p.controller->property("worker").value<QObject *>();
    }
    if (p.view->metaObject()->indexOfProperty("document") >= 0) {
        d.wrapper = p.view->property("document").value<QObject *>();
        if (d.wrapper && qstrcmp(d.wrapper->metaObject()->className(), "QmlDocumentWrapper") != 0) d.wrapper = nullptr;
    }
    if (!d.wrapper) {
        const auto ws = findObjectsOfClass("QmlDocumentWrapper");
        if (ws.size() == 1) d.wrapper = ws.first();
        else logLine(QStringLiteral("   %1 QmlDocumentWrapper object(s); not choosing").arg(ws.size()));
    }
    const auto ls = findObjectsOfClass("DocumentLockManager");
    for (QObject *l : ls) {
        // the lock manager of this document: its `document` is our wrapper
        if (l->metaObject()->indexOfProperty("document") >= 0 && l->property("document").value<QObject *>() == d.wrapper) d.locks = l;
    }
    if (!d.locks && ls.size() == 1) d.locks = ls.first();
    return d;
}

void logDocState(const OpenPage &p, const DocObjects &d, const char *when) {
    logLine(QStringLiteral("state %1: worker=%2 wrapper=%3 locks=%4").arg(QString::fromLatin1(when))
                .arg(d.worker ? QString::fromLatin1(d.worker->metaObject()->className()) : QStringLiteral("none"))
                .arg(d.wrapper ? QString::fromLatin1(d.wrapper->metaObject()->className()) : QStringLiteral("none"))
                .arg(d.locks ? QString::fromLatin1(d.locks->metaObject()->className()) : QStringLiteral("none")));
    dumpValues(p.controller, "controller", {"undoAvailable", "working", "updating", "pendingEdit"});
    dumpValues(d.worker, "worker", {"hasPending", "hasPendingChanges", "jobQueueSize", "pageCount"});
    dumpValues(d.wrapper, "document", {"hasPendingStoreLines", "hasContentsOnAnyPage", "pageCount"});
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// The commands.

void cmdWatch(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    if (spy()->count()) {
        logLine(QStringLiteral("watch: already watching %1 signals; unwatch first").arg(spy()->count()));
        return;
    }
    const bool full = arg(w, "full") == QLatin1String("1");
    const DocObjects d = docObjects(p);
    int n = 0;
    n += hookSignal(p.pen, "pen", "strokeCompleted", full);
    n += hookSignal(p.pen, "pen", "gestureStarted");
    n += hookSignal(p.pen, "pen", "gestureEnded");
    n += hookAllSignals(p.controller, "scene");
    // tileReady carries a QImage per rendered tile: frequent, and says nothing about content
    n += hookAllSignals(d.worker, "worker", {"tileReady"});
    n += hookAllSignals(d.wrapper, "document");
    n += hookAllSignals(d.locks, "locks");
    logDocState(p, d, "at watch");
    logLine(QStringLiteral("watch: %1 signals hooked on page %2").arg(n).arg(p.pageId));
}

void cmdUnwatch() {
    logLine(QStringLiteral("unwatch: %1 signals disconnected").arg(spy()->unhookAll()));
}

void cmdPending(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    logDocState(p, docObjects(p), "now");
}

// save page=<uuid> via=<route>: ask xochitl to store the page's pending lines now. Each route is
// a meta-method of xochitl's own document objects (names from the 6.0.105 binary's meta-strings,
// native-erase.md); which of them stores lines, and at what cost, is what this measures (not yet
// run on the device, native-erase.md §6). With `watch` on, the worker's
// `linesStored(page, pageId, size)` marks success.
//   deferred     DocumentWorker::startDeferredRequestTimers()
//   modified     DocumentWorker::onModifiedPageId(<the page's id>)
//   abouttosleep emit DocumentWorker::aboutToSleep()   (what the worker hears before a suspend)
//   sleepcycle   DocumentLockManager::setSleepState(true) then (false)   (last resort)
void cmdSave(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    const DocObjects d = docObjects(p);
    const QString via = arg(w, "via");
    logDocState(p, d, "before save");
    const qint64 t0 = nowMs();
    bool ok = false;
    if (via == QLatin1String("deferred") && d.worker) {
        ok = invoke(d.worker, "startDeferredRequestTimers", {});
    } else if (via == QLatin1String("modified") && d.worker) {
        ok = invoke(d.worker, "onModifiedPageId", {p.pageId});
    } else if (via == QLatin1String("abouttosleep") && d.worker) {
        ok = invoke(d.worker, "aboutToSleep", {});  // invoking a signal by index emits it
    } else if (via == QLatin1String("sleepcycle") && d.locks) {
        ok = invoke(d.locks, "setSleepState", {true}) && invoke(d.locks, "setSleepState", {false});
    } else {
        logLine(QStringLiteral("save: via must be deferred|modified|abouttosleep|sleepcycle and its object must exist (got \"%1\")").arg(via));
        return;
    }
    logLine(QStringLiteral("save: via %1 invoked=%2 in %3 ms (watch for worker.linesStored)").arg(via).arg(ok).arg(nowMs() - t0));
    logDocState(p, d, "after save");
}

// dumpscene page=<uuid>: SceneController::dumpScene(), a debug slot in xochitl. Where its output
// goes (journal, stderr) is unknown; read-only by its name. Only on request.
void cmdDumpScene(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    const qint64 t0 = nowMs();
    const bool ok = invoke(p.controller, "dumpScene", {});
    logLine(QStringLiteral("dumpscene: invoked=%1 in %2 ms (see journalctl -u xochitl)").arg(ok).arg(nowMs() - t0));
}

}  // namespace cdl
