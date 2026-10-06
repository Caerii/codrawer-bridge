// autoinput.cpp: see autoinput.h.
#include "autoinput.h"

#include "auto_rules.h"
#include "autostate.h"
#include "grab.h"
#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "text.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QTimer>
#include <QtGui/QGuiApplication>
#include <QtGui/QMouseEvent>
#include <QtQuick/QQuickItem>
#include <QtQuick/QQuickWindow>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

namespace cdl {

namespace {

QQuickWindow *mainWindow() {
    for (QWindow *w : QGuiApplication::allWindows()) {
        if (auto *qw = qobject_cast<QQuickWindow *>(w); qw && qw->isVisible()) return qw;
    }
    return nullptr;
}

// The deepest visible, enabled item under a scene point (topmost child first at each level) and
// its ancestry's names (objectName and class, from the window's content item down), for the deny
// list.
std::vector<std::string> namesAt(QQuickWindow *w, const QPointF &p) {
    std::vector<std::string> names;
    QQuickItem *it = w->contentItem();
    for (int depth = 0; it && depth < 200; ++depth) {
        names.push_back(it->objectName().toStdString());
        names.push_back(it->metaObject()->className());
        const QPointF local = it->mapFromScene(p);
        QQuickItem *next = nullptr;
        const auto kids = it->childItems();
        for (auto k = kids.rbegin(); k != kids.rend(); ++k) {  // topmost first
            QQuickItem *c = *k;
            if (!c->isVisible() || !c->isEnabled()) continue;
            if (c->contains(c->mapFromItem(it, local))) {
                next = c;
                break;
            }
        }
        it = next;
    }
    return names;
}

// Why a synthesized press at p must not happen, or "".
QString inputRefusal(QQuickWindow *w, const QPointF &p) {
    if (lockScreenUp()) return QStringLiteral("locked");
    const std::vector<std::string> names = namesAt(w, p);
    const std::string d = autorules::denied(names);
    if (!d.empty()) return QStringLiteral("blocked: destructive or security UI (%1)").arg(QString::fromStdString(d));
    QQuickItem *view = followedView();
    if (view && view->isVisible() && !autorules::editAllowed(visibleDocTitle().toStdString())) {
        bool nav = false;
        for (const std::string &n : names) nav = nav || n == "close-documentview-button" || n.find("pageOverview") != std::string::npos;
        if (!nav) return QStringLiteral("blocked: edits only in the notebook \"codrawer: test\" (open: \"%1\")").arg(visibleDocTitle());
    }
    return QString();
}

void sendMouse(QQuickWindow *w, QEvent::Type type, const QPointF &p) {
    const Qt::MouseButtons buttons = type == QEvent::MouseButtonRelease ? Qt::NoButton : Qt::LeftButton;
    QMouseEvent ev(type, p, p, w->mapToGlobal(p), Qt::LeftButton, buttons, Qt::NoModifier);
    synthesizing() = true;
    QCoreApplication::sendEvent(w, &ev);
    synthesizing() = false;
}

// A press at `from`, moves to `to` over `ms` (16 ms steps), and a release: tap, long press, swipe.
void autoGesture(QPointF from, QPointF to, int ms, std::function<void(QJsonObject)> answer) {
    QQuickWindow *w = mainWindow();
    if (!w) return answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("no window")}});
    const QString why = inputRefusal(w, from);
    if (!why.isEmpty()) {
        logLine(QStringLiteral("auto: refused input at %1,%2: %3").arg(from.x()).arg(from.y()).arg(why));
        return answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), why}});
    }
    QPointer<QQuickWindow> pw(w);
    sendMouse(w, QEvent::MouseButtonPress, from);
    const int steps = std::max(1, ms / 16);
    auto *t = new QTimer(QCoreApplication::instance());
    auto step = std::make_shared<int>(0);
    t->setInterval(16);
    QObject::connect(t, &QTimer::timeout, [t, step, steps, from, to, pw, answer] {
        if (!pw) {
            t->stop();
            t->deleteLater();
            answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("window gone")}});
            return;
        }
        if (autoPaused()) {  // the user took over mid-gesture: let go where we are
            t->stop();
            t->deleteLater();
            const double f = double(*step) / steps;
            sendMouse(pw, QEvent::MouseButtonRelease, from + (to - from) * f);
            answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("paused by the user")}});
            return;
        }
        ++*step;
        const QPointF p = from + (to - from) * (double(*step) / steps);
        if (*step < steps) {
            if (from != to) sendMouse(pw, QEvent::MouseMove, p);
            return;
        }
        t->stop();
        t->deleteLater();
        sendMouse(pw, QEvent::MouseButtonRelease, to);
        answer(QJsonObject{{QStringLiteral("ok"), true}});
    });
    t->start();
}

