// live.cpp: see live.h.
#include "live.h"

#include "log.h"
#include "paths.h"
#include "qtmeta.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QJsonArray>
#include <QtCore/QPointer>
#include <QtCore/QRectF>
#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtGui/QTransform>
#include <QtQml/QQmlComponent>
#include <QtQml/QQmlContext>
#include <QtQml/QQmlEngine>
#include <QtQuick/QQuickItem>

#include <map>
#include <sys/stat.h>

namespace cdl {

namespace {

constexpr const char *kLiveQml = "/home/root/xovi/exthome/codrawer-layer/live.qml";
constexpr int kRemoveAfterMs = 250;   // after the commit: the native line is on screen by then
constexpr int kForgetAfterMs = 15000; // a stroke whose commit never reports goes anyway

struct Overlay {
    QPointer<QQuickItem> item;
    QPointer<QQuickItem> view;
    Relay *relay = nullptr;
    qint64 failedAt = 0;  // the last load failure (retried after 30 s)
};

Overlay &overlayState() {
    static Overlay o;
    return o;
}

// Per live stroke: whether its live_end and its commit verdict have come.
struct Stroke {
    bool ended = false, committed = false;
};

std::map<QString, Stroke> &strokes() {
    static std::map<QString, Stroke> s;
    return s;
}

QQuickItem *visibleView() {
    QQuickItem *v = followedView();
    return v && v->isVisible() ? v : nullptr;
}

// The overlay on the visible DocumentView, made if needed; null when there is none (no page, the
// kill switch, a load failure in the last 30 s).
QQuickItem *overlay() {
    Overlay &o = overlayState();
    QQuickItem *v = visibleView();
    struct stat st;
    if (!v || stat(kNoInject, &st) == 0) return nullptr;
    if (o.item && o.view == v) return o.item;
    if (o.item) delete o.item.data();
    delete o.relay;
    o.relay = nullptr;
    if (o.failedAt && nowMs() - o.failedAt < 30000) return nullptr;
    QQmlEngine *eng = nullptr;
    for (QQuickItem *e = v; e && !eng; e = e->parentItem()) eng = qmlEngine(e);
    if (!eng) return nullptr;
    QQmlComponent comp(eng, QUrl::fromLocalFile(QString::fromLatin1(kLiveQml)));
    if (comp.isError() || comp.status() != QQmlComponent::Ready) {
        logLine(QStringLiteral("live: %1 does not load: %2").arg(QString::fromLatin1(kLiveQml), comp.errorString().trimmed()));
        o.failedAt = nowMs();
        return nullptr;
    }
    QObject *obj = comp.beginCreate(eng->rootContext());
    auto *item = qobject_cast<QQuickItem *>(obj);
    if (!item) {
        delete obj;
        o.failedAt = nowMs();
        return nullptr;
    }
    item->setParentItem(v);
    item->setParent(v);  // destroyed with the view
    comp.completeCreate();
    item->setProperty("paused", userTouching());
    o.item = item;
    o.view = v;
    o.relay = new Relay;
    o.relay->on(item, Relay::signalNamed(item, "note"), [](void **a) {
        logLine(QStringLiteral("live: %1").arg(*static_cast<QString *>(a[1])));
    });
    logLine(QStringLiteral("live: overlay created on %1 (%2x%3)")
                .arg(QString::fromLatin1(v->metaObject()->className())).arg(v->width()).arg(v->height()));
    return item;
}

// Page units to the view's coordinates, or an invalid transform.
QVariant viewTransform(QQuickItem *v) {
    QObject *tiles = v ? v->property("tileManager").value<QObject *>() : nullptr;
    const QVariant tv = tiles ? tiles->property("sceneToViewTransform") : QVariant();
    return tv.metaType().id() == QMetaType::QTransform ? tv : QVariant();
}

void removeLater(const QString &id, int ms) {
    QTimer::singleShot(ms, QCoreApplication::instance(), [id] {
        strokes().erase(id);
        if (QQuickItem *item = overlayState().item) invoke(item, "liveRemove", {id});
    });
}

}  // namespace

void liveOp(const QJsonObject &o) {
    const QString op = o.value(QStringLiteral("op")).toString();
    const QString id = o.value(QStringLiteral("id")).toString().left(64);
    if (id.isEmpty()) return;
    QQuickItem *item = overlay();
    if (!item) return;
    const QVariant tv = viewTransform(visibleView());
    if (!tv.isValid()) return;
    const QTransform t = tv.value<QTransform>();
    if (op == QLatin1String("live")) {
        if (o.value(QStringLiteral("page")).toString() != visiblePageId()) return;  // not this page
        QVariantList pts;
        for (const QJsonValue &pv : o.value(QStringLiteral("pts")).toArray()) {
            const QJsonArray p = pv.toArray();
            if (p.size() < 2) continue;
            const QPointF v = t.map(QPointF(p[0].toDouble(), p[1].toDouble()));
            pts << QVariant(QVariantList{v.x(), v.y(), p.size() > 2 ? p[2].toDouble() : 0.6, p.size() > 3 ? p[3].toDouble() : 0.0});
        }
        const double width = o.value(QStringLiteral("width")).toDouble(4) * t.m11();
        const QString argb = o.value(QStringLiteral("argb")).toString();
        const QString color = argb.size() == 8 ? QStringLiteral("#") + argb.mid(2) : QStringLiteral("#1f6fe0");
        strokes()[id];
        invoke(item, "liveAdd", {id, QVariant(pts), width, color});
    } else if (op == QLatin1String("live_end")) {
        invoke(item, "liveEnd", {id});
        auto it = strokes().find(id);
        if (it == strokes().end()) return;
        if (!o.value(QStringLiteral("committed")).toBool()) {
            removeLater(id, 0);  // refused: nothing native will replace it
            return;
        }
        it->second.ended = true;
        if (it->second.committed) removeLater(id, kRemoveAfterMs);
        else removeLater(id, kForgetAfterMs);
    } else if (op == QLatin1String("overlay")) {
        const QString kind = o.value(QStringLiteral("kind")).toString();
        const QJsonArray b = o.value(QStringLiteral("bbox")).toArray();
        const QRectF page = b.size() == 4 ? QRectF(QPointF(b[0].toDouble(), b[1].toDouble()), QPointF(b[2].toDouble(), b[3].toDouble()))
                                          : QRectF();
        const QRectF r = t.mapRect(page);
        if (kind == QLatin1String("clear")) {
            // writing: the answer block's top left is where the nib flies if no live ink comes
            if (b.size() == 4) invoke(item, "thinkClear", {r.left(), r.top()});
            else invoke(item, "thinkClear", {QVariant(), QVariant()});
            return;
        }
        if (kind != QLatin1String("thinking") || b.size() != 4) return;
        invoke(item, "thinkStart", {r.x(), r.y(), r.width(), r.height(), o.value(QStringLiteral("style")).toString()});
    }
}

void liveCommitted(const QString &id) {
    auto it = strokes().find(id);
    if (it == strokes().end()) return;  // a stroke that was never live
    it->second.committed = true;
    if (it->second.ended) removeLater(id, kRemoveAfterMs);
}

void livePen(bool down) {
    if (QQuickItem *item = overlayState().item) item->setProperty("paused", down);
}

}  // namespace cdl
