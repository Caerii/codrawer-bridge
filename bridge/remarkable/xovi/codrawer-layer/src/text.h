// text.h: text into the focused text box of the visible page, and reading it back.
//
// # The problem
//
// The bridge types `/term` replies into the tablet's focused text field through a uinput
// keyboard. Measured 2026-10-06 (docs/investigations/keyboard-and-text.md §2): that loses the
// first characters after an Enter and cannot produce ^ [ ] { } \ ` ~ at all (the virtual
// keyboard's layout). Inside xochitl the text can be handed to the page directly.
//
// # Two routes (keyboard-and-text.md §1.2-1.3)
//
// Route A, the page's own text API. When the visible page's root text document is focused (the
// user has a text cursor on the page: `textDocumentId` set and not "0:0"), the text goes in
// through `SceneController.replaceText(QString)` at that cursor, one call per line with
// `replaceText("\n")` between, inside begin/endInputMethodTransaction when the controller has them
// (meant to make a reply one undo step). It does not pass xochitl's QML key gate and has no
// keymap, so every character arrives. Like the layer slots, the effect may land a moment later,
// so the reply waits (20 ms polls, up to 1.5 s) for `rootDocumentLength` to grow by the text's
// length and reports what it saw: `ok text_insert <n> via=replace len a->b` when it matches,
// `… via=replace unverified len a->b` when it does not (never retried: the text may be in).
//
// Route B, the focused item. The target is the active focus item of the focused window, and only
// if it lies inside the followed (visible) DocumentView and takes text. An item that accepts input
// methods gets a QInputMethodEvent whose commit string is the text (the route a platform input
// method takes into a Qt text item, so the item's own editing and undo apply); a line break is a
// Return key press between commits. An item without input-method support but with
// `insert(int,QString)` (QML TextEdit/TextInput) gets that at its cursor. Anything else is
// refused and logged; nothing is ever inserted outside the visible page.
//
// Formatting, shortcuts and completion are a separate design (keyboard-and-text.md §3-5).
//
// # Threading
//
// GUI thread only. Replies are strings without the request id (the socket adds it): the first
// word is the reply kind (`ok`, `err`, `text`).
#pragma once

#include <QtCore/QString>

#include <functional>

namespace cdl {

constexpr int kMaxTextInsert = 16384;  // characters (UTF-16 units) per text_insert

// Route A. If the visible page's root text document is focused, inserts `text` there and calls
// `reply` once the length is verified or 1.5 s have passed; returns true. Returns false, having
// done nothing, when there is no visible page, no `replaceText(QString)`, or no focused root
// document (route B decides). Does not check the write-back guard itself: callers do.
bool textInsertRouteA(const QString &text, std::function<void(const QString &)> reply);

// Route B: `text` into the focused text item of the visible page, at once. Returns
// `ok text_insert <n> via=im|insert` or `err <why>` (including `err pen or finger on the page`,
// the write-back guard).
QString textInsert(const QString &text);

// The focused text item of the visible page as `text {json}`: its class, the input method's
// surrounding text, cursor and selection, its `text` property if any, and the page's root
// document length, cursor and id. Or `err <why>`. Read-only.
QString textRead();

}  // namespace cdl
