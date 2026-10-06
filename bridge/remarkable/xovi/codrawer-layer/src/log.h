// log.h: the extension's log, and the formatting every module shares.
//
// One line per fact, stamped with wall-clock seconds and milliseconds, appended to
// /tmp/codrawer-layer/log and written to stderr (xochitl's journal, prefixed
// `[codrawer-layer]`). Scripts and docs grep these lines (`ready`, `ink: ok`, `tool: following`,
// `inject dock: created`, …), so their wording is an interface: keep it when moving code.
//
// Threading: callable from any thread. Each line is opened, written and closed on its own, so
// lines from the GUI thread, the socket threads and the command poller interleave whole.
#pragma once

#include <QtCore/QString>
#include <QtCore/QVariant>

namespace cdl {

// Appends `s` as one stamped line to the log file and to stderr.
void logLine(const QString &s);

// The first `n` bytes at `p` in hex, a space every 8 bytes (for the Line layout checks).
QString hex(const void *p, int n);

// A value as the log shows it: plain values as text with their type, QObject pointers as
// `Class(address)`, rects and points spelled out, unsigned ints in hex, gadgets and lists by
// type name. Reads nothing beyond the value.
QString show(const QVariant &v);

// Wall-clock time in ms (CLOCK_REALTIME); the unit of every timeout and age in the extension.
qint64 nowMs();

}  // namespace cdl
