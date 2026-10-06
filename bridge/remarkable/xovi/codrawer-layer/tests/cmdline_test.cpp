// Tests for cmdline.h (the command file's and inject.conf's word grammar), host-only, no Qt.
// The expectations are what QString::split / trimmed gave before the grammar moved here.
#include "cmdline.h"

#include "check.h"

using namespace cmdline;

int main() {
    // lines: empty parts dropped, blank-but-not-empty parts kept (trim decides later)
    auto ls = splitLines("dump\n\nlayers page=x\n  \n");
    CHECK(ls.size() == 3 && ls[0] == "dump" && ls[1] == "layers page=x" && ls[2] == "  ");
    CHECK(splitLines("").empty());
    CHECK(splitLines("\n\n").empty());
    CHECK(splitLines("one").size() == 1);

    // trim: ASCII white space, CRLF files, and Unicode spaces as QChar::isSpace sees them
    CHECK(trim("  stroke page=a \r") == "stroke page=a");
    CHECK(trim("\t\v\fx\n") == "x");
    CHECK(trim("") == "" && trim(" \r\n ") == "");
    CHECK(trim("\xC2\xA0tree\xC2\xA0") == "tree");                 // U+00A0
    CHECK(trim("\xE2\x80\x83tree\xE3\x80\x80") == "tree");         // U+2003, U+3000
    CHECK(trim("\xE2\x80\xAFx\xE2\x81\x9F") == "x");               // U+202F, U+205F
    CHECK(trim("\xC3\xA9t\xC3\xA9") == "\xC3\xA9t\xC3\xA9");       // é is not a space
    CHECK(trim("\xE2\x80\x8B" "x") == "\xE2\x80\x8B" "x");         // U+200B is not a space either

    // words: split on ' ' only, empties dropped; a tab stays inside a word
    auto w = words("inject  name=dock parent=name:a^ qml=/x.qml\tafter=1");
    CHECK(w.size() == 4 && w[0] == "inject" && w[3] == "qml=/x.qml\tafter=1");
    CHECK(words("   ").empty());

    // arg: the first word that starts with key=, the rest verbatim
    w = words("stroke page=abc argb=ff00ff00 page=second x=a=b");
    CHECK(arg(w, "page") == "abc");
    CHECK(arg(w, "argb") == "ff00ff00");
    CHECK(arg(w, "x") == "a=b");
    CHECK(arg(w, "missing").empty());
    CHECK(arg(words("pagex=1 page="), "page").empty());  // `page=` with an empty value
    CHECK(arg(words("pagex=1"), "page").empty());        // a longer key does not match
    return finish("cmdline");
}
