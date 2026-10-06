// automation.h: the UI automation sockets and their request dispatch.
//
// # The interface (docs/investigations/ui-automation.md)
//
// /run/codrawer/auto.sock (0600, root) and the same protocol on 127.0.0.1:8579, loopback only,
// for the desktop runner (scripts/dev/rmflow.py) through `ssh -L`: dropbear forwards TCP ports,
// not Unix sockets. One JSON request per line, one JSON reply per line, in order of completion:
//
//   {"id":"1","cmd":"state"}                                   → {"id":"1","ok":true,"state":{…}}
//   {"id":"3","cmd":"wait_for","cond":"page.index==2","timeout_ms":3000}
//                                                              → {"id":"3","ok":true,"waited_ms":420,"value":"2"}
//   {"id":"5","cmd":"…"}                                       → {"id":"5","ok":false,"error":"…"}
//
// Commands: `state` (always answers, also when locked), `resume`, `find selector`,
// `wait_for cond timeout_ms` (0..60000, default 3000; autostate.h), and autoinput.h's grab,
// input, navigation and text commands. Every request is logged (`auto: <cmd> <json>`).
//
// # Guardrails
//
// - Off unless enabled: both listeners exist only while /home/root/codrawer/AUTOMATION exists
//   (the user's opt-in). Each listener thread waits for the file (checked every 2 s), and checks
//   it again after each accepted connection: a connection accepted after the file is gone is
//   closed and the listener shuts down. (accept blocks, so a removed opt-in is noticed at the
//   next connection attempt.)
// - With the lock screen up every command but `state` answers `locked`.
// - The user wins: the user's pen or finger pauses automation (autostate.h) and every command
//   but `state` and `resume` answers `paused …` until `resume`.
// - Visible: while a client is connected the dock's status says "automation active" (the
//   clients-changed hook refreshes it).
//
// # Threading
//
// Two listener threads (autoServer, autoTcpServer; started by entry.cpp), each serving one client
// at a time: they read lines and post each request to the GUI thread, where it is handled and
// answered. Lines over 64 KiB close the connection.
#pragma once

#include <functional>

namespace cdl {

// The Unix socket's thread body (runs for the life of xochitl).
void autoServer();

// The loopback TCP listener's thread body (runs for the life of xochitl).
void autoTcpServer();

constexpr int kAutoPort = 8579;

// Sets the function called on the GUI thread when an automation client connects or disconnects
// (entry.cpp: refresh the injected UI, whose status line says "automation active").
void setAutoClientsChangedHook(std::function<void()> fn);

}  // namespace cdl
