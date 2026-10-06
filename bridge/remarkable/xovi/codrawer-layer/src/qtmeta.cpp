// qtmeta.cpp: see qtmeta.h.
#include "qtmeta.h"

#include "log.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QMetaProperty>
#include <QtCore/QStringList>
#include <QtCore/QTimer>

namespace cdl {

// ---------------------------------------------------------------------------------------------
// Introspection (the `dump` probe).

namespace {

const char *methodKind(QMetaMethod::MethodType k) {
    switch (k) {
    case QMetaMethod::Method: return "method";
    case QMetaMethod::Signal: return "signal";
    case QMetaMethod::Slot: return "slot";
    case QMetaMethod::Constructor: return "ctor";
    }
    return "?";
}

}  // namespace

void dumpMetaObject(const QMetaObject *mo, const char *label) {
    logLine(QStringLiteral("== meta %1").arg(QString::fromLatin1(label)));
    for (const QMetaObject *m = mo; m; m = m->superClass()) {
        const QByteArray cls = m->className();
        if (cls == "QObject" || cls == "QQuickItem" || cls == "QQuickPaintedItem") {
            logLine(QStringLiteral("   (base %1)").arg(QString::fromLatin1(cls)));
            break;
        }
        logLine(QStringLiteral("   class %1  methods %2..%3  properties %4..%5  ctors %6")
                    .arg(QString::fromLatin1(cls))
                    .arg(m->methodOffset()).arg(m->methodCount() - 1)
                    .arg(m->propertyOffset()).arg(m->propertyCount() - 1)
                    .arg(m->constructorCount()));
        for (int i = 0; i < m->constructorCount(); ++i) {
            logLine(QStringLiteral("     ctor %1").arg(QString::fromLatin1(m->constructor(i).methodSignature())));
        }
        for (int i = m->methodOffset(); i < m->methodCount(); ++i) {
            const QMetaMethod mm = m->method(i);
            logLine(QStringLiteral("     %1 #%2 %3 %4")
                        .arg(QString::fromLatin1(methodKind(mm.methodType())))
                        .arg(i)
                        .arg(QString::fromLatin1(mm.typeName()))
                        .arg(QString::fromLatin1(mm.methodSignature())));
        }
        for (int i = m->propertyOffset(); i < m->propertyCount(); ++i) {
            const QMetaProperty p = m->property(i);
            logLine(QStringLiteral("     prop #%1 %2 %3 %4%5")
                        .arg(i)
                        .arg(QString::fromLatin1(p.typeName()))
                        .arg(QString::fromLatin1(p.name()))
                        .arg(p.isReadable() ? "r" : "-")
                        .arg(p.isWritable() ? "w" : "-"));
        }
        for (int i = m->enumeratorOffset(); i < m->enumeratorCount(); ++i) {
            const QMetaEnum e = m->enumerator(i);
            QStringList keys;
            for (int k = 0; k < e.keyCount(); ++k) {
                keys << QStringLiteral("%1=%2").arg(QString::fromLatin1(e.key(k))).arg(e.value(k));
            }
            logLine(QStringLiteral("     enum %1 { %2 }").arg(QString::fromLatin1(e.name()), keys.join(QStringLiteral(", "))));
        }
    }
}

void dumpValues(QObject *o, const char *label, std::initializer_list<const char *> names) {
    if (!o) return;
    QStringList parts;
    for (const char *n : names) {
        if (o->metaObject()->indexOfProperty(n) < 0) {
            parts << QStringLiteral("%1=<none>").arg(QString::fromLatin1(n));
            continue;
        }
        parts << QStringLiteral("%1=%2").arg(QString::fromLatin1(n), show(o->property(n)));
    }
    logLine(QStringLiteral("   values %1: %2").arg(QString::fromLatin1(label), parts.join(QStringLiteral("  "))));
}

bool hasProps(const QObject *o, std::initializer_list<const char *> names) {
    for (const char *n : names) {
        if (o->metaObject()->indexOfProperty(n) < 0) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Calling by name.

bool invoke(QObject *o, const char *name, QVariantList args, QVariant *ret) {
    const QMetaObject *mo = o->metaObject();
    for (int i = mo->methodCount() - 1; i >= 0; --i) {
        const QMetaMethod m = mo->method(i);
        if (m.name() != name || m.parameterCount() != args.size()) continue;
        void *argv[11] = {nullptr};
        QVariantList conv = args;  // per overload: a failed conversion must not alter the next try
        bool fits = true;
        for (int a = 0; a < conv.size() && fits; ++a) {
            const QMetaType want = m.parameterMetaType(a);
            if (want.id() == QMetaType::QVariant) {
                // A QML function's untyped parameter: the slot takes the QVariant itself.
                argv[a + 1] = &conv[a];
                continue;
            }
            fits = conv[a].metaType() == want || conv[a].convert(want);
            argv[a + 1] = conv[a].data();
        }
        if (!fits) continue;  // another overload (sceneToView(QPointF) vs (QRectF)) may take them
        QVariant r;
        if (m.returnMetaType().isValid() && m.returnMetaType().id() == QMetaType::QVariant) {
            argv[0] = &r;  // a QML function's return value: written into r itself
        } else if (m.returnMetaType().isValid() && m.returnMetaType().id() != QMetaType::Void) {
            r = QVariant(m.returnMetaType());
            argv[0] = r.data();
        }
        QMetaObject::metacall(o, QMetaObject::InvokeMetaMethod, m.methodIndex(), argv);
        if (ret) *ret = r;
        return true;
    }
    logLine(QStringLiteral("invoke: %1 has no %2/%3").arg(QString::fromLatin1(mo->className()), QString::fromLatin1(name)).arg(args.size()));
    return false;
}

QJsonValue firstProp(QObject *o, std::initializer_list<const char *> names) {
    if (!o) return QJsonValue();
    for (const char *n : names) {
        if (o->metaObject()->indexOfProperty(n) < 0) continue;
        const QVariant v = o->property(n);
        if (!v.isValid()) continue;
        if (v.metaType().id() == QMetaType::Bool) return v.toBool();
        bool num = false;
        const double d = v.toDouble(&num);
        if (num && v.metaType().id() != QMetaType::QString) return d;
        if (v.canConvert<QString>()) return v.toString();
    }
    return QJsonValue();
}

// ---------------------------------------------------------------------------------------------
// Relay.

bool Relay::on(QObject *sender, const QMetaMethod &signal, Fn fn) {
    if (!sender || signal.methodType() != QMetaMethod::Signal) return false;
    const int slot = QObject::staticMetaObject.methodCount() + int(fns_.size());
    fns_.push_back(std::move(fn));
    if (!QMetaObject::connect(sender, signal.methodIndex(), this, slot, Qt::DirectConnection)) {
        fns_.back() = nullptr;
        return false;
    }
    return true;
}

QMetaMethod Relay::notifyOf(QObject *sender, const char *name) {
    const int i = sender ? sender->metaObject()->indexOfProperty(name) : -1;
    return i < 0 ? QMetaMethod() : sender->metaObject()->property(i).notifySignal();
}

QMetaMethod Relay::signalNamed(QObject *sender, const char *name) {
    const QMetaObject *mo = sender ? sender->metaObject() : nullptr;
    for (int i = 0; mo && i < mo->methodCount(); ++i) {
        const QMetaMethod m = mo->method(i);
        if (m.methodType() == QMetaMethod::Signal && m.name() == name) return m;
    }
    return QMetaMethod();
}

int Relay::qt_metacall(QMetaObject::Call call, int id, void **a) {
    id = QObject::qt_metacall(call, id, a);
    if (id < 0 || call != QMetaObject::InvokeMetaMethod) return id;
    if (id < int(fns_.size()) && fns_[size_t(id)]) fns_[size_t(id)](a);
    return -1;
}

// ---------------------------------------------------------------------------------------------
// Waiting without blocking.

void waitFor(std::function<bool()> cond, int timeoutMs, std::function<void(bool)> then) {
    if (cond()) {
        then(true);
        return;
    }
    const qint64 start = nowMs();
    auto *t = new QTimer(QCoreApplication::instance());
    t->setInterval(20);
    QObject::connect(t, &QTimer::timeout, [t, start, timeoutMs, cond, then] {
        const bool ok = cond();
        if (!ok && nowMs() - start < timeoutMs) return;
        t->stop();
        t->deleteLater();
        then(ok);
    });
    t->start();
}

}  // namespace cdl
