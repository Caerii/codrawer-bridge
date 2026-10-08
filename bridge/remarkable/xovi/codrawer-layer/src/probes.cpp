// probes.cpp: see probes.h. PROBE code.
#include "probes.h"

#include "cmdline_qt.h"
#include "ink.h"
#include "line.h"
#include "log.h"
#include "qtmeta.h"
#include "scene.h"

#include <QtCore/QSet>
#include <QtGui/QTransform>

#include <algorithm>
#include <cmath>

namespace cdl {

namespace {

// The probe's stroke: a 3-period wave across the upper left of the page (x −560…−140,
// y 285…375 in page coordinates), 120 points, 4 px wide, with a pressure taper at both ends.
QList<RmPoint> probeStroke() {
    QList<RmPoint> pts;
    constexpr int n = 120;
    for (int i = 0; i < n; ++i) {
        const double t = double(i) / (n - 1);
        const double x = -560.0 + 420.0 * t;
        const double y = 330.0 + 45.0 * std::sin(t * 3 * 2 * M_PI);
        const double dx = 420.0, dy = 45.0 * 3 * 2 * M_PI * std::cos(t * 3 * 2 * M_PI);
        const double taper = std::min(1.0, std::min(t, 1.0 - t) * 10.0);
        RmPoint p;
        p.x = float(x);
        p.y = float(y);
        p.speed = quint16(12);
        p.width = quint16(16);  // fineliner, size 2: 4 px
        p.direction = linelayout::directionByte(std::atan2(dy, dx));
        p.pressure = quint8(60 + std::lround(160 * taper));
        pts << p;
    }
    return pts;
}

}  // namespace

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
    if (lt.isValid() && lt.sizeOf() > 0 && lt.sizeOf() <= 256) {
        QVariant fresh(lt);
        logLine(QStringLiteral("Line default layout: %1").arg(hex(fresh.constData(), lt.sizeOf())));
    }
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
    const bool ok = buildLine(/*Finelinerv2*/ 17, 0xff1f6fe0u, 2.0, probeStroke(), line);
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

// Probe 1: one hard-coded stroke on "codrawer: test".
//   stroke page=<uuid> [argb=<hex>] [adopt=<layer>] [restore=<layer>]
void cmdStroke(const QStringList &w) {
    InkJob job;
    job.page = arg(w, "page");
    job.layer = kTestLayer();
    job.verbose = true;
    if (!arg(w, "adopt").isEmpty()) job.adopt = arg(w, "adopt").toInt();
    if (!arg(w, "restore").isEmpty()) job.restore = arg(w, "restore").toInt();
    InkStroke st;
    st.tool = 17;  // Finelinerv2
    st.argb = arg(w, "argb").isEmpty() ? 0xff1f6fe0u : arg(w, "argb").toUInt(nullptr, 16);
    st.thickness = 2.0;
    st.pts = probeStroke();
    job.strokes << st;
    job.done = [](const QString &r) {
        logLine(QStringLiteral("stroke: %1").arg(r));
    };
    enqueueInk(std::move(job));
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

// tree [match=<spec>] [depth=<n>]: see scene.h logTree.
void cmdTree(const QStringList &w) {
    const QString match = arg(w, "match");
    const int depth = arg(w, "depth").isEmpty() ? (match.isEmpty() ? 6 : 4) : arg(w, "depth").toInt();
    logTree(match, depth);
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

}  // namespace cdl
