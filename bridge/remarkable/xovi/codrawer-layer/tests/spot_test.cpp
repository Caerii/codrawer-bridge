// Tests for spot.h (where an answer goes), host-only, no Qt.
#include "spot.h"

#include "check.h"

#include <vector>

using namespace spot;

int main() {
    // the device's lasso (2026-10-07): rect -436.6,406.6 822x100; ink a little inside it
    const Rect lasso{-436.6, 406.6, 385.6, 506.5};
    const std::vector<Rect> lines{{-426, 412, -100, 470}, {-90, 430, 300, 498}, {0, 0, 0, 0}};
    const Rect ink = unite(lines.begin(), lines.end());
    CHECK(ink.x0 == -426 && ink.y0 == 412 && ink.x1 == 300 && ink.y1 == 498);
    CHECK(inkInsideLasso(ink, lasso));

    const Rect s = answerSpot(ink);
    CHECK(s.x0 == -426 && s.y0 == 498 + kBelowGap);     // the ink's left edge, 36 below its bottom
    CHECK(s.x1 == -426 + 726 && s.y1 == s.y0 + kSpotH);  // as wide as the ink when wider than 600
    const Rect narrow = answerSpot({0, 0, 100, 50});
    CHECK(narrow.x1 - narrow.x0 == kSpotW);

    // not believable: empty, or reaching well outside the lasso (other coordinates, a stale list)
    CHECK(!inkInsideLasso(Rect{}, lasso));
    CHECK(!inkInsideLasso({300, 600, 900, 700}, lasso));
    CHECK(inkInsideLasso({-450, 400, 400, 520}, lasso));  // within the pen's slack
    const std::vector<Rect> none;
    CHECK(unite(none.begin(), none.end()).empty());
    return finish("spot");
}
