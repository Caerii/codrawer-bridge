// codrawer-layer: put a stroke onto the Paper Pro's open page, on its own layer, from inside
// xochitl.
//
// # The problem
//
// codrawer wants other participants' strokes (a phone, an agent) to appear natively on the
// reMarkable Paper Pro's open notebook page: on their own layer, saved in the page's `.rm`,
// undoable, synced, and all of that while the user keeps drawing with the real pen. The study in
// `docs/investigations/native-multiplayer-layer.md` found the native commit path:
// xochitl's QML hands every finished pen stroke to `SceneController::addDrawingLine(const Line&)`
// and then to `SceneTileManager::renderLineToTiles(Line)`. Both are in Qt meta-objects, so they
// can be called by name without any xochitl symbol (xochitl is a stripped PIE). The one unknown
// was how to obtain a `Line` that carries *our* points: nothing in QML builds one, and the type
// has no writable properties.
//
// This file is the probe that settles it. It is a XOVI extension (an `LD_PRELOAD`ed shared
// object loaded into xochitl by `xovi.so`, see `durable-install.md`). It hooks nothing.
//
// # How a Line is built (route 2: by layout)
//
// Route 1 was to feed points through xochitl's own pen pipeline. The pipeline's meta-objects
// (`PenInputSurface`, `ScenePenInputHandler`, `PenInputHandler`, `PenInput`, `Digitizer`) expose
// no point-accepting member: points arrive through C++ virtual calls from the digitizer thread
// (`DigitizerRM1xx::run` reading evdev). Reaching those means calling unexported virtuals by
// vtable slot or hooking libc `read` on the digitizer thread, which is the hot, blocking,
// multithreaded path inkling and XOVI's own README warn against. `dump` below records the
// pipeline's meta-objects on the device so that conclusion rests on the live build.
//
// Route 2 builds the value directly. The `Line` type is registered with `QMetaType`, so
// `QMetaType::fromName("Line").create()` runs xochitl's own default constructor. Its layout on
// this build was read from the default constructor, move constructor, equality operator and
// destructor in the binary (all reached through the `QMetaTypeInterface`), and every field this
// code writes is checked against that reading at run time before anything is committed:
//
//   offset  size  field                       evidence
//   0       4     Line::Color (default 9)     default ctor stores 9 = ArgbCode
//   4       4     Line::Tool                  operator== compares it
//   8       4     ARGB (default 0xff000000)   default ctor
//   16      24    QList<Point>  d, ptr, size  move ctor steals, dtor derefs d and frees 14-byte items
//   40      8     thickness (double, 1.0)     default ctor
//   48      4     starting length (float)     copied as a float
//   56      32    bounding rect (QRectF)      copied as two 16-byte words
//   88            sizeof(Line)                QMetaTypeInterface::size
//
// A Point is 14 packed bytes, the same record the `.rm` v6 file stores per point
// (`xochitl-pen-data.md`): f32 x, f32 y, u16 speed, u16 width (quarter pixels), u8 direction,
// u8 pressure. The `QList` is allocated by Qt's exported `QArrayData` allocator, so xochitl's
// destructor frees it the normal way. Nothing calls a function by address.
//
// `linetest` performs this construction and reads the result back through the `Line` gadget's
// own properties (`tool`, `pointCount`, `boundingRect`, `lineLength()`), without touching the
// scene. `stroke` commits it.
//
// # Control channel and threading
//
// A worker thread polls `/tmp/codrawer-layer/cmd` every 250 ms. A command file is read, removed,
// and executed on the GUI thread (`QMetaObject::invokeMethod` on the application object), because
// calling Qt Quick off the GUI thread crashes xochitl (inkling, smart_remarkable). Results are
// appended to `/tmp/codrawer-layer/log`. Every command is one short GUI-thread job, well inside
// xochitl's 60 s systemd watchdog.
//
// # Safety
//
// - Commands that change the scene name the page they expect (`page=<uuid>`) and refuse unless
//   the visible DocumentView *and* its SceneController are on that page.
// - The only scene changes are `addLayer`, `setLayerName` on the layer this extension created
//   (found by its name, "codrawer: test"), `setCurrentLayer`, and `addDrawingLine` into that
//   layer. The user's original layer is selected again before the job returns.
// - The pen's `lineArgbCode` is only written by `pencolor`, which reads it back and restores the
//   previous value in the same job.
//
// Build: `build.sh` (aarch64, Qt 6 headers). Install and use: `README.md`.

