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
// code writes is checked against that reading at run time before anything is committed. The
// first device run (3.29.0.149, 2026-10-06) corrected the static reading: the default
// constructor's 9 at +0 is the *tool* (the gadget's `tool` read 9 before and after we wrote 17
// at +4), and +4 is the colour. The check below caught it and nothing was committed.
//
//   offset  size  field                       evidence
//   0       4     Line::Tool (default 9)      the gadget's `tool` reads this word (device, Probe 1)
//   4       4     Line::Color (default 0)     Black by default; 9 = ArgbCode makes +8 the colour
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
// xochitl's 60 s systemd watchdog. A second thread serves the agent ink socket
// (/run/codrawer/ink.sock, section "The agent ink socket"); it too only parses and posts work to
// the GUI thread, where a commit runs as a chain of short timer steps (section "Committing ink").
//
// # Safety
//
// - Commands that change the scene name the page they expect (`page=<uuid>`) and refuse unless
//   the visible DocumentView *and* its SceneController are on that page.
// - The only scene changes are `addLayer`, `setLayerName` on the layer this extension created
//   (found by its name: "codrawer: test" for the probe, "codrawer: agent" for agent ink),
//   `setCurrentLayer`, and `addDrawingLine` into that layer. The user's layer is selected again
//   (found by its name, since indices move) before the commit reports back.
// - Nothing is committed while the user's pen or finger is on the page (the write-back guard,
//   `userTouching`): agent ink waits for the pen to lift, text insertion is refused.
// - Text goes only into the focused text item of the visible page (`focusedTextItem`).
// - Injected UI is our own QML, created at run time; nothing of xochitl's on disk changes.
// - The pen's `lineArgbCode` is only written by `pencolor`, which reads it back and restores the
//   previous value in the same job.
//
// # Watching erasures (the erase probe, `docs/investigations/native-erase.md`)
//
// The page's true state reaches codrawer only when xochitl saves the `.rm` (seconds to a minute
// after the user pauses), so an erase shows late everywhere but on the tablet. xochitl's QML
// commits an erase in `DocumentView.onStrokeCompleted`: when the pen lifts, a stroke whose
// `isEraserTool` is true goes to `SceneController::eraseWithLine(Line)` (the scene job splits the
// lines it covers), and the `Line` it passes carries the eraser's exact path and thickness. Saves
// are xochitl's own `StoreLines` jobs on the `DocumentWorker`, which reports them with
// `linesStored(page, pageId, size)`.
//
// `watch` connects a logging receiver to those signals, without hooking any function: the pen
// handler's `strokeCompleted(Line)` (decoded: tool, eraser or not, thickness, point count, bounds,
// and for erasers the whole path, written to a file), every signal of the page's SceneController
// (`documentContentChanged`, `updated`, `undoAvailableChanged`, …), of its DocumentWorker
// (`contentsUpdated`, `linesStored`, `hasPendingChanged`, `jobQueueSizeChanged`, …) and of the
// document's `QmlDocumentWrapper` and `DocumentLockManager` if they are found. The receiver is a
// QObject whose `qt_metacall` takes the connected signals as extra methods (the way Qt's own
// QSignalSpy works); it runs in the emitting thread, only formats values it knows, and is
// rate-limited per signal. `unwatch` disconnects it.
//
// `save` asks xochitl to store pending lines now, through one of a short list of xochitl's own
// meta-methods named explicitly (`via=`), and logs the worker's state before and after; with
// `watch` on, `linesStored` shows whether it worked and how long the store took. `pending` logs
// that state alone. None of these change page content.
//
// # Following the tool
//
// evdev shows the bridge the Marker's eraser end, but not the eraser picked in the toolbar and
// used with the tip. From load on, a 100 ms GUI-thread timer copies the pen handler's `lineTool`
// to /run/codrawer/tool, which the bridge reads at each pen-down (section "Following the tool").
// This is the one thing the extension does without a command, and it only reads properties.
//
// Build: `build.sh` (aarch64, Qt 6 headers). Install and use: `README.md`.

