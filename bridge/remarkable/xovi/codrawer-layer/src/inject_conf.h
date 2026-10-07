// inject_conf.h: inject.conf and the `inject` command's arguments, as pure functions.
//
// inject.conf (shipped in the release, installed to /home/root/xovi/exthome/codrawer-layer/ by
// boot/xovi.sh) lists the QML injections to make from load on, one per line, with the same
// arguments as the `inject` probe command (inject.cpp explains what an injection is):
//
//   name=<n> parent=<match>[^] qml=<file> [after=1] [when=selection] [inside=<match>] [inert=1]
//
// `inside=<match>` takes only a matched item that has an ancestor matching it: xochitl has the
// same icon in other menus, and an empty lasso once put "Ask" into one of those (device,
// 2026-10-07), where it stayed and stopped the real one being made.
//
// Blank lines and lines whose first non-space character is `#` are comments. A line is trimmed
// and split into words by cmdline.h's rules. Tested on the host by tests/inject_conf_test.cpp.
#pragma once

#include "cmdline.h"

#include <string>
#include <vector>

namespace injectconf {

// One injection request. `match` keeps its optional trailing `^` (inject.cpp resolves it).
struct Spec {
    std::string name, match, qml;
    bool after = false;        // after=1: stacked right after the matched item
    bool onSelection = false;  // when=selection: made right after a lasso, not by the 2 s tick
    bool inert = false;        // inert=1: taps are logged, never sent
    std::string inside;        // inside=<match>: only a match below an item matching this
    // The three required arguments are present (the `inject` command refuses otherwise).
    bool complete() const { return !name.empty() && !match.empty() && !qml.empty(); }
};

inline Spec parseSpec(const std::vector<std::string> &words) {
    Spec s;
    s.name = cmdline::arg(words, "name");
    s.match = cmdline::arg(words, "parent");
    s.qml = cmdline::arg(words, "qml");
    s.after = cmdline::arg(words, "after") == "1";
    s.onSelection = cmdline::arg(words, "when") == "selection";
    s.inert = cmdline::arg(words, "inert") == "1";
    s.inside = cmdline::arg(words, "inside");
    return s;
}

// What a when=selection injection does when a lasso settles (inject.cpp createSelectionInjections;
// every step is logged). `have`: our item exists; `inPlace`: it sits below a visible item matching
// `inside` (or, without `inside`, it is visible); `target`: a match for `parent` (within `inside`)
// is in the tree now.
enum class SelectionStep {
    Keep,      // ours is in the live menu already
    Recreate,  // ours is left over somewhere else (a closed or another menu): replace it
    Create,    // none yet, and the menu is up
    Wait,      // none, and no menu to put it in (an empty lasso, a tap)
    Drop,      // ours is left over and there is no menu: remove it
};
inline SelectionStep selectionStep(bool have, bool inPlace, bool target) {
    if (have && inPlace) return SelectionStep::Keep;
    if (have) return target ? SelectionStep::Recreate : SelectionStep::Drop;
    return target ? SelectionStep::Create : SelectionStep::Wait;
}
inline const char *stepName(SelectionStep s) {
    switch (s) {
    case SelectionStep::Keep: return "already in the menu";
    case SelectionStep::Recreate: return "left over outside the menu; made again";
    case SelectionStep::Create: return "creating";
    case SelectionStep::Wait: return "no menu up; nothing to do";
    case SelectionStep::Drop: return "left over and no menu up; removed";
    }
    return "?";
}

// The request lines of a conf file's text, each trimmed, in file order (comments and blank
// lines dropped). Each is logged as `inject.conf: <line>` and run as an `inject` command.
inline std::vector<std::string> requestLines(const std::string &text) {
    std::vector<std::string> out;
    for (const std::string &l : cmdline::splitLines(text)) {
        const std::string t = cmdline::trim(l);
        if (t.empty() || t[0] == '#') continue;
        out.push_back(t);
    }
    return out;
}

}  // namespace injectconf
