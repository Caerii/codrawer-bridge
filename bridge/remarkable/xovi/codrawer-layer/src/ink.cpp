// ink.cpp: see ink.h. The steps are defined in reverse order of execution (each calls the
// next); read them from startCommit at the bottom up.
#include "ink.h"

#include "ink_protocol.h"
#include "log.h"
#include "qtmeta.h"
#include "scene.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QRectF>
#include <QtCore/QTimer>
#include <QtGui/QTransform>

#include <algorithm>
#include <memory>
#include <vector>

namespace cdl {

QString kTestLayer() { return QStringLiteral("codrawer: test"); }
QString kAgentLayer() { return QStringLiteral("codrawer: agent"); }

namespace {

using inkproto::kMaxBatch;

// One commit in flight: the job, the page's objects (guarded: xochitl may destroy them between
// steps), the user's layer to restore (by index and name), and ours.
struct Commit {
    InkJob job;
    QPointer<QObject> c, tiles, viewport;
    QPointer<QQuickItem> view;
    int original = -1;
    QString originalName;
    int ours = -1;
    qint64 t0 = 0;
    // The window (ink.h, "The commit window"): built Lines, and when each step was asked for and
    // seen (nowMs; 0 until then).
    QList<QVariant> lines;
    QRectF pageBounds;          // the strokes' bounds in page units (the repaint)
    Relay *relay = nullptr;     // currentLayer's notify while this commit runs
    int restoreTo = -1;         // the user's layer, found by name when the lines go in
    bool drawn = false;
    qint64 askedOursAt = 0, oursAt = 0, drawAt = 0, restoreCalledAt = 0, userAt = 0;
};
using CommitPtr = std::shared_ptr<Commit>;

QList<InkJob> &inkQueue() {
    static QList<InkJob> q;
    return q;
}
bool inkBusy = false;
bool pumpScheduled = false;
qint64 lastCommitAt = 0;
constexpr qint64 kDownSettleMs = 150;  // a pen down this long is a stroke, not a dot: commits may run
constexpr qint64 kCommitGapMs = 1500;  // between the starts of two commits (one e-ink refresh each)
void pumpInk();

// The commit whose layer is selected now (seen selected, the user's not yet seen again), if any.
CommitPtr &openWindow() {
    static CommitPtr w;
    return w;
}

// What the window has cost so far, for the log.
struct WindowStats {
    int commits = 0;
    qint64 maxMs = 0, totalMs = 0;
    int misfiled = 0, nearMisses = 0, duringPen = 0;
};
WindowStats &windowStats() {
    static WindowStats w;
    return w;
}

void closeWindow(const CommitPtr &s) {
    if (openWindow() == s) openWindow().reset();
}

void finishCommit(const CommitPtr &s, const QString &result) {
    closeWindow(s);
    if (s->relay) {
        s->relay->deleteLater();  // may be inside its own signal
        s->relay = nullptr;
    }
    logLine(QStringLiteral("ink: %1 (%2 stroke(s), layer \"%3\", %4 ms)")
                .arg(result).arg(s->job.strokes.size()).arg(s->job.layer).arg(nowMs() - s->t0));
    if (s->job.done) s->job.done(result);
    inkBusy = false;
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] { pumpInk(); }, Qt::QueuedConnection);
}

// The safety net: a user stroke completed while our layer was selected went onto it (xochitl adds
// a stroke to the current layer at pen-up). Nothing can move a Line between layers, so it is
// counted and logged loudly; `currentLayer` at that moment tells a real one from a near miss.
void userStrokeCompleted() {
    const CommitPtr w = openWindow();
    if (!w) return;
    const int cur = w->c ? w->c->property("currentLayer").toInt() : -1;
    if (cur == w->ours) {
        ++windowStats().misfiled;
        logLine(QStringLiteral("ink: WARNING a user stroke completed while \"%1\" (layer %2) was selected, %3 ms into the "
                               "commit window: it is on our layer (misfiled %4 so far)")
                    .arg(w->job.layer).arg(w->ours).arg(nowMs() - w->oursAt).arg(windowStats().misfiled));
    } else {
        ++windowStats().nearMisses;
        logLine(QStringLiteral("ink: a user stroke completed in the commit window but currentLayer reads %1 (ours %2): "
                               "near miss %3").arg(cur).arg(w->ours).arg(windowStats().nearMisses));
    }
}

bool stillOnPage(const CommitPtr &s) {
    return s->c && s->view && s->view->isVisible() && s->view->property("pageId").toString() == s->job.page &&
           s->c->property("pageId").toString() == s->job.page;
}

int currentLayer(const CommitPtr &s) { return s->c ? s->c->property("currentLayer").toInt() : -1; }

