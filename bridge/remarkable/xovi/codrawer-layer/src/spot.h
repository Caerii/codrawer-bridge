// spot.h: where an answer to an Ask goes, proposed by the tablet; pure, no Qt.
//
// # The problem
//
// The user taps Ask and a thinking doodle should start at once where the answer will be written,
// and stay there: a doodle that starts in one place and jumps when the agent's first status names
// another is awkward (device, 2026-10-07: the pending doodle sat 36 units under the lasso rect,
// agentd's spot was 121 units lower). So the tablet proposes the spot and sends it with the Ask
// (`"spot"`, and `"ink"` when it has the selected ink's real bounds; docs/protocol.md,
// dock_action), and agentd uses it unless it collides or does not fit. Both sides compute it the
// same way, from the same numbers:
//
//   the spot's top left is the ink's left edge, kBelowGap (36) page units below the ink's bottom
//   (agentd's BELOW_GAP), at least kSpotW wide (or the ink's width, if wider) and kSpotH high.
//
// # The ink's bounds
//
// The lasso's rect (`areaSelected`) is not the ink: a loose lasso is larger than what it caught.
// SceneController's `getLineBoundingRectsToBeSelected()` returns the selected lines' rects
// (selection.h reads it when a selection settles). Those are trusted only if, as a whole, they lie
// inside the lasso's rect (a little slack for the pen's width) and are not empty
// (`inkInsideLasso`); else the lasso's rect stands in.
//
// Units: page units throughout (x centred, y down from the top; line_layout.h).
#pragma once

#include <algorithm>

namespace spot {

constexpr double kBelowGap = 36;  // page units between the ink's bottom and the answer's top
constexpr double kSpotW = 600;
constexpr double kSpotH = 200;
constexpr double kSlack = 24;     // how far ink may reach outside the lasso rect (pen width)

struct Rect {
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    bool empty() const { return !(x1 > x0 && y1 > y0); }
    double w() const { return x1 - x0; }
};

// The answer's spot for ink bounds `ink`.
inline Rect answerSpot(const Rect &ink) {
    return {ink.x0, ink.y1 + kBelowGap, ink.x0 + std::max(kSpotW, ink.w()), ink.y1 + kBelowGap + kSpotH};
}

// The union of rects, or an empty Rect for none.
template <typename It>
Rect unite(It begin, It end) {
    Rect u;
    bool any = false;
    for (It it = begin; it != end; ++it) {
        if (it->empty()) continue;
        if (!any) u = *it;
        u = {std::min(u.x0, it->x0), std::min(u.y0, it->y0), std::max(u.x1, it->x1), std::max(u.y1, it->y1)};
        any = true;
    }
    return any ? u : Rect{};
}

// Ink bounds are believable: not empty, and inside the lasso's rect give or take kSlack.
inline bool inkInsideLasso(const Rect &ink, const Rect &lasso) {
    return !ink.empty() && !lasso.empty() && ink.x0 >= lasso.x0 - kSlack && ink.y0 >= lasso.y0 - kSlack &&
           ink.x1 <= lasso.x1 + kSlack && ink.y1 <= lasso.y1 + kSlack;
}

}  // namespace spot
