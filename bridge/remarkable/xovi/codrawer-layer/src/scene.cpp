// scene.cpp: see scene.h.
#include "scene.h"

#include "log.h"
#include "qtmeta.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QMetaProperty>
#include <QtCore/QSequentialIterable>
#include <QtCore/QSet>
#include <QtGui/QGuiApplication>
#include <QtGui/QWindow>
#include <QtQuick/QQuickWindow>

namespace cdl {

// ---------------------------------------------------------------------------------------------
// Walking the item trees.

namespace {

void collectItems(QQuickItem *item, QList<QQuickItem *> &out, int depth = 0) {
    if (!item || depth > 200) return;
    out << item;
    const auto kids = item->childItems();
    for (QQuickItem *c : kids) collectItems(c, out, depth + 1);
}

}  // namespace

QList<QQuickItem *> allItems() {
    QList<QQuickItem *> out;
    const auto windows = QGuiApplication::allWindows();
    for (QWindow *w : windows) {
        if (auto *qw = qobject_cast<QQuickWindow *>(w)) collectItems(qw->contentItem(), out);
    }
    return out;
}

QList<QObject *> findObjectsOfClass(const char *cls) {
    QList<QObject *> out;
    QSet<QObject *> seen;
    auto consider = [&](QObject *o) {
        if (!o || seen.contains(o)) return;
        seen.insert(o);
        for (const QMetaObject *m = o->metaObject(); m; m = m->superClass()) {
            if (qstrcmp(m->className(), cls) == 0) {
                out << o;
                return;
            }
        }
    };
    const auto windows = QGuiApplication::allWindows();
    for (QWindow *w : windows) {
        auto *qw = qobject_cast<QQuickWindow *>(w);
        if (!qw) continue;
        consider(qw->contentItem());
        const auto kids = qw->contentItem()->findChildren<QObject *>();
        for (QObject *k : kids) consider(k);
    }
    if (QObject *app = QCoreApplication::instance()) {
        const auto kids = app->findChildren<QObject *>();
        for (QObject *k : kids) consider(k);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// The open page.

QList<OpenPage> findDocumentViews() {
    QList<OpenPage> out;
    for (QQuickItem *it : allItems()) {
        if (!hasProps(it, {"controller", "strokeHandler", "pageId", "tileManager", "viewport"})) continue;
        OpenPage p;
        p.view = it;
        p.controller = it->property("controller").value<QObject *>();
        p.pen = it->property("strokeHandler").value<QObject *>();
        p.tiles = it->property("tileManager").value<QObject *>();
        p.viewport = it->property("viewport").value<QObject *>();
        p.pageId = it->property("pageId").toString();
        out << p;
    }
    return out;
}

bool findOpenPage(const QString &expectedPage, OpenPage &page) {
    const auto views = findDocumentViews();
    for (const OpenPage &p : views) {
        if (!p.view->isVisible() || !p.controller || p.pageId != expectedPage) continue;
        const QVariant cp = p.controller->property("pageId");
        if (cp.isValid() && cp.toString() != expectedPage) {
            logLine(QStringLiteral("refuse: view page %1 but controller page %2").arg(p.pageId, cp.toString()));
            return false;
        }
        page = p;
        return true;
    }
    QStringList seen;
    for (const OpenPage &p : views) seen << QStringLiteral("%1 visible=%2").arg(p.pageId).arg(p.view->isVisible());
    logLine(QStringLiteral("refuse: open page is not %1 (views: %2)").arg(expectedPage, seen.join(QStringLiteral(", "))));
    return false;
}

// ---------------------------------------------------------------------------------------------
// Layers.

QList<LayerInfo> layers(QObject *controller) {
    QList<LayerInfo> out;
    const int count = controller->property("layerCount").toInt();
    if (controller->metaObject()->indexOfMethod("layerName(int)") >= 0) {
        for (int i = 0; i < count; ++i) {
            QVariant name;
            invoke(controller, "layerName", {i}, &name);
            QVariant vis;
            invoke(controller, "isLayerVisible", {i}, &vis);
            out << LayerInfo{i, name.toString(),
                             QStringLiteral("name=\"%1\" visible=%2").arg(name.toString()).arg(vis.toBool())};
        }
        return out;
    }
    // Builds without layerName(int): each Scene::LayerState gadget, its first string property
    // taken as the name.
    const QVariant v = controller->property("layerStates");
    if (!v.canConvert<QVariantList>()) {
        logLine(QStringLiteral("layerStates: cannot iterate %1").arg(QString::fromLatin1(v.metaType().name())));
        return out;
    }
    const QSequentialIterable it = v.value<QSequentialIterable>();
    int idx = 0;
    for (const QVariant &s : it) {
        LayerInfo li{idx++, QString(), QString()};
        const QMetaObject *gm = s.metaType().metaObject();
        if (gm) {
            QStringList parts;
            for (int p = gm->propertyOffset(); p < gm->propertyCount(); ++p) {
                const QMetaProperty mp = gm->property(p);
                const QVariant pv = mp.readOnGadget(s.constData());
                parts << QStringLiteral("%1=%2").arg(QString::fromLatin1(mp.name()), show(pv));
                if (li.name.isEmpty() && pv.metaType().id() == QMetaType::QString) li.name = pv.toString();
            }
            li.raw = parts.join(QStringLiteral(" "));
        } else {
            li.raw = QStringLiteral("<%1>").arg(QString::fromLatin1(s.metaType().name()));
        }
        out << li;
    }
    return out;
}

void logLayers(QObject *controller, const char *when) {
    const auto ls = layers(controller);
    logLine(QStringLiteral("layers %1: count=%2 current=%3")
                .arg(QString::fromLatin1(when))
                .arg(controller->property("layerCount").toInt())
                .arg(controller->property("currentLayer").toInt()));
    for (const LayerInfo &l : ls) logLine(QStringLiteral("   layer[%1] %2").arg(l.index).arg(l.raw));
}

int findLayer(QObject *controller, const QString &name) {
    for (const LayerInfo &l : layers(controller)) {
        if (l.name == name) return l.index;
    }
    return -1;
}

QString layerNameAt(QObject *c, int i) {
    QVariant name;
    invoke(c, "layerName", {i}, &name);
    return name.toString();
}

// ---------------------------------------------------------------------------------------------
// Selectors and the tree log.

QList<QQuickItem *> matchItems(const QString &spec) {
    QList<QQuickItem *> out;
    const int colon = spec.indexOf(QLatin1Char(':'));
    if (colon < 0) return out;
    const QString kind = spec.left(colon), want = spec.mid(colon + 1);
    for (QQuickItem *it : allItems()) {
        bool ok = false;
        if (kind == QLatin1String("class")) {
            ok = QString::fromLatin1(it->metaObject()->className()).contains(want);
        } else if (kind == QLatin1String("name")) {
            ok = it->objectName() == want;
        } else if (kind == QLatin1String("text")) {
            ok = it->metaObject()->indexOfProperty("text") >= 0 && it->property("text").toString() == want;
        } else if (kind == QLatin1String("prop")) {
            const int eq = want.indexOf(QLatin1Char('='));
            if (eq > 0) {
                const QByteArray pn = want.left(eq).toLatin1();
                ok = it->metaObject()->indexOfProperty(pn.constData()) >= 0 && it->property(pn.constData()).toString() == want.mid(eq + 1);
            }
        }
        if (ok) out << it;
    }
    return out;
}

namespace {

void logItem(QQuickItem *it, int depth, const QString &indent) {
    QStringList extra;
    for (const char *p : {"text", "iconSource", "source", "icon", "title", "checked", "enabled"}) {
        if (it->metaObject()->indexOfProperty(p) < 0) continue;
        const QVariant v = it->property(p);
        if (v.metaType().id() == QMetaType::QString || v.metaType().id() == QMetaType::QUrl || v.metaType().id() == QMetaType::Bool) {
            const QString s = v.toString();
            if (!s.isEmpty()) extra << QStringLiteral("%1=%2").arg(QString::fromLatin1(p), s.left(60));
        }
    }
    const QPointF g = it->mapToScene(QPointF(0, 0));
    logLine(QStringLiteral("%1%2 \"%3\" %4,%5 %6x%7 scene %8,%9%10 %11")
                .arg(indent, QString::fromLatin1(it->metaObject()->className()), it->objectName())
                .arg(it->x()).arg(it->y()).arg(it->width()).arg(it->height()).arg(g.x()).arg(g.y())
                .arg(it->isVisible() ? QString() : QStringLiteral(" hidden"), extra.join(QLatin1Char(' '))));
    if (depth <= 0) return;
    for (QQuickItem *c : it->childItems()) logItem(c, depth - 1, indent + QStringLiteral("  "));
}

}  // namespace

void logTree(const QString &match, int depth) {
    if (match.isEmpty()) {
        for (QWindow *win : QGuiApplication::allWindows()) {
            if (auto *qw = qobject_cast<QQuickWindow *>(win)) logItem(qw->contentItem(), depth, QString());
        }
        return;
    }
    const QList<QQuickItem *> found = matchItems(match);
    logLine(QStringLiteral("tree: %1 item(s) match %2").arg(found.size()).arg(match));
    int shown = 0;
    for (QQuickItem *it : found) {
        if (++shown > 8) break;
        QStringList up;
        for (QQuickItem *p = it->parentItem(); p; p = p->parentItem()) {
            up << QStringLiteral("%1\"%2\"").arg(QString::fromLatin1(p->metaObject()->className()), p->objectName());
        }
        logLine(QStringLiteral("tree: ancestry %1").arg(up.join(QStringLiteral(" < "))));
        logItem(it, depth, QStringLiteral("  "));
    }
}

}  // namespace cdl
