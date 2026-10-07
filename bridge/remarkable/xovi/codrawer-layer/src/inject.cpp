// inject.cpp: see inject.h.
#include "inject.h"

#include "autostate.h"
#include "cmdline_qt.h"
#include "inject_conf.h"
#include "inksock.h"
#include "live.h"
#include "log.h"
#include "navigate.h"
#include "paths.h"
#include "qtmeta.h"
#include "scene.h"
#include "selection.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QFile>
#include <QtCore/QJsonArray>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QPointer>
#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtQml/QQmlComponent>
#include <QtQml/QQmlContext>
#include <QtQml/QQmlEngine>
#include <QtQuick/QQuickItem>

#include <ctime>
#include <iterator>
#include <map>
#include <sys/stat.h>

namespace cdl {

namespace {

struct Injection {
    QString name, match, qml;
    bool after = false;
    bool onSelection = false;  // when=selection: made right after a lasso, not by the 2 s tick
    bool inert = false;  // inert=1: taps are logged, never sent (a new button's first rollout)
    QPointer<QQuickItem> item;
    Relay *relay = nullptr;
    int failures = 0;
    qint64 nextTry = 0;
};

QList<Injection> &injections() {
    static QList<Injection> l;
    return l;
}

// ---------------------------------------------------------------------------------------------
// What the injected UI shows.

// The configured or built-in entries.
QVariantList baseEntries() {
    QFile f(QString::fromLatin1(kDockJson));
    if (f.open(QIODevice::ReadOnly)) {
        const QJsonDocument d = QJsonDocument::fromJson(f.read(1 << 16));
        const QJsonArray a = d.object().value(QStringLiteral("entries")).toArray();
        if (!a.isEmpty()) return a.toVariantList();
    }
    auto e = [](const char *id, const char *label) {
        return QVariantMap{{QStringLiteral("id"), QString::fromLatin1(id)}, {QStringLiteral("label"), QString::fromLatin1(label)}};
    };
    return {e("status", "codrawer status"), e("agent_ink", "Agent ink on/off"), e("practice_coach", "Practice coach"),
            e("ask_page", "Ask about this page"), e("ask_selection", "Ask about selection")};
}

// The entries, with a pending "Go to …?" offer first (navigate.h).
QVariantList dockEntries() {
    QVariantList l = baseEntries();
    const QString offer = offerLabel();
    if (!offer.isEmpty()) l.prepend(QVariantMap{{QStringLiteral("id"), QStringLiteral("goto_offer")}, {QStringLiteral("label"), offer}});
    return l;
}

// The status line: the bridge's (its `status` socket line, or /run/codrawer/status if written in
// the last 30 s), or whether it is connected; plus "; automation active" while an automation
// client is connected (ui-automation.md, "Visible and logged").
QString localStatus() {
    QString s = bridgeStatus();
    QFile f(QString::fromLatin1(kStatusFile));  // the bridge's own line, when it writes one
    struct stat st;
    if (stat(kStatusFile, &st) == 0 && time(nullptr) - st.st_mtime < 30 && f.open(QIODevice::ReadOnly)) {
        s = QString::fromUtf8(f.read(512)).trimmed();
    }
    const bool bridge = bridgeConnected();
    if (!bridge) s = QStringLiteral("bridge not connected");
    else if (s.isEmpty()) s = QStringLiteral("bridge connected");
    if (autoClientsActive()) s += QStringLiteral("; automation active");
    return s;
}

void refreshInjected(Injection &in) {
    if (!in.item) return;
    in.item->setProperty("entries", dockEntries());
    in.item->setProperty("status", localStatus());
    in.item->setProperty("page", visiblePageId());
    if (in.item->metaObject()->indexOfProperty("badge") >= 0) in.item->setProperty("badge", !offerLabel().isEmpty());
    if (in.item->metaObject()->indexOfProperty("hasStrokes") >= 0) in.item->setProperty("hasStrokes", lastSelection().containsStroke);
}

// ---------------------------------------------------------------------------------------------
// Actions.

void dockAction(const QString &source, const QString &id) {
    const QString page = visiblePageId();
    if (id == QLatin1String("status")) {
        for (Injection &in : injections()) refreshInjected(in);
        logLine(QStringLiteral("action: status (answered locally: %1)").arg(localStatus()));
        return;
    }
    if (id == QLatin1String("goto_offer")) {
        // the user's tap on the offer: the one way an offered goto navigates (navigate.h)
        acceptOffer([source](const QString &r) {
            logLine(QStringLiteral("action: goto_offer accepted: %1").arg(r));
            const QJsonObject done{{QStringLiteral("t"), QStringLiteral("dock_action")}, {QStringLiteral("id"), QStringLiteral("goto_accepted")},
                                   {QStringLiteral("page"), visiblePageId()}, {QStringLiteral("source"), source},
                                   {QStringLiteral("result"), r}};
            sendToBridge(QJsonDocument(done).toJson(QJsonDocument::Compact));
        });
        return;
    }
    QJsonObject o{{QStringLiteral("t"), QStringLiteral("dock_action")}, {QStringLiteral("id"), id},
                  {QStringLiteral("page"), page}, {QStringLiteral("source"), source}};
    if (id == QLatin1String("ask_selection")) {
        const Selection &s = lastSelection();
        if (s.page == page && s.atMs > 0) {
            o.insert(QStringLiteral("bbox"), QJsonArray{s.rect.left(), s.rect.top(), s.rect.right(), s.rect.bottom()});
            o.insert(QStringLiteral("items"), s.count);
            o.insert(QStringLiteral("contains_stroke"), s.containsStroke);
            o.insert(QStringLiteral("contains_image"), s.containsImage);
            if (!s.viewRect.isNull())
                o.insert(QStringLiteral("view_bbox"), QJsonArray{s.viewRect.left(), s.viewRect.top(), s.viewRect.right(), s.viewRect.bottom()});
            o.insert(QStringLiteral("selected_ms_ago"), double(nowMs() - s.atMs));
        }
    }
    const bool ask = id == QLatin1String("ask_page") || id == QLatin1String("ask_selection");
    if (ask) {
        // A second tap on the same question (the same action, page and selection box) within 2 s
        // is the same question: one action is sent. A different selection is a new question and
        // is sent at once, even while others are still being answered (each gets its own doodle).
        static std::map<QString, qint64> askedAt;  // key -> nowMs of its last send
        const QString key = id + QLatin1Char(' ') + page + QLatin1Char(' ') +
                            QString::fromUtf8(QJsonDocument(o.value(QStringLiteral("bbox")).toArray()).toJson(QJsonDocument::Compact));
        const qint64 now = nowMs();
        for (auto it = askedAt.begin(); it != askedAt.end();) it = now - it->second >= 2000 ? askedAt.erase(it) : std::next(it);
        if (askedAt.count(key)) {
            logLine(QStringLiteral("action: %1 again within 2 s; the first one stands, not sent").arg(id));
            return;
        }
        askedAt[key] = now;
    }
    const QByteArray line = QJsonDocument(o).toJson(QJsonDocument::Compact);
    const bool sent = sendToBridge(line);
    logLine(QStringLiteral("action: %1 %2").arg(sent ? QStringLiteral("sent") : QStringLiteral("dropped (no bridge)"), QString::fromUtf8(line)));
    for (Injection &in : injections()) {
        if (in.item) in.item->setProperty("status", sent ? QStringLiteral("sent: %1").arg(id) : QStringLiteral("bridge not connected"));
    }
    if (ask && sent) {
        // The answer's thinking starts here, at once (live.h), not when an agent's first status
        // makes it across the network; if no agent speaks within 8 s, the dock says so.
        const Selection &s = lastSelection();
        liveLocalThinking(id == QLatin1String("ask_selection") && s.page == page && s.atMs > 0 ? s.rect : QRectF());
        const qint64 askedAt = nowMs();
        QTimer::singleShot(8000, QCoreApplication::instance(), [askedAt] {
            if (liveLastAgentStatusMs() >= askedAt) return;
            logLine(QStringLiteral("action: no agent answered in 8 s"));
            for (Injection &in : injections()) {
                if (in.item) in.item->setProperty("status", QStringLiteral("no agent answered (is agentd running?)"));
            }
        });
    }
}

// ---------------------------------------------------------------------------------------------
// Creating an injection.

bool createInjection(Injection &in) {
    QString spec = in.match;
    const bool up = spec.endsWith(QLatin1Char('^'));
    if (up) spec.chop(1);
    const QList<QQuickItem *> found = matchItems(spec);
    if (found.isEmpty()) {
        logLine(QStringLiteral("inject %1: nothing matches %2; nothing created").arg(in.name, in.match));
        return false;
    }
    if (found.size() > 1) logLine(QStringLiteral("inject %1: %2 items match %3; using the first visible").arg(in.name).arg(found.size()).arg(in.match));
    QQuickItem *hit = found.first();
    for (QQuickItem *f : found) {
        if (f->isVisible()) {
            hit = f;
            break;
        }
    }
    QQuickItem *parent = up ? hit->parentItem() : hit;
    if (!parent) {
        logLine(QStringLiteral("inject %1: matched item has no parent").arg(in.name));
        return false;
    }
    QQmlEngine *eng = nullptr;
    for (QQuickItem *e = parent; e && !eng; e = e->parentItem()) eng = qmlEngine(e);
    if (!eng) {
        logLine(QStringLiteral("inject %1: no QQmlEngine above the parent").arg(in.name));
        return false;
    }
    QQmlComponent comp(eng, QUrl::fromLocalFile(in.qml));
    if (comp.isError() || comp.status() != QQmlComponent::Ready) {
        logLine(QStringLiteral("inject %1: %2 does not load: %3").arg(in.name, in.qml, comp.errorString().trimmed()));
        return false;
    }
    QObject *obj = comp.beginCreate(eng->rootContext());
    auto *item = qobject_cast<QQuickItem *>(obj);
    if (!item) {
        delete obj;
        logLine(QStringLiteral("inject %1: root of %2 is not an Item").arg(in.name, in.qml));
        return false;
    }
    item->setParentItem(parent);
    item->setParent(parent);  // owned by xochitl's item: destroyed with it
    // the item ours stands next to, for the QML to follow its visibility and size
    if (item->metaObject()->indexOfProperty("anchorItem") >= 0) item->setProperty("anchorItem", QVariant::fromValue<QObject *>(hit));
    comp.completeCreate();
    if (in.after && up) item->stackAfter(hit);
    in.item = item;
    delete in.relay;
    in.relay = new Relay;
    const QString name = in.name;
    const bool inert = in.inert;
    in.relay->on(item, Relay::signalNamed(item, "action"), [name, inert](void **a) {
        // QML `signal action(string id)`: the argument arrives as a QString.
        const QString id = *static_cast<QString *>(a[1]);
        if (inert) {
            logLine(QStringLiteral("action: %1 tapped %2 (inert: logged only)").arg(name, id));
            return;
        }
        QMetaObject::invokeMethod(QCoreApplication::instance(), [name, id] { dockAction(name, id); }, Qt::QueuedConnection);
    });
    in.relay->on(item, Relay::signalNamed(item, "opened"), [name](void **) {
        QMetaObject::invokeMethod(QCoreApplication::instance(), [name] {
            for (Injection &i : injections()) if (i.name == name) refreshInjected(i);
        }, Qt::QueuedConnection);
    });
    refreshInjected(in);
    logLine(QStringLiteral("inject %1: created %2 in %3 (%4) at %5,%6 %7x%8")
                .arg(in.name, in.qml, QString::fromLatin1(parent->metaObject()->className()), parent->objectName())
                .arg(item->x()).arg(item->y()).arg(item->width()).arg(item->height()));
    return true;
}

// Removes the injection named `name` and destroys its item; false if there is none.
bool removeInjection(const QString &name) {
    for (int i = 0; i < injections().size(); ++i) {
        if (injections()[i].name != name) continue;
        if (injections()[i].item) delete injections()[i].item.data();
        delete injections()[i].relay;
        injections().removeAt(i);
        return true;
    }
    return false;
}

}  // namespace

void injectCommand(const QStringList &w) {
    const injectconf::Spec spec = injectconf::parseSpec(toStdWords(w));
    Injection in;
    in.name = QString::fromStdString(spec.name);
    in.match = QString::fromStdString(spec.match);
    in.qml = QString::fromStdString(spec.qml);
    in.after = spec.after;
    in.onSelection = spec.onSelection;
    in.inert = spec.inert;
    if (!spec.complete()) {
        logLine(QStringLiteral("inject: needs name= parent= qml="));
        return;
    }
    removeInjection(in.name);
    createInjection(in);
    injections() << in;
}

void uninjectCommand(const QStringList &w) {
    const QString name = arg(w, "name");
    if (removeInjection(name)) logLine(QStringLiteral("uninject %1: removed").arg(name));
    else logLine(QStringLiteral("uninject %1: no such injection").arg(name));
}

void createSelectionInjections() {
    for (Injection &in : injections()) {
        if (!in.onSelection || in.item) continue;
        QString spec = in.match;
        if (spec.endsWith(QLatin1Char('^'))) spec.chop(1);
        if (matchItems(spec).isEmpty()) continue;
        createInjection(in);
    }
}

void refreshAllInjections() {
    for (Injection &in : injections()) refreshInjected(in);
}

void injectTick() {
    static qint64 confMtime = -1, dockMtime = -1;
    static bool noInjectLogged = false;
    struct stat st;
    if (stat(kNoInject, &st) == 0) {
        if (!noInjectLogged) logLine(QStringLiteral("inject: %1 present; no injections").arg(QString::fromLatin1(kNoInject)));
        noInjectLogged = true;
        return;
    }
    const qint64 cm = stat(kInjectConf, &st) == 0 ? qint64(st.st_mtime) : 0;
    if (cm != confMtime) {
        confMtime = cm;
        QFile f(QString::fromLatin1(kInjectConf));
        if (cm && f.open(QIODevice::ReadOnly)) {
            for (const std::string &t : injectconf::requestLines(f.readAll().toStdString())) {
                const QString line = QString::fromStdString(t);
                logLine(QStringLiteral("inject.conf: %1").arg(line));
                injectCommand(fromStdWords(cmdline::words(t)));
            }
        }
    }
    const qint64 now = nowMs();
    for (Injection &in : injections()) {
        if (in.item || in.onSelection || now < in.nextTry) continue;
        if (createInjection(in)) {
            in.failures = 0;
        } else {
            ++in.failures;
            in.nextTry = now + (in.failures >= 10 ? 60000 : in.failures >= 3 ? 10000 : 0);
        }
    }
    const qint64 dm = stat(kDockJson, &st) == 0 ? qint64(st.st_mtime) : 0;
    if (dm != dockMtime) {
        dockMtime = dm;
        for (Injection &in : injections()) refreshInjected(in);
    }
}

}  // namespace cdl
