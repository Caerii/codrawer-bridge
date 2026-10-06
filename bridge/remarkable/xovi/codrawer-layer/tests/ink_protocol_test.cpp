// Tests for ink_protocol.h (the agent ink socket's limits and point conversion), host-only.
#include "ink_protocol.h"

#include "check.h"

#include <cmath>
#include <vector>

using namespace inkproto;

int main() {
    // tools: ink only
    CHECK(toolFromName("fineliner") == 17 && toolFromName("pen") == 15 && toolFromName("ballpoint") == 15);
    CHECK(toolFromName("pencil") == 14 && toolFromName("sharp_pencil") == 13 && toolFromName("mechanical") == 13);
    CHECK(toolFromName("marker") == 16 && toolFromName("calligraphy") == 21 && toolFromName("brush") == 12);
    CHECK(toolFromName("highlighter") == -1 && toolFromName("eraser") == -1 && toolFromName("Fineliner") == -1);
    for (int t : {0, 1, 2, 3, 4, 7, 12, 13, 14, 15, 16, 17, 21}) CHECK(toolFromNumber(t) == t);
    for (int t : {-1, 5, 6, 8, 9, 10, 11, 18, 22, 23, 99}) CHECK(toolFromNumber(t) == -1);  // highlighters, erasers, select, zoom

    // counts and sizes
    CHECK(!strokeCountOk(0) && strokeCountOk(1) && strokeCountOk(64) && !strokeCountOk(65));
    CHECK(!pointCountOk(0) && pointCountOk(4000) && !pointCountOk(4001));
    CHECK(!thicknessOk(0.09) && thicknessOk(0.1) && thicknessOk(20) && !thicknessOk(20.01) && !thicknessOk(NAN));
    CHECK(kMaxLineBytes == 1048576);

    // points: page range; NaN never passes
    CHECK(pointOk(0, 0, 4) && pointOk(-2000, -2000, 0) && pointOk(2000, 40000, 200));
    CHECK(!pointOk(2000.5, 0, 4) && !pointOk(0, 40001, 4) && !pointOk(0, -2001, 4));
    CHECK(!pointOk(0, 0, -0.1) && !pointOk(0, 0, 200.1));
    CHECK(!pointOk(NAN, 0, 4) && !pointOk(0, NAN, 4) && !pointOk(0, 0, NAN));

    // conversion: width in quarter px, pressure 0..255 clamped, speed 12
    RmPoint p = toPoint(-560.25, 330.5, 0.5, 4.0);
    CHECK(p.x == -560.25f && p.y == 330.5f && p.width == 16 && p.pressure == 128 && p.speed == 12 && p.direction == 0);
    CHECK(toPoint(0, 0, 2.0, 1.1).pressure == 255 && toPoint(0, 0, -1, 1.1).pressure == 0);
    CHECK(toPoint(0, 0, 0, 1.1).width == 4);  // 4.4 rounds to 4
    CHECK(toPoint(0, 0, 0, 1.125).width == 5);  // 4.5 rounds away from zero

    // directions from neighbours: east 0, south (y down) 64, west 128, north 191
    std::vector<RmPoint> line = {toPoint(0, 0, .5, 4), toPoint(10, 0, .5, 4), toPoint(20, 0, .5, 4)};
    fillDirections(line);
    CHECK(line[0].direction == 0 && line[1].direction == 0 && line[2].direction == 0);
    std::vector<RmPoint> down = {toPoint(0, 0, .5, 4), toPoint(0, 10, .5, 4)};
    fillDirections(down);
    CHECK(down[0].direction == 64 && down[1].direction == 64);
    std::vector<RmPoint> west = {toPoint(10, 0, .5, 4), toPoint(0, 0, .5, 4)};
    fillDirections(west);
    CHECK(west[0].direction == 128);
    std::vector<RmPoint> up = {toPoint(0, 10, .5, 4), toPoint(0, 0, .5, 4)};
    fillDirections(up);
    CHECK(up[0].direction == 191);  // 3π/2 → 191.25
    std::vector<RmPoint> one = {toPoint(5, 5, .5, 4)};
    fillDirections(one);
    CHECK(one[0].direction == 0);
    // the corner: the middle point looks from its previous to its next neighbour (south-east)
    std::vector<RmPoint> corner = {toPoint(0, 0, .5, 4), toPoint(10, 0, .5, 4), toPoint(10, 10, .5, 4)};
    fillDirections(corner);
    CHECK(corner[1].direction == 32);
    return finish("ink_protocol");
}
