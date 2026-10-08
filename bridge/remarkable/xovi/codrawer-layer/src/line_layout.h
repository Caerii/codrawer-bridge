// line_layout.h: the byte layout of xochitl's `Line` value and of its points, as pure code.
//
// # The problem
//
// A stroke enters a page through `SceneController::addDrawingLine(const Line &)`, and nothing in
// QML builds a `Line` with chosen points: the gadget has no writable properties
// (docs/investigations/native-multiplayer-layer.md §2, "Line — the stroke value type"). The
// extension therefore lets xochitl's own default constructor make one (through `QMetaType`) and
// then fills the fields it needs at their offsets. This header is that layout, with no Qt, so the
// host tests (tests/line_layout_test.cpp) pin it; line.cpp does the construction and the
// read-back checks against the live gadget.
//
// # The layout (3.29.0.149 / Codex 6.0.105)
//
// Read statically from the default constructor, move constructor, equality operator and
// destructor in the binary (all reached through the `QMetaTypeInterface`), then corrected by the
// first device run (2026-10-06, native-multiplayer-layer.md "Probe 1: results", item 1): the
// default constructor's 9 at +0 is the *tool* (the gadget's `tool` read 9 before and after a 17
// was written at +4), and +4 is the colour. The run-time check caught it; nothing was committed.
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
// A point is 14 packed bytes, the record the `.rm` v6 file stores per point
// (docs/investigations/xochitl-pen-data.md): f32 x, f32 y, u16 speed, u16 width (quarter
// pixels), u8 direction, u8 pressure.
//
// # Units
//
// Points are in page coordinates, exactly as the `.rm` file stores them: x centred on the page
// (−810..810 across a 1620 px page), y down from the page's top, in page pixels. `addDrawingLine`
// takes them unmapped at any pan and zoom (measured 2026-10-06, native-multiplayer-layer.md
// "Probe 1: results", item 4).
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

namespace linelayout {

// One point of a Line, as xochitl and the .rm file store it.
struct RmPoint {
    float x, y;          // page coordinates (see Units above)
    uint16_t speed;      // as the pen reports it; agent and probe ink use 12
    uint16_t width;      // drawn width in quarter pixels
    uint8_t direction;   // angle of travel, 0..255 = 0..2π (directionByte)
    uint8_t pressure;    // 0..255
} __attribute__((packed));
static_assert(sizeof(RmPoint) == 14, "xochitl's Line point is 14 bytes");

// ARM32: OS 3.28.0.172 reports size 72 and the default double at +24.
// QList has three native-width words; gadget read-back in buildLine validates the layout.
constexpr bool kArm32 = sizeof(uintptr_t) == 4;
constexpr int kLineSize = kArm32 ? 72 : 88;
constexpr int kOffTool = 0, kOffColor = 4, kOffArgb = 8,
              kOffPoints = kArm32 ? 12 : 16, kOffThickness = kArm32 ? 24 : 40,
              kOffBounds = kArm32 ? 40 : 56;

// Line::Color value that makes the ARGB word at +8 the stroke's colour.
constexpr uint32_t kColorArgbCode = 9;

// The fixed-size fields of a Line, decoded from its bytes.
struct Header {
    uint32_t tool = 0, color = 0, argb = 0;
    uintptr_t listD = 0, listPtr = 0;  // the point QList's d and ptr
    intptr_t listSize = 0;              // its element count
    double thickness = 0;
};

inline Header readHeader(const unsigned char *p) {
    Header h;
    std::memcpy(&h.color, p + kOffColor, 4);
    std::memcpy(&h.tool, p + kOffTool, 4);
    std::memcpy(&h.argb, p + kOffArgb, 4);
    std::memcpy(&h.listD, p + kOffPoints, sizeof(uintptr_t));
    std::memcpy(&h.listPtr, p + kOffPoints + sizeof(uintptr_t), sizeof(uintptr_t));
    std::memcpy(&h.listSize, p + kOffPoints + 2 * sizeof(uintptr_t), sizeof(intptr_t));
    std::memcpy(&h.thickness, p + kOffThickness, 8);
    return h;
}

// What xochitl's default constructor must have produced if the table above holds for this
// build: plausible enum values, opaque black, an empty (null) point list, thickness 1. If any of
// it differs, the layout is wrong for this xochitl and line.cpp writes nothing.
inline bool defaultLooksRight(const Header &h) {
    return h.color < 16 && h.tool < 25 && h.argb == 0xff000000u && h.listD == 0 && h.listSize == 0 &&
           h.thickness == 1.0;
}

// Writes tool, colour (kColorArgbCode), ARGB and thickness into a default-constructed Line. The
// point list and bounding rect are line.cpp's (they need Qt's allocator and QRectF).
inline void writeHeader(unsigned char *p, int tool, uint32_t argb, double thickness) {
    const uint32_t colorArgbCode = kColorArgbCode;
    std::memcpy(p + kOffColor, &colorArgbCode, 4);
    std::memcpy(p + kOffTool, &tool, 4);
    std::memcpy(p + kOffArgb, &argb, 4);
    std::memcpy(p + kOffThickness, &thickness, 8);
}

// An angle of travel in radians (atan2's −π..π) as the point's direction byte: 0..255 over a
// full turn, rounded, 2π wrapping to 0.
inline uint8_t directionByte(double ang) {
    if (ang < 0) ang += 2 * M_PI;
    return uint8_t(std::lround(ang / (2 * M_PI) * 255.0) & 0xff);
}

}  // namespace linelayout