#include "auto_rules.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QFile>
#include <QtCore/QJsonArray>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QMetaMethod>
#include <QtCore/QMetaProperty>
#include <QtCore/QMetaType>
#include <QtCore/QMutex>
#include <QtCore/QPointer>
#include <QtCore/QRectF>
#include <QtCore/QSequentialIterable>
#include <QtCore/QSet>
#include <QtCore/QTimer>
#include <QtCore/QVariant>
#include <QtGui/QTransform>
#include <QtQml/QQmlComponent>
#include <QtQml/QQmlContext>
#include <QtQml/QQmlEngine>
#include <QtGui/QGuiApplication>
#include <QtGui/QImage>
#include <QtGui/QMouseEvent>
#include <QtGui/QInputMethodEvent>
#include <QtGui/QKeyEvent>
#include <QtGui/QWindow>
#include <QtQuick/QQuickItem>
#include <QtQuick/QQuickWindow>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <functional>
#include <memory>
#include <mutex>
#include <utime.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

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
        QVariantList conv = args;  // per overload: a failed conversion must not alter the next try
        bool fits = true;
        for (int a = 0; a < conv.size() && fits; ++a) {
            const QMetaType want = m.parameterMetaType(a);
            fits = conv[a].metaType() == want || conv[a].convert(want);
            argv[a + 1] = conv[a].data();
        }
        if (!fits) continue;  // another overload (sceneToView(QPointF) vs (QRectF)) may take them
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
    // On 3.29.0.149 `layerStates` reads as an invalid QVariant from C++ (it is not a registered
    // sequential type there), but the controller has a slot `QString layerName(int)`.
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
constexpr int kOffTool = 0, kOffColor = 4, kOffArgb = 8, kOffPoints = 16, kOffThickness = 40,
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
    return color < 16 && tool < 25 && argb == 0xff000000u && d == 0 && size == 0 && thick == 1.0;
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
// value semantics). Returns false and builds nothing if any check fails, and logs why; with
// `verbose` (the probe commands) it also logs the raw bytes and every read-back.
bool buildLine(int tool, quint32 argb, double thickness, QList<RmPoint> pts, QVariant &out, bool verbose = true) {
    const QMetaType lt = QMetaType::fromName("Line");
    if (!lt.isValid() || lt.sizeOf() != kLineSize) {
        logLine(QStringLiteral("line: type Line invalid or size %1 != %2").arg(lt.isValid() ? lt.sizeOf() : -1).arg(kLineSize));
        return false;
    }
    QVariant v(lt);  // xochitl's default constructor
    auto *p = static_cast<unsigned char *>(v.data());
    QString why;
    if (verbose) logLine(QStringLiteral("line: default bytes %1").arg(hex(p, kLineSize)));
    if (!defaultLooksRight(p, why)) {
        logLine(QStringLiteral("line: default Line does not match the layout table (%1); not building").arg(why));
        return false;
    }
    const int toolBefore = readGadget(lt, p, "tool").toInt();
    quint32 toolWordAt0;
    std::memcpy(&toolWordAt0, p + kOffTool, 4);
    if (quint32(toolBefore) != toolWordAt0) {
        logLine(QStringLiteral("line: gadget tool %1 is not the word at +%2 (%3); not building").arg(toolBefore).arg(kOffTool).arg(toolWordAt0));
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
        logLine(QStringLiteral("line: bounds stored at +56; wrote %1, reads %2").arg(show(bounds), show(br)));
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
    QRectF unused;
    const bool ok = buildLine(/*Finelinerv2*/ 17, 0xff1f6fe0u, 2.0, probeStroke(&unused), line);
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

void cmdLayers(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    logLayers(p.controller, "now");
    dumpValues(p.controller, "controller", {"pageId", "layerCount", "currentLayer", "undoAvailable", "redoAvailable"});
}

// ---------------------------------------------------------------------------------------------
// Watching (erase probe). See "Watching erasures" at the top of the file.

qint64 nowMs() {
    timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return qint64(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

// Every QObject reachable from the windows' item trees and the application object, once each.
// QML puts non-visual objects (a DocumentLockManager, a QmlDocumentWrapper) under the item that
// declares them, so `findChildren` from each window's content item reaches them.
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

// A `Line` passed by a signal (strokeCompleted), read in place: its gadget properties, its
// thickness (+40, a double) and its points (the QList<RmPoint> at +16), the layout `buildLine`
// checks. The points are read only when the gadget's own `pointCount` agrees with the list.
// Eraser paths, and every path with `full`, are written whole to a file for calibration
// (x y in scene px, width in quarter px, pressure 0..255): the exact input to eraseWithLine.
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

// One signal argument for the log. Only types we can format without side effects are read;
// everything else is named.
QString showArg(const QMetaType &t, void *p, bool full) {
    if (!p) return QStringLiteral("<null>");
    if (qstrcmp(t.name(), "Line") == 0) return describeLine(p, full);
    if (t.flags() & QMetaType::PointerToQObject) {
        QObject *o = *static_cast<QObject **>(p);
        return o ? QStringLiteral("%1(%2)").arg(QString::fromLatin1(o->metaObject()->className())).arg(quintptr(o), 0, 16)
                 : QStringLiteral("null");
    }
    if (t.flags() & QMetaType::IsEnumeration) {
        qint64 v = 0;
        std::memcpy(&v, p, std::min<qsizetype>(t.sizeOf(), 8));
        return QStringLiteral("%1(%2)").arg(QString::fromLatin1(t.name())).arg(v);
    }
    switch (t.id()) {
    case QMetaType::Bool: case QMetaType::Int: case QMetaType::UInt: case QMetaType::LongLong:
    case QMetaType::ULongLong: case QMetaType::Double: case QMetaType::Float: case QMetaType::QString:
    case QMetaType::QRectF: case QMetaType::QRect: case QMetaType::QPointF: case QMetaType::QSizeF:
        return show(QVariant(t, p));
    default:
        return QStringLiteral("<%1>").arg(QString::fromLatin1(t.name()));
    }
}

// The logging receiver. Each hooked signal is one extra method of this object: QObject's own
// methods come first, then hook 0, 1, … (QMetaObject::connect by index, as QSignalSpy does).
// `qt_metacall` runs in whichever thread emitted the signal (DocumentWorker signals come from
// its thread), so the hook table is guarded and the formatting reads only the arguments.
class Spy : public QObject {
public:
    struct Hook {
        QPointer<QObject> sender;
        int signalIndex = -1;
        QMetaMethod signal;
        QByteArray label;
        bool full = false;
        qint64 windowMs = 0;  // rate limit: at most kPerSecond lines per signal per second
        int inWindow = 0;
        int suppressed = 0;
    };
    static constexpr int kPerSecond = 20;

    bool hook(QObject *sender, const QMetaMethod &sig, const QByteArray &label, bool full = false) {
        QMutexLocker lock(&mutex_);
        const int slot = QObject::staticMetaObject.methodCount() + int(hooks_.size());
        Hook h;
        h.sender = sender;
        h.signalIndex = sig.methodIndex();
        h.signal = sig;
        h.label = label;
        h.full = full;
        hooks_.append(h);
        if (!QMetaObject::connect(sender, sig.methodIndex(), this, slot, Qt::DirectConnection)) {
            hooks_.removeLast();
            return false;
        }
        return true;
    }

    int unhookAll() {
        QMutexLocker lock(&mutex_);
        const int base = QObject::staticMetaObject.methodCount();
        int n = 0;
        for (int i = 0; i < hooks_.size(); ++i) {
            if (hooks_[i].sender && QMetaObject::disconnect(hooks_[i].sender, hooks_[i].signalIndex, this, base + i)) ++n;
        }
        hooks_.clear();
        return n;
    }

    int count() {
        QMutexLocker lock(&mutex_);
        return int(hooks_.size());
    }

    int qt_metacall(QMetaObject::Call call, int id, void **a) override {
        id = QObject::qt_metacall(call, id, a);
        if (id < 0 || call != QMetaObject::InvokeMetaMethod) return id;
        fire(id, a);
        return -1;
    }

private:
    void fire(int id, void **a) {
        QString text;
        {
            QMutexLocker lock(&mutex_);
            if (id >= hooks_.size()) return;
            Hook &h = hooks_[id];
            const qint64 now = nowMs();
            if (now - h.windowMs >= 1000) {
                if (h.suppressed) text = QStringLiteral("(%1 more %2 in the last second) ").arg(h.suppressed).arg(QString::fromLatin1(h.signal.name()));
                h.windowMs = now;
                h.inWindow = 0;
                h.suppressed = 0;
            }
            if (++h.inWindow > kPerSecond) {
                ++h.suppressed;
                return;
            }
            QStringList args;
            for (int i = 0; i < h.signal.parameterCount(); ++i) {
                args << QStringLiteral("%1=%2").arg(QString::fromLatin1(h.signal.parameterNames().value(i)),
                                                     showArg(h.signal.parameterMetaType(i), a[i + 1], h.full));
            }
            text += QStringLiteral("signal %1.%2(%3)").arg(QString::fromLatin1(h.label), QString::fromLatin1(h.signal.name()), args.join(QStringLiteral(", ")));
        }
        logLine(text);
    }

    QMutex mutex_;
    QList<Hook> hooks_;
};

// Created on first use by a command, so on the GUI thread; lives as long as xochitl.
Spy *spy() {
    static Spy *s = new Spy;
    return s;
}

// Hooks every signal `o`'s own classes declare (stopping at Qt's base classes), except `skip`.
int hookAllSignals(QObject *o, const char *label, std::initializer_list<const char *> skip = {}) {
    if (!o) return 0;
    int n = 0;
    for (const QMetaObject *m = o->metaObject(); m; m = m->superClass()) {
        const QByteArray cls = m->className();
        if (cls == "QObject" || cls == "QQuickItem" || cls == "QQuickPaintedItem") break;
        for (int i = m->methodOffset(); i < m->methodCount(); ++i) {
            const QMetaMethod mm = m->method(i);
            if (mm.methodType() != QMetaMethod::Signal) continue;
            bool skipped = false;
            for (const char *s : skip) skipped = skipped || mm.name() == s;
            if (skipped) {
                logLine(QStringLiteral("   skip %1.%2 (noisy)").arg(QString::fromLatin1(label), QString::fromLatin1(mm.methodSignature())));
                continue;
            }
            if (spy()->hook(o, mm, label)) {
                ++n;
                logLine(QStringLiteral("   hook %1.%2").arg(QString::fromLatin1(label), QString::fromLatin1(mm.methodSignature())));
            }
        }
    }
    return n;
}

int hookSignal(QObject *o, const char *label, const char *name, bool full = false) {
    if (!o) return 0;
    const QMetaObject *mo = o->metaObject();
    for (int i = 0; i < mo->methodCount(); ++i) {
        const QMetaMethod mm = mo->method(i);
        if (mm.methodType() == QMetaMethod::Signal && mm.name() == name && spy()->hook(o, mm, label, full)) {
            logLine(QStringLiteral("   hook %1.%2").arg(QString::fromLatin1(label), QString::fromLatin1(mm.methodSignature())));
            return 1;
        }
    }
    logLine(QStringLiteral("   %1 has no signal %2").arg(QString::fromLatin1(label), QString::fromLatin1(name)));
    return 0;
}

// The open page's DocumentWorker (SceneController.worker), document wrapper and lock manager.
struct DocObjects {
    QObject *worker = nullptr;
    QObject *wrapper = nullptr;
    QObject *locks = nullptr;
};

DocObjects docObjects(const OpenPage &p) {
    DocObjects d;
    if (p.controller && p.controller->metaObject()->indexOfProperty("worker") >= 0) {
        d.worker = p.controller->property("worker").value<QObject *>();
    }
    if (p.view->metaObject()->indexOfProperty("document") >= 0) {
        d.wrapper = p.view->property("document").value<QObject *>();
        if (d.wrapper && qstrcmp(d.wrapper->metaObject()->className(), "QmlDocumentWrapper") != 0) d.wrapper = nullptr;
    }
    if (!d.wrapper) {
        const auto ws = findObjectsOfClass("QmlDocumentWrapper");
        if (ws.size() == 1) d.wrapper = ws.first();
        else logLine(QStringLiteral("   %1 QmlDocumentWrapper object(s); not choosing").arg(ws.size()));
    }
    const auto ls = findObjectsOfClass("DocumentLockManager");
    for (QObject *l : ls) {
        // the lock manager of this document: its `document` is our wrapper
        if (l->metaObject()->indexOfProperty("document") >= 0 && l->property("document").value<QObject *>() == d.wrapper) d.locks = l;
    }
    if (!d.locks && ls.size() == 1) d.locks = ls.first();
    return d;
}

void logDocState(const OpenPage &p, const DocObjects &d, const char *when) {
    logLine(QStringLiteral("state %1: worker=%2 wrapper=%3 locks=%4").arg(QString::fromLatin1(when))
                .arg(d.worker ? QString::fromLatin1(d.worker->metaObject()->className()) : QStringLiteral("none"))
                .arg(d.wrapper ? QString::fromLatin1(d.wrapper->metaObject()->className()) : QStringLiteral("none"))
                .arg(d.locks ? QString::fromLatin1(d.locks->metaObject()->className()) : QStringLiteral("none")));
    dumpValues(p.controller, "controller", {"undoAvailable", "working", "updating", "pendingEdit"});
    dumpValues(d.worker, "worker", {"hasPending", "hasPendingChanges", "jobQueueSize", "pageCount"});
    dumpValues(d.wrapper, "document", {"hasPendingStoreLines", "hasContentsOnAnyPage", "pageCount"});
}

// watch page=<uuid> [full=1]: hook the signals that report a stroke, an erase and a save.
void cmdWatch(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    if (spy()->count()) {
        logLine(QStringLiteral("watch: already watching %1 signals; unwatch first").arg(spy()->count()));
        return;
    }
    const bool full = arg(w, "full") == QLatin1String("1");
    const DocObjects d = docObjects(p);
    int n = 0;
    n += hookSignal(p.pen, "pen", "strokeCompleted", full);
    n += hookSignal(p.pen, "pen", "gestureStarted");
    n += hookSignal(p.pen, "pen", "gestureEnded");
    n += hookAllSignals(p.controller, "scene");
    // tileReady carries a QImage per rendered tile: frequent, and says nothing about content
    n += hookAllSignals(d.worker, "worker", {"tileReady"});
    n += hookAllSignals(d.wrapper, "document");
    n += hookAllSignals(d.locks, "locks");
    logDocState(p, d, "at watch");
    logLine(QStringLiteral("watch: %1 signals hooked on page %2").arg(n).arg(p.pageId));
}

void cmdUnwatch() {
    logLine(QStringLiteral("unwatch: %1 signals disconnected").arg(spy()->unhookAll()));
}

void cmdPending(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    logDocState(p, docObjects(p), "now");
}

// save page=<uuid> via=<route>: ask xochitl to store the page's pending lines now. Each route is
// a meta-method of xochitl's own document objects (names from the 6.0.105 binary's meta-strings,
// `native-erase.md`); which of them stores lines, and at what cost, is what this measures. With
// `watch` on, the worker's `linesStored(page, pageId, size)` marks success.
//   deferred     DocumentWorker::startDeferredRequestTimers()
//   modified     DocumentWorker::onModifiedPageId(<the page's id>)
//   abouttosleep emit DocumentWorker::aboutToSleep()   (what the worker hears before a suspend)
//   sleepcycle   DocumentLockManager::setSleepState(true) then (false)   (last resort)
void cmdSave(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    const DocObjects d = docObjects(p);
    const QString via = arg(w, "via");
    logDocState(p, d, "before save");
    const qint64 t0 = nowMs();
    bool ok = false;
    if (via == QLatin1String("deferred") && d.worker) {
        ok = invoke(d.worker, "startDeferredRequestTimers", {});
    } else if (via == QLatin1String("modified") && d.worker) {
        ok = invoke(d.worker, "onModifiedPageId", {p.pageId});
    } else if (via == QLatin1String("abouttosleep") && d.worker) {
        ok = invoke(d.worker, "aboutToSleep", {});  // invoking a signal by index emits it
    } else if (via == QLatin1String("sleepcycle") && d.locks) {
        ok = invoke(d.locks, "setSleepState", {true}) && invoke(d.locks, "setSleepState", {false});
    } else {
        logLine(QStringLiteral("save: via must be deferred|modified|abouttosleep|sleepcycle and its object must exist (got \"%1\")").arg(via));
        return;
    }
    logLine(QStringLiteral("save: via %1 invoked=%2 in %3 ms (watch for worker.linesStored)").arg(via).arg(ok).arg(nowMs() - t0));
    logDocState(p, d, "after save");
}

// dumpscene page=<uuid>: SceneController::dumpScene(), a debug slot in xochitl. Where its output
// goes (journal, stderr) is unknown; read-only by its name. Only on request.
void cmdDumpScene(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    const qint64 t0 = nowMs();
    const bool ok = invoke(p.controller, "dumpScene", {});
    logLine(QStringLiteral("dumpscene: invoked=%1 in %2 ms (see journalctl -u xochitl)").arg(ok).arg(nowMs() - t0));
}

// ---------------------------------------------------------------------------------------------
// Signals into functions, without moc.
//
// This file is built without moc, so it cannot declare slots. Relay is a QObject whose extra
// meta-method indices (after QObject's own) each stand for one connected signal, the way Spy
// works above: `QMetaObject::connect` by index, and `qt_metacall` calls the function registered
// for that index with the signal's raw argument array. Connections are direct, so a function runs
// in the emitting thread; everything connected here is emitted on the GUI thread (the pen
// handler, the scene controller, injected QML).

class Relay : public QObject {
public:
    using Fn = std::function<void(void **)>;

    // Connects `sender`'s `signal` to `fn`; false if Qt refuses the connection.
    bool on(QObject *sender, const QMetaMethod &signal, Fn fn) {
        if (!sender || signal.methodType() != QMetaMethod::Signal) return false;
        const int slot = QObject::staticMetaObject.methodCount() + int(fns_.size());
        fns_.push_back(std::move(fn));
        if (!QMetaObject::connect(sender, signal.methodIndex(), this, slot, Qt::DirectConnection)) {
            fns_.back() = nullptr;
            return false;
        }
        return true;
    }

    // The notify signal of `sender`'s property `name`, or an invalid QMetaMethod.
    static QMetaMethod notifyOf(QObject *sender, const char *name) {
        const int i = sender ? sender->metaObject()->indexOfProperty(name) : -1;
        return i < 0 ? QMetaMethod() : sender->metaObject()->property(i).notifySignal();
    }

    // A signal of `sender` by its name (the first overload declared).
    static QMetaMethod signalNamed(QObject *sender, const char *name) {
        const QMetaObject *mo = sender ? sender->metaObject() : nullptr;
        for (int i = 0; mo && i < mo->methodCount(); ++i) {
            const QMetaMethod m = mo->method(i);
            if (m.methodType() == QMetaMethod::Signal && m.name() == name) return m;
        }
        return QMetaMethod();
    }

    int qt_metacall(QMetaObject::Call call, int id, void **a) override {
        id = QObject::qt_metacall(call, id, a);
        if (id < 0 || call != QMetaObject::InvokeMetaMethod) return id;
        if (id < int(fns_.size()) && fns_[size_t(id)]) fns_[size_t(id)](a);
        return -1;
    }

private:
    std::vector<Fn> fns_;  // index = slot - QObject's method count; never shrinks (indices stay valid)
};

// ---------------------------------------------------------------------------------------------
// Following the tool: /run/codrawer/tool.
//
// The bridge sees the pen only through evdev, which tells the Marker's eraser *end* apart
// (BTN_TOOL_RUBBER, sent as brush `eraser`) but not the toolbar. With the toolbar's Eraser
// selected, the tip erases in xochitl while the bridge streamed it as ink. The tool the tip
// draws with is the pen handler's `lineTool` (PenInputLineHandler, notify `lineToolChanged`):
// `Eraser` while the toolbar eraser is selected, and `lineThickness` is then the eraser's
// thickness, its size squared (sizes 1/2/3 give 1/4/9; DocumentView QML, native-erase.md §1). The
// erase probe on the device (3.29.0.149, 2026-10-06) saw `strokeCompleted` with tool=6 eraser=1
// thickness=4 for the toolbar eraser used with the tip, and thickness=5.76 for the eraser end.
//
// Event-driven since 2026-10-06 (the first version polled the two properties every 100 ms and
// rewrote the file every second). The extension connects to the notify signals of the open pen
// handler's `lineTool` and `lineThickness` and writes one line, `<tool> <thickness>`, to
// /run/codrawer/tool by rename only when it changes. One 2 s GUI-thread timer does the rest:
//
//   - the heartbeat: `utime()` on the file, so its mtime stays inside the bridge's 3 s freshness
//     window (toolhint, Go and Rust: both re-read the file when its mtime changes, and a stale or
//     missing file means "unknown", so a stock or hung xochitl leaves the bridge as before);
//   - discovery: only while no handler is known (none yet, or the old one was destroyed or its
//     DocumentView hidden by another document) is the item tree walked, because a walk costs
//     tens of milliseconds of GUI time.
//
// The tool word is one of `eraser` (Eraser, MaskedEraser), `erase_area` (EraseSection),
// `clear_page`, `select`, `highlighter`, `shader`, `zoom` or `pen`; `none` when no document is
// open. /run is tmpfs, so nothing survives a reboot.

constexpr const char *kToolDir = "/run/codrawer";
constexpr const char *kToolFile = "/run/codrawer/tool";
constexpr const char *kToolTmp = "/run/codrawer/.tool.tmp";
constexpr int kTickMs = 2000;

// Line::Tool values (the `Line` gadget's enum on this build, logged by `dump`) as protocol words.
const char *toolWord(int tool) {
    switch (tool) {
    case 6: case 22: return "eraser";  // Eraser, MaskedEraser
    case 8: return "erase_area";       // EraseSection
    case 9: return "clear_page";       // ClearPage
    case 11: return "select";          // SelectionTool
    case 5: case 18: return "highlighter";
    case 23: return "shader";          // ShadingMarker
    case 10: return "zoom";            // ZoomTool
    default: return "pen";
    }
}

void pauseAutomationForUser();  // section "UI automation"

struct ToolFollow {
    QPointer<QObject> pen;
    QPointer<QQuickItem> view;  // the DocumentView the handler belongs to
    QByteArray last;
    Relay *relay = nullptr;  // one per handler followed; deleted (disconnecting) on loss
    // The write-back guard: true between the pen handler's gestureStarted and gestureEnded (the
    // pen or a finger on the page). Agent ink and text wait while it is set (pumpInk, textInsert),
    // so nothing is committed under the user's hand. Set on the GUI thread only.
    bool penDown = false;
    qint64 penDownSince = 0;
};

ToolFollow &toolFollow() {
    static ToolFollow tf;
    return tf;
}

bool writeToolFile(const QByteArray &line) {
    mkdir(kToolDir, 0755);
    FILE *f = std::fopen(kToolTmp, "w");
    if (!f) return false;
    std::fwrite(line.constData(), 1, size_t(line.size()), f);
    std::fputc('\n', f);
    std::fclose(f);
    return std::rename(kToolTmp, kToolFile) == 0;
}

// Reads the two properties and writes the file if the line changed.
void toolChanged() {
    ToolFollow &tf = toolFollow();
    QByteArray line("none");
    if (tf.pen) {
        bool ok = false;
        const int tool = tf.pen->property("lineTool").toInt(&ok);
        const double thickness = tf.pen->property("lineThickness").toDouble();
        line = ok ? QByteArray(toolWord(tool)) + ' ' + QByteArray::number(thickness, 'g', 4) : QByteArray("unknown");
    }
    if (line == tf.last) return;
    logLine(QStringLiteral("tool: %1").arg(QString::fromLatin1(line)));
    writeToolFile(line);
    tf.last = line;
}

void forgetPen(const char *why) {
    ToolFollow &tf = toolFollow();
    if (tf.relay) {
        delete tf.relay;  // disconnects
        tf.relay = nullptr;
    }
    if (tf.pen || tf.view) logLine(QStringLiteral("tool: lost the pen handler (%1)").arg(QString::fromLatin1(why)));
    tf.pen = nullptr;
    tf.view = nullptr;
}

void followPen(QObject *pen, QQuickItem *view) {
    ToolFollow &tf = toolFollow();
    forgetPen("replaced");
    tf.pen = pen;
    tf.view = view;
    tf.relay = new Relay;
    int n = 0;
    for (const char *prop : {"lineTool", "lineThickness"}) {
        if (tf.relay->on(pen, Relay::notifyOf(pen, prop), [](void **) { toolChanged(); })) ++n;
    }
    tf.relay->on(pen, Relay::signalNamed(pen, "gestureStarted"), [](void **) {
        pauseAutomationForUser();
        toolFollow().penDown = true;
        toolFollow().penDownSince = nowMs();
    });
    tf.relay->on(pen, Relay::signalNamed(pen, "gestureEnded"), [](void **) { toolFollow().penDown = false; });
    tf.relay->on(pen, Relay::signalNamed(pen, "destroyed"), [](void **) {
        QMetaObject::invokeMethod(QCoreApplication::instance(), [] { forgetPen("destroyed"); toolChanged(); }, Qt::QueuedConnection);
    });
    logLine(QStringLiteral("tool: following %1 (%2 notify signal(s))").arg(QString::fromLatin1(pen->metaObject()->className())).arg(n));
}

// The 2 s tick: rediscover if needed, then the heartbeat. Other periodic jobs (injection) are
// added to `tickHooks`.
std::vector<std::function<void()>> &tickHooks() {
    static std::vector<std::function<void()>> h;
    return h;
}

void toolTick() {
    ToolFollow &tf = toolFollow();
    if (tf.pen && (!tf.view || !tf.view->isVisible())) forgetPen("view hidden");
    if (!tf.pen) {
        const qint64 t0 = nowMs();
        for (const OpenPage &p : findDocumentViews()) {
            if (p.pen && p.view->isVisible()) {
                followPen(p.pen, p.view);
                logLine(QStringLiteral("tool: found in %1 ms").arg(nowMs() - t0));
                break;
            }
        }
    }
    toolChanged();
    if (utime(kToolFile, nullptr) != 0) writeToolFile(tf.last.isEmpty() ? QByteArray("none") : tf.last);
    for (auto &h : tickHooks()) h();
}

// Started once on the GUI thread by the worker; runs for the life of xochitl.
void startToolFollow() {
    auto *t = new QTimer(QCoreApplication::instance());
    t->setInterval(kTickMs);
    QObject::connect(t, &QTimer::timeout, [] { toolTick(); });
    t->start();
    toolTick();
    logLine(QStringLiteral("tool: following the pen handler's lineTool into %1 (event-driven, %2 ms heartbeat)")
                .arg(QString::fromLatin1(kToolFile)).arg(kTickMs));
}

// ---------------------------------------------------------------------------------------------
// Committing ink: Probe 1's `stroke` and the agent ink socket share this path.
//
// What the device taught (3.29.0.149, 2026-10-06): SceneController's layer slots do not take
// effect inside the GUI-thread job that calls them. `addLayer()` returned with `layerCount`
// unchanged, and the new layer (with `currentLayer` moved onto it) appeared a few milliseconds
// later, once the scene's own job had run. A commit is therefore a chain of short GUI-thread
// steps. Each step waits, on a 20 ms timer and never by blocking, until the controller reports
// the previous step's effect:
//
//   1. find the layer by name; if it is missing, `addLayer()`, wait for `layerCount` to grow,
//      then `setLayerName(new, name)` and wait until `layerName(new)` reads it back;
//   2. `setCurrentLayer(ours)` and wait for `currentLayer`;
//   3. build every stroke's `Line` (route 2), `addDrawingLine` + `renderLineToTiles` each, and
//      repaint once;
//   4. wait for the scene to take the lines (`itemsBoundingRect` changes, or 400 ms), then
//      select the user's layer again (found by its name, as indices move) and wait for it.
//
// Every step first checks that the page it started on is still the visible one; if the user
// turned the page, the chain stops and, if it can, puts the user's layer back. Jobs run one at a
// time; jobs queued meanwhile for the same page and layer are merged into one commit (up to
// kMaxBatch strokes), so a burst of agent strokes costs one select/restore, not one per stroke.

struct InkStroke {
    int tool = 17;  // Line::Tool
    quint32 argb = 0xff000000u;
    double thickness = 2.0;  // xochitl's pen size (the toolbar's 1/2/3 are 1.0/2.0/3.0 here)
    QList<RmPoint> pts;  // scene coordinates
};

struct InkJob {
    QString page;
    QString layer;  // "codrawer: agent" or "codrawer: test", nothing else
    QList<InkStroke> strokes;
    int adopt = -1;  // probe only: name this layer (the last, not the first) instead of adding one
    int restore = -1;  // probe only: select this layer afterwards, not the one selected now
    bool verbose = false;
    bool raw = false;  // probe only: the points are already in the pen's frame (no scene -> view mapping)
    std::function<void(const QString &)> done;  // "ok <n>" or "err <reason>", on the GUI thread
};

constexpr int kMaxQueue = 256;  // pending jobs; beyond this a job is refused with "err busy"
constexpr int kMaxBatch = 64;  // strokes per commit

// waitFor: calls `then(true)` once `cond()` holds, or `then(false)` after `timeoutMs`. Polls on
// a GUI-thread timer; nothing blocks.
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

QString layerNameAt(QObject *c, int i) {
    QVariant name;
    invoke(c, "layerName", {i}, &name);
    return name.toString();
}

struct Commit {
    InkJob job;
    QPointer<QObject> c, tiles, viewport;
    QPointer<QQuickItem> view;
    int original = -1;
    QString originalName;
    int ours = -1;
    qint64 t0 = 0;
    QVariant boundsBefore;
};
using CommitPtr = std::shared_ptr<Commit>;

QList<InkJob> &inkQueue() {
    static QList<InkJob> q;
    return q;
}
bool inkBusy = false;
void pumpInk();

void finishCommit(const CommitPtr &s, const QString &result) {
    logLine(QStringLiteral("ink: %1 (%2 stroke(s), layer \"%3\", %4 ms)")
                .arg(result).arg(s->job.strokes.size()).arg(s->job.layer).arg(nowMs() - s->t0));
    if (s->job.done) s->job.done(result);
    inkBusy = false;
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] { pumpInk(); }, Qt::QueuedConnection);
}

bool stillOnPage(const CommitPtr &s) {
    return s->c && s->view && s->view->isVisible() && s->view->property("pageId").toString() == s->job.page &&
           s->c->property("pageId").toString() == s->job.page;
}

int currentLayer(const CommitPtr &s) { return s->c ? s->c->property("currentLayer").toInt() : -1; }

// Step 4b: the user's layer again, then the verdict.
void restoreUserLayer(const CommitPtr &s, const QString &verdict) {
    if (!stillOnPage(s)) {
        finishCommit(s, QStringLiteral("err page changed before the user's layer was restored (%1)").arg(verdict));
        return;
    }
    int to = s->original;
    if (!s->originalName.isEmpty()) {
        int found = -1, matches = 0;
        for (const LayerInfo &l : layers(s->c)) {
            if (l.name == s->originalName) {
                found = l.index;
                ++matches;
            }
        }
        if (matches == 1) to = found;
    }
    if (currentLayer(s) == to) {
        finishCommit(s, verdict);
        return;
    }
    invoke(s->c, "setCurrentLayer", {to});
    waitFor([s, to] { return !stillOnPage(s) || currentLayer(s) == to; }, 2000, [s, to, verdict](bool ok) {
        if (ok && currentLayer(s) == to) finishCommit(s, verdict);
        else finishCommit(s, QStringLiteral("err could not restore the user's layer %1 (%2)").arg(to).arg(verdict));
    });
}

// Step 3 and 4a: the lines themselves.
void drawLines(const CommitPtr &s) {
    if (!stillOnPage(s) || currentLayer(s) != s->ours) {
        restoreUserLayer(s, QStringLiteral("err layer %1 not selected; nothing drawn").arg(s->ours));
        return;
    }
    const QMetaObject *cm = s->c->metaObject();
    const bool hasItemsBounds = cm->indexOfProperty("itemsBoundingRect") >= 0;
    s->boundsBefore = hasItemsBounds ? s->c->property("itemsBoundingRect") : QVariant();
    int added = 0;
    // Placement. Probe 1 showed that `addDrawingLine` takes the Line in the pen's frame, not in
    // page coordinates: a wave given at x −560…−140, y 285…375 was saved at x +12…+432,
    // y −12…+78 on a page the user had panned. xochitl maps a pen stroke through the view's
    // transform, so ink given in page coordinates is first mapped scene → view with the tile
    // manager's own `sceneToViewTransform`, making it land where it was meant to be saved.
    // `raw` (probe only) skips this.
    QTransform toView;
    bool mapped = false;
    if (!s->job.raw && s->tiles && s->tiles->metaObject()->indexOfProperty("sceneToViewTransform") >= 0) {
        const QVariant tv = s->tiles->property("sceneToViewTransform");
        if (tv.metaType().id() == QMetaType::QTransform) {
            toView = tv.value<QTransform>();
            mapped = toView.isInvertible();
        }
    }
    if (!s->job.raw && !mapped) {
        restoreUserLayer(s, QStringLiteral("err no sceneToViewTransform; nothing drawn"));
        return;
    }
    if (s->job.verbose && mapped) {
        const RmPoint &f = s->job.strokes.first().pts.first();
        logLine(QStringLiteral("ink: sceneToView [%1 %2 | %3 %4 | dx %5 dy %6]; first point (%7,%8) -> %9")
                    .arg(toView.m11()).arg(toView.m12()).arg(toView.m21()).arg(toView.m22()).arg(toView.dx()).arg(toView.dy())
                    .arg(f.x).arg(f.y).arg(show(toView.map(QPointF(f.x, f.y)))));
    }
    for (InkStroke &st : s->job.strokes) {
        if (mapped) {
            for (RmPoint &q : st.pts) {
                const QPointF v = toView.map(QPointF(q.x, q.y));
                q.x = float(v.x());
                q.y = float(v.y());
            }
        }
        QVariant line;
        if (!buildLine(st.tool, st.argb, st.thickness, st.pts, line, s->job.verbose)) continue;
        if (!invoke(s->c, "addDrawingLine", {line})) continue;
        if (s->tiles) invoke(s->tiles, "renderLineToTiles", {line});
        ++added;
    }
    if (s->viewport && s->view) {
        // DocumentView.qml marks the stroke's view rect dirty and repaints; the view transform
        // lives in QML, so mark the whole viewport (one e-ink refresh per commit).
        const QRectF all(0, 0, s->view->width(), s->view->height());
        invoke(s->viewport, "markDirty", {all});
        invoke(s->viewport, "requestRepaintDirty", {});
    }
    const QString verdict = added == s->job.strokes.size()
                                ? QStringLiteral("ok %1").arg(added)
                                : QStringLiteral("err %1 of %2 strokes built").arg(added).arg(s->job.strokes.size());
    if (s->job.verbose) {
        logLine(QStringLiteral("ink: addDrawingLine x%1 on layer %2; currentLayer %3 itemsBoundingRect %4")
                    .arg(added).arg(s->ours).arg(currentLayer(s)).arg(show(s->boundsBefore)));
    }
    const qint64 drawnAt = nowMs();
    waitFor(
        [s, hasItemsBounds, drawnAt] {
            if (!stillOnPage(s)) return true;
            if (nowMs() - drawnAt < 60) return false;  // let the scene job run at least once
            return hasItemsBounds && s->c->property("itemsBoundingRect") != s->boundsBefore;
        },
        400,
        [s, verdict, drawnAt](bool) {
            if (s->job.verbose && s->c) {
                logLine(QStringLiteral("ink: after %1 ms itemsBoundingRect %2, currentLayer %3")
                            .arg(nowMs() - drawnAt).arg(show(s->c->property("itemsBoundingRect"))).arg(currentLayer(s)));
            }
            restoreUserLayer(s, verdict);
        });
}

// Step 2.
void selectOurLayer(const CommitPtr &s) {
    if (!stillOnPage(s)) {
        finishCommit(s, QStringLiteral("err page changed"));
        return;
    }
    invoke(s->c, "setCurrentLayer", {s->ours});
    waitFor([s] { return !stillOnPage(s) || currentLayer(s) == s->ours; }, 2000, [s](bool) { drawLines(s); });
}

// Step 1b: name the layer and wait for the name to read back.
void nameOurLayer(const CommitPtr &s, int index) {
    invoke(s->c, "setLayerName", {index, s->job.layer});
    waitFor([s, index] { return !stillOnPage(s) || layerNameAt(s->c, index) == s->job.layer; }, 2000,
            [s, index](bool) {
                if (!stillOnPage(s) || layerNameAt(s->c, index) != s->job.layer) {
                    restoreUserLayer(s, QStringLiteral("err could not name layer %1").arg(index));
                    return;
                }
                s->ours = index;
                selectOurLayer(s);
            });
}

void startCommit(InkJob job) {
    auto s = std::make_shared<Commit>();
    s->job = std::move(job);
    s->t0 = nowMs();
    OpenPage p;
    if (!findOpenPage(s->job.page, p)) {
        finishCommit(s, QStringLiteral("err not the visible page"));
        return;
    }
    s->c = p.controller;
    s->tiles = p.tiles;
    s->viewport = p.viewport;
    s->view = p.view;
    if (s->c->metaObject()->indexOfMethod("layerName(int)") < 0) {
        finishCommit(s, QStringLiteral("err SceneController has no layerName(int)"));
        return;
    }
    const int count = s->c->property("layerCount").toInt();
    s->original = (s->job.restore >= 0 && s->job.restore < count) ? s->job.restore : currentLayer(s);
    s->originalName = layerNameAt(s->c, s->original);
    if (s->job.verbose) logLayers(s->c, "before");

    const int existing = findLayer(s->c, s->job.layer);
    if (existing >= 0) {
        if (existing == s->original) {
            // The user has our layer selected; drawing there is still only our layer.
            if (s->job.verbose) logLine(QStringLiteral("ink: the user's selected layer is ours (%1)").arg(existing));
        }
        s->ours = existing;
        selectOurLayer(s);
        return;
    }
    if (s->job.adopt >= 0) {
        // Probe recovery: name a layer that an earlier attempt added. Only the last layer, never
        // the first (the user's base layer), never the one the user is to get back.
        if (s->job.adopt != count - 1 || s->job.adopt == 0 || s->job.adopt == s->original) {
            finishCommit(s, QStringLiteral("err adopt=%1 refused (count %2, user layer %3)").arg(s->job.adopt).arg(count).arg(s->original));
            return;
        }
        nameOurLayer(s, s->job.adopt);
        return;
    }
    if (count >= 32) {
        finishCommit(s, QStringLiteral("err page has %1 layers; not adding another").arg(count));
        return;
    }
    invoke(s->c, "addLayer", {});
    waitFor([s, count] { return !stillOnPage(s) || s->c->property("layerCount").toInt() == count + 1; }, 3000,
            [s, count](bool) {
                if (!stillOnPage(s) || s->c->property("layerCount").toInt() != count + 1) {
                    restoreUserLayer(s, QStringLiteral("err addLayer did not add one layer"));
                    return;
                }
                nameOurLayer(s, count);  // xochitl appends: the new layer is the last
            });
}

// Whether the user's hand is on the page now. A gestureStarted with no gestureEnded for 30 s
// (a lost signal) stops counting, so a missed end cannot block agent ink for good.
bool userTouching() {
    ToolFollow &tf = toolFollow();
    return tf.penDown && nowMs() - tf.penDownSince < 30000;
}

void pumpInk() {
    if (inkBusy || inkQueue().isEmpty()) return;
    if (userTouching()) {
        // the write-back guard: commit after the pen lifts, never under it
        QTimer::singleShot(50, QCoreApplication::instance(), [] { pumpInk(); });
        return;
    }
    inkBusy = true;
    InkJob job = inkQueue().takeFirst();
    // Merge queued jobs for the same page and layer (agent ink arrives one stroke per message).
    std::vector<std::function<void(const QString &)>> dones;
    if (job.done) dones.push_back(job.done);
    while (job.adopt < 0 && job.restore < 0 && !inkQueue().isEmpty() && job.strokes.size() < kMaxBatch) {
        const InkJob &next = inkQueue().first();
        if (next.page != job.page || next.layer != job.layer || next.adopt >= 0 || next.restore >= 0 ||
            job.strokes.size() + next.strokes.size() > kMaxBatch) {
            break;
        }
        InkJob n = inkQueue().takeFirst();
        job.strokes += n.strokes;
        if (n.done) dones.push_back(n.done);
    }
    if (dones.size() > 1) {
        job.done = [dones](const QString &r) {
            for (const auto &d : dones) d(r);
        };
    }
    startCommit(std::move(job));
}

// Called on the GUI thread.
void enqueueInk(InkJob job) {
    if (inkQueue().size() >= kMaxQueue) {
        if (job.done) job.done(QStringLiteral("err busy"));
        return;
    }
    inkQueue().append(std::move(job));
    pumpInk();
}

// Probe 1: one hard-coded stroke on "codrawer: test".
//   stroke page=<uuid> [argb=<hex>] [adopt=<layer>] [restore=<layer>]
void cmdStroke(const QStringList &w) {
    InkJob job;
    job.page = arg(w, "page");
    job.layer = kLayerName();
    job.verbose = true;
    if (!arg(w, "adopt").isEmpty()) job.adopt = arg(w, "adopt").toInt();
    if (!arg(w, "restore").isEmpty()) job.restore = arg(w, "restore").toInt();
    job.raw = arg(w, "raw") == QLatin1String("1");
    InkStroke st;
    st.tool = 17;  // Finelinerv2
    st.argb = arg(w, "argb").isEmpty() ? 0xff1f6fe0u : arg(w, "argb").toUInt(nullptr, 16);
    st.thickness = 2.0;
    QRectF unused;
    st.pts = probeStroke(&unused);
    job.strokes << st;
    job.done = [](const QString &r) {
        logLine(QStringLiteral("stroke: %1").arg(r));
    };
    enqueueInk(std::move(job));
}

// ---------------------------------------------------------------------------------------------
// The agent ink socket: /run/codrawer/ink.sock.
//
// The bridge (ADR 003: agent ink is governed, and lives only on its own layer) connects and
// writes one JSON object per line, one message per stroke or a few strokes:
//
//   {"id":"a7","page":"<uuid>","layer":"agent",
//    "strokes":[{"tool":"fineliner","argb":"ff1f6fe0","thickness":2,
//                "pts":[[x,y,pressure,width],...]}]}
//
// x, y are xochitl scene coordinates (px; x centred on the page, −810..810 across a 1620 px
// page, y down from the top). pressure is 0..1; width is the point's drawn width in px (stored as
// quarter pixels). For every line the extension answers one line, `ok <id> <n>` or
// `err <id> <reason>`, once the strokes are committed or refused. Pacing (strokes appearing at
// the agent's writing speed) is the bridge's job: it sends each stroke at its time, and each is
// committed as it arrives.
//
// What the socket refuses, before anything reaches the GUI thread: a layer other than "agent"
// (→ "codrawer: agent") or "test" (→ "codrawer: test"); tools that xochitl does not commit through
// addDrawingLine (highlighter, erasers, selection); more than kMaxBatch strokes or 4000 points in
// a stroke; coordinates or widths outside the page's plausible range; a line over 1 MiB. On the
// GUI thread the page must be the visible one (startCommit). The socket is 0600, root only.

constexpr const char *kInkSock = "/run/codrawer/ink.sock";

int toolFromName(const QJsonValue &v) {
    if (v.isDouble()) {
        const int t = v.toInt(-1);
        switch (t) {
        case 0: case 1: case 2: case 3: case 4: case 7: case 12: case 13: case 14: case 15: case 16: case 17: case 21:
            return t;
        default:
            return -1;
        }
    }
    const QString n = v.toString(QStringLiteral("fineliner"));
    if (n == QLatin1String("fineliner")) return 17;
    if (n == QLatin1String("ballpoint") || n == QLatin1String("pen")) return 15;
    if (n == QLatin1String("pencil")) return 14;
    if (n == QLatin1String("mechanical") || n == QLatin1String("sharp_pencil")) return 13;
    if (n == QLatin1String("marker")) return 16;
    if (n == QLatin1String("calligraphy")) return 21;
    if (n == QLatin1String("paintbrush") || n == QLatin1String("brush")) return 12;
    return -1;
}

// Parses one socket line into a job; on failure returns false with `why`.
bool parseInk(const QByteArray &line, InkJob &job, QString &id, QString &why) {
    QJsonParseError pe;
    const QJsonDocument doc = QJsonDocument::fromJson(line, &pe);
    if (pe.error != QJsonParseError::NoError || !doc.isObject()) {
        why = QStringLiteral("bad json");
        return false;
    }
    const QJsonObject o = doc.object();
    id = o.value(QStringLiteral("id")).toVariant().toString().left(64);
    id.replace(QLatin1Char(' '), QLatin1Char('_'));
    if (id.isEmpty()) id = QStringLiteral("-");
    job.page = o.value(QStringLiteral("page")).toString();
    if (job.page.size() != 36) {
        why = QStringLiteral("page must be a uuid");
        return false;
    }
    const QString layer = o.value(QStringLiteral("layer")).toString(QStringLiteral("agent"));
    if (layer == QLatin1String("agent")) job.layer = QStringLiteral("codrawer: agent");
    else if (layer == QLatin1String("test")) job.layer = kLayerName();
    else {
        why = QStringLiteral("layer must be agent or test");
        return false;
    }
    const QJsonArray strokes = o.value(QStringLiteral("strokes")).toArray();
    if (strokes.isEmpty() || strokes.size() > kMaxBatch) {
        why = QStringLiteral("1..%1 strokes per message").arg(kMaxBatch);
        return false;
    }
    for (const QJsonValue &sv : strokes) {
        const QJsonObject so = sv.toObject();
        InkStroke st;
        st.tool = toolFromName(so.value(QStringLiteral("tool")));
        if (st.tool < 0) {
            why = QStringLiteral("tool not allowed");
            return false;
        }
        const QJsonValue av = so.value(QStringLiteral("argb"));
        bool okArgb = true;
        st.argb = av.isString() ? av.toString().toUInt(&okArgb, 16) : quint32(av.toDouble(double(0xff000000u)));
        if (!okArgb) {
            why = QStringLiteral("bad argb");
            return false;
        }
        st.thickness = so.value(QStringLiteral("thickness")).toDouble(2.0);
        if (!(st.thickness >= 0.1 && st.thickness <= 20.0)) {
            why = QStringLiteral("thickness out of range");
            return false;
        }
        const QJsonArray pts = so.value(QStringLiteral("pts")).toArray();
        if (pts.isEmpty() || pts.size() > 4000) {
            why = QStringLiteral("1..4000 points per stroke");
            return false;
        }
        for (int i = 0; i < pts.size(); ++i) {
            const QJsonArray a = pts[i].toArray();
            if (a.size() < 2) {
                why = QStringLiteral("point needs x,y");
                return false;
            }
            const double x = a[0].toDouble(NAN), y = a[1].toDouble(NAN);
            const double pr = a.size() > 2 ? a[2].toDouble(0.5) : 0.5;
            const double wpx = a.size() > 3 ? a[3].toDouble(st.thickness * 2) : st.thickness * 2;
            if (!(x >= -2000 && x <= 2000 && y >= -2000 && y <= 40000 && wpx >= 0 && wpx <= 200)) {
                why = QStringLiteral("point %1 out of range").arg(i);
                return false;
            }
            RmPoint p;
            p.x = float(x);
            p.y = float(y);
            p.speed = 12;
            p.width = quint16(std::lround(wpx * 4));
            p.direction = 0;
            p.pressure = quint8(std::lround(std::clamp(pr, 0.0, 1.0) * 255));
            st.pts << p;
        }
        // Direction of travel, 0..255 over a full turn, from each point's neighbours.
        for (int i = 0; i < st.pts.size(); ++i) {
            const RmPoint &a = st.pts[std::max(0, i - 1)];
            const RmPoint &b = st.pts[std::min(int(st.pts.size()) - 1, i + 1)];
            double ang = std::atan2(double(b.y - a.y), double(b.x - a.x));
            if (ang < 0) ang += 2 * M_PI;
            st.pts[i].direction = quint8(std::lround(ang / (2 * M_PI) * 255.0) & 0xff);
        }
        job.strokes << st;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Text into the focused text box: `text_insert` and `text_read` on the same socket.
//
// The bridge types `/term` replies into the tablet's focused text field through a uinput
// keyboard. Measured 2026-10-06: that loses the first characters after an Enter and cannot
// produce ^ [ ] { } \ ` ~ at all (the virtual keyboard's layout). Inside xochitl the text can be
// handed to the focused item directly, the way an input method commits text:
//
//   {"op":"text_insert","id":"t3","text":"…"}  →  ok t3 text_insert <chars> via=<route> | err t3 <why>
//   {"op":"text_read","id":"t4"}               →  text t4 {"class":…,"cursor":n,"text":…} | err t4 <why>
//
// The target is the active focus item of the focused window, and only if it lies inside the
// visible DocumentView (a text box on the page on screen) and takes text: an item that accepts
// input methods gets a QInputMethodEvent whose commit string is the text (the route a
// platform input method, and hence the on-screen keyboard's composition, takes into a Qt text
// item, so the item's own editing, and its undo, apply); a line break is a Return key press
// between commits, as typing one would be. An item without input-method support but with an
// `insert(int,QString)` method (QML TextEdit/TextInput) gets that at its cursor. Anything else is
// refused and logged; nothing is ever inserted outside the visible page. Formatting, shortcuts
// and completion are a separate design (branch research/keyboard-text).
//
// On connect the extension says what it can do: `hello codrawer-layer ink text_insert text_read`.

constexpr int kMaxTextInsert = 16384;  // characters per text_insert

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
    ToolFollow &tf = toolFollow();
    if (!tf.view || !tf.view->isVisible()) {
        why = QStringLiteral("no visible page");
        return nullptr;
    }
    bool onPage = false;
    for (QQuickItem *p = it; p && !onPage; p = p->parentItem()) onPage = p == tf.view;
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

// Runs on the GUI thread; returns the reply line (without the id, which the caller adds).
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

// Route A (docs/investigations/keyboard-and-text.md §1.2-1.3): the page's own text API.
// When the visible page's root text document is focused (the user has a text cursor on the
// page: `textDocumentId` set), the text goes in through `SceneController.replaceText(QString)`
// at that cursor, one call per line with `replaceText("\n")` between, inside
// begin/endInputMethodTransaction so that a reply is meant to be one undo step. It does not
// pass xochitl's QML key gate and has no keymap, so every character arrives. Like the layer
// slots, the effect may land a moment later, so the reply waits (20 ms polls, up to 1.5 s) for
// `rootDocumentLength` to grow by the text's length and reports what it saw: `ok … via=replace
// len a->b` when it matches, `ok … via=replace unverified …` when it does not (never retried:
// the text may be in). No root document, or none focused: nothing is created; route B decides.
bool textInsertRouteA(const QString &text, std::function<void(const QString &)> reply) {
    ToolFollow &tf = toolFollow();
    if (!tf.view || !tf.view->isVisible()) return false;
    QPointer<QObject> c = tf.view->property("controller").value<QObject *>();
    if (!c || c->metaObject()->indexOfMethod("replaceText(QString)") < 0) return false;
    const QVariant docId = c->property("textDocumentId");
    if (!docId.isValid() || docId.isNull() || docId.toString().isEmpty() || docId.toString() == QLatin1String("0:0")) return false;
    const QString page = tf.view->property("pageId").toString();
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
    if (QObject *c = toolFollow().view ? toolFollow().view->property("controller").value<QObject *>() : nullptr) {
        o.insert(QStringLiteral("root_length"), c->property("rootDocumentLength").toInt());
        o.insert(QStringLiteral("root_cursor"), c->property("textCursorIndex").toInt());
        o.insert(QStringLiteral("root_document"), c->property("textDocumentId").toString());
    }
    return QStringLiteral("text ") + QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

void setBridgeStatus(const QString &s);  // section "Injected UI"

// One connected client. The fd is closed when the last reference goes (the reader and any
// commit still holding a reply callback), so a late reply never reaches a reused fd.
struct InkClient {
    int fd;
    std::atomic<bool> open{true};
    std::mutex sending;  // whole lines: replies and actions come from the GUI thread, refusals from the reader
    explicit InkClient(int f) : fd(f) {}
    ~InkClient() { close(fd); }
    void reply(const QString &s) {
        std::lock_guard<std::mutex> lock(sending);
        if (!open) return;
        const QByteArray b = s.toUtf8() + '\n';
        if (send(fd, b.constData(), size_t(b.size()), MSG_NOSIGNAL | MSG_DONTWAIT) < 0) open = false;
    }
};

// The connected bridge, for actions going the other way (section "Actions" below). One client
// at a time; the reader thread sets and clears it.
std::mutex &inkClientMutex() {
    static std::mutex m;
    return m;
}
std::weak_ptr<InkClient> &currentInkClient() {
    static std::weak_ptr<InkClient> c;
    return c;
}

// Sends one line to the connected bridge; false if none is connected or the send fails.
bool sendToBridge(const QByteArray &line) {
    std::shared_ptr<InkClient> cl;
    {
        std::lock_guard<std::mutex> lock(inkClientMutex());
        cl = currentInkClient().lock();
    }
    if (!cl || !cl->open) return false;
    cl->reply(QString::fromUtf8(line));
    return cl->open;
}

void serveInk(const std::shared_ptr<InkClient> &cl) {
    {
        std::lock_guard<std::mutex> lock(inkClientMutex());
        currentInkClient() = cl;
    }
    cl->reply(QStringLiteral("hello codrawer-layer ink text_insert text_read"));
    QByteArray buf;
    char chunk[16384];
    for (;;) {
        const ssize_t n = read(cl->fd, chunk, sizeof chunk);
        if (n <= 0) break;
        buf.append(chunk, int(n));
        qsizetype nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const QByteArray line = buf.left(nl).trimmed();
            buf.remove(0, nl + 1);
            if (line.isEmpty()) continue;
            if (line.startsWith("status ")) {
                setBridgeStatus(QString::fromUtf8(line.mid(7)).left(200));
                continue;
            }
            if (line.contains("\"op\"")) {
                // text_insert / text_read (section "Text into the focused text box")
                const QJsonObject o = QJsonDocument::fromJson(line).object();
                const QString op = o.value(QStringLiteral("op")).toString();
                QString tid = o.value(QStringLiteral("id")).toString().left(64);
                tid.replace(QLatin1Char(' '), QLatin1Char('_'));
                if (tid.isEmpty()) tid = QStringLiteral("-");
                const QString text = o.value(QStringLiteral("text")).toString();
                if ((op != QLatin1String("text_insert") && op != QLatin1String("text_read")) ||
                    (op == QLatin1String("text_insert") && (text.isEmpty() || text.size() > kMaxTextInsert))) {
                    cl->reply(QStringLiteral("err %1 bad op or text").arg(tid));
                    continue;
                }
                QMetaObject::invokeMethod(QCoreApplication::instance(), [cl, op, tid, text] {
                    auto send = [cl, op, tid](const QString &r) {
                        if (r.startsWith(QLatin1String("err "))) logLine(QStringLiteral("text: refused %1: %2").arg(op, r.mid(4)));
                        const int sp = r.indexOf(QLatin1Char(' '));
                        cl->reply(r.left(sp) + QLatin1Char(' ') + tid + r.mid(sp));
                    };
                    if (op == QLatin1String("text_read")) {
                        send(textRead());
                    } else if (userTouching()) {
                        send(QStringLiteral("err pen or finger on the page"));  // the write-back guard
                    } else if (!textInsertRouteA(text, send)) {
                        send(textInsert(text));  // route B: the focused item, as an input method
                    }
                }, Qt::QueuedConnection);
                continue;
            }
            InkJob job;
            QString id, why;
            if (!parseInk(line, job, id, why)) {
                logLine(QStringLiteral("ink: refused %1: %2").arg(id, why));
                cl->reply(QStringLiteral("err %1 %2").arg(id.isEmpty() ? QStringLiteral("-") : id, why));
                continue;
            }
            job.done = [cl, id](const QString &r) {
                const int sp = r.indexOf(QLatin1Char(' '));
                cl->reply(sp < 0 ? r + QLatin1Char(' ') + id : r.left(sp) + QLatin1Char(' ') + id + r.mid(sp));
            };
            QMetaObject::invokeMethod(QCoreApplication::instance(), [job]() mutable { enqueueInk(std::move(job)); },
                                      Qt::QueuedConnection);
        }
        if (buf.size() > (1 << 20)) {
            cl->reply(QStringLiteral("err - line over 1 MiB; closing"));
            break;
        }
    }
    cl->open = false;
    std::lock_guard<std::mutex> lock(inkClientMutex());
    if (currentInkClient().lock() == cl) currentInkClient().reset();
}

// The socket's own thread: accept one client at a time (the bridge) and serve it.
void inkServer() {
    mkdir(kToolDir, 0755);
    unlink(kInkSock);
    const int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, kInkSock, sizeof addr.sun_path - 1);
    if (s < 0 || bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof addr) != 0 || listen(s, 2) != 0) {
        logLine(QStringLiteral("ink: cannot listen on %1 (errno %2)").arg(QString::fromLatin1(kInkSock)).arg(errno));
        if (s >= 0) close(s);
        return;
    }
    chmod(kInkSock, 0600);
    logLine(QStringLiteral("ink: listening on %1").arg(QString::fromLatin1(kInkSock)));
    for (;;) {
        const int fd = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
        if (fd < 0) {
            if (errno != EINTR) sleep(1);
            continue;
        }
        logLine(QStringLiteral("ink: client connected"));
        serveInk(std::make_shared<InkClient>(fd));
        logLine(QStringLiteral("ink: client gone"));
    }
}

// ---------------------------------------------------------------------------------------------
// The selection: what the user last lasso-selected on the visible page.
//
// SceneController has no meta-call that returns the selected lines' ids (`cloneSelectedItems`
// returns opaque `std::shared_ptr<SceneItem>`s), but it signals `areaSelected(int, QRectF)` when a
// lasso selection settles, `selectionCleared()` when it goes, and `selectionItemCount` says how
// many items it holds (meta-object dump, 3.29.0.149). The extension remembers the last rect and
// sends it with an `ask_selection` action; the bridge resolves the line ids from its page snapshot
// (strokes whose points fall in the rect), which is the same ink the user circled once xochitl
// has saved it.

struct Selection {
    bool containsStroke = false, containsImage = false;  // the controller's own, read 300 ms after
    QRectF viewRect;  // `rect` through the tile manager's sceneToViewTransform
    QString page;
    int arg = -1;  // areaSelected's int (logged: which it is, layer or mode, is not yet known)
    QRectF rect;  // as signalled (scene coordinates expected; `xform` and the log tell)
    int count = 0;
    qint64 atMs = 0;
};

struct SelectionFollow {
    QPointer<QObject> controller;
    Relay *relay = nullptr;
    Selection last;
};

SelectionFollow &selectionFollow() {
    static SelectionFollow sf;
    return sf;
}

void createSelectionInjections();  // section "Injected UI"
void cmdTree(const QStringList &w);

// readSelection: the lasso as the controller and the view describe it (guibor's map:
// selectionContainsStroke/Image, the page rect, the selection handler's geometry). Read-only;
// the first time in a run it also logs the selection menu's item tree, for placing a button.
void readSelection(QObject *c) {
    Selection &s = selectionFollow().last;
    s.count = c->property("selectionItemCount").toInt();
    s.containsStroke = c->property("selectionContainsStroke").toBool();
    s.containsImage = c->property("selectionContainsImage").toBool();
    ToolFollow &tf = toolFollow();
    QString pageRect = QStringLiteral("none");
    if (tf.view) {
        for (QQuickItem *v = tf.view; v; v = v->parentItem()) {
            if (v->metaObject()->indexOfProperty("pageBorderRect") >= 0) {
                pageRect = show(v->property("pageBorderRect")) + QStringLiteral(" on ") + QString::fromLatin1(v->metaObject()->className());
                break;
            }
        }
        if (pageRect == QLatin1String("none")) {
            for (QQuickItem *it : allItems()) {
                if (it->metaObject()->indexOfProperty("pageBorderRect") >= 0 && it->isVisible()) {
                    pageRect = show(it->property("pageBorderRect")) + QStringLiteral(" on ") + QString::fromLatin1(it->metaObject()->className());
                    break;
                }
            }
        }
        QObject *tiles = tf.view->property("tileManager").value<QObject *>();
        const QVariant tv = tiles ? tiles->property("sceneToViewTransform") : QVariant();
        if (tv.metaType().id() == QMetaType::QTransform) s.viewRect = tv.value<QTransform>().mapRect(s.rect);
    }
    logLine(QStringLiteral("selection: items=%1 stroke=%2 image=%3 rect %4 -> view %5; pageBorderRect %6")
                .arg(s.count).arg(s.containsStroke).arg(s.containsImage).arg(show(s.rect), show(s.viewRect), pageRect));
    static bool treeLogged = false;
    if (!treeLogged) {
        treeLogged = true;
        cmdTree({QStringLiteral("tree"), QStringLiteral("match=class:SelectionContextualMenu"), QStringLiteral("depth=3")});
        cmdTree({QStringLiteral("tree"), QStringLiteral("match=class:SelectionHandler"), QStringLiteral("depth=1")});
    }
}

void selectionTick() {
    SelectionFollow &sf = selectionFollow();
    ToolFollow &tf = toolFollow();
    if (!tf.view) return;
    QObject *c = tf.view->property("controller").value<QObject *>();
    if (!c || c == sf.controller) return;
    delete sf.relay;
    sf.relay = new Relay;
    sf.controller = c;
    sf.relay->on(c, Relay::signalNamed(c, "areaSelected"), [c](void **a) {
        SelectionFollow &s = selectionFollow();
        s.last.page = c->property("pageId").toString();
        s.last.arg = *static_cast<int *>(a[1]);
        s.last.rect = *static_cast<QRectF *>(a[2]);
        s.last.count = c->property("selectionItemCount").toInt();
        s.last.atMs = nowMs();
        logLine(QStringLiteral("selection: areaSelected(%1, %2) items=%3 page=%4")
                    .arg(s.last.arg).arg(show(s.last.rect)).arg(s.last.count).arg(s.last.page));
        // The selection settles in the scene's own job: read it a moment later, and then try the
        // injections that wait for a selection menu (when=selection).
        QPointer<QObject> pc(c);
        QTimer::singleShot(300, QCoreApplication::instance(), [pc] {
            if (pc) readSelection(pc);
            createSelectionInjections();
        });
        QTimer::singleShot(900, QCoreApplication::instance(), [] { createSelectionInjections(); });
    });
    sf.relay->on(c, Relay::signalNamed(c, "selectionCleared"), [](void **) {
        logLine(QStringLiteral("selection: cleared"));
    });
}

// ---------------------------------------------------------------------------------------------
// Actions: from the extension's UI to the bridge.
//
// A tap on an injected button (the dock, the selection menu) becomes one JSON line sent to the
// bridge over the connection it already holds on /run/codrawer/ink.sock, interleaved with the
// `ok`/`err` replies (those start with a letter, actions with `{`):
//
//   {"t":"dock_action","id":"ask_page","page":"<uuid>","source":"dock"}
//   {"t":"dock_action","id":"ask_selection","page":"<uuid>","bbox":[x0,y0,x1,y1],"items":3,...}
//
// The page is the visible page; the bridge adds the document id from its page watcher and
// relays the message into the router (docs/protocol.md, "dock_action"). With no bridge connected
// the action is logged and dropped, and the UI says so.

QString visiblePageId() {
    ToolFollow &tf = toolFollow();
    return tf.view && tf.view->isVisible() ? tf.view->property("pageId").toString() : QString();
}

// ---------------------------------------------------------------------------------------------
// Injected UI: QML items created at run time inside xochitl's own scene.
//
// xochitl's QML lives in its binary's resources; codrawer changes none of it, and nothing on
// disk that belongs to xochitl. An injection is a QML file of ours (shipped with the release in
// /home/root/xovi/exthome/codrawer-layer/) instantiated with xochitl's own QQmlEngine
// (`qmlEngine(parent)`) and parented into a live item found by a match:
//
//   class:<substring>   the item's class name contains it (e.g. class:Toolbar)
//   name:<objectName>   the item's objectName
//   text:<text>         the item's `text` property
//   prop:<name>=<value> any readable property, compared as a string
//
// with an optional `^` suffix to take the matched item's parent (the toolbar column of a matched
// redo button). With `after=1` the new item is stacked right after the matched item, so a
// Column or ColumnLayout places it there. If nothing matches, nothing is created and the reason is
// logged. The item is a child of xochitl's item, so it follows it (collapsed toolbar, rotation);
// if xochitl destroys that item (rebuilding the toolbar, a document closing), the 2 s tick
// creates ours again, backing off after repeated failures.
//
// The contract with the QML file (all optional): properties `entries` (list of {id, label}),
// `status` (string), `page` (string), set by the extension; signals `action(string id)` and
// `opened()`, which the extension connects. Entries come from /run/codrawer/dock.json
// (`{"entries":[{"id":…,"label":…},…]}`), re-read when it changes, so the bridge or the desktop
// can add agents without a rebuild; without it the built-in list below applies.
//
// Injections are requested by command (`inject`, `uninject`) and, from boot, by the lines of
// /home/root/xovi/exthome/codrawer-layer/inject.conf (same arguments as `inject`).

constexpr const char *kDockJson = "/run/codrawer/dock.json";
constexpr const char *kStatusFile = "/run/codrawer/status";
constexpr const char *kInjectConf = "/home/root/xovi/exthome/codrawer-layer/inject.conf";

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

// Items matching `spec` (without the `^`), in tree order.
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

QVariantList dockEntries() {
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

// The bridge's own status line (`status <text>` on the socket: engine, agent ink on/off), kept
// while the bridge is connected.
std::mutex &bridgeStatusMutex() {
    static std::mutex m;
    return m;
}
QString &bridgeStatus() {
    static QString s;
    return s;
}

void refreshInjected(struct Injection &in);
bool autoClientsActive();  // section "UI automation"

// From the socket's thread: keep the line, and show it on the next refresh (GUI thread).
void setBridgeStatus(const QString &line) {
    {
        std::lock_guard<std::mutex> lock(bridgeStatusMutex());
        bridgeStatus() = line;
    }
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] {
        for (Injection &in : injections()) refreshInjected(in);
    }, Qt::QueuedConnection);
}

QString localStatus() {
    QString s;
    {
        std::lock_guard<std::mutex> lock(bridgeStatusMutex());
        s = bridgeStatus();
    }
    QFile f(QString::fromLatin1(kStatusFile));  // the bridge's own line, when it writes one
    struct stat st;
    if (stat(kStatusFile, &st) == 0 && time(nullptr) - st.st_mtime < 30 && f.open(QIODevice::ReadOnly)) {
        s = QString::fromUtf8(f.read(512)).trimmed();
    }
    bool bridge = false;
    {
        std::lock_guard<std::mutex> lock(inkClientMutex());
        bridge = !currentInkClient().expired();
    }
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
}

void dockAction(const QString &source, const QString &id) {
    const QString page = visiblePageId();
    if (id == QLatin1String("status")) {
        for (Injection &in : injections()) refreshInjected(in);
        logLine(QStringLiteral("action: status (answered locally: %1)").arg(localStatus()));
        return;
    }
    QJsonObject o{{QStringLiteral("t"), QStringLiteral("dock_action")}, {QStringLiteral("id"), id},
                  {QStringLiteral("page"), page}, {QStringLiteral("source"), source}};
    if (id == QLatin1String("ask_selection")) {
        const Selection &s = selectionFollow().last;
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
    const QByteArray line = QJsonDocument(o).toJson(QJsonDocument::Compact);
    const bool sent = sendToBridge(line);
    logLine(QStringLiteral("action: %1 %2").arg(sent ? QStringLiteral("sent") : QStringLiteral("dropped (no bridge)"), QString::fromUtf8(line)));
    for (Injection &in : injections()) {
        if (in.item) in.item->setProperty("status", sent ? QStringLiteral("sent: %1").arg(id) : QStringLiteral("bridge not connected"));
    }
}

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

// inject name=<n> parent=<match>[^] qml=<path> [after=1]
void cmdInject(const QStringList &w) {
    Injection in;
    in.name = arg(w, "name");
    in.match = arg(w, "parent");
    in.qml = arg(w, "qml");
    in.after = arg(w, "after") == QLatin1String("1");
    in.onSelection = arg(w, "when") == QLatin1String("selection");
    in.inert = arg(w, "inert") == QLatin1String("1");
    if (in.name.isEmpty() || in.match.isEmpty() || in.qml.isEmpty()) {
        logLine(QStringLiteral("inject: needs name= parent= qml="));
        return;
    }
    for (int i = 0; i < injections().size(); ++i) {
        if (injections()[i].name == in.name) {
            if (injections()[i].item) delete injections()[i].item.data();
            delete injections()[i].relay;
            injections().removeAt(i);
            break;
        }
    }
    createInjection(in);
    injections() << in;
}

void cmdUninject(const QStringList &w) {
    const QString name = arg(w, "name");
    for (int i = 0; i < injections().size(); ++i) {
        if (injections()[i].name != name) continue;
        if (injections()[i].item) delete injections()[i].item.data();
        delete injections()[i].relay;
        injections().removeAt(i);
        logLine(QStringLiteral("uninject %1: removed").arg(name));
        return;
    }
    logLine(QStringLiteral("uninject %1: no such injection").arg(name));
}

// The tick's part: re-read inject.conf when it changes, re-create lost items (backing off:
// 2 s, then 10 s after three failures, then 60 s after ten), refresh entries when dock.json changes.
// createSelectionInjections: the when=selection injections, tried right after a lasso (the
// selection menu exists only then). Quiet when nothing matches: the menu may not be up yet.
void createSelectionInjections() {
    for (Injection &in : injections()) {
        if (!in.onSelection || in.item) continue;
        QString spec = in.match;
        if (spec.endsWith(QLatin1Char('^'))) spec.chop(1);
        if (matchItems(spec).isEmpty()) continue;
        createInjection(in);
    }
}

// The injection kill switch: the boot guard writes it when xochitl's journal shows errors from
// our QML (xovi.sh); the extension then makes no injection at all, while ink and text go on.
constexpr const char *kNoInject = "/home/root/codrawer/XOVI_NO_INJECT";

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
            for (const QString &l : QString::fromUtf8(f.readAll()).split(QLatin1Char('\n'), Qt::SkipEmptyParts)) {
                const QString t = l.trimmed();
                if (t.startsWith(QLatin1Char('#')) || t.isEmpty()) continue;
                logLine(QStringLiteral("inject.conf: %1").arg(t));
                cmdInject(t.split(QLatin1Char(' '), Qt::SkipEmptyParts));
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

// textprobe page=<uuid>: read-only. The text API's state on the page (the types and values of
// textDocumentId, rootDocumentLength, textCursorIndex, hasRootDocument, textParagraphStyle) and
// the signatures of the controller's text and image members (replaceText, pasteText,
// cycleParagraphStyle, setTextStyle, begin/endInputMethodTransaction, insertImage*), so that
// route A and a later image_insert rest on this build's real signatures.
void cmdTextProbe(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    QObject *c = p.controller;
    for (const char *prop : {"textDocumentId", "rootDocumentLength", "textCursorIndex", "hasRootDocument",
                             "textParagraphStyle", "textStyles", "hasTextSelection", "textModeEnabled"}) {
        if (c->metaObject()->indexOfProperty(prop) < 0) {
            logLine(QStringLiteral("textprobe: %1 <none>").arg(QString::fromLatin1(prop)));
            continue;
        }
        const QVariant v = c->property(prop);
        logLine(QStringLiteral("textprobe: %1 type=%2 value=%3 null=%4")
                    .arg(QString::fromLatin1(prop), QString::fromLatin1(v.metaType().name()), show(v)).arg(v.isNull()));
    }
    const QMetaObject *mo = c->metaObject();
    for (int i = 0; i < mo->methodCount(); ++i) {
        const QByteArray sig = mo->method(i).methodSignature();
        for (const char *k : {"replaceText", "pasteText", "ParagraphStyle", "TextStyle", "InputMethodTransaction",
                              "insertImage", "RootDocument", "setCursorIndex", "moveCursor"}) {
            if (sig.contains(k)) {
                logLine(QStringLiteral("textprobe: method #%1 %2 %3").arg(i).arg(QString::fromLatin1(mo->method(i).typeName()), QString::fromLatin1(sig)));
                break;
            }
        }
    }
}

// tree [match=<spec>] [depth=<n>]: the live item tree, read-only, for finding where to inject.
// Without match: the whole tree to `depth` (default 6). With match: each matching item's
// ancestry and subtree (to `depth`, default 4). Logs class, objectName, geometry, visibility, and
// `text`/`iconSource`/`source` where an item has them.
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

void cmdTree(const QStringList &w) {
    const QString match = arg(w, "match");
    int depth = arg(w, "depth").isEmpty() ? (match.isEmpty() ? 6 : 4) : arg(w, "depth").toInt();
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

// xform page=<uuid>: every view<->scene transform xochitl exposes for the page, read-only.
void cmdXform(const QStringList &w) {
    OpenPage p;
    if (!findOpenPage(arg(w, "page"), p)) return;
    auto showT = [](const QVariant &v) {
        if (!v.canConvert<QTransform>()) return QStringLiteral("<%1>").arg(QString::fromLatin1(v.metaType().name()));
        const QTransform t = v.value<QTransform>();
        return QStringLiteral("[%1 %2 %3 | %4 %5 %6 | dx %7 dy %8]").arg(t.m11()).arg(t.m12()).arg(t.m13())
            .arg(t.m21()).arg(t.m22()).arg(t.m23()).arg(t.dx()).arg(t.dy());
    };
    for (QObject *o : {static_cast<QObject *>(p.tiles), p.viewport, static_cast<QObject *>(p.view), p.pen, p.controller}) {
        if (!o) continue;
        const QByteArray cls = o->metaObject()->className();
        for (const char *prop : {"viewToSceneTransform", "sceneToViewTransform", "transform", "scale", "penScale", "contentX", "contentY", "zoomFactor"}) {
            if (o->metaObject()->indexOfProperty(prop) < 0) continue;
            const QVariant v = o->property(prop);
            logLine(QStringLiteral("xform %1.%2 = %3").arg(QString::fromLatin1(cls), QString::fromLatin1(prop),
                                                           v.canConvert<QTransform>() && v.metaType().id() == QMetaType::QTransform ? showT(v) : show(v)));
        }
        if (o->metaObject()->indexOfMethod("sceneToView(QPointF)") >= 0) {
            for (const QPointF &q : {QPointF(0, 0), QPointF(-560, 285)}) {
                QVariant r;
                invoke(o, "sceneToView", {q}, &r);
                QVariant back;
                invoke(o, "viewToScene", {q}, &back);
                logLine(QStringLiteral("xform %1.sceneToView(%2,%3) = %4; viewToScene(same) = %5")
                            .arg(QString::fromLatin1(cls)).arg(q.x()).arg(q.y()).arg(show(r), show(back)));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// UI automation, milestone 1: /run/codrawer/auto.sock (docs/investigations/ui-automation.md).
//
// Read and look only: `state`, `find`, `wait_for`, plus `resume`. One JSON request per line, one
// JSON reply per line, in order. The socket exists only while /home/root/codrawer/AUTOMATION
// exists (the user's opt-in); it is checked at load and by the 2 s tick. The guardrails that
// later milestones need (the deny list, edits only in "codrawer: test", the conditions) are pure
// functions in auto_rules.h, tested on the desktop (test.sh). While a client is connected the
// dock's status says "automation active"; the user's pen or finger pauses automation until
// `resume`; with the lock screen up only `state` answers (`locked`).

constexpr const char *kAutoSock = "/run/codrawer/auto.sock";
constexpr const char *kAutoOptIn = "/home/root/codrawer/AUTOMATION";

std::atomic<int> &autoClients() {
    static std::atomic<int> n{0};
    return n;
}
std::atomic<bool> &autoPaused() {
    static std::atomic<bool> p{false};
    return p;
}

// The lock screen, if it is up: a visible item whose class or objectName names a lock or
// passcode view.
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

// The first of `names` that `o` has as a readable property, as a JSON value (null if none).
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

QJsonObject autoState() {
    QJsonObject st;
    const bool locked = lockScreenUp();
    st.insert(QStringLiteral("locked"), locked);
    st.insert(QStringLiteral("paused"), autoPaused().load());
    ToolFollow &tf = toolFollow();
    st.insert(QStringLiteral("tool"), QString::fromLatin1(tf.last));
    if (tf.view && tf.view->isVisible()) {
        QQuickItem *v = tf.view;
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

// A dotted path into the state (`page.index`), as text for autorules::evalCond.
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

// ---------------------------------------------------------------------------------------------
// UI automation, milestones 2 and 3: grab, input, navigation (docs/investigations/ui-automation.md).
//
// `grab` copies xochitl's own display buffer out of this process's memory, the way the read-only
// fbgrab tool of Probe 1 did from outside: an anonymous mapping just over 6528 × 2160 bytes
// (1620 × 2160 at 4 bytes a pixel, stride 6528). It does not render: QQuickWindow::grabWindow
// would make the render loop draw again on the GUI thread, which inkling warns against, and a
// stall there trips xochitl's 60 s watchdog. The PNG is written by a worker thread.
//
// Input is QMouseEvents sent to the QQuickWindow on the GUI thread (xochitl's MouseAreas take
// them: the injected dock's MouseArea received the user's taps), paced by timers. Before a
// press, the item under the point and its ancestry are checked against the deny list
// (auto_rules.h); with a notebook open that is not "codrawer: test", taps are allowed only on
// the close button and the page overview (navigation); in the library, anything not denied.

struct GrabRegion {
    const unsigned char *base = nullptr;
    size_t size = 0;
};

// The display buffer: the first anonymous mapping of the right size.
GrabRegion displayBuffer() {
    constexpr size_t kStride = 6528, kH = 2160;
    FILE *f = std::fopen("/proc/self/maps", "r");
    if (!f) return {};
    char line[512];
    GrabRegion r;
    while (std::fgets(line, sizeof line, f)) {
        unsigned long a = 0, b = 0;
        char perms[8] = {0};
        int fields = 0;
        char path[256] = {0};
        fields = std::sscanf(line, "%lx-%lx %7s %*s %*s %*s %255s", &a, &b, perms, path);
        if (fields >= 5 && path[0]) continue;  // named mapping
        if (perms[0] != 'r') continue;
        const size_t sz = b - a;
        if (sz >= kStride * kH && sz < kStride * kH + (1u << 20)) {
            r.base = reinterpret_cast<const unsigned char *>(a);
            r.size = sz;
            break;
        }
    }
    std::fclose(f);
    return r;
}

// grab x y w h → PNG path (written by a worker; the reply comes when it is on disk).
void autoGrab(const QJsonObject &req, std::function<void(QJsonObject)> answer) {
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
        const unsigned char *src = r.base + size_t(y + row) * 6528 + size_t(x) * 4;
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

QQuickWindow *mainWindow() {
    for (QWindow *w : QGuiApplication::allWindows()) {
        if (auto *qw = qobject_cast<QQuickWindow *>(w); qw && qw->isVisible()) return qw;
    }
    return nullptr;
}

// The deepest visible item under a scene point and its ancestry's names (objectName and class),
// for the deny list.
std::vector<std::string> namesAt(QQuickWindow *w, const QPointF &p) {
    std::vector<std::string> names;
    QQuickItem *it = w->contentItem();
    for (int depth = 0; it && depth < 200; ++depth) {
        names.push_back(it->objectName().toStdString());
        names.push_back(it->metaObject()->className());
        const QPointF local = it->mapFromScene(p);
        QQuickItem *next = nullptr;
        const auto kids = it->childItems();
        for (auto k = kids.rbegin(); k != kids.rend(); ++k) {  // topmost first
            QQuickItem *c = *k;
            if (!c->isVisible() || !c->isEnabled()) continue;
            if (c->contains(c->mapFromItem(it, local))) {
                next = c;
                break;
            }
        }
        it = next;
    }
    return names;
}

QString visibleDocTitle() {
    ToolFollow &tf = toolFollow();
    if (!tf.view || !tf.view->isVisible()) return QString();
    QObject *docObj = tf.view->metaObject()->indexOfProperty("document") >= 0 ? tf.view->property("document").value<QObject *>() : nullptr;
    return firstProp(docObj, {"title", "visibleName", "name"}).toString();
}

// Why a synthesized press at p must not happen, or "".
QString inputRefusal(QQuickWindow *w, const QPointF &p) {
    if (lockScreenUp()) return QStringLiteral("locked");
    const std::vector<std::string> names = namesAt(w, p);
    const std::string d = autorules::denied(names);
    if (!d.empty()) return QStringLiteral("blocked: destructive or security UI (%1)").arg(QString::fromStdString(d));
    ToolFollow &tf = toolFollow();
    if (tf.view && tf.view->isVisible() && !autorules::editAllowed(visibleDocTitle().toStdString())) {
        bool nav = false;
        for (const std::string &n : names) nav = nav || n == "close-documentview-button" || n.find("pageOverview") != std::string::npos;
        if (!nav) return QStringLiteral("blocked: edits only in the notebook \"codrawer: test\" (open: \"%1\")").arg(visibleDocTitle());
    }
    return QString();
}

std::atomic<bool> &synthesizing() {
    static std::atomic<bool> s{false};
    return s;
}

void sendMouse(QQuickWindow *w, QEvent::Type type, const QPointF &p) {
    const Qt::MouseButtons buttons = type == QEvent::MouseButtonRelease ? Qt::NoButton : Qt::LeftButton;
    QMouseEvent ev(type, p, p, w->mapToGlobal(p), Qt::LeftButton, buttons, Qt::NoModifier);
    synthesizing() = true;
    QCoreApplication::sendEvent(w, &ev);
    synthesizing() = false;
}

// A press at `from`, moves to `to` over `ms` (16 ms steps), and a release: tap, long press, swipe.
void autoGesture(QPointF from, QPointF to, int ms, std::function<void(QJsonObject)> answer) {
    QQuickWindow *w = mainWindow();
    if (!w) return answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("no window")}});
    const QString why = inputRefusal(w, from);
    if (!why.isEmpty()) {
        logLine(QStringLiteral("auto: refused input at %1,%2: %3").arg(from.x()).arg(from.y()).arg(why));
        return answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), why}});
    }
    QPointer<QQuickWindow> pw(w);
    sendMouse(w, QEvent::MouseButtonPress, from);
    const int steps = std::max(1, ms / 16);
    auto *t = new QTimer(QCoreApplication::instance());
    auto step = std::make_shared<int>(0);
    t->setInterval(16);
    QObject::connect(t, &QTimer::timeout, [t, step, steps, from, to, pw, answer] {
        if (!pw) {
            t->stop();
            t->deleteLater();
            answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("window gone")}});
            return;
        }
        if (autoPaused()) {  // the user took over mid-gesture: let go where we are
            t->stop();
            t->deleteLater();
            const double f = double(*step) / steps;
            sendMouse(pw, QEvent::MouseButtonRelease, from + (to - from) * f);
            answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("paused by the user")}});
            return;
        }
        ++*step;
        const QPointF p = from + (to - from) * (double(*step) / steps);
        if (*step < steps) {
            if (from != to) sendMouse(pw, QEvent::MouseMove, p);
            return;
        }
        t->stop();
        t->deleteLater();
        sendMouse(pw, QEvent::MouseButtonRelease, to);
        answer(QJsonObject{{QStringLiteral("ok"), true}});
    });
    t->start();
}