#include <QtCore/QCoreApplication>
#include <QtCore/QFile>
#include <QtCore/QMetaMethod>
#include <QtCore/QMetaProperty>
#include <QtCore/QMetaType>
#include <QtCore/QRectF>
#include <QtCore/QSequentialIterable>
#include <QtCore/QSet>
#include <QtCore/QVariant>
#include <QtGui/QGuiApplication>
#include <QtGui/QWindow>
#include <QtQuick/QQuickItem>
#include <QtQuick/QQuickWindow>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <functional>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace {

// ---------------------------------------------------------------------------------------------
// Logging. One line per fact, wall-clock stamped, to the log file and to stderr (the journal).

constexpr const char *kDir = "/tmp/codrawer-layer";
constexpr const char *kCmd = "/tmp/codrawer-layer/cmd";
constexpr const char *kLog = "/tmp/codrawer-layer/log";

// The layer this extension owns. It is found by this exact name, so a restart of xochitl (or of
// the extension) finds the same layer again instead of adding another.
const QString kLayerName() { return QStringLiteral("codrawer: test"); }

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

// A QVariant rendered for the log: plain values as text, QObject pointers as their class name,
// gadgets and lists by type name. Only used on values the caller chose to read.
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

// ---------------------------------------------------------------------------------------------
// Meta-object introspection (Probe 0).

const char *methodKind(QMetaMethod::MethodType k) {
    switch (k) {
    case QMetaMethod::Method: return "method";
    case QMetaMethod::Signal: return "signal";
    case QMetaMethod::Slot: return "slot";
    case QMetaMethod::Constructor: return "ctor";
    }
    return "?";
}

// Logs every class in `mo`'s chain down to (not including) QObject/QQuickItem: methods with
// their full signatures and return types, properties with type and access, enums with keys.
// `stopAtQt` keeps the dump to xochitl's own classes.
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

// Reads the named properties of `o` (a whitelist: reading arbitrary getters can block on
// xochitl's document worker) and logs them.
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

// ---------------------------------------------------------------------------------------------
// Finding the open page. xochitl's DocumentView (a QML FocusScope) is the item that has
// `controller`, `strokeHandler` and `pageId`; it keeps neighbouring pages' SceneViews alive, so
// the controller must be taken from the DocumentView, never by scanning for SceneControllers.

void collectItems(QQuickItem *item, QList<QQuickItem *> &out, int depth = 0) {
    if (!item || depth > 200) return;
    out << item;
    const auto kids = item->childItems();
    for (QQuickItem *c : kids) collectItems(c, out, depth + 1);
}

QList<QQuickItem *> allItems() {
    QList<QQuickItem *> out;
    const auto windows = QGuiApplication::allWindows();
    for (QWindow *w : windows) {
        if (auto *qw = qobject_cast<QQuickWindow *>(w)) collectItems(qw->contentItem(), out);
    }
    return out;
}

bool hasProps(const QObject *o, std::initializer_list<const char *> names) {
    for (const char *n : names) {
        if (o->metaObject()->indexOfProperty(n) < 0) return false;
    }
    return true;
}

struct OpenPage {
    QQuickItem *view = nullptr;  // DocumentView
    QObject *controller = nullptr;  // SceneController of the page on screen
    QObject *pen = nullptr;  // ScenePenInputHandler ("strokeHandler")
    QObject *tiles = nullptr;  // SceneTileManager
    QObject *viewport = nullptr;  // DeviceSceneViewport
    QString pageId;
};

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

