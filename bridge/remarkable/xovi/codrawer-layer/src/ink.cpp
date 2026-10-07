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
    QVariant boundsBefore;
};
using CommitPtr = std::shared_ptr<Commit>;

QList<InkJob> &inkQueue() {
    static QList<InkJob> q;
    return q;
}
bool inkBusy = false;
bool pumpScheduled = false;
qint64 lastCommitAt = 0;
constexpr qint64 kPenGapMs = 800;     // the user's pen up at least this long before a commit
constexpr qint64 kCommitGapMs = 1500; // between the starts of two commits
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

// Steps 3 and 4a: the lines themselves, then the wait for the scene to take them.
void drawLines(const CommitPtr &s) {
    if (!stillOnPage(s) || currentLayer(s) != s->ours) {
        restoreUserLayer(s, QStringLiteral("err layer %1 not selected; nothing drawn").arg(s->ours));
        return;
    }
    const QMetaObject *cm = s->c->metaObject();
    const bool hasItemsBounds = cm->indexOfProperty("itemsBoundingRect") >= 0;
    s->boundsBefore = hasItemsBounds ? s->c->property("itemsBoundingRect") : QVariant();
    int added = 0;
    // Placement (ink.h): the Lines are page coordinates and are committed unmapped; the view
    // transform is only logged.
    if (s->job.verbose && s->tiles && s->tiles->metaObject()->indexOfProperty("sceneToViewTransform") >= 0) {
        const QVariant tv = s->tiles->property("sceneToViewTransform");
        if (tv.metaType().id() == QMetaType::QTransform) {
            const QTransform t = tv.value<QTransform>();
            logLine(QStringLiteral("ink: view offset dx %1 dy %2 zoom %3 (not applied: Lines are page coordinates)")
                        .arg(t.dx()).arg(t.dy()).arg(t.m11()));
        }
    }
    for (InkStroke &st : s->job.strokes) {
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
            if (userTouching()) return true;  // the user writes again: give their layer back now
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
    // The write-back guard: commit only in a pause of the user's writing (no pen down, and at least
    // kPenGapMs since it lifted: a commit selects our layer for a few hundred ms, and a user stroke
    // ending meanwhile would land on it), and at most every kCommitGapMs, so a streaming answer is
    // committed in batches (the live overlay shows it meanwhile, live.h).
    const qint64 wait = std::max<qint64>({userTouching() ? kPenGapMs : 0, kPenGapMs - msSincePenUp(),
                                          kCommitGapMs - (nowMs() - lastCommitAt)});
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
