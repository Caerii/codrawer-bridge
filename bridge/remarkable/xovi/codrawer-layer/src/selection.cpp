// selection.cpp: see selection.h.
#include "selection.h"

#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QTimer>
#include <QtGui/QTransform>
#include <QtQuick/QQuickItem>

namespace cdl {

namespace {

struct SelectionFollow {
    QPointer<QObject> controller;
    Relay *relay = nullptr;
    Selection last;
};

SelectionFollow &selectionFollow() {
    static SelectionFollow sf;
    return sf;
}

std::function<void()> &settledHook() {
    static std::function<void()> h;
    return h;
}

void settled() {
    if (settledHook()) settledHook()();
}

// The lasso as the controller and the view describe it (guibor's map:
// selectionContainsStroke/Image, the page rect, the selection handler's geometry). Read-only;
// the first time in a run it also logs the selection menu's item tree, for placing a button.
void readSelection(QObject *c) {
    Selection &s = selectionFollow().last;
    s.count = c->property("selectionItemCount").toInt();
    s.containsStroke = c->property("selectionContainsStroke").toBool();
    s.containsImage = c->property("selectionContainsImage").toBool();
    QQuickItem *view = followedView();
    QString pageRect = QStringLiteral("none");
    if (view) {
        for (QQuickItem *v = view; v; v = v->parentItem()) {
            if (v->metaObject()->indexOfProperty("pageBorderRect") >= 0) {
                pageRect = show(v->property("pageBorderRect")) + QStringLiteral(" on ") + QString::fromLatin1(v->metaObject()->className());
                break;
            }
        }
        if (pageRect == QLatin1String("none")) {
            for (QQuickItem *it : allItems()) {
                if (it->metaObject()->indexOfProperty("pageBorderRect") >= 0 && it->isVisible()) {
                    pageRect = show(it->property("pageBorderRect")) + QStringLiteral(" on ") + QString::fromLatin1(it->metaObject()->className());
                    break;
                }
            }
        }
        QObject *tiles = view->property("tileManager").value<QObject *>();
        const QVariant tv = tiles ? tiles->property("sceneToViewTransform") : QVariant();
        if (tv.metaType().id() == QMetaType::QTransform) s.viewRect = tv.value<QTransform>().mapRect(s.rect);
    }
    logLine(QStringLiteral("selection: items=%1 stroke=%2 image=%3 rect %4 -> view %5; pageBorderRect %6")
                .arg(s.count).arg(s.containsStroke).arg(s.containsImage).arg(show(s.rect), show(s.viewRect), pageRect));
    static bool treeLogged = false;
    if (!treeLogged) {
        treeLogged = true;
        logTree(QStringLiteral("class:SelectionContextualMenu"), 3);
        logTree(QStringLiteral("class:SelectionHandler"), 1);
    }
}

}  // namespace

const Selection &lastSelection() { return selectionFollow().last; }

void setSelectionSettledHook(std::function<void()> fn) { settledHook() = std::move(fn); }

void selectionTick() {
    SelectionFollow &sf = selectionFollow();
    QQuickItem *view = followedView();
    if (!view) return;
    QObject *c = view->property("controller").value<QObject *>();
    if (!c || c == sf.controller) return;
    delete sf.relay;
    sf.relay = new Relay;
    sf.controller = c;
    sf.relay->on(c, Relay::signalNamed(c, "areaSelected"), [c](void **a) {
        SelectionFollow &s = selectionFollow();
        s.last.page = c->property("pageId").toString();
        s.last.arg = *static_cast<int *>(a[1]);
        s.last.rect = *static_cast<QRectF *>(a[2]);
        s.last.count = c->property("selectionItemCount").toInt();
        s.last.atMs = nowMs();
        logLine(QStringLiteral("selection: areaSelected(%1, %2) items=%3 page=%4")
                    .arg(s.last.arg).arg(show(s.last.rect)).arg(s.last.count).arg(s.last.page));
        // The selection settles in the scene's own job: read it a moment later, and then try the
        // injections that wait for a selection menu (when=selection).
        QPointer<QObject> pc(c);
        QTimer::singleShot(300, QCoreApplication::instance(), [pc] {
            if (pc) readSelection(pc);
            settled();
        });
        QTimer::singleShot(900, QCoreApplication::instance(), [] { settled(); });
    });
    sf.relay->on(c, Relay::signalNamed(c, "selectionCleared"), [](void **) {
        logLine(QStringLiteral("selection: cleared"));
    });
}

}  // namespace cdl
