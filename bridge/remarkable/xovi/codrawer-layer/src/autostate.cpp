// autostate.cpp: see autostate.h.
#include "autostate.h"

#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "toolfollow.h"

#include <QtCore/QJsonArray>
#include <QtGui/QGuiApplication>
#include <QtGui/QTransform>
#include <QtQuick/QQuickItem>
#include <QtQuick/QQuickWindow>

namespace cdl {

std::atomic<int> &autoClients() {
    static std::atomic<int> n{0};
    return n;
}

std::atomic<bool> &autoPaused() {
    static std::atomic<bool> p{false};
    return p;
}

std::atomic<bool> &synthesizing() {
    static std::atomic<bool> s{false};
    return s;
}

bool autoClientsActive() { return autoClients().load() > 0; }

void pauseAutomationForUser() {
    if (synthesizing().load()) return;
    if (autoClients().load() > 0 && !autoPaused().exchange(true)) logLine(QStringLiteral("auto: paused by the user's pen or touch"));
}

bool lockScreenUp() {
    for (QQuickItem *it : allItems()) {
        if (!it->isVisible()) continue;
        const QString n = QString::fromLatin1(it->metaObject()->className()) + QLatin1Char(' ') + it->objectName();
        if (n.contains(QLatin1String("LockScreen"), Qt::CaseInsensitive) || n.contains(QLatin1String("Passcode"), Qt::CaseInsensitive) ||
            n.contains(QLatin1String("PinCode"), Qt::CaseInsensitive))
            return true;
    }
    return false;
}

QJsonObject autoState() {
    QJsonObject st;
    const bool locked = lockScreenUp();
    st.insert(QStringLiteral("locked"), locked);
    st.insert(QStringLiteral("paused"), autoPaused().load());
    st.insert(QStringLiteral("tool"), QString::fromLatin1(toolLine()));
    QQuickItem *v = followedView();
    if (v && v->isVisible()) {
        QObject *c = v->property("controller").value<QObject *>();
        QObject *docObj = v->metaObject()->indexOfProperty("document") >= 0 ? v->property("document").value<QObject *>() : nullptr;
        QJsonObject doc{{QStringLiteral("id"), firstProp(docObj, {"id", "documentId", "uuid"})},
                        {QStringLiteral("title"), firstProp(docObj, {"title", "visibleName", "name"})}};
        st.insert(QStringLiteral("doc"), doc);
        QJsonObject page{{QStringLiteral("id"), v->property("pageId").toString()},
                         {QStringLiteral("index"), firstProp(v, {"currentPage", "pageIndex", "currentPageIndex", "page"})},
                         {QStringLiteral("count"), firstProp(docObj, {"pageCount"})}};
        st.insert(QStringLiteral("page"), page);
        QObject *tiles = v->property("tileManager").value<QObject *>();
        const QVariant tv = tiles ? tiles->property("sceneToViewTransform") : QVariant();
        if (tv.metaType().id() == QMetaType::QTransform) {
            const QTransform t = tv.value<QTransform>();
            st.insert(QStringLiteral("zoom"), t.m11());
            st.insert(QStringLiteral("scroll"), QJsonArray{t.dx(), t.dy()});
        }
        if (c) {
            st.insert(QStringLiteral("layers"), c->property("layerCount").toInt());
            st.insert(QStringLiteral("undo"), c->property("undoAvailable").toBool());
            st.insert(QStringLiteral("selection"), QJsonObject{{QStringLiteral("items"), c->property("selectionItemCount").toInt()}});
        }
    } else {
        st.insert(QStringLiteral("doc"), QJsonValue());
    }
    if (auto *qw = qobject_cast<QQuickWindow *>(QGuiApplication::focusWindow())) {
        if (QQuickItem *f = qw->activeFocusItem())
            st.insert(QStringLiteral("focus"), QString::fromLatin1(f->metaObject()->className()) + QLatin1Char(' ') + f->objectName());
    }
    QJsonArray popups;
    for (QQuickItem *it : allItems()) {
        if (!it->isVisible()) continue;
        const QString cls = QString::fromLatin1(it->metaObject()->className());
        if (cls.contains(QLatin1String("Popup")) || cls.contains(QLatin1String("Foldout_")) || cls.contains(QLatin1String("Dialog")) ||
            cls.contains(QLatin1String("ContextualMenu")))
            popups << QStringLiteral("%1 %2").arg(cls, it->objectName()).trimmed();
    }
    st.insert(QStringLiteral("popups"), popups);
    return st;
}

std::string statePath(const QJsonObject &st, const std::string &path) {
    QJsonValue v = st;
    for (const QString &k : QString::fromStdString(path).split(QLatin1Char('.'))) v = v.toObject().value(k);
    if (v.isBool()) return v.toBool() ? "true" : "false";
    if (v.isDouble()) return QString::number(v.toDouble(), 'g', 15).toStdString();
    if (v.isString()) return v.toString().toStdString();
    return "";
}

QJsonObject autoFind(const QString &selector) {
    QJsonArray out;
    for (QQuickItem *it : matchItems(selector)) {
        const QPointF p = it->mapToScene(QPointF(0, 0));
        QJsonObject o{{QStringLiteral("class"), QString::fromLatin1(it->metaObject()->className())},
                      {QStringLiteral("name"), it->objectName()},
                      {QStringLiteral("bounds"), QJsonArray{p.x(), p.y(), it->width(), it->height()}},
                      {QStringLiteral("visible"), it->isVisible()}};
        if (it->metaObject()->indexOfProperty("text") >= 0) o.insert(QStringLiteral("text"), it->property("text").toString());
        out << o;
        if (out.size() >= 50) break;
    }
    return QJsonObject{{QStringLiteral("items"), out}};
}

QString visibleDocTitle() {
    QQuickItem *v = followedView();
    if (!v || !v->isVisible()) return QString();
    QObject *docObj = v->metaObject()->indexOfProperty("document") >= 0 ? v->property("document").value<QObject *>() : nullptr;
    return firstProp(docObj, {"title", "visibleName", "name"}).toString();
}

}  // namespace cdl