QPointF centerOf(QQuickItem *it) { return it->mapToScene(QPointF(it->width() / 2, it->height() / 2)); }

// The milestone 2 and 3 commands; false when `cmd` is none of them.
bool autoRequestMore(const QString &cmd, const QJsonObject &req, std::function<void(QJsonObject)> answer) {
    auto fail = [answer](const QString &why) { answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), why}}); };
    auto pt = [&req](const char *kx, const char *ky) { return QPointF(req.value(QLatin1String(kx)).toDouble(), req.value(QLatin1String(ky)).toDouble()); };
    if (cmd == QLatin1String("grab")) {
        autoGrab(req, answer);
    } else if (cmd == QLatin1String("tap")) {
        autoGesture(pt("x", "y"), pt("x", "y"), 80, answer);
    } else if (cmd == QLatin1String("long_press")) {
        autoGesture(pt("x", "y"), pt("x", "y"), std::clamp(req.value(QStringLiteral("ms")).toInt(800), 300, 5000), answer);
    } else if (cmd == QLatin1String("swipe")) {
        autoGesture(pt("x0", "y0"), pt("x1", "y1"), std::clamp(req.value(QStringLiteral("ms")).toInt(300), 50, 5000), answer);
    } else if (cmd == QLatin1String("tap_item")) {
        // tap the centre of the first visible item matching a selector (find's syntax)
        const QString sel = req.value(QStringLiteral("selector")).toString();
        for (QQuickItem *it : matchItems(sel)) {
            if (it->isVisible() && it->width() > 0) return autoGesture(centerOf(it), centerOf(it), 80, answer), true;
        }
        fail(QStringLiteral("no visible item matches %1").arg(sel));
    } else if (cmd == QLatin1String("tool")) {
        const QString name = req.value(QStringLiteral("name")).toString();
        for (QQuickItem *it : matchItems(QStringLiteral("name:editingToolLoader_") + name)) {
            if (it->isVisible()) return autoGesture(centerOf(it), centerOf(it), 80, answer), true;
        }
        fail(QStringLiteral("no toolbar tool %1 (names: primaryPenMenu, secondaryPenMenu, typingMenu, eraserMenu, selectionButton, layersMenu, undoButton, redoButton)").arg(name));
    } else if (cmd == QLatin1String("open")) {
        // a notebook by its title, from the library: a tap on its tile's title
        const QString title = req.value(QStringLiteral("title")).toString();
        if (toolFollow().view && toolFollow().view->isVisible()) return fail(QStringLiteral("a notebook is open; close it first")), true;
        for (QQuickItem *it : matchItems(QStringLiteral("text:") + title)) {
            if (it->isVisible()) return autoGesture(centerOf(it), centerOf(it), 80, answer), true;
        }
        fail(QStringLiteral("no visible tile titled %1").arg(title));
    } else if (cmd == QLatin1String("goto")) {
        ToolFollow &tf = toolFollow();
        if (!tf.view || !tf.view->isVisible()) return fail(QStringLiteral("no notebook open")), true;
        const QString page = req.value(QStringLiteral("page")).toVariant().toString();
        for (const char *m : {"goToPageId", "goToPage", "setCurrentPage"}) {
            const QByteArray sig = QByteArray(m) + "(QString)";
            const QByteArray sigInt = QByteArray(m) + "(int)";
            QObject *target = nullptr;
            for (QQuickItem *v = tf.view; v && !target; v = v->parentItem()) {
                if (v->metaObject()->indexOfMethod(sig.constData()) >= 0 || v->metaObject()->indexOfMethod(sigInt.constData()) >= 0) target = v;
            }
            if (!target) continue;
            bool isInt = false;
            const int idx = page.toInt(&isInt);
            const bool called = isInt && target->metaObject()->indexOfMethod(sigInt.constData()) >= 0 ? invoke(target, m, {idx}) : invoke(target, m, {page});
            if (called) {
                answer(QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("via"), QString::fromLatin1(m)}});
                return true;
            }
        }
        fail(QStringLiteral("no page navigation function found on the DocumentView chain"));
    } else if (cmd == QLatin1String("text_insert") || cmd == QLatin1String("text_read")) {
        if (cmd == QLatin1String("text_insert") && !autorules::editAllowed(visibleDocTitle().toStdString()))
            return fail(QStringLiteral("blocked: edits only in the notebook \"codrawer: test\"")), true;
        auto send = [answer](const QString &r) {
            answer(QJsonObject{{QStringLiteral("ok"), !r.startsWith(QLatin1String("err "))}, {QStringLiteral("result"), r}});
        };
        if (cmd == QLatin1String("text_read")) send(textRead());
        else if (!textInsertRouteA(req.value(QStringLiteral("text")).toString(), send)) send(textInsert(req.value(QStringLiteral("text")).toString()));
    } else {
        return false;
    }
    return true;
}

