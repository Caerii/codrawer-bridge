// Tests for line_layout.h (xochitl's Line bytes), host-only, no Qt.
#include "line_layout.h"

#include "check.h"

#include <cstddef>
#include <cstring>

using namespace linelayout;

int main() {
    CHECK(kLineSize == (sizeof(uintptr_t) == 4 ? 72 : 88));
    CHECK(kOffThickness == (sizeof(uintptr_t) == 4 ? 24 : 40));

    // the point record is the .rm v6 one: 14 packed bytes
    CHECK(sizeof(RmPoint) == 14);
    CHECK(offsetof(RmPoint, x) == 0 && offsetof(RmPoint, y) == 4 && offsetof(RmPoint, speed) == 8);
    CHECK(offsetof(RmPoint, width) == 10 && offsetof(RmPoint, direction) == 12 && offsetof(RmPoint, pressure) == 13);

    // a default Line as xochitl's constructor leaves it (3.29.0.149): tool 9 at +0, colour 0 at +4,
    // opaque black at +8, a null empty list at +16, thickness 1.0 at +40
    unsigned char line[kLineSize] = {};
    const uint32_t tool9 = 9, black = 0xff000000u;
    const double one = 1.0;
    std::memcpy(line + 0, &tool9, 4);
    std::memcpy(line + 8, &black, 4);
    std::memcpy(line + kOffThickness, &one, 8);
    Header h = readHeader(line);
    CHECK(h.tool == 9 && h.color == 0 && h.argb == black && h.listD == 0 && h.listPtr == 0 && h.listSize == 0 && h.thickness == 1.0);
    CHECK(defaultLooksRight(h));

    // the first static reading had tool and colour swapped; this check is what caught it
    Header bad = h;
    bad.tool = 30;
    CHECK(!defaultLooksRight(bad));
    bad = h;
    bad.listSize = 3;
    CHECK(!defaultLooksRight(bad));
    bad = h;
    bad.thickness = 2.0;
    CHECK(!defaultLooksRight(bad));
    bad = h;
    bad.argb = 0;
    CHECK(!defaultLooksRight(bad));

    // writing: tool at +0, colour ArgbCode (9) at +4, ARGB at +8, thickness at +40; nothing else
    unsigned char before[kLineSize];
    std::memcpy(before, line, kLineSize);
    writeHeader(line, 17, 0xff1f6fe0u, 2.0);
    h = readHeader(line);
    CHECK(h.tool == 17 && h.color == kColorArgbCode && h.argb == 0xff1f6fe0u && h.thickness == 2.0);
    CHECK(std::memcmp(line + 12, before + 12, kOffThickness - 12) == 0);  // +12..+40: padding and the point list
    CHECK(std::memcmp(line + kOffThickness + 8, before + kOffThickness + 8, kLineSize - kOffThickness - 8) == 0);  // length, bounds

    // direction bytes: 0..255 over a full turn, negative angles wrapped
    CHECK(directionByte(0) == 0);
    CHECK(directionByte(M_PI / 2) == 64);
    CHECK(directionByte(M_PI) == 128);
    CHECK(directionByte(-M_PI / 2) == 191);
    CHECK(directionByte(2 * M_PI - 1e-9) == 255);
    return finish("line_layout");
}