// The user's layer to give back: found by its name (indices move), else the index it had.
int userLayer(const CommitPtr &s) {
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
    return to;
}

// On errors: the user's layer again (if not selected), then the verdict.
void restoreUserLayer(const CommitPtr &s, const QString &verdict) {
    if (!stillOnPage(s)) {
        finishCommit(s, QStringLiteral("err page changed before the user's layer was restored (%1)").arg(verdict));
        return;
    }
    const int to = userLayer(s);
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

// Step 4: the user's layer is selected again. Now the parts that do not need our layer: render
// the lines to tiles and repaint just their part of the view (one e-ink refresh per commit), then
// the verdict.
void renderAndFinish(const CommitPtr &s) {
    if (!s->userAt) s->userAt = nowMs();
    closeWindow(s);
    WindowStats &w = windowStats();
    const qint64 window = s->oursAt ? s->userAt - s->oursAt : -1;
    if (window >= 0) {
        ++w.commits;
        w.totalMs += window;
        w.maxMs = std::max(w.maxMs, window);
    }
    logLine(QStringLiteral("ink: window %1 ms (our layer seen +%2 ms after asking, lines in +%3 ms after that, the user's "
                           "layer seen +%4 ms after asking)%5; %6 commits, mean %7 ms, max %8 ms, misfiled %9")
                .arg(window).arg(s->oursAt - s->askedOursAt).arg(s->drawAt - s->oursAt).arg(s->userAt - s->restoreCalledAt)
                .arg(userTouching() ? QStringLiteral(", pen down") : QString())
                .arg(w.commits).arg(w.commits ? w.totalMs / w.commits : 0).arg(w.maxMs).arg(w.misfiled));
    if (!stillOnPage(s)) {
        finishCommit(s, QStringLiteral("err page changed after the lines went in (%1 lines in)").arg(s->lines.size()));
        return;
    }
    if (s->tiles) {
        for (const QVariant &line : s->lines) invoke(s->tiles, "renderLineToTiles", {line});
    }
    if (s->viewport && s->view) {
        QRectF dirty(0, 0, s->view->width(), s->view->height());
        const QVariant tv = s->tiles ? s->tiles->property("sceneToViewTransform") : QVariant();
        if (tv.metaType().id() == QMetaType::QTransform && s->pageBounds.isValid())
            dirty = tv.value<QTransform>().mapRect(s->pageBounds).adjusted(-24, -24, 24, 24).intersected(dirty);
        invoke(s->viewport, "markDirty", {dirty});
        invoke(s->viewport, "requestRepaintDirty", {});
    }
    finishCommit(s, s->lines.size() == s->job.strokes.size()
                        ? QStringLiteral("ok %1").arg(s->lines.size())
                        : QStringLiteral("err %1 of %2 strokes built").arg(s->lines.size()).arg(s->job.strokes.size()));
}

// Step 3, the commit window: our layer is selected. Every line goes in at once and the user's
// layer is asked for straight away; nothing else happens while our layer is selected.
void drawNow(const CommitPtr &s) {
    if (s->drawn) return;
    s->drawn = true;
    if (!stillOnPage(s) || currentLayer(s) != s->ours) {
        closeWindow(s);
        restoreUserLayer(s, QStringLiteral("err layer %1 not selected; nothing drawn").arg(s->ours));
        return;
    }
    s->drawAt = nowMs();
    int added = 0;
    for (const QVariant &line : s->lines) added += invoke(s->c, "addDrawingLine", {line}) ? 1 : 0;
    s->restoreTo = userLayer(s);
    s->restoreCalledAt = nowMs();
    invoke(s->c, "setCurrentLayer", {s->restoreTo});
    if (added != s->lines.size()) logLine(QStringLiteral("ink: addDrawingLine refused %1 of %2").arg(s->lines.size() - added).arg(s->lines.size()));
    if (s->job.verbose) logLine(QStringLiteral("ink: addDrawingLine x%1 on layer %2, the user's layer %3 asked for").arg(added).arg(s->ours).arg(s->restoreTo));
    waitFor([s] { return !stillOnPage(s) || s->userAt || currentLayer(s) == s->restoreTo; }, 2000, [s](bool) {
        if (stillOnPage(s) && currentLayer(s) != s->restoreTo) {
            finishCommit(s, QStringLiteral("err could not restore the user's layer %1 (%2 lines in)").arg(s->restoreTo).arg(s->lines.size()));
            return;
        }
        renderAndFinish(s);
    });
}

// Step 2: build every Line first, then ask for our layer and do the rest the moment it is seen
// selected (currentLayer's notify; a 20 ms poll if it has none), so the window is as short as
// the scene allows.
void selectOurLayer(const CommitPtr &s) {
    if (!stillOnPage(s)) {
        finishCommit(s, QStringLiteral("err page changed"));
        return;
    }
    QRectF bounds;
    for (InkStroke &st : s->job.strokes) {
        QVariant line;
        if (!buildLine(st.tool, st.argb, st.thickness, st.pts, line, s->job.verbose)) continue;
        s->lines << line;
        for (const RmPoint &p : st.pts) bounds |= QRectF(p.x - 4, p.y - 4, 8, 8);
    }
    s->pageBounds = bounds;
    if (s->job.verbose && s->tiles && s->tiles->metaObject()->indexOfProperty("sceneToViewTransform") >= 0) {
        // Placement (ink.h): the Lines are page coordinates and are committed unmapped.
        const QVariant tv = s->tiles->property("sceneToViewTransform");
        if (tv.metaType().id() == QMetaType::QTransform) {
            const QTransform t = tv.value<QTransform>();
            logLine(QStringLiteral("ink: view offset dx %1 dy %2 zoom %3 (not applied: Lines are page coordinates)")
                        .arg(t.dx()).arg(t.dy()).arg(t.m11()));
        }
    }
    if (s->lines.isEmpty()) {
        finishCommit(s, QStringLiteral("err 0 of %1 strokes built").arg(s->job.strokes.size()));
        return;
    }
    if (!s->relay) {
        s->relay = new Relay;
        std::weak_ptr<Commit> weak = s;
        s->relay->on(s->c, Relay::notifyOf(s->c, "currentLayer"), [weak](void **) {
            CommitPtr s = weak.lock();
            if (!s || !s->c) return;
            const int cur = s->c->property("currentLayer").toInt();
            if (!s->oursAt && cur == s->ours && s->askedOursAt) {
                s->oursAt = nowMs();
                openWindow() = s;
                if (userTouching()) ++windowStats().duringPen;
                // the lines go in on the next turn of the event loop, outside xochitl's own signal
                QMetaObject::invokeMethod(QCoreApplication::instance(), [s] { drawNow(s); }, Qt::QueuedConnection);
            } else if (s->restoreCalledAt && !s->userAt && cur == s->restoreTo) {
                s->userAt = nowMs();
                closeWindow(s);
            }
        });
    }
    if (currentLayer(s) == s->ours) {  // the user has our layer selected; drawing there is still only ours
        s->askedOursAt = s->oursAt = nowMs();
        drawNow(s);
        return;
    }
    s->askedOursAt = nowMs();
    invoke(s->c, "setCurrentLayer", {s->ours});
    waitFor([s] { return !stillOnPage(s) || s->drawn || currentLayer(s) == s->ours; }, 2000, [s](bool) {
        if (s->drawn) return;
        if (stillOnPage(s) && currentLayer(s) == s->ours) {  // seen by the poll before (or without) the notify
            if (!s->oursAt) {
                s->oursAt = nowMs();
                openWindow() = s;
            }
            drawNow(s);
            return;
        }
        restoreUserLayer(s, QStringLiteral("err layer %1 not selected; nothing drawn").arg(s->ours));
    });
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

// Step 1: the page, the user's layer, and ours (found, adopted, or added).
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

// The queue: one commit at a time, merged where possible, never under the user's hand.
void pumpInk() {
    if (inkBusy || inkQueue().isEmpty()) return;
    static bool listening = false;
    if (!listening) {
        listening = true;
        addStrokeListener([] { userStrokeCompleted(); });
    }
    // The write-back guard (ink.h, "The commit window"): a user stroke misfiles only if it ends
    // inside the window of a few tens of ms while our layer is selected. So commits run in pen-up
    // gaps and while the pen is down and moving, but never in the first kDownSettleMs of a
    // gesture (a dot or a short tick could end inside the window), and at most every
    // kCommitGapMs, so a streaming answer is committed in batches (the live overlay shows it
    // meanwhile, live.h).
    const qint64 down = msPenDown();
    const qint64 wait = std::max<qint64>({down >= 0 ? kDownSettleMs - down : 0, kCommitGapMs - (nowMs() - lastCommitAt)});
    if (wait > 0) {
        if (!pumpScheduled) {
            pumpScheduled = true;
            QTimer::singleShot(int(std::min<qint64>(wait, 200)), QCoreApplication::instance(), [] {
                pumpScheduled = false;
                pumpInk();
            });
        }
        return;
    }
    lastCommitAt = nowMs();
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

}  // namespace

void enqueueInk(InkJob job) {
    if (inkQueue().size() >= kMaxQueue) {
        if (job.done) job.done(QStringLiteral("err busy"));
        return;
    }
    inkQueue().append(std::move(job));
    pumpInk();
}

}  // namespace cdl