// Handles one request on the GUI thread; `reply` gets the JSON reply (possibly later: wait_for).
void autoRequest(const QJsonObject &req, std::function<void(QJsonObject)> reply) {
    const QString id = req.value(QStringLiteral("id")).toVariant().toString();
    const QString cmd = req.value(QStringLiteral("cmd")).toString();
    auto answer = [id, reply](QJsonObject o) {
        o.insert(QStringLiteral("id"), id);
        reply(o);
    };
    auto fail = [answer](const QString &why) { answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), why}}); };
    logLine(QStringLiteral("auto: %1 %2").arg(cmd, QString::fromUtf8(QJsonDocument(req).toJson(QJsonDocument::Compact)).left(200)));
    if (cmd == QLatin1String("state")) {
        answer(QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("state"), autoState()}});
        return;
    }
    if (lockScreenUp()) return fail(QStringLiteral("locked"));
    if (cmd == QLatin1String("resume")) {
        autoPaused() = false;
        answer(QJsonObject{{QStringLiteral("ok"), true}});
        return;
    }
    if (autoPaused()) return fail(QStringLiteral("paused (the user touched the page; send resume)"));
    if (cmd == QLatin1String("find")) {
        const QString sel = req.value(QStringLiteral("selector")).toString();
        if (sel.indexOf(QLatin1Char(':')) <= 0) return fail(QStringLiteral("selector must be class:|name:|text:|prop:"));
        QJsonObject o = autoFind(sel);
        o.insert(QStringLiteral("ok"), true);
        answer(o);
        return;
    }
    if (cmd == QLatin1String("wait_for")) {
        const autorules::Cond c = autorules::parseCond(req.value(QStringLiteral("cond")).toString().toStdString());
        if (!c.ok) return fail(QStringLiteral("cond must be '<path> <op> <value>'"));
        const int timeout = std::clamp(req.value(QStringLiteral("timeout_ms")).toInt(3000), 0, 60000);
        const qint64 t0 = nowMs();
        waitFor([c] { return autorules::evalCond(c, statePath(autoState(), c.path)); }, timeout,
                [answer, c, t0](bool ok) {
                    answer(QJsonObject{{QStringLiteral("ok"), ok},
                                       {QStringLiteral("waited_ms"), double(nowMs() - t0)},
                                       {QStringLiteral("value"), QString::fromStdString(statePath(autoState(), c.path))}});
                });
        return;
    }
    if (autoRequestMore(cmd, req, answer)) return;
    fail(QStringLiteral("unknown command (state, find, wait_for, resume, grab, tap, long_press, swipe, tap_item, tool, open, goto, text_insert, text_read)"));
}

