// ink_protocol.h: the agent ink socket's governance limits and point conversion, as pure code.
//
// The bridge sends agent strokes to the extension as JSON lines on /run/codrawer/ink.sock
// (inksock.cpp has the protocol). ADR 003 makes agent ink governed: what the socket accepts is
// decided before anything reaches xochitl's GUI thread, and those decisions are here, with no Qt,
// so the host tests (tests/ink_protocol_test.cpp) pin the limits the extension enforces.
//
//   tools          only ink that xochitl commits through addDrawingLine (pens, pencils, marker,
//                  fineliner, calligraphy, paintbrush). Highlighters, erasers and the selection
//                  tool are refused. Names and numbers are Line::Tool values (logged by `dump`).
//   strokes        1..kMaxBatch per message; 1..kMaxPoints points per stroke.
//   thickness      0.1..20 (xochitl's pen size; the toolbar's sizes 1/2/3 are 1.0/2.0/3.0).
//   points         x in −2000..2000, y in −2000..40000 (page coordinates: x centred, y down
//                  from the top, long pages scroll down), width 0..200 px. NaN fails every test.
//   line length    kMaxLineBytes; a longer line closes the connection.
//
// A point arrives as [x, y, pressure 0..1, width px] and is stored as linelayout::RmPoint:
// width in quarter pixels, pressure 0..255, speed 12, and a direction of travel computed from
// its neighbours (fillDirections).
#pragma once

#include "line_layout.h"

#include <algorithm>
#include <cmath>
#include <string>

namespace inkproto {

using linelayout::RmPoint;

constexpr int kMaxBatch = 64;          // strokes per message, and per commit (ink.cpp merges up to it)
constexpr int kMaxPoints = 4000;       // points per stroke
constexpr int kMaxLineBytes = 1 << 20; // one JSON line

// A Line::Tool number the socket accepts, or −1.
inline int toolFromNumber(int t) {
    switch (t) {
    case 0: case 1: case 2: case 3: case 4: case 7: case 12: case 13: case 14: case 15: case 16: case 17: case 21:
        return t;
    default:
        return -1;
    }
}

// A tool name the socket accepts, as its Line::Tool number, or −1.
inline int toolFromName(const std::string &n) {
    if (n == "fineliner") return 17;
    if (n == "ballpoint" || n == "pen") return 15;
    if (n == "pencil") return 14;
    if (n == "mechanical" || n == "sharp_pencil") return 13;
    if (n == "marker") return 16;
    if (n == "calligraphy") return 21;
    if (n == "paintbrush" || n == "brush") return 12;
    return -1;
}

inline bool strokeCountOk(long long n) { return n >= 1 && n <= kMaxBatch; }
inline bool pointCountOk(long long n) { return n >= 1 && n <= kMaxPoints; }
inline bool thicknessOk(double t) { return t >= 0.1 && t <= 20.0; }

// x, y in page coordinates, wpx the point's drawn width in px.
inline bool pointOk(double x, double y, double wpx) {
    return x >= -2000 && x <= 2000 && y >= -2000 && y <= 40000 && wpx >= 0 && wpx <= 200;
}

// One accepted point (pointOk holds) as stored: pressure clamped to 0..1, direction 0 until
// fillDirections.
inline RmPoint toPoint(double x, double y, double pressure, double wpx) {
    RmPoint p;
    p.x = float(x);
    p.y = float(y);
    p.speed = 12;
    p.width = uint16_t(std::lround(wpx * 4));
    p.direction = 0;
    p.pressure = uint8_t(std::lround(std::clamp(pressure, 0.0, 1.0) * 255));
    return p;
}

// Sets each point's direction from its neighbours (the previous and next point, clamped at the
// ends; a one-point stroke gets 0). `Seq` is any indexable sequence of RmPoint (a QList here).
template <class Seq>
void fillDirections(Seq &pts) {
    const int n = int(pts.size());
    for (int i = 0; i < n; ++i) {
        const RmPoint a = pts[std::max(0, i - 1)];
        const RmPoint b = pts[std::min(n - 1, i + 1)];
        pts[i].direction = linelayout::directionByte(std::atan2(double(b.y - a.y), double(b.x - a.x)));
    }
}

}  // namespace inkproto
