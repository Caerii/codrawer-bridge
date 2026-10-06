// paths.h: every file and socket path the extension reads or writes, in one place.
//
// Scripts, the bridge and the docs name these paths, so they are part of the extension's
// interface: changing one is a protocol change. Owners in brackets.
//
//   /tmp/codrawer-layer/            the extension's own directory (0700), made at load [entry]
//     cmd                           probe commands, one per line; read and removed [commands]
//     log                           one line per fact, also on stderr (the journal) [log]
//     line-<ms>.txt                 eraser paths written by `watch` [line]
//     grab-<ms>.png                 automation screenshots [grab]
//   /run/codrawer/                  tmpfs, shared with the bridge (made on demand, 0755)
//     tool                          `<tool> <thickness>`, the followed pen tool [toolfollow]
//     ink.sock                      agent ink, text, actions; 0600 [inksock]
//     auto.sock                     UI automation, while AUTOMATION exists; 0600 [automation]
//     dock.json                     the dock's entries, written by the bridge [inject]
//     status                        the bridge's status line, if fresh (< 30 s) [inject]
//   /home/root/xovi/exthome/codrawer-layer/inject.conf   injections to make [inject]
//   /home/root/codrawer/XOVI_NO_INJECT   kill switch for injections, written by xovi.sh [inject]
//   /home/root/codrawer/AUTOMATION       the user's opt-in to UI automation [automation]
#pragma once

namespace cdl {

constexpr const char *kDir = "/tmp/codrawer-layer";
constexpr const char *kCmd = "/tmp/codrawer-layer/cmd";
constexpr const char *kLog = "/tmp/codrawer-layer/log";

constexpr const char *kRunDir = "/run/codrawer";
constexpr const char *kToolFile = "/run/codrawer/tool";
constexpr const char *kToolTmp = "/run/codrawer/.tool.tmp";
constexpr const char *kInkSock = "/run/codrawer/ink.sock";
constexpr const char *kAutoSock = "/run/codrawer/auto.sock";
constexpr const char *kDockJson = "/run/codrawer/dock.json";
constexpr const char *kStatusFile = "/run/codrawer/status";

constexpr const char *kInjectConf = "/home/root/xovi/exthome/codrawer-layer/inject.conf";
constexpr const char *kNoInject = "/home/root/codrawer/XOVI_NO_INJECT";
constexpr const char *kAutoOptIn = "/home/root/codrawer/AUTOMATION";

}  // namespace cdl
