// line.cpp: see line.h.
#include "line.h"

#include "log.h"
#include "paths.h"

#include <QtCore/QMetaMethod>
#include <QtCore/QMetaProperty>
#include <QtCore/QRectF>

#include <algorithm>
#include <cstdio>
#include <cstring>

namespace cdl {

using namespace linelayout;

QVariant readGadget(const QMetaType &lt, const void *line, const char *prop) {
    const QMetaObject *gm = lt.metaObject();
    const int i = gm ? gm->indexOfProperty(prop) : -1;
    return i < 0 ? QVariant() : gm->property(i).readOnGadget(line);
}

namespace {

double gadgetLineLength(const QMetaType &lt, void *line) {
    const QMetaObject *gm = lt.metaObject();
    const int i = gm ? gm->indexOfMethod("lineLength()") : -1;
    if (i < 0) return -1;
    double len = -1;
    gm->method(i).invokeOnGadget(line, qReturnArg(len));
    return len;
}

// The header as the refusal line describes it.
QString describeHeader(const Header &h) {
    return QStringLiteral("color=%1 tool=%2 argb=0x%3 list=(%4,%5,%6) thickness=%7")
        .arg(h.color).arg(h.tool).arg(h.argb, 8, 16, QLatin1Char('0'))
        .arg(h.listD, 0, 16).arg(h.listPtr, 0, 16).arg(h.listSize).arg(h.thickness);
}

}  // namespace

bool buildLine(int tool, quint32 argb, double thickness, QList<RmPoint> pts, QVariant &out, bool verbose) {
    const QMetaType lt = QMetaType::fromName("Line");
    if (!lt.isValid() || lt.sizeOf() != kLineSize) {
        logLine(QStringLiteral("line: type Line invalid or size %1 != %2").arg(lt.isValid() ? lt.sizeOf() : -1).arg(kLineSize));
        return false;
    }
    QVariant v(lt);  // xochitl's default constructor
    auto *p = static_cast<unsigned char *>(v.data());
    if (verbose) logLine(QStringLiteral("line: default bytes %1").arg(hex(p, kLineSize)));
    const Header h = readHeader(p);
    if (!defaultLooksRight(h)) {
        logLine(QStringLiteral("line: default Line does not match the layout table (%1); not building").arg(describeHeader(h)));
        return false;
    }
    const int toolBefore = readGadget(lt, p, "tool").toInt();
    if (quint32(toolBefore) != h.tool) {
        logLine(QStringLiteral("line: gadget tool %1 is not the word at +%2 (%3); not building").arg(toolBefore).arg(kOffTool).arg(h.tool));
        return false;
    }

    if (pts.isEmpty()) {
        logLine(QStringLiteral("line: no points; not building"));
        return false;
    }
    double minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const RmPoint &q : pts) {
        minx = std::min(minx, double(q.x)); maxx = std::max(maxx, double(q.x));
        miny = std::min(miny, double(q.y)); maxy = std::max(maxy, double(q.y));
    }
    const QRectF bounds(minx, miny, maxx - minx, maxy - miny);
    const qsizetype n = pts.size();

    writeHeader(p, tool, argb, thickness);
    // Hand our QList's storage to the Line: placement-move into the (empty, null) slot.
    new (p + kOffPoints) QList<RmPoint>(std::move(pts));

    const int toolAfter = readGadget(lt, p, "tool").toInt();
    const int count = readGadget(lt, p, "pointCount").toInt();
    QRectF br = readGadget(lt, p, "boundingRect").toRectF();
    if (verbose || toolAfter != tool || count != n) {
        logLine(QStringLiteral("line: tool %1 -> %2 (wanted %3), pointCount %4 (wanted %5), boundingRect %6")
                    .arg(toolBefore).arg(toolAfter).arg(tool).arg(count).arg(n).arg(show(br)));
    }
    if (toolAfter != tool || count != n) {
        logLine(QStringLiteral("line: gadget does not read back what was written; not using it"));
        return false;
    }
    // The gadget's rect must cover our points (it is padded by the stroke width). Compared by
    // edges with 1 px slack, so a straight or one-point stroke (zero width or height) passes.
    auto covers = [&bounds](const QRectF &r) {
        return r.left() <= bounds.left() + 1 && r.top() <= bounds.top() + 1 &&
               r.right() >= bounds.right() - 1 && r.bottom() >= bounds.bottom() - 1;
    };
    if (!covers(br)) {
        // The bounding rect is stored, not computed: fill it in the same way xochitl's pen
        // handler leaves it, then read it back.
        std::memcpy(p + kOffBounds, &bounds, sizeof(QRectF));
        br = readGadget(lt, p, "boundingRect").toRectF();
        logLine(QStringLiteral("line: bounds wrote %1, reads %2").arg(show(bounds), show(br)));
        if (!covers(br)) return false;
    }
    if (verbose) {
        logLine(QStringLiteral("line: lineLength() %1, isHighlighter %2, built bytes %3")
                    .arg(gadgetLineLength(lt, p))
                    .arg(show(readGadget(lt, p, "isHighlighter")))
                    .arg(hex(p, kLineSize)));
    }
    out = v;
    return true;
}

QString describeLine(const void *line, bool full) {
    const QMetaType lt = QMetaType::fromName("Line");
    if (!lt.isValid() || lt.sizeOf() != kLineSize) return QStringLiteral("<Line: unexpected type>");
    const int tool = readGadget(lt, line, "tool").toInt();
    const int count = readGadget(lt, line, "pointCount").toInt();
    const bool eraser = readGadget(lt, line, "isEraserTool").toBool();
    const QRectF br = readGadget(lt, line, "boundingRect").toRectF();
    double thickness = 0;
    std::memcpy(&thickness, static_cast<const unsigned char *>(line) + kOffThickness, 8);
    QString s = QStringLiteral("Line{tool=%1 eraser=%2 thickness=%3 points=%4 bounds=%5")
                    .arg(tool).arg(eraser).arg(thickness).arg(count).arg(show(br));
    const auto *pts = reinterpret_cast<const QList<RmPoint> *>(static_cast<const unsigned char *>(line) + kOffPoints);
    if (pts->size() != count) return s + QStringLiteral(" list=%1 (disagrees; points not read)}").arg(pts->size());
    if (count > 0) {
        const RmPoint &a = pts->first();
        const RmPoint &b = pts->last();
        s += QStringLiteral(" first=(%1,%2 w%3 p%4) last=(%5,%6 w%7 p%8)")
                 .arg(a.x).arg(a.y).arg(a.width).arg(a.pressure).arg(b.x).arg(b.y).arg(b.width).arg(b.pressure);
    }
    if ((eraser || full) && count > 0) {
        const QString path = QStringLiteral("%1/line-%2.txt").arg(QString::fromLatin1(kDir)).arg(nowMs());
        if (FILE *f = std::fopen(path.toUtf8().constData(), "w")) {
            std::fprintf(f, "# tool %d eraser %d thickness %g points %d\n", tool, int(eraser), thickness, count);
            for (const RmPoint &p : *pts) std::fprintf(f, "%.2f %.2f %u %u\n", p.x, p.y, unsigned(p.width), unsigned(p.pressure));
            std::fclose(f);
            s += QStringLiteral(" path=%1").arg(path);
        }
    }
    return s + QLatin1Char('}');
}

}  // namespace cdl
