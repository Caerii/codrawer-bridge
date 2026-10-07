// selection.cpp: see selection.h.
#include "selection.h"

#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "spot.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QRect>
#include <QtCore/QTimer>
#include <QtGui/QTransform>
#include <QtQuick/QQuickItem>

#include <vector>

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
spot::Rect toSpot(const QRectF &r) { return {r.left(), r.top(), r.right(), r.bottom()}; }

// The selected ink's bounds (spot.h, "The ink's bounds"): the union of the controller's
// `getLineBoundingRectsToBeSelected()`, taken as page units or, failing that, mapped from view
// coordinates; used only if it lies inside the lasso's rect. Logged each time with its verdict.
QRectF inkBounds(QObject *c, const QRectF &lasso, QQuickItem *view) {
    QVariant ret;
    if (c->metaObject()->indexOfMethod("getLineBoundingRectsToBeSelected()") < 0 ||
        !invoke(c, "getLineBoundingRectsToBeSelected", {}, &ret)) {
        logLine(QStringLiteral("selection: ink bounds: getLineBoundingRectsToBeSelected() not callable; the lasso rect stands in"));
        return QRectF();
    }
    const QList<QRect> rects = ret.value<QList<QRect>>();
    std::vector<spot::Rect> page;
    for (const QRect &r : rects) page.push_back(toSpot(QRectF(r)));
    const spot::Rect asPage = spot::unite(page.begin(), page.end());
    const spot::Rect lassoR = toSpot(lasso);
    QRectF found;
    QString how = QStringLiteral("not inside the lasso");
    if (spot::inkInsideLasso(asPage, lassoR)) {
        found = QRectF(QPointF(asPage.x0, asPage.y0), QPointF(asPage.x1, asPage.y1));
        how = QStringLiteral("page units");
    } else if (QObject *tiles = view ? view->property("tileManager").value<QObject *>() : nullptr) {
        const QVariant tv = tiles->property("sceneToViewTransform");
        if (tv.metaType().id() == QMetaType::QTransform) {
            const QTransform inv = tv.value<QTransform>().inverted();
            std::vector<spot::Rect> mapped;
            for (const QRect &r : rects) mapped.push_back(toSpot(inv.mapRect(QRectF(r))));
            const spot::Rect asView = spot::unite(mapped.begin(), mapped.end());
            if (spot::inkInsideLasso(asView, lassoR)) {
                found = QRectF(QPointF(asView.x0, asView.y0), QPointF(asView.x1, asView.y1));
                how = QStringLiteral("view coordinates, mapped");
            }
        }
    }
    logLine(QStringLiteral("selection: ink bounds: %1 line rect(s), union %2 -> %3 (%4)")
                .arg(rects.size()).arg(show(QVariant(QRectF(QPointF(asPage.x0, asPage.y0), QPointF(asPage.x1, asPage.y1)))))
                .arg(found.isValid() ? show(QVariant(found)) : QStringLiteral("the lasso rect stands in"), how));
    return found;
}

void readSelection(QObject *c) {
    Selection &s = selectionFollow().last;
    s.inkRect = inkBounds(c, s.rect, followedView());
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
    logLine(QStringLiteral("selection: items=%1 stroke=%2 image=%3 rect %4 -> view %5; ink %6; pageBorderRect %7")
                .arg(s.count).arg(s.containsStroke).arg(s.containsImage).arg(show(s.rect), show(s.viewRect), show(QVariant(s.inkRect)), pageRect));
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
