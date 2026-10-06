// grab.cpp: see grab.h.
#include "grab.h"

#include "log.h"
#include "paths.h"
#include "procmaps.h"

#include <QtCore/QCoreApplication>
#include <QtGui/QImage>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <thread>

namespace cdl {

namespace {

struct GrabRegion {
    const unsigned char *base = nullptr;
    size_t size = 0;
};

// The display buffer: the first mapping in /proc/self/maps that procmaps::frameMapping accepts.
GrabRegion displayBuffer() {
    FILE *f = std::fopen("/proc/self/maps", "r");
    if (!f) return {};
    char line[512];
    GrabRegion r;
    while (std::fgets(line, sizeof line, f)) {
        uintptr_t base = 0;
        size_t size = 0;
        if (procmaps::frameMapping(line, base, size)) {
            r.base = reinterpret_cast<const unsigned char *>(base);
            r.size = size;
            break;
        }
    }
    std::fclose(f);
    return r;
}

}  // namespace

void grab(const QJsonObject &req, std::function<void(QJsonObject)> answer) {
    const GrabRegion r = displayBuffer();
    if (!r.base) {
        answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("display buffer not found")}});
        return;
    }
    const int x = std::clamp(req.value(QStringLiteral("x")).toInt(0), 0, 1619);
    const int y = std::clamp(req.value(QStringLiteral("y")).toInt(0), 0, 2159);
    const int w = std::clamp(req.value(QStringLiteral("w")).toInt(1620), 1, 1620 - x);
    const int h = std::clamp(req.value(QStringLiteral("h")).toInt(2160), 1, 2160 - y);
    // Copy on the GUI thread (a few MB at most), encode off it.
    QImage img(w, h, QImage::Format_RGB32);
    for (int row = 0; row < h; ++row) {
        const unsigned char *src = r.base + size_t(y + row) * procmaps::kStride + size_t(x) * 4;
        std::memcpy(img.scanLine(row), src, size_t(w) * 4);
    }
    const QString path = QStringLiteral("%1/grab-%2.png").arg(QString::fromLatin1(kDir)).arg(nowMs());
    std::thread([img, path, answer, w, h] {
        const bool ok = img.save(path, "PNG");
        QMetaObject::invokeMethod(QCoreApplication::instance(), [ok, path, answer, w, h] {
            answer(QJsonObject{{QStringLiteral("ok"), ok}, {QStringLiteral("png"), path}, {QStringLiteral("w"), w}, {QStringLiteral("h"), h}});
        }, Qt::QueuedConnection);
    }).detach();
}

}  // namespace cdl