// The open page, but only if it is `expectedPage`, visible, and its controller agrees.
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
// Calling meta-methods by name. Arguments are converted to the method's declared parameter
// types; the call is a direct QMetaObject::metacall on the GUI thread, which is exactly how a
// QML expression `controller.addLayer()` reaches the C++ side.

bool invoke(QObject *o, const char *name, QVariantList args, QVariant *ret = nullptr) {
    const QMetaObject *mo = o->metaObject();
    for (int i = mo->methodCount() - 1; i >= 0; --i) {
        const QMetaMethod m = mo->method(i);
        if (m.name() != name || m.parameterCount() != args.size()) continue;
        void *argv[11] = {nullptr};
        for (int a = 0; a < args.size(); ++a) {
            const QMetaType want = m.parameterMetaType(a);
            if (args[a].metaType() != want && !args[a].convert(want)) {
                logLine(QStringLiteral("invoke %1: cannot convert argument %2 to %3")
                            .arg(QString::fromLatin1(m.methodSignature())).arg(a).arg(QString::fromLatin1(want.name())));
                return false;
            }
            argv[a + 1] = args[a].data();
        }
        QVariant r;
        if (m.returnMetaType().isValid() && m.returnMetaType().id() != QMetaType::Void) {
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

// ---------------------------------------------------------------------------------------------
// Layers. `layerStates` is a QList<Scene::LayerState>; each state is a gadget. Its property
// names are logged by `dump`; we look for the first string property as the name.

struct LayerInfo {
    int index;
    QString name;
    QString raw;
};

QList<LayerInfo> layers(QObject *controller) {
    QList<LayerInfo> out;
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

// ---------------------------------------------------------------------------------------------
// Building a Line (route 2). See the table at the top of the file.

struct RmPoint {
    float x, y;  // scene coordinates: x centred on the page (−810..810), y down from the top
    quint16 speed;
    quint16 width;  // quarter pixels, as xochitl stores it
    quint8 direction;  // angle of travel, 0..255 = 0..2π
    quint8 pressure;  // 0..255
} __attribute__((packed));
static_assert(sizeof(RmPoint) == 14, "xochitl's Line point is 14 bytes");

constexpr int kLineSize = 88;
constexpr int kOffColor = 0, kOffTool = 4, kOffArgb = 8, kOffPoints = 16, kOffThickness = 40,
              kOffBounds = 56;

// What the default constructor must have produced on this build (offsets above). If any of it
// differs, the layout table is wrong for this xochitl and nothing is written.
bool defaultLooksRight(const unsigned char *p, QString &why) {
    quint32 color, tool, argb;
    double thick;
    quintptr d, ptr;
    qint64 size;
    std::memcpy(&color, p + kOffColor, 4);
    std::memcpy(&tool, p + kOffTool, 4);
    std::memcpy(&argb, p + kOffArgb, 4);
    std::memcpy(&d, p + kOffPoints, 8);
    std::memcpy(&ptr, p + kOffPoints + 8, 8);
    std::memcpy(&size, p + kOffPoints + 16, 8);
    std::memcpy(&thick, p + kOffThickness, 8);
    why = QStringLiteral("color=%1 tool=%2 argb=0x%3 list=(%4,%5,%6) thickness=%7")
              .arg(color).arg(tool).arg(argb, 8, 16, QLatin1Char('0'))
              .arg(d, 0, 16).arg(ptr, 0, 16).arg(size).arg(thick);
    return color == 9 && argb == 0xff000000u && d == 0 && size == 0 && thick == 1.0;
}

// The probe's stroke: a 3-period wave across the upper left of the page, 120 points, with a
// pressure taper at both ends. Hard-coded; integration will take points from the router.
QList<RmPoint> probeStroke(QRectF *bounds) {
    QList<RmPoint> pts;
    constexpr int n = 120;
    double minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (int i = 0; i < n; ++i) {
        const double t = double(i) / (n - 1);
        const double x = -560.0 + 420.0 * t;
        const double y = 330.0 + 45.0 * std::sin(t * 3 * 2 * M_PI);
        const double dx = 420.0, dy = 45.0 * 3 * 2 * M_PI * std::cos(t * 3 * 2 * M_PI);
        double ang = std::atan2(dy, dx);
        if (ang < 0) ang += 2 * M_PI;
        const double taper = std::min(1.0, std::min(t, 1.0 - t) * 10.0);
        RmPoint p;
        p.x = float(x);
        p.y = float(y);
        p.speed = quint16(12);
        p.width = quint16(16);  // fineliner, size 2: 4 px
        p.direction = quint8(std::lround(ang / (2 * M_PI) * 255.0) & 0xff);
        p.pressure = quint8(60 + std::lround(160 * taper));
        pts << p;
        minx = std::min(minx, x); maxx = std::max(maxx, x);
        miny = std::min(miny, y); maxy = std::max(maxy, y);
    }
    *bounds = QRectF(minx, miny, maxx - minx, maxy - miny);
    return pts;
}

QVariant readGadget(const QMetaType &lt, const void *line, const char *prop) {
    const QMetaObject *gm = lt.metaObject();
    const int i = gm ? gm->indexOfProperty(prop) : -1;
    return i < 0 ? QVariant() : gm->property(i).readOnGadget(line);
}

double gadgetLineLength(const QMetaType &lt, void *line) {
    const QMetaObject *gm = lt.metaObject();
    const int i = gm ? gm->indexOfMethod("lineLength()") : -1;
    if (i < 0) return -1;
    double len = -1;
    gm->method(i).invokeOnGadget(line, qReturnArg(len));
    return len;
}

// Builds a populated Line in `out` (a QVariant of type Line, so its lifetime is xochitl's normal
// value semantics). Logs every check; returns false and builds nothing if any check fails.
bool buildLine(int tool, quint32 argb, double thickness, QVariant &out) {
    const QMetaType lt = QMetaType::fromName("Line");
    if (!lt.isValid() || lt.sizeOf() != kLineSize) {
        logLine(QStringLiteral("line: type Line invalid or size %1 != %2").arg(lt.isValid() ? lt.sizeOf() : -1).arg(kLineSize));
        return false;
    }
    QVariant v(lt);  // xochitl's default constructor
    auto *p = static_cast<unsigned char *>(v.data());
    QString why;
    logLine(QStringLiteral("line: default bytes %1").arg(hex(p, kLineSize)));
    if (!defaultLooksRight(p, why)) {
        logLine(QStringLiteral("line: default Line does not match the layout table (%1); not building").arg(why));
        return false;
    }
    const int toolBefore = readGadget(lt, p, "tool").toInt();

    QRectF bounds;
    QList<RmPoint> pts = probeStroke(&bounds);
    const qsizetype n = pts.size();

    const quint32 colorArgbCode = 9;
    std::memcpy(p + kOffColor, &colorArgbCode, 4);
    std::memcpy(p + kOffTool, &tool, 4);
    std::memcpy(p + kOffArgb, &argb, 4);
    std::memcpy(p + kOffThickness, &thickness, 8);
    // Hand our QList's storage to the Line: placement-move into the (empty, null) slot.
    new (p + kOffPoints) QList<RmPoint>(std::move(pts));

    const int toolAfter = readGadget(lt, p, "tool").toInt();
    const int count = readGadget(lt, p, "pointCount").toInt();
    QRectF br = readGadget(lt, p, "boundingRect").toRectF();
    logLine(QStringLiteral("line: tool %1 -> %2 (wanted %3), pointCount %4 (wanted %5), boundingRect %6")
                .arg(toolBefore).arg(toolAfter).arg(tool).arg(count).arg(n).arg(show(br)));
    if (toolAfter != tool || count != n) {
        logLine(QStringLiteral("line: gadget does not read back what was written; not using it"));
        return false;
    }
    if (!br.contains(bounds.adjusted(1, 1, -1, -1))) {
        // The bounding rect is stored, not computed: fill it in the same way xochitl's pen
        // handler leaves it, then read it back.
        std::memcpy(p + kOffBounds, &bounds, sizeof(QRectF));
        br = readGadget(lt, p, "boundingRect").toRectF();
        logLine(QStringLiteral("line: bounds stored at +56; wrote %1, reads %2").arg(show(bounds), show(br)));
        if (!br.contains(bounds.adjusted(1, 1, -1, -1))) return false;
    }
    logLine(QStringLiteral("line: lineLength() %1, isHighlighter %2, built bytes %3")
                .arg(gadgetLineLength(lt, p))
                .arg(show(readGadget(lt, p, "isHighlighter")))
                .arg(hex(p, kLineSize)));
    out = v;
    return true;
}

// ---------------------------------------------------------------------------------------------
// Commands.

QString arg(const QStringList &words, const char *key) {
    const QString k = QString::fromLatin1(key) + QLatin1Char('=');
    for (const QString &w : words) {
        if (w.startsWith(k)) return w.mid(k.size());
    }
    return QString();
}

// Probe 0: the live object model.
void cmdDump() {
    const auto views = findDocumentViews();
    logLine(QStringLiteral("dump: %1 DocumentView(s)").arg(views.size()));
    for (const OpenPage &p : views) {
        logLine(QStringLiteral(" view %1 class=%2 page=%3 visible=%4")
                    .arg(quintptr(p.view), 0, 16).arg(QString::fromLatin1(p.view->metaObject()->className()))
                    .arg(p.pageId).arg(p.view->isVisible()));
        dumpValues(p.controller, "controller", {"pageId", "layerCount", "currentLayer", "undoAvailable",
                                                "redoAvailable", "boundingRect", "working", "updating"});
        dumpValues(p.pen, "penHandler", {"lineTool", "lineColor", "lineArgbCode", "lineThickness",
                                         "eraserTool", "gestureMode", "sampleRate", "antialiasing",
                                         "directColorPens", "pageLoading", "rightHandMode"});
        dumpValues(p.view, "view", {"penScale", "defaultScale", "zoomMode", "notePage"});
        if (p.controller) logLayers(p.controller, "now");
    }
    if (!views.isEmpty()) {
        const OpenPage &p = views.first();
        if (p.controller) dumpMetaObject(p.controller->metaObject(), "SceneController");
        if (p.pen) dumpMetaObject(p.pen->metaObject(), "penHandler");
        if (p.tiles) dumpMetaObject(p.tiles->metaObject(), "tileManager");
        if (p.viewport) dumpMetaObject(p.viewport->metaObject(), "viewport");
    }
    // The pen pipeline: is there any member that accepts points (route 1)?
    QSet<QByteArray> done;
    for (QQuickItem *it : allItems()) {
        const QByteArray cls = it->metaObject()->className();
        if ((cls.startsWith("PenInputSurface") || cls.contains("PenInput")) && !done.contains(cls)) {
            done.insert(cls);
            dumpMetaObject(it->metaObject(), cls.constData());
            for (const char *link : {"manager", "handler"}) {
                if (it->metaObject()->indexOfProperty(link) < 0) continue;
                if (QObject *o = it->property(link).value<QObject *>()) {
                    const QByteArray oc = o->metaObject()->className();
                    if (!done.contains(oc)) {
                        done.insert(oc);
                        dumpMetaObject(o->metaObject(), oc.constData());
                    }
                }
            }
        }
        if (it->metaObject()->indexOfProperty("penInput") >= 0) {
            if (QObject *pi = it->property("penInput").value<QObject *>()) {
                const QByteArray oc = pi->metaObject()->className();
                if (!done.contains(oc)) {
                    done.insert(oc);
                    dumpMetaObject(pi->metaObject(), oc.constData());
                }
            }
        }
    }
    const QMetaType lt = QMetaType::fromName("Line");
    logLine(QStringLiteral("Line metatype: valid=%1 id=%2 size=%3 align=%4 flags=0x%5")
                .arg(lt.isValid()).arg(lt.id()).arg(lt.sizeOf()).arg(lt.alignOf()).arg(uint(lt.flags()), 0, 16));
    if (lt.metaObject()) dumpMetaObject(lt.metaObject(), "Line (gadget)");
    for (const char *from : {"QVariantList", "QVariantMap", "QPolygonF", "QString", "QJsonObject", "QByteArray"}) {
        const QMetaType ft = QMetaType::fromName(from);
        logLine(QStringLiteral("Line converter from %1: %2").arg(QString::fromLatin1(from)).arg(QMetaType::canConvert(ft, lt)));
    }
    const QMetaType ls = QMetaType::fromName("Scene::LayerState");
    if (ls.isValid() && ls.metaObject()) dumpMetaObject(ls.metaObject(), "Scene::LayerState");
}

// Builds a Line and reads it back; touches no scene.
void cmdLineTest() {
    QVariant line;
    const bool ok = buildLine(/*Finelinerv2*/ 17, 0xff1f6fe0u, 2.0, line);
    logLine(QStringLiteral("linetest: %1").arg(ok ? "ok" : "FAILED"));
}

// Writes penHandler.lineArgbCode, reads it back, restores it.
void cmdPenColor(const QStringList &w) {
    const QString page = arg(w, "page");
    OpenPage p;
    if (!findOpenPage(page, p) || !p.pen) return;
    const QVariant before = p.pen->property("lineArgbCode");
    const quint32 want = arg(w, "argb").toUInt(nullptr, 16);
    const bool set = p.pen->setProperty("lineArgbCode", QVariant::fromValue(want));
    const QVariant during = p.pen->property("lineArgbCode");
    p.pen->setProperty("lineArgbCode", before);
    logLine(QStringLiteral("pencolor: before %1, set(0x%2)=%3 reads %4, restored reads %5")
                .arg(show(before)).arg(want, 8, 16, QLatin1Char('0')).arg(set)
                .arg(show(during), show(p.pen->property("lineArgbCode"))));
}

// Probe 1: own layer + one stroke, then the user's layer again.
void cmdStroke(const QStringList &w) {
    const QString page = arg(w, "page");
    OpenPage p;
    if (!findOpenPage(page, p)) return;
    QObject *c = p.controller;
    const int original = c->property("currentLayer").toInt();
    const QString originalName = [&] {
        for (const LayerInfo &l : layers(c)) if (l.index == original) return l.name;
        return QString();
    }();
    logLayers(c, "before");

    QVariant line;
    const quint32 argb = arg(w, "argb").isEmpty() ? 0xff1f6fe0u : arg(w, "argb").toUInt(nullptr, 16);
    if (!buildLine(/*Finelinerv2*/ 17, argb, 2.0, line)) {
        logLine(QStringLiteral("stroke: no Line, nothing changed"));
        return;
    }

    int ours = findLayer(c, kLayerName());
    if (ours < 0) {
        const int countBefore = c->property("layerCount").toInt();
        QVariant r;
        if (!invoke(c, "addLayer", {}, &r)) return;
        const int countAfter = c->property("layerCount").toInt();
        logLine(QStringLiteral("stroke: addLayer() -> %1, layerCount %2 -> %3, currentLayer now %4")
                    .arg(show(r)).arg(countBefore).arg(countAfter).arg(c->property("currentLayer").toInt()));
        if (countAfter != countBefore + 1) {
            logLine(QStringLiteral("stroke: layer count did not grow by one; stopping"));
            return;
        }
        // The new layer is the one whose state is new: find it as the unnamed/default-named
        // entry that was not there before. xochitl appends, so it is the last index.
        ours = countAfter - 1;
        invoke(c, "setLayerName", {ours, kLayerName()});
        if (findLayer(c, kLayerName()) != ours) {
            logLine(QStringLiteral("stroke: could not confirm the name on layer %1").arg(ours));
        }
    } else {
        logLine(QStringLiteral("stroke: reusing layer %1 \"%2\"").arg(ours).arg(kLayerName()));
    }

    // The user's layer index may have moved if the new layer was inserted below it.
    int restoreTo = original;
    if (!originalName.isEmpty()) {
        const int again = findLayer(c, originalName);
        if (again >= 0) restoreTo = again;
    }

    invoke(c, "setCurrentLayer", {ours});
    const bool undoBefore = c->property("undoAvailable").toBool();
    const bool added = invoke(c, "addDrawingLine", {line});
    bool tiled = false;
    if (p.tiles) tiled = invoke(p.tiles, "renderLineToTiles", {line});
    if (p.viewport) {
        // The handler in DocumentView.qml marks the stroke's view rect dirty and repaints; the
        // view transform lives in QML, so mark the whole viewport (one e-ink refresh).
        const QRectF all(0, 0, p.view->width(), p.view->height());
        invoke(p.viewport, "markDirty", {all});
        invoke(p.viewport, "requestRepaintDirty", {});
    }
    invoke(c, "setCurrentLayer", {restoreTo});
    logLine(QStringLiteral("stroke: addDrawingLine=%1 renderLineToTiles=%2 undoAvailable %3 -> %4; restored layer %5 (was %6 \"%7\")")
                .arg(added).arg(tiled).arg(undoBefore).arg(c->property("undoAvailable").toBool())
                .arg(c->property("currentLayer").toInt()).arg(original).arg(originalName));
    logLayers(c, "after");
}

void cmdLayers(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    logLayers(p.controller, "now");
    dumpValues(p.controller, "controller", {"pageId", "layerCount", "currentLayer", "undoAvailable", "redoAvailable"});
}

void runCommand(const QString &text) {
    for (const QString &rawLine : text.split(QLatin1Char('\n'), Qt::SkipEmptyParts)) {
        const QStringList w = rawLine.trimmed().split(QLatin1Char(' '), Qt::SkipEmptyParts);
        if (w.isEmpty()) continue;
        logLine(QStringLiteral("> %1").arg(rawLine.trimmed()));
        const QString c = w.first();
        if (c == QLatin1String("dump")) cmdDump();
        else if (c == QLatin1String("linetest")) cmdLineTest();
        else if (c == QLatin1String("pencolor")) cmdPenColor(w);
        else if (c == QLatin1String("stroke")) cmdStroke(w);
        else if (c == QLatin1String("layers")) cmdLayers(w);
        else logLine(QStringLiteral("unknown command %1").arg(c));
        logLine(QStringLiteral("< done %1").arg(c));
    }
}

// ---------------------------------------------------------------------------------------------
// The worker: wait for the application, then poll the command file.

void worker() {
    while (!QCoreApplication::instance()) usleep(200 * 1000);
    sleep(3);
    logLine(QStringLiteral("ready (pid %1), commands in %2").arg(getpid()).arg(QString::fromLatin1(kCmd)));
    for (;;) {
        usleep(250 * 1000);
        if (access(kCmd, F_OK) != 0) continue;
        QFile f(QString::fromLatin1(kCmd));
        if (!f.open(QIODevice::ReadOnly)) continue;
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        unlink(kCmd);
        QObject *app = QCoreApplication::instance();
        QMetaObject::invokeMethod(app, [text] { runCommand(text); }, Qt::QueuedConnection);
    }
}

}  // namespace

extern "C" void _xovi_construct() {
    mkdir(kDir, 0700);
    std::thread(worker).detach();
}
