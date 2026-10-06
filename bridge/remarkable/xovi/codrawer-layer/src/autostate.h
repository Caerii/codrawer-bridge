// autostate.h: what UI automation reads: the UI's state, items by selector, and its own
// pause/client bookkeeping.
//
// Part of the UI automation (docs/investigations/ui-automation.md; automation.h has the socket
// and the request dispatch, autoinput.h the synthesized input). This module is the read side:
//
//   state     {"locked","paused","tool","doc":{"id","title"},"page":{"id","index","count"},
//              "zoom","scroll":[dx,dy],"layers","undo","selection":{"items"},"focus","popups":[…]}
//             `doc` is null with no notebook open; zoom and scroll are the tile manager's
//             sceneToViewTransform (m11 and dx, dy); property names that differ between builds
//             are tried in order (firstProp).
//   find      the first 50 items matching a selector (scene.h): class, name, scene bounds
//             [x, y, w, h], visibility, text.
//   wait_for  conditions are auto_rules.h's, evaluated on `state` through a dotted path.
//
// The guardrails' state lives here too: whether automation is paused (the user's pen or finger
// pauses it until `resume`), whether input is being synthesized right now (so our own events do
// not pause it), how many clients are connected (the dock says "automation active"), and whether
// the lock screen is up (then only `state` answers).
//
// # Threading
//
// The flags are atomics, read and written from the GUI thread and the socket threads. Everything
// that reads the UI runs on the GUI thread.
#pragma once

#include <QtCore/QJsonObject>
#include <QtCore/QString>

#include <atomic>
#include <string>

namespace cdl {

std::atomic<int> &autoClients();          // connected automation clients (both listeners)
std::atomic<bool> &autoPaused();          // set by the user's gesture, cleared by `resume`
std::atomic<bool> &synthesizing();        // true while autoinput sends one of its own events

// Whether an automation client is connected. Any thread.
bool autoClientsActive();

// The user-gesture hook (toolfollow.h): pause automation while a client is connected, unless the
// gesture is one we are synthesizing. Logs `auto: paused by the user's pen or touch` once per
// pause. GUI thread.
void pauseAutomationForUser();

// Whether the lock screen is up: a visible item whose class or objectName names a lock screen,
// passcode or pin code view. GUI thread; walks the whole tree.
bool lockScreenUp();

// The `state` object (above). GUI thread.
QJsonObject autoState();

// The value at a dotted path into `st` (`page.index`) as text for autorules::evalCond: true/false,
// a number (%.15g), a string, or "" when absent.
std::string statePath(const QJsonObject &st, const std::string &path);

// The `find` reply's body: {"items":[…]} for the items matching `selector`.
QJsonObject autoFind(const QString &selector);

// The visible notebook's title (the followed view's `document`), or "" with none open.
QString visibleDocTitle();

}  // namespace cdl
