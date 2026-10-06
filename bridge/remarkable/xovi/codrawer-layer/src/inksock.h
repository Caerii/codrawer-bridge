// inksock.h: the bridge's socket, /run/codrawer/ink.sock: agent ink, text, status and actions.
//
// # The protocol
//
// The bridge (`agent_ink.go` / `agent_ink.rs`, with NATIVE_AGENT_INK) connects to this Unix
// socket (0600, root only; one client at a time) and the extension greets it with
//
//   hello codrawer-layer ink text_insert text_read
//
// Then each side writes lines. bridge → extension, one JSON object or status line per line:
//
//   {"id":"a7","page":"<uuid>","layer":"agent",
//    "strokes":[{"tool":"fineliner","argb":"ff1f6fe0","thickness":2,
//                "pts":[[x,y,pressure,width],...]}]}           →  ok a7 <n> | err a7 <why>
//   {"op":"text_insert","id":"t3","text":"…"}                   →  ok t3 text_insert <n> via=<route> | err t3 <why>
//   {"op":"text_read","id":"t4"}                                →  text t4 {…} | err t4 <why>
//   status <text>                                               (no answer; shown in the dock)
//
// x, y are page coordinates (line_layout.h, "Units"); pressure is 0..1; width is the point's
// drawn width in px. The `ok`/`err` for a stroke message comes once its strokes are committed or
// refused. Pacing (strokes appearing at the agent's writing speed) is the bridge's job: it sends
// each stroke at its time, and each is committed as it arrives (ink.h merges what queues up).
//
// extension → bridge, interleaved with the replies (which start with a letter; actions with `{`):
// the dock's and the selection menu's actions, `{"t":"dock_action",…}` (inject.h, sendToBridge).
//
// # Governance (ADR 003: agent ink is governed, and lives only on its own layer)
//
// Refused on the socket's thread, before anything reaches the GUI thread: a layer other than
// "agent" (→ "codrawer: agent") or "test" (→ "codrawer: test"); a page id that is not 36
// characters; anything ink_protocol.h refuses (tools, counts, thickness, point ranges); a line
// over 1 MiB (the connection is closed). On the GUI thread, ink.h requires the page to be the
// visible one and waits for the user's pen to lift; text waits for nothing and is refused while
// the pen is down.
//
// # Threading
//
// One thread (inkServer, started by entry.cpp) accepts and serves the client: it reads, parses
// and refuses there, and posts accepted work to the GUI thread (QMetaObject::invokeMethod,
// queued). Replies come from both threads; SocketClient sends whole lines under a mutex.
#pragma once

#include <QtCore/QByteArray>
#include <QtCore/QString>

#include <atomic>
#include <functional>
#include <mutex>

namespace cdl {

// One connected client of a line-protocol socket (this one, and automation's). The fd is closed
// when the last reference goes (the reader and any job still holding a reply callback), so a
// late reply never reaches a reused fd.
struct SocketClient {
    int fd;
    std::atomic<bool> open{true};
    std::mutex sending;  // whole lines: replies and actions come from the GUI thread, refusals from the reader
    explicit SocketClient(int f) : fd(f) {}
    ~SocketClient();
    // Sends `s` and a newline without blocking; a failed send marks the client closed and later
    // replies are dropped.
    void reply(const QString &s);
};

// The socket's thread body: listens on /run/codrawer/ink.sock and serves one client at a time,
// for the life of xochitl. Logs `ink: listening on /run/codrawer/ink.sock`.
void inkServer();

// Sends one line to the connected bridge; false if none is connected or the send fails. Any
// thread.
bool sendToBridge(const QByteArray &line);

// Whether a bridge is connected now. Any thread.
bool bridgeConnected();

// The bridge's last `status <text>` line (at most 200 characters), kept while it is connected
// (and after; the dock shows "bridge not connected" instead once it is gone). Any thread.
QString bridgeStatus();

// Sets the function called on the GUI thread after each `status` line (entry.cpp: refresh the
// injected UI).
void setBridgeStatusHook(std::function<void()> fn);

}  // namespace cdl