void serveAuto(const std::shared_ptr<InkClient> &cl) {
    ++autoClients();
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] { for (Injection &in : injections()) refreshInjected(in); },
                              Qt::QueuedConnection);
    QByteArray buf;
    char chunk[8192];
    for (;;) {
        const ssize_t n = read(cl->fd, chunk, sizeof chunk);
        if (n <= 0) break;
        buf.append(chunk, int(n));
        if (buf.size() > (1 << 16)) break;
        qsizetype nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const QByteArray line = buf.left(nl).trimmed();
            buf.remove(0, nl + 1);
            if (line.isEmpty()) continue;
            const QJsonDocument d = QJsonDocument::fromJson(line);
            if (!d.isObject()) {
                cl->reply(QStringLiteral("{\"ok\":false,\"error\":\"bad json\"}"));
                continue;
            }
            const QJsonObject req = d.object();
            QMetaObject::invokeMethod(QCoreApplication::instance(), [cl, req] {
                autoRequest(req, [cl](const QJsonObject &o) { cl->reply(QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact))); });
            }, Qt::QueuedConnection);
        }
    }
    cl->open = false;
    --autoClients();
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] { for (Injection &in : injections()) refreshInjected(in); },
                              Qt::QueuedConnection);
}

// The same protocol on 127.0.0.1:8579, loopback only, for the desktop runner through `ssh -L`
// (dropbear forwards TCP ports, not Unix sockets). Same opt-in, one client at a time.
constexpr int kAutoPort = 8579;

