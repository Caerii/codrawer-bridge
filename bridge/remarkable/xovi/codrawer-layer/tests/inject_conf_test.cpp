// Tests for inject_conf.h (inject.conf and the `inject` arguments), host-only, no Qt.
#include "inject_conf.h"

#include "check.h"

#include <fstream>
#include <sstream>

using namespace injectconf;

int main(int argc, char **argv) {
    // comments and blank lines dropped, lines trimmed, order kept
    const std::string text =
        "# a comment\n"
        "\n"
        "   # an indented comment\r\n"
        "name=dock parent=name:editingToolLoader_redoButton^ qml=/q/dock.qml after=1\r\n"
        "  name=ask parent=class:SelectionContextualMenu qml=/q/ask.qml when=selection inert=1  \n"
        "\t\n";
    const auto lines = requestLines(text);
    CHECK(lines.size() == 2);
    CHECK(lines[0] == "name=dock parent=name:editingToolLoader_redoButton^ qml=/q/dock.qml after=1");
    CHECK(lines[1] == "name=ask parent=class:SelectionContextualMenu qml=/q/ask.qml when=selection inert=1");

    Spec s = parseSpec(cmdline::words(lines[0]));
    CHECK(s.complete() && s.name == "dock" && s.match == "name:editingToolLoader_redoButton^" && s.qml == "/q/dock.qml");
    CHECK(s.after && !s.onSelection && !s.inert);
    s = parseSpec(cmdline::words(lines[1]));
    CHECK(s.complete() && s.onSelection && s.inert && !s.after);

    // the `inject` command form (the verb is just another word)
    s = parseSpec(cmdline::words("inject name=x parent=text:Redo qml=/a.qml after=2"));
    CHECK(s.complete() && s.match == "text:Redo" && !s.after);  // only after=1 counts
    CHECK(!parseSpec(cmdline::words("inject name=x qml=/a.qml")).complete());
    CHECK(!parseSpec(cmdline::words("inject name= parent=a:b qml=/a.qml")).complete());

    // the file shipped in the release parses to its one dock line
    if (argc > 1) {
        std::ifstream f(argv[1]);
        std::stringstream ss;
        ss << f.rdbuf();
        const auto shipped = requestLines(ss.str());
        CHECK(shipped.size() == 1);
        if (!shipped.empty()) {
            const Spec d = parseSpec(cmdline::words(shipped[0]));
            CHECK(d.complete() && d.name == "dock" && d.after);
            CHECK(d.qml == "/home/root/xovi/exthome/codrawer-layer/dock.qml");
        }
    }
    return finish("inject_conf");
}
