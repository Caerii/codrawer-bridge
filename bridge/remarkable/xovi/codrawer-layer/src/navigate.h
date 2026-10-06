// navigate.h: "take me there": open a document by id, turn to a page, flash a region; library
// folders; offers that wait for the user's tap.
//
// # The problem
//
// A citation, a search hit or an agent's pointer names a place in the user's library: a document,
// a page, a region on it. The tablet should be able to go there, through xochitl's own paths, so
// that everything xochitl does on the way (an archived document fetched, a password asked for,
// the last-opened page remembered) still happens. The automation's first `goto` looked for
// typed slots (`goToPage(int)`) that QML functions never have, and `open` could only tap a tile
// already on screen.
//
// # xochitl's paths (extracted QML of 6.0.105; to be confirmed live with `dump`/`tree`)
//
// - Open a document: `MainView.onOpened({documentId, page?})`, the library's own entry point
//   (MainView_QMLTYPE_*, the window's root view). LibraryExplorer's `openDocument` signal ends
//   there, and it runs `Library.entryForId`, the archive and password guards and
//   `DocumentView.openDocument[OnPage]`, which closes any other open document first. It works by
//   id: the tile need not be visible.
// - Turn the page: `DocumentView.openPage(page, position)`, the swipe path (it also records the
//   last opened page); a page uuid becomes an index with the document's `pageForId`.
// - Folders: `MainView.onOpened({folderId})` enters a folder (closing the open document, as the
//   page overview's "show in folder" does); the library explorer (`MainView.explorer`, a
//   TreeExplorer) has `isInRoot`, `currentFolderId`, `parentForEntity`, `open` and `rootId`.
// - All these QML functions take and return QVariant (qtmeta.h, invoke).
//
// # Never yank the user
//
// Navigation takes the page away from under the pen, so it runs only when the user asked for it:
// a `go` request (the bridge sends those only for the user's own tap elsewhere, agentink/goto.go),
// an automation or probe command (the user's own tools), or a tap on an offer in the dock. Any
// other request becomes the offer: one at a time (a new one replaces it), shown as the dock's first
// entry ("Go to …?") with a dot on the dock button, kept for 10 minutes. Nothing navigates while
// the pen or a finger is on the page (toolfollow.h, the write-back guard).
//
// # The flash
//
// A region can be flashed: a 6 px black frame around it for 2 s, then gone. It is our own QML item
// over the window, created from source held here; nothing is drawn into the page and nothing is
// saved. Before flashing, a region not fully on screen is scrolled into view with the tile
// manager's `scrollToMakeSceneRectangleVisible` when xochitl has it.
//
// # Threading
//
// GUI thread only. Every wait is a waitFor poll (qtmeta.h); `done` gets one reply line,
// `ok goto …` or `err <why>`.
#pragma once

#include "goto_req.h"

#include <QtCore/QString>

#include <functional>

namespace cdl {

using Done = std::function<void(const QString &)>;

// Opens req.doc (unless it is open), turns to req's page, scrolls and flashes req's region.
// Replies `ok goto opened|already-open page <index>[ flashed]` or `err <why>`. Ignores req.go:
// callers decide that this is the user's request.
void gotoDoc(const gotoreq::Request &req, Done done);

// Turns the open document to req's page (a page uuid or index); replies like gotoDoc.
void gotoPage(const gotoreq::Request &req, Done done);

// Library folders: `enter` (id = a folder uuid), `up`, `home`. Replies `ok folder <action>` or
// `err <why>`.
void folder(const QString &action, const QString &id, Done done);

// Keeps req as the pending offer (replacing any older one) and calls the offer hook. Replies
// `ok goto_offer`.
void offerGoto(const gotoreq::Request &req, const QString &title, Done done);

// The pending offer's dock label ("Go to …?"), or "" when none is pending (or it expired).
QString offerLabel();

// Carries out the pending offer, as the user's tap on it: gotoDoc, then the offer is gone.
// `err no offer` when none is pending.
void acceptOffer(Done done);

// Sets the function called on the GUI thread when an offer comes or goes (entry.cpp: refresh the
// dock, whose entries and badge show it).
void setOfferHook(std::function<void()> fn);

}  // namespace cdl
