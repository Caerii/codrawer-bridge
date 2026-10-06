// line.h: building xochitl's `Line` value from our points, and reading one back.
//
// # How a Line is built ("route 2": by layout)
//
// Route 1 was to feed points through xochitl's own pen pipeline. Its meta-objects
// (`PenInputSurface`, `ScenePenInputHandler`, `PenInputHandler`, `PenInput`, `Digitizer`) expose
// no member that accepts points: points arrive through C++ virtual calls from the digitizer
// thread (`DigitizerRM1xx::run` reading evdev). Reaching those means calling unexported virtuals
// by vtable slot or hooking libc `read` on the digitizer thread, the hot, blocking,
// multithreaded path inkling and XOVI's own README warn against. The `dump` probe logs the
// pipeline's meta-objects on the device, so that conclusion rests on the live build.
//
// Route 2 builds the value directly. `Line` is registered with `QMetaType`, so
// `QMetaType::fromName("Line")` gives xochitl's own default constructor, size and destructor.
// buildLine lets that constructor make a Line, checks the bytes against the layout table
// (line_layout.h), writes tool, colour, thickness and our point list into it, and reads every
// written field back through the gadget's own properties (`tool`, `pointCount`,
// `boundingRect`) before the Line is used. The point list is a QList allocated by Qt's exported
// `QArrayData` allocator and moved into the Line, so xochitl's destructor frees it the normal
// way. Nothing is called by address. Verified on 3.29.0.149 (2026-10-06): the Line renders,
// saves into the `.rm`, and the user's undo removes it (native-multiplayer-layer.md, "Probe 1:
// results").
//
// # Units
//
// Points are page coordinates (line_layout.h, "Units"); thickness is xochitl's pen size.
//
// # Threading
//
// GUI thread (buildLine reads gadget properties through xochitl's meta-objects; describeLine
// may also run in a signal's emitting thread for `watch`, and reads only the Line it is given).
#pragma once

#include "line_layout.h"

#include <QtCore/QList>
#include <QtCore/QMetaType>
#include <QtCore/QString>
#include <QtCore/QVariant>

namespace cdl {

using RmPoint = linelayout::RmPoint;

// A Line gadget property of the Line at `line`, read through its meta-object; invalid if the
// gadget has no such property.
QVariant readGadget(const QMetaType &lt, const void *line, const char *prop);

// Builds a populated Line in `out` (a QVariant of type Line, so its lifetime follows xochitl's
// value semantics): `tool` a Line::Tool value, `argb` the colour, `thickness` the pen size, `pts`
// at least one point in page coordinates. Returns false, logs why and builds nothing if the type
// is missing or not 88 bytes, the default Line does not match the layout table, or the gadget
// does not read back what was written. The bounding rect is stored only when the gadget's own
// does not cover the points (1 px slack per edge, so a straight or one-point stroke passes).
// `verbose` (the probes) also logs the raw bytes and every read-back.
bool buildLine(int tool, quint32 argb, double thickness, QList<RmPoint> pts, QVariant &out, bool verbose = true);

// The `Line` at `line` (one a signal passed, read in place) for the log: tool, eraser or not,
// thickness, point count, bounds, and its first and last point. The points are read only when the
// gadget's own `pointCount` agrees with the list at +16. Eraser paths, and every path with
// `full`, are also written whole to /tmp/codrawer-layer/line-<ms>.txt (`x y width pressure` per
// line: page px, quarter px, 0..255), the exact input xochitl gives `eraseWithLine`.
QString describeLine(const void *line, bool full);

}  // namespace cdl