void autoTcpServer() {
    for (;;) {
        while (access(kAutoOptIn, F_OK) != 0) sleep(2);
        const int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        int one = 1;
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(kAutoPort);
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (s < 0 || bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof addr) != 0 || listen(s, 1) != 0) {
            logLine(QStringLiteral("auto: cannot listen on 127.0.0.1:%1 (errno %2)").arg(kAutoPort).arg(errno));
            if (s >= 0) close(s);
            sleep(10);
            continue;
        }
        logLine(QStringLiteral("auto: listening on 127.0.0.1:%1").arg(kAutoPort));
        while (access(kAutoOptIn, F_OK) == 0) {
            const int fd = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
            if (fd < 0) continue;
            if (access(kAutoOptIn, F_OK) != 0) {
                close(fd);
                break;
            }
            logLine(QStringLiteral("auto: tcp client connected"));
            serveAuto(std::make_shared<InkClient>(fd));
            logLine(QStringLiteral("auto: tcp client gone"));
        }
        close(s);
    }
}

// The socket's thread: only while the opt-in file exists (checked before each accept and every
// 2 s while waiting for it).
void autoServer() {
    for (;;) {
        while (access(kAutoOptIn, F_OK) != 0) sleep(2);
        unlink(kAutoSock);
        const int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, kAutoSock, sizeof addr.sun_path - 1);
        if (s < 0 || bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof addr) != 0 || listen(s, 1) != 0) {
            logLine(QStringLiteral("auto: cannot listen on %1 (errno %2)").arg(QString::fromLatin1(kAutoSock)).arg(errno));
            if (s >= 0) close(s);
            sleep(10);
            continue;
        }
        chmod(kAutoSock, 0600);
        logLine(QStringLiteral("auto: listening on %1 (opt-in %2 present)").arg(QString::fromLatin1(kAutoSock), QString::fromLatin1(kAutoOptIn)));
        while (access(kAutoOptIn, F_OK) == 0) {
            const int fd = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
            if (fd < 0) continue;
            if (access(kAutoOptIn, F_OK) != 0) {
                close(fd);
                break;
            }
            logLine(QStringLiteral("auto: client connected"));
            serveAuto(std::make_shared<InkClient>(fd));
            logLine(QStringLiteral("auto: client gone"));
        }
        close(s);
        unlink(kAutoSock);
        logLine(QStringLiteral("auto: opt-in removed; socket closed"));
    }
}


