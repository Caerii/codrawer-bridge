// log.cpp: see log.h.
#include "log.h"

#include "paths.h"

#include <QtCore/QMetaType>
#include <QtCore/QObject>
#include <QtCore/QPointF>
#include <QtCore/QRectF>

#include <cstdio>
#include <ctime>

namespace cdl {

void logLine(const QString &s) {
    timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    const QByteArray line = QStringLiteral("%1.%2 %3\n")
                                .arg(qint64(ts.tv_sec))
                                .arg(int(ts.tv_nsec / 1000000), 3, 10, QLatin1Char('0'))
                                .arg(s)
                                .toUtf8();
    if (FILE *f = std::fopen(kLog, "a")) {
        std::fwrite(line.constData(), 1, size_t(line.size()), f);
        std::fclose(f);
    }
    std::fprintf(stderr, "[codrawer-layer] %s", line.constData());
}

QString hex(const void *p, int n) {
    QString out;
    const auto *b = static_cast<const unsigned char *>(p);
    for (int i = 0; i < n; ++i) {
        if (i && i % 8 == 0) out += QLatin1Char(' ');
        out += QStringLiteral("%1").arg(b[i], 2, 16, QLatin1Char('0'));
    }
    return out;
}

QString show(const QVariant &v) {
    if (!v.isValid()) return QStringLiteral("<invalid>");
    const QMetaType t = v.metaType();
    if (t.flags() & QMetaType::PointerToQObject) {
        QObject *o = v.value<QObject *>();
        return o ? QStringLiteral("%1(%2)").arg(o->metaObject()->className()).arg(quintptr(o), 0, 16)
                 : QStringLiteral("null");
    }
    switch (t.id()) {
    case QMetaType::QRectF: {
        const QRectF r = v.toRectF();
        return QStringLiteral("QRectF(%1,%2 %3x%4)").arg(r.x()).arg(r.y()).arg(r.width()).arg(r.height());
    }
    case QMetaType::QPointF: {
        const QPointF p = v.toPointF();
        return QStringLiteral("QPointF(%1,%2)").arg(p.x()).arg(p.y());
    }
    case QMetaType::UInt:
        return QStringLiteral("0x%1").arg(v.toUInt(), 8, 16, QLatin1Char('0'));
    default:
        break;
    }
    if (v.canConvert<QString>() && !(t.flags() & QMetaType::IsGadget)) {
        return v.toString() + QStringLiteral(" [") + QString::fromLatin1(t.name()) + QLatin1Char(']');
    }
    return QStringLiteral("<%1>").arg(QString::fromLatin1(t.name()));
}

qint64 nowMs() {
    timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return qint64(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

}  // namespace cdl
