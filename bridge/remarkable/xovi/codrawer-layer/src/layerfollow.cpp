// Observe native layer removal without waiting for the .rm autosave.
#include "layerfollow.h"
#include "scene.h"
#include "qtmeta.h"
#include "toolfollow.h"
#include "inksock.h"
#include "log.h"
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QPointer>
#include <QtCore/QTimer>

namespace cdl {
namespace {
QPointer<QObject> controller;
QPointer<QQuickItem> view;
QString page;
bool hadAgent = false;
Relay *relay = nullptr;

void checkLayers() {
    if (!controller || !view || !view->isVisible()) return;
    const QString now = view->property("pageId").toString();
    const QVariant controllerPage = controller->property("pageId");
    if (now.isEmpty() || (controllerPage.isValid() && controllerPage.toString() != now)) return;
    const auto ls = layers(controller);
    const int count = controller->property("layerCount").toInt();
    if (count < 1 || ls.size() != count) return; // transient/loading state isn't deletion
    bool hasAgent = false;
    for (const auto &l : ls) if (l.name == QStringLiteral("codrawer: agent")) hasAgent = true;
    if (page == now && hadAgent && !hasAgent) {
        QJsonObject action{{"t", "dock_action"}, {"id", "agent_layer_deleted"},
                           {"page", now}, {"source", "native-layer"}};
        sendToBridge(QJsonDocument(action).toJson(QJsonDocument::Compact));
        logLine(QStringLiteral("layers: agent removed on %1; notified bridge").arg(now));
    }
    page = now;
    hadAgent = hasAgent;
}
}
void layerTick() {
    QQuickItem *v = followedView();
    QObject *c = v ? v->property("controller").value<QObject *>() : nullptr;
    if (c != controller || v != view) {
        delete relay;
        relay = nullptr;
        controller = c; view = v; page.clear(); hadAgent = false;
        if (c) {
            relay = new Relay;
            const bool connected = relay->on(c, Relay::notifyOf(c, "layerCount"), [](void **) {
                // Let the native model finish its removal before reading the layer list.
                QTimer::singleShot(0, [] { checkLayers(); });
            });
            logLine(QStringLiteral("layers: following native layerCount (notify=%1)").arg(connected));
        }
    }
    checkLayers(); // discovery / fallback when a firmware has no notify signal
}
}