bool autoClientsActive() { return autoClients().load() > 0; }

// A real pen or finger on the page while automation is connected: pause until `resume`.
// (Milestone 1 synthesizes no input, so every gesture is the user's.)
std::atomic<bool> &synthesizing();

void pauseAutomationForUser() {
    if (synthesizing().load()) return;
    if (autoClients().load() > 0 && !autoPaused().exchange(true)) logLine(QStringLiteral("auto: paused by the user's pen or touch"));
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
        else if (c == QLatin1String("watch")) cmdWatch(w);
        else if (c == QLatin1String("unwatch")) cmdUnwatch();
        else if (c == QLatin1String("pending")) cmdPending(w);
        else if (c == QLatin1String("save")) cmdSave(w);
        else if (c == QLatin1String("dumpscene")) cmdDumpScene(w);
        else if (c == QLatin1String("tree")) cmdTree(w);
        else if (c == QLatin1String("textprobe")) cmdTextProbe(w);
        else if (c == QLatin1String("xform")) cmdXform(w);
        else if (c == QLatin1String("inject")) cmdInject(w);
        else if (c == QLatin1String("uninject")) cmdUninject(w);
        else if (c == QLatin1String("tool")) logLine(QStringLiteral("tool: %1").arg(QString::fromLatin1(toolFollow().last)));
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
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] {
        tickHooks().push_back([] { selectionTick(); });
        tickHooks().push_back([] { injectTick(); });
        startToolFollow();
    }, Qt::QueuedConnection);
    std::thread(autoServer).detach();
    std::thread(autoTcpServer).detach();
    std::thread(inkServer).detach();
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

// Exported explicitly: build.sh compiles with -fvisibility=hidden, and xovi finds the
// constructor by name in the dynamic symbol table.
extern "C" __attribute__((visibility("default"))) void _xovi_construct() {
    mkdir(kDir, 0700);
    std::thread(worker).detach();
}
