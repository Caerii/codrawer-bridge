// live.h: agent ink drawn as it is written, and the agent "thinking", in an overlay of ours.
//
// # The problem
//
// An agent stroke reaches the page natively only after it ends, through ink.h's commit chain
// (150-300 ms per batch, one e-ink refresh per commit), so the user saw a reply appear a letter at
// a time, "laggily". xochitl draws the user's own pen immediately, in the e-paper Pen waveform.
// The bridge now streams an ai stroke's points as they arrive (`live` lines; bridge
// agentink/live.go), and this module shows them at once in qml/live.qml, an overlay item of ours
// over the visible DocumentView that plays each stroke at the speed it was written, in an e-paper
// Animation region over just what it draws. When the stroke's native line has been committed, its
// overlay copy goes. The same overlay plays a small "thinking" animation where the answer will go
// while an agent considers a selection (`overlay` lines, from the router's `agent_status`), and
// hands it off into the answer's first stroke.
//
// # Rules
//
// - The user's pen always wins. The first version of the overlay filled the DocumentView (a
//   zero-input Canvas at z 1e6, plus a Pen screen-mode region over the live strokes), and the user's
//   pen stopped writing anywhere until XOVI was turned off (device, 2026-10-07): a lasso drawn with
//   the pen settled at log time 1791331826, the overlay was made at 1791331828 for the Ask that
//   lasso sent, the user reported the pen dead from then on, even idle, and on stock xochitl it
//   wrote again. The page-covering overlay was the one thing of ours over the whole page from that
//   moment (the dock's panel was hidden), so xochitl evidently does not let the pen write under
//   another item. Now the overlay's root is zero-sized, its one canvas spans only what it draws,
//   nothing of it takes input, it uses no Pen region (the user's pen's own), and when nothing is
//   shown it says `idle` and is destroyed here. Only a live stroke or a thinking overlay makes one.
//   tests/qml/live_test.qml guards all of this.
// - Nothing in the overlay is saved: it is our QML item, not page content (ink.h commits the real
//   line, as before).
// - It follows the visible page: points for another page are ignored, and the overlay is made
//   anew on the visible DocumentView when that changes.
// - The user wins: while the pen or a finger is on the page the overlay stops (it resumes where it
//   was), and commits wait as before (toolfollow.h, the write-back guard).
// - The XOVI_NO_INJECT kill switch (inject.h) also stops the overlay: then live lines are ignored
//   and ink appears at commit time, as before.
//
// # Units
//
// Socket points are page units (x centred; line_layout.h), and so is everything inside the
// overlay: it is anchored to the paper. Its root is placed with the tile manager's
// sceneToViewTransform (x, y = the offset, scale = the zoom) when made and at every change of that
// transform (its notify signal), so the doodle and the live strokes stay where they are on the page
// while it scrolls or zooms, without repainting; and it is told which page area is on screen, so it
// stops moving while what it draws is wholly scrolled away (as the user asked, 2026-10-07: "the
// place where the answer is loading should stay in the absolute position it was in the paper").
//
// # Threading
//
// GUI thread only (inksock.cpp posts every op here).
#pragma once

#include <QtCore/QJsonObject>
#include <QtCore/QRectF>
#include <QtCore/QString>

namespace cdl {

// A `live`, `live_end` or `overlay` op from the bridge (inksock.h). Replies nothing: errors are
// logged (`live: …`).
void liveOp(const QJsonObject &op);

// The user just tapped Ask (inject.h): start the thinking doodle at once, as "pending", just below
// `selection` (page units, x centred; left-aligned, a line's gap down) or, for the whole page (an
// invalid rect), a third of the way down the screen. The agent's first `overlay` status adopts it;
// with none in 8 s it shows a "?" and goes (the dock says so: liveLastAgentStatusMs).
void liveLocalThinking(const QRectF &selection);

// When the last `overlay` status from an agent arrived (nowMs), 0 for never.
qint64 liveLastAgentStatusMs();

// The commit chain's verdict for the stroke line `id` (ink.h, via inksock): the overlay copy goes
// a moment later, once the native line is on screen.
void liveCommitted(const QString &id);

// The user's pen or finger touched (true) or left (false) the page (toolfollow.h).
void livePen(bool down);

}  // namespace cdl
