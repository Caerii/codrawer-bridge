// live.h: agent ink drawn as it is written, and the agent "thinking", in an overlay of ours.
//
// # The problem
//
// An agent stroke reaches the page natively only after it ends, through ink.h's commit chain
// (150-300 ms per batch, one e-ink refresh per commit), so the user saw a reply appear a letter at
// a time, "laggily". xochitl draws the user's own pen immediately, in the e-paper Pen waveform.
// The bridge now streams an ai stroke's points as they arrive (`live` lines; bridge
// agentink/live.go), and this module shows them at once in qml/live.qml, an overlay item of ours
// over the visible DocumentView that plays each stroke at the speed it was written and marks its
// region as an e-paper Pen region. When the stroke's native line has been committed, its overlay
// copy goes. The same overlay plays a small "thinking" animation beside a selection while an
// agent considers it (`overlay` lines, from the router's `agent_status`), and hands it off into
// the answer's first stroke.
//
// # Rules
//
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
// Socket points are page units (x centred; line_layout.h); the overlay works in the
// DocumentView's own coordinates, through the tile manager's sceneToViewTransform at the time each
// point arrives. Widths scale with the zoom.
//
// # Threading
//
// GUI thread only (inksock.cpp posts every op here).
#pragma once

#include <QtCore/QJsonObject>
#include <QtCore/QString>

namespace cdl {

// A `live`, `live_end` or `overlay` op from the bridge (inksock.h). Replies nothing: errors are
// logged (`live: …`).
void liveOp(const QJsonObject &op);

// The commit chain's verdict for the stroke line `id` (ink.h, via inksock): the overlay copy goes
// a moment later, once the native line is on screen.
void liveCommitted(const QString &id);

// The user's pen or finger touched (true) or left (false) the page (toolfollow.h).
void livePen(bool down);

}  // namespace cdl
