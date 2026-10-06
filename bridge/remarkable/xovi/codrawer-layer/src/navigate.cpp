// navigate.cpp: see navigate.h.
#include "navigate.h"

#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "toolfollow.h"

#include <QtCore/QPointer>
#include <QtCore/QRectF>
#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtGui/QTransform>
#include <QtQml/QQmlComponent>
#include <QtQml/QQmlContext>
#include <QtQml/QQmlEngine>
#include <QtQuick/QQuickItem>
#include <QtQuick/QQuickWindow>

namespace cdl {

namespace {

constexpr double kPageW = 1620, kPageH = 2160;  // page units (the Paper Pro page; protocol `w`, `h`)
constexpr int kOpenMs = 10000;  // a document's view must be up by then
constexpr int kPageMs = 3000;   // and on the asked page by then
constexpr int kFlashMs = 2000;
constexpr qint64 kOfferMs = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Finding xochitl's objects.

QQuickItem *itemWithClassPrefix(const char *prefix) {
    for (QQuickItem *it : allItems()) {
        if (qstrncmp(it->metaObject()->className(), prefix, qstrlen(prefix)) == 0) return it;
    }
    return nullptr;
}

QQuickItem *mainView() { return itemWithClassPrefix("MainView_QMLTYPE"); }

// The visible DocumentView, or null.
QQuickItem *openView() {
    for (const OpenPage &p : findDocumentViews()) {
        if (p.view->isVisible()) return p.view;
    }
    return nullptr;
}

QObject *documentOf(QQuickItem *view) {
    return view && view->metaObject()->indexOfProperty("document") >= 0 ? view->property("document").value<QObject *>()
                                                                         : nullptr;
}

QString docIdOf(QQuickItem *view) {
    return firstProp(documentOf(view), {"id", "documentId", "uuid"}).toVariant().toString();
}

int currentPageOf(QQuickItem *view) {
    bool ok = false;
    const int n = view ? view->property("currentPage").toInt(&ok) : -1;
    return ok ? n : -1;
}

QString err(const QString &why) { return QStringLiteral("err ") + why; }

// ---------------------------------------------------------------------------------------------
// The flash.

const char *kFlashQml =
    "import QtQuick\n"
    "Rectangle { color: \"transparent\"; border.width: 6; border.color: \"black\"; radius: 8 }\n";

// Frames `pageRect` (page units) on `view` for kFlashMs. False if the view has no transform.
bool flash(QQuickItem *view, const QRectF &pageRect) {
    QObject *tiles = view->property("tileManager").value<QObject *>();
    const QVariant tv = tiles ? tiles->property("sceneToViewTransform") : QVariant();
    if (tv.metaType().id() != QMetaType::QTransform || !view->window()) return false;
    const QRectF inView = tv.value<QTransform>().mapRect(pageRect).adjusted(-12, -12, 12, 12);
    const QRectF inWindow = view->mapRectToScene(inView);
    QQmlEngine *eng = nullptr;
    for (QQuickItem *e = view; e && !eng; e = e->parentItem()) eng = qmlEngine(e);
    if (!eng) return false;
    QQmlComponent comp(eng);
    comp.setData(kFlashQml, QUrl(QStringLiteral("codrawer-flash.qml")));
    auto *item = qobject_cast<QQuickItem *>(comp.create(eng->rootContext()));
    if (!item) {
        logLine(QStringLiteral("goto: flash: %1").arg(comp.errorString().trimmed()));
        return false;
    }
    QQuickItem *top = view->window()->contentItem();
    item->setParentItem(top);
    item->setParent(top);
    item->setZ(1e6);
    item->setPosition(inWindow.topLeft());
    item->setSize(inWindow.size());
    QPointer<QQuickItem> p(item);
    QTimer::singleShot(kFlashMs, top, [p] {
        if (p) p->deleteLater();
    });
    logLine(QStringLiteral("goto: flash %1 (view %2)").arg(show(pageRect), show(inWindow)));
    return true;
}

// Scrolls the page rect into view when it is not entirely on screen. True if it called xochitl.
bool scrollIntoView(QQuickItem *view, const QRectF &pageRect) {
    QObject *tiles = view->property("tileManager").value<QObject *>();
    const QVariant tv = tiles ? tiles->property("sceneToViewTransform") : QVariant();
    if (tv.metaType().id() != QMetaType::QTransform) return false;
    const QRectF inView = tv.value<QTransform>().mapRect(pageRect);
    if (QRectF(0, 0, view->width(), view->height()).contains(inView)) return false;
    if (tiles->metaObject()->indexOfMethod("scrollToMakeSceneRectangleVisible(QRectF,qreal,qreal,qreal,qreal)") < 0) {
        logLine(QStringLiteral("goto: region off screen and no scrollToMakeSceneRectangleVisible; not scrolled"));
        return false;
    }
    const bool ok = invoke(tiles, "scrollToMakeSceneRectangleVisible", {pageRect, 0.0, 0.0, 0.0, 0.0});
    logLine(QStringLiteral("goto: scroll %1 into view: %2").arg(show(pageRect)).arg(ok));
    return ok;
}

// ---------------------------------------------------------------------------------------------
// Pages.

// The index of req's page in the open document, or −1 (logged).
int pageIndexFor(QQuickItem *view, const gotoreq::Request &req) {
    if (req.pageIndex >= 0) return req.pageIndex;
    if (req.pageId.empty()) return currentPageOf(view);
    QObject *doc = documentOf(view);
    QVariant idx;
    if (!doc || !invoke(doc, "pageForId", {QString::fromStdString(req.pageId)}, &idx)) return -1;
    bool ok = false;
    const int n = idx.toInt(&ok);
    return ok ? n : -1;
}

// After the page: scroll and flash the region, then reply.
void finishAt(QPointer<QQuickItem> view, const gotoreq::Request &req, const QString &how, Done done) {
    const int page = currentPageOf(view);
    if (!req.hasRegion || !view) {
        done(QStringLiteral("ok goto %1 page %2").arg(how).arg(page));
        return;
    }
    const gotoreq::PageRect r = gotoreq::toPageUnits(req.region, kPageW, kPageH);
    const QRectF rect(r.x, r.y, r.w, r.h);
    const bool scrolled = scrollIntoView(view, rect);
    if (!req.flash) {
        done(QStringLiteral("ok goto %1 page %2%3").arg(how).arg(page).arg(scrolled ? QStringLiteral(" scrolled") : QString()));
        return;
    }
    // let a scroll settle before framing the region where it now is
    QTimer::singleShot(scrolled ? 400 : 0, view, [view, rect, how, page, scrolled, done] {
        const bool flashed = view && flash(view, rect);
        done(QStringLiteral("ok goto %1 page %2%3%4").arg(how).arg(page)
                 .arg(scrolled ? QStringLiteral(" scrolled") : QString(), flashed ? QStringLiteral(" flashed") : QString()));
    });
}

void turnTo(QQuickItem *v, const gotoreq::Request &req, const QString &how, Done done) {
    QPointer<QQuickItem> view(v);
    const int want = pageIndexFor(v, req);
    if (want < 0) {
        done(err(QStringLiteral("page %1 not in this document").arg(QString::fromStdString(req.pageId))));
        return;
    }
    if (currentPageOf(v) == want) {
        finishAt(view, req, how, done);
        return;
    }
    if (!invoke(v, "openPage", {want, QVariant()})) {
        done(err(QStringLiteral("DocumentView has no openPage")));
        return;
    }
    waitFor([view, want] { return !view || currentPageOf(view) == want; }, kPageMs, [view, want, req, how, done](bool) {
        if (!view || currentPageOf(view) != want) {
            done(err(QStringLiteral("page %1 did not open").arg(want)));
            return;
        }
        finishAt(view, req, how, done);
    });
}

// ---------------------------------------------------------------------------------------------
// The offer.

struct Offer {
    gotoreq::Request req;
    QString title;
    qint64 atMs = 0;
};

Offer &offer() {
    static Offer o;
    return o;
}

std::function<void()> &offerHook() {
    static std::function<void()> h;
    return h;
}

void offerChanged() {
    if (offerHook()) offerHook()();
}

}  // namespace

void gotoPage(const gotoreq::Request &req, Done done) {
    if (userTouching()) return done(err(QStringLiteral("pen or finger on the page")));
    QQuickItem *v = openView();
    if (!v) return done(err(QStringLiteral("no notebook open")));
    turnTo(v, req, QStringLiteral("already-open"), done);
}

void gotoDoc(const gotoreq::Request &req, Done done) {
    if (userTouching()) return done(err(QStringLiteral("pen or finger on the page")));
    const QString doc = QString::fromStdString(req.doc);
    QQuickItem *v = openView();
    if (v && docIdOf(v) == doc) {
        turnTo(v, req, QStringLiteral("already-open"), done);
        return;
    }
    QQuickItem *mv = mainView();
    if (!mv) return done(err(QStringLiteral("no MainView")));
    QVariantMap args{{QStringLiteral("documentId"), doc}};
    if (req.pageIndex >= 0) args.insert(QStringLiteral("page"), req.pageIndex);
    logLine(QStringLiteral("goto: opening %1 (page %2)").arg(doc, req.pageId.empty() ? QString::number(req.pageIndex) : QString::fromStdString(req.pageId)));
    if (!invoke(mv, "onOpened", {QVariant(args)})) return done(err(QStringLiteral("MainView has no onOpened")));
    waitFor(
        [doc] {
            QQuickItem *w = openView();
            const QVariant loaded = w ? w->property("documentLoaded") : QVariant();
            return w && docIdOf(w) == doc && (!loaded.isValid() || loaded.toBool());
        },
        kOpenMs,
        [doc, req, done](bool ok) {
            QQuickItem *w = openView();
            if (!ok || !w || docIdOf(w) != doc) {
                done(err(QStringLiteral("document %1 did not open").arg(doc)));
                return;
            }
            turnTo(w, req, QStringLiteral("opened"), done);
        });
}

void folder(const QString &action, const QString &id, Done done) {
    if (userTouching()) return done(err(QStringLiteral("pen or finger on the page")));
    QQuickItem *mv = mainView();
    if (!mv) return done(err(QStringLiteral("no MainView")));
    QObject *explorer = mv->metaObject()->indexOfProperty("explorer") >= 0 ? mv->property("explorer").value<QObject *>() : nullptr;
    auto enter = [mv, done, action](const QVariant &folderId) {
        const bool ok = invoke(mv, "onOpened", {QVariant(QVariantMap{{QStringLiteral("folderId"), folderId.toString()}})});
        logLine(QStringLiteral("goto: folder %1 %2: %3").arg(action, folderId.toString()).arg(ok));
        done(ok ? QStringLiteral("ok folder %1").arg(action) : err(QStringLiteral("MainView has no onOpened")));
    };
    if (action == QLatin1String("enter")) {
        if (!gotoreq::isUuid(id.toStdString())) return done(err(QStringLiteral("id must be a folder uuid")));
        return enter(id);
    }
    if (!explorer) return done(err(QStringLiteral("no library explorer")));
    if (action == QLatin1String("home")) {
        QVariant root;
        if (!invoke(explorer, "rootId", {}, &root)) return done(err(QStringLiteral("explorer has no rootId")));
        return enter(root);
    }
    if (action == QLatin1String("up")) {
        QVariant inRoot;
        if (invoke(explorer, "isInRoot", {}, &inRoot) && inRoot.toBool()) return done(QStringLiteral("ok folder up (already at the top)"));
        QVariant cur = explorer->property("currentFolderId");
        if (!cur.isValid()) invoke(explorer, "currentFolderId", {}, &cur);
        QVariant parent;
        if (!cur.isValid() || !invoke(explorer, "parentForEntity", {cur}, &parent)) return done(err(QStringLiteral("no parent folder")));
        return enter(parent);
    }
    done(err(QStringLiteral("action must be enter|up|home")));
}

void offerGoto(const gotoreq::Request &req, const QString &title, Done done) {
    offer() = Offer{req, title, nowMs()};
    logLine(QStringLiteral("goto: offer %1 (%2)").arg(QString::fromStdString(req.doc), title));
    offerChanged();
    done(QStringLiteral("ok goto_offer"));
}

QString offerLabel() {
    const Offer &o = offer();
    if (o.atMs == 0 || nowMs() - o.atMs > kOfferMs) return QString();
    return QStringLiteral("Go to %1?").arg(o.title.isEmpty() ? QStringLiteral("the cited page") : o.title);
}

void acceptOffer(Done done) {
    if (offerLabel().isEmpty()) return done(err(QStringLiteral("no offer")));
    const gotoreq::Request req = offer().req;
    offer() = Offer{};
    offerChanged();
    gotoDoc(req, done);
}

void setOfferHook(std::function<void()> fn) { offerHook() = std::move(fn); }

}  // namespace cdl
