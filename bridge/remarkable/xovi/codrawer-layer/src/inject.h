// inject.h: QML of ours, created at run time inside xochitl's own scene (the dock), and the
// actions it sends to the bridge.
//
// # Injections
//
// xochitl's QML lives in its binary's resources; codrawer changes none of it, and nothing on
// disk that belongs to xochitl. An injection is a QML file of ours (shipped with the release in
// /home/root/xovi/exthome/codrawer-layer/) instantiated with xochitl's own QQmlEngine
// (`qmlEngine(parent)`) and parented into a live item found by a selector (scene.h,
// `matchItems`), with an optional `^` suffix to take the matched item's parent (the toolbar
// layout of a matched redo button). With `after=1` the new item is stacked right after the
// matched item, so a Column, ColumnLayout or GridLayout places it there. If nothing matches,
// nothing is created and the reason is logged. The item is a child of xochitl's item, so it
// follows it (collapsed toolbar, rotation); if xochitl destroys that item (rebuilding the
// toolbar, a document closing), the 2 s tick creates ours again, backing off after repeated
// failures (2 s, then 10 s after three failures, then 60 s after ten). A `when=selection`
// injection is instead tried right after a lasso, when the selection menu exists.
//
// The contract with the QML file (all optional): properties `entries` (list of {id, label}),
// `status` (string), `page` (string) and `anchorItem` (the matched item), set by the extension;
// signals `action(string id)` and `opened()`, which the extension connects. Entries come from
// /run/codrawer/dock.json (`{"entries":[{"id":…,"label":…},…]}`), re-read when it changes, so
// the bridge or the desktop can add agents without a rebuild; without it a built-in list applies.
//
// Injections are requested by the `inject` / `uninject` commands and, from load on, by the
// lines of inject.conf (inject_conf.h), re-read when its mtime changes. The kill switch
// /home/root/codrawer/XOVI_NO_INJECT (written by boot/xovi.sh when xochitl's journal shows an
// error from our QML) stops all injection; ink and text go on.
//
// # Actions: from the injected UI to the bridge
//
// A tap on an injected button becomes one JSON line sent to the bridge over the connection it
// already holds on /run/codrawer/ink.sock (inksock.h):
//
//   {"t":"dock_action","id":"ask_page","page":"<uuid>","source":"dock"}
//   {"t":"dock_action","id":"ask_selection","page":"<uuid>","bbox":[x0,y0,x1,y1],"items":3,...}
//
// The page is the visible page; the bridge adds the document id from its page watcher and
// relays the message into the router (docs/protocol.md, "dock_action"). `status` is answered on
// the tablet. An Ask (`ask_page`, `ask_selection`) also starts the thinking doodle at once
// (live.h, pending until an agent's status adopts it; with none in 8 s the dock's status row says
// "no agent answered"), and a second tap on the same question within 2 s sends nothing. A pending "Go to …?" offer (navigate.h) is the first entry, with `badge` set on the
// dock; a tap on it (`goto_offer`) navigates and then tells the bridge
// `{"t":"dock_action","id":"goto_accepted",…,"result":"ok goto …"}`. With no bridge connected the action is logged and dropped, and the UI says so. An
// `inert=1` injection only logs its taps (a new button's first rollout).
//
// # Threading
//
// GUI thread only. QML signals arrive on it; each action is handled in a queued job, after the
// QML handler has returned.
#pragma once

#include <QtCore/QStringList>

namespace cdl {

// The `inject` command: name=<n> parent=<match>[^] qml=<path> [after=1] [when=selection]
// [inert=1]. Replaces an injection of the same name and tries to create it at once; a failure is
// logged (`inject <n>: …`) and left to the tick, or, for `when=selection`, to the next lasso.
// Logs `inject: needs name= parent= qml=` and does nothing if one of those is missing.
void injectCommand(const QStringList &words);

// The `uninject name=<n>` command: removes the injection and destroys its item.
void uninjectCommand(const QStringList &words);

// The tick's part: honour the kill switch, re-read inject.conf when it changes, re-create lost
// items (with back-off), and refresh entries when dock.json changes.
void injectTick();

// Creates the `when=selection` injections that are missing and whose selector now matches.
// Quiet when nothing matches (the menu may not be up yet).
void createSelectionInjections();

// Sets `entries`, `status` and `page` on every live injected item.
void refreshAllInjections();

}  // namespace cdl
