// grab.h: a PNG of a screen region, copied from xochitl's own display buffer.
//
// `grab` copies the display buffer out of this process's memory, the way Probe 1's read-only
// fbgrab tool did from outside: the first readable anonymous mapping of one frame's size
// (procmaps.h: 1620 × 2160 pixels, 4 bytes a pixel, stride 6528). It does not render:
// QQuickWindow::grabWindow would make the render loop draw again on the GUI thread, which inkling
// warns against, and a stall there trips xochitl's 60 s watchdog
// (docs/investigations/ui-automation.md, "grab").
//
// # Threading
//
// The copy runs on the GUI thread (a few MB at most); a detached worker thread encodes and writes
// the PNG; the answer is posted back to the GUI thread once the file is on disk.
#pragma once

#include <QtCore/QJsonObject>

#include <functional>

namespace cdl {

// The `grab` command: `req` may give x, y, w, h in screen px (clamped to the 1620 × 2160 screen;
// default the whole screen). `answer` gets {"ok","png":"/tmp/codrawer-layer/grab-<ms>.png","w","h"}
// or {"ok":false,"error":"display buffer not found"}. GUI thread.
void grab(const QJsonObject &req, std::function<void(QJsonObject)> answer);

}  // namespace cdl
