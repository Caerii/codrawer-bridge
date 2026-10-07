// autoinput.h: UI automation's milestones 2 and 3: grab, synthesized input, navigation, text.
//
// docs/investigations/ui-automation.md, "As built". Input is QMouseEvents sent to the visible
// QQuickWindow on the GUI thread (xochitl's MouseAreas take them: the injected dock's MouseArea
// received the user's taps), paced by a 16 ms timer: a press, moves, a release.
//
// # Guardrails (ui-automation.md, "Guardrails"; the rules are auto_rules.h, tested on the host)
//
// Before every press, the deepest visible, enabled item under the point and its whole ancestry
// (objectNames and class names) are checked against the deny list: destructive and security UI
// is never pressed. With a notebook open that is not "codrawer: test", only the close button and
// the page overview may be pressed (navigation); in the library, anything not denied. With the
// lock screen up nothing is pressed. If the user's pen or finger pauses automation mid-gesture,
// the gesture lets go where it is and answers `paused by the user`. `text_insert` is refused
// outside "codrawer: test". `goto`, `goto_doc` and `folder` press nothing: they are navigation
// through xochitl's own functions, allowed anywhere ("navigation and reading elsewhere are
// allowed"), and refused while the pen or a finger is on the page.
//
// # Commands (each answers one JSON object)
//
//   grab x y w h               grab.h
//   hit x y                    read-only: the items under a point (objectName, class), outermost first
//   tap x y                    press, 80 ms, release
//   long_press x y [ms]        ms clamped to 300..5000 (default 800)
//   swipe x0 y0 x1 y1 [ms]     ms clamped to 50..5000 (default 300)
//   tap_item selector          the centre of the first visible item matching (scene.h)
//   tool name                  taps the ToolLoader `editingToolLoader_<name>`
//   open title                 with no notebook open: taps the library tile titled so
//   goto page                  the open notebook to a page (uuid or index from 0; navigate.h)
//   goto_doc doc [page] [region] [flash]   any document by uuid, through xochitl's own path
//   folder action [id]         library folders: enter id, up, home
//   text_insert text, text_read   text.h's routes (A, then B)
//
// # Threading
//
// GUI thread only.
#pragma once

#include <QtCore/QJsonObject>
#include <QtCore/QString>

#include <functional>

namespace cdl {

// Handles `cmd` if it is one of the commands above and returns true (the answer may come later);
// false when it is none of them.
bool autoInputRequest(const QString &cmd, const QJsonObject &req, std::function<void(QJsonObject)> answer);

}  // namespace cdl
