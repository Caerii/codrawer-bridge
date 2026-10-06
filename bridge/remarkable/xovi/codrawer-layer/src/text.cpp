// text.cpp: see text.h.
#include "text.h"

#include "log.h"
#include "qtmeta.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QPointer>
#include <QtCore/QStringList>
#include <QtGui/QGuiApplication>
#include <QtGui/QInputMethodEvent>
#include <QtGui/QKeyEvent>
#include <QtQuick/QQuickItem>
#include <QtQuick/QQuickWindow>

namespace cdl {

namespace {

// The active focus item of the focused window, if it is on the visible page and takes text.
QQuickItem *focusedTextItem(QString &why) {
    auto *qw = qobject_cast<QQuickWindow *>(QGuiApplication::focusWindow());
    if (!qw) {
        why = QStringLiteral("no focused window");
        return nullptr;
    }
    QQuickItem *it = qw->activeFocusItem();
    if (!it) {
        why = QStringLiteral("no focused item");
        return nullptr;
    }
    const QString cls = QString::fromLatin1(it->metaObject()->className());
    QQuickItem *view = followedView();
    if (!view || !view->isVisible()) {
        why = QStringLiteral("no visible page");
        return nullptr;
    }
    bool onPage = false;
    for (QQuickItem *p = it; p && !onPage; p = p->parentItem()) onPage = p == view;
    if (!onPage) {
        why = QStringLiteral("focused item %1 is not on the visible page").arg(cls);
        return nullptr;
    }
    const bool im = it->flags() & QQuickItem::ItemAcceptsInputMethod;
    if (!im && it->metaObject()->indexOfMethod("insert(int,QString)") < 0) {
        why = QStringLiteral("focused item %1 takes no text").arg(cls);
        return nullptr;
    }
    return it;
}

void sendKey(QQuickItem *it, int key, const QString &text) {
    QKeyEvent press(QEvent::KeyPress, key, Qt::NoModifier, text);
    QCoreApplication::sendEvent(it, &press);
    QKeyEvent release(QEvent::KeyRelease, key, Qt::NoModifier, text);
    QCoreApplication::sendEvent(it, &release);
}

}  // namespace

QString textInsert(const QString &text) {
    if (userTouching()) return QStringLiteral("err pen or finger on the page");  // the write-back guard
    QString why;
    QQuickItem *it = focusedTextItem(why);
    if (!it) return QStringLiteral("err ") + why;
    const QString cls = QString::fromLatin1(it->metaObject()->className());
    if (it->flags() & QQuickItem::ItemAcceptsInputMethod) {
        const QStringList lines = text.split(QLatin1Char('\n'));
        for (int i = 0; i < lines.size(); ++i) {
            if (i > 0) sendKey(it, Qt::Key_Return, QStringLiteral("\r"));
            if (lines[i].isEmpty()) continue;
            QInputMethodEvent ev;
            ev.setCommitString(lines[i]);
            QCoreApplication::sendEvent(it, &ev);
        }
        logLine(QStringLiteral("text: inserted %1 chars into %2 via input method").arg(text.size()).arg(cls));
        return QStringLiteral("ok text_insert %1 via=im").arg(text.size());
    }
    const int pos = it->property("cursorPosition").toInt();
    invoke(it, "insert", {pos, text});
    logLine(QStringLiteral("text: inserted %1 chars into %2 at %3 via insert()").arg(text.size()).arg(cls).arg(pos));
    return QStringLiteral("ok text_insert %1 via=insert").arg(text.size());
}

bool textInsertRouteA(const QString &text, std::function<void(const QString &)> reply) {
    QQuickItem *view = followedView();
    if (!view || !view->isVisible()) return false;
    QPointer<QObject> c = view->property("controller").value<QObject *>();
    if (!c || c->metaObject()->indexOfMethod("replaceText(QString)") < 0) return false;
    const QVariant docId = c->property("textDocumentId");
    if (!docId.isValid() || docId.isNull() || docId.toString().isEmpty() || docId.toString() == QLatin1String("0:0")) return false;
    const QString page = view->property("pageId").toString();
    const int len0 = c->property("rootDocumentLength").toInt();
    const int cur0 = c->property("textCursorIndex").toInt();
    const bool txn = c->metaObject()->indexOfMethod("beginInputMethodTransaction()") >= 0 &&
                     c->metaObject()->indexOfMethod("endInputMethodTransaction()") >= 0;
    if (txn) invoke(c, "beginInputMethodTransaction", {});
    const QStringList lines = text.split(QLatin1Char('\n'));
    for (int i = 0; i < lines.size(); ++i) {
        if (i > 0) invoke(c, "replaceText", {QStringLiteral("\n")});
        if (!lines[i].isEmpty()) invoke(c, "replaceText", {lines[i]});
    }
    if (txn) invoke(c, "endInputMethodTransaction", {});
    const int want = len0 + int(text.size());
    waitFor([c, want] { return !c || c->property("rootDocumentLength").toInt() >= want; }, 1500,
            [c, len0, cur0, want, text, page, txn, reply](bool) {
                const int len1 = c ? c->property("rootDocumentLength").toInt() : -1;
                const int cur1 = c ? c->property("textCursorIndex").toInt() : -1;
                const bool ok = len1 == want;
                logLine(QStringLiteral("text: replaceText %1 chars on page %2, txn=%3: length %4 -> %5 (want %6), cursor %7 -> %8%9")
                            .arg(text.size()).arg(page).arg(txn).arg(len0).arg(len1).arg(want).arg(cur0).arg(cur1)
                            .arg(ok ? QString() : QStringLiteral(" UNVERIFIED")));
                reply(QStringLiteral("ok text_insert %1 via=replace%2 len %3->%4")
                          .arg(text.size()).arg(ok ? QString() : QStringLiteral(" unverified")).arg(len0).arg(len1));
            });
    return true;
}

QString textRead() {
    QString why;
    QQuickItem *it = focusedTextItem(why);
    if (!it) return QStringLiteral("err ") + why;
    QJsonObject o{{QStringLiteral("class"), QString::fromLatin1(it->metaObject()->className())}};
    QInputMethodQueryEvent q(Qt::ImSurroundingText | Qt::ImCursorPosition | Qt::ImCurrentSelection);
    QCoreApplication::sendEvent(it, &q);
    o.insert(QStringLiteral("surrounding"), q.value(Qt::ImSurroundingText).toString());
    o.insert(QStringLiteral("cursor"), q.value(Qt::ImCursorPosition).toInt());
    o.insert(QStringLiteral("selection"), q.value(Qt::ImCurrentSelection).toString());
    if (it->metaObject()->indexOfProperty("text") >= 0) o.insert(QStringLiteral("text"), it->property("text").toString());
    QQuickItem *view = followedView();
    if (QObject *c = view ? view->property("controller").value<QObject *>() : nullptr) {
        o.insert(QStringLiteral("root_length"), c->property("rootDocumentLength").toInt());
        o.insert(QStringLiteral("root_cursor"), c->property("textCursorIndex").toInt());
        o.insert(QStringLiteral("root_document"), c->property("textDocumentId").toString());
    }
    return QStringLiteral("text ") + QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

}  // namespace cdl