QPointF centerOf(QQuickItem *it) { return it->mapToScene(QPointF(it->width() / 2, it->height() / 2)); }

}  // namespace

bool autoInputRequest(const QString &cmd, const QJsonObject &req, std::function<void(QJsonObject)> answer) {
    auto fail = [answer](const QString &why) { answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), why}}); };
    auto pt = [&req](const char *kx, const char *ky) { return QPointF(req.value(QLatin1String(kx)).toDouble(), req.value(QLatin1String(ky)).toDouble()); };
    if (cmd == QLatin1String("grab")) {
        grab(req, answer);
    } else if (cmd == QLatin1String("tap")) {
        autoGesture(pt("x", "y"), pt("x", "y"), 80, answer);
    } else if (cmd == QLatin1String("long_press")) {
        autoGesture(pt("x", "y"), pt("x", "y"), std::clamp(req.value(QStringLiteral("ms")).toInt(800), 300, 5000), answer);
    } else if (cmd == QLatin1String("swipe")) {
        autoGesture(pt("x0", "y0"), pt("x1", "y1"), std::clamp(req.value(QStringLiteral("ms")).toInt(300), 50, 5000), answer);
    } else if (cmd == QLatin1String("tap_item")) {
        // tap the centre of the first visible item matching a selector (find's syntax)
        const QString sel = req.value(QStringLiteral("selector")).toString();
        for (QQuickItem *it : matchItems(sel)) {
            if (it->isVisible() && it->width() > 0) return autoGesture(centerOf(it), centerOf(it), 80, answer), true;
        }
        fail(QStringLiteral("no visible item matches %1").arg(sel));
    } else if (cmd == QLatin1String("tool")) {
        const QString name = req.value(QStringLiteral("name")).toString();
        for (QQuickItem *it : matchItems(QStringLiteral("name:editingToolLoader_") + name)) {
            if (it->isVisible()) return autoGesture(centerOf(it), centerOf(it), 80, answer), true;
        }
        fail(QStringLiteral("no toolbar tool %1 (names: primaryPenMenu, secondaryPenMenu, typingMenu, eraserMenu, selectionButton, layersMenu, undoButton, redoButton)").arg(name));
    } else if (cmd == QLatin1String("open")) {
        // a notebook by its title, from the library: a tap on its tile's title
        const QString title = req.value(QStringLiteral("title")).toString();
        QQuickItem *view = followedView();
        if (view && view->isVisible()) return fail(QStringLiteral("a notebook is open; close it first")), true;
        for (QQuickItem *it : matchItems(QStringLiteral("text:") + title)) {
            if (it->isVisible()) return autoGesture(centerOf(it), centerOf(it), 80, answer), true;
        }
        fail(QStringLiteral("no visible tile titled %1").arg(title));
    } else if (cmd == QLatin1String("goto")) {
        QQuickItem *view = followedView();
        if (!view || !view->isVisible()) return fail(QStringLiteral("no notebook open")), true;
        const QString page = req.value(QStringLiteral("page")).toVariant().toString();
        for (const char *m : {"goToPageId", "goToPage", "setCurrentPage"}) {
            const QByteArray sig = QByteArray(m) + "(QString)";
            const QByteArray sigInt = QByteArray(m) + "(int)";
            QObject *target = nullptr;
            for (QQuickItem *v = view; v && !target; v = v->parentItem()) {
                if (v->metaObject()->indexOfMethod(sig.constData()) >= 0 || v->metaObject()->indexOfMethod(sigInt.constData()) >= 0) target = v;
            }
            if (!target) continue;
            bool isInt = false;
            const int idx = page.toInt(&isInt);
            const bool called = isInt && target->metaObject()->indexOfMethod(sigInt.constData()) >= 0 ? invoke(target, m, {idx}) : invoke(target, m, {page});
            if (called) {
                answer(QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("via"), QString::fromLatin1(m)}});
                return true;
            }
        }
        fail(QStringLiteral("no page navigation function found on the DocumentView chain"));
    } else if (cmd == QLatin1String("text_insert") || cmd == QLatin1String("text_read")) {
        if (cmd == QLatin1String("text_insert") && !autorules::editAllowed(visibleDocTitle().toStdString()))
            return fail(QStringLiteral("blocked: edits only in the notebook \"codrawer: test\"")), true;
        auto send = [answer](const QString &r) {
            answer(QJsonObject{{QStringLiteral("ok"), !r.startsWith(QLatin1String("err "))}, {QStringLiteral("result"), r}});
        };
        if (cmd == QLatin1String("text_read")) send(textRead());
        else if (!textInsertRouteA(req.value(QStringLiteral("text")).toString(), send)) send(textInsert(req.value(QStringLiteral("text")).toString()));
    } else {
        return false;
    }
    return true;
}

}  // namespace cdl
