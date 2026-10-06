// Tests for auto_rules.h (the automation's guardrails and conditions), host-only, no Qt.
// Run: bridge/remarkable/xovi/codrawer-layer/test.sh
#include "auto_rules.h"

#include <cstdio>

static int failures = 0;
#define CHECK(x)                                                                 \
    do {                                                                         \
        if (!(x)) {                                                              \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #x);             \
            ++failures;                                                          \
        }                                                                        \
    } while (0)

int main() {
    using namespace autorules;
    // destructive and security UI is refused wherever it sits in the ancestry
    CHECK(denied({"FoldoutItem_QMLTYPE_1595", "eraseAllFoldout"}) == "eraseall");
    CHECK(denied({"ToolButton", "secondaryToolLoader_settingsMenu"}) == "settingsmenu");
    CHECK(denied({"DeleteDialog_QMLTYPE_9"}) == "delete");
    CHECK(denied({"PasscodeView"}) == "passcode");
    CHECK(denied({"EmptyTrashButton"}) == "trash");
    CHECK(denied({"AccountSettings"}) == "account");
    // ordinary toolbar and page items pass
    CHECK(denied({"ToolLoader_QMLTYPE_1905", "editingToolLoader_redoButton", "toolbarLayout"}).empty());
    CHECK(denied({"DocumentView_QMLTYPE_1591", "QQuickItem"}).empty());
    // edits only in the test notebook
    CHECK(editAllowed("codrawer: test"));
    CHECK(!editAllowed("Test"));
    CHECK(!editAllowed("codrawer: test copy"));
    // conditions
    Cond c = parseCond("page.index == 2");
    CHECK(c.ok && c.path == "page.index" && c.op == "==" && c.value == "2");
    CHECK(evalCond(c, "2") && !evalCond(c, "3"));
    c = parseCond("selection.items>=1");
    CHECK(c.ok && c.op == ">=" && evalCond(c, "3") && !evalCond(c, "0"));
    c = parseCond("locked == false");
    CHECK(evalCond(c, "false") && !evalCond(c, "true"));
    c = parseCond("doc.title != Test");
    CHECK(evalCond(c, "codrawer: test") && !evalCond(c, "Test"));
    CHECK(!parseCond("nonsense").ok);
    CHECK(!evalCond(parseCond("a < b"), "c"));  // strings only compare for equality
    if (failures) return 1;
    std::printf("auto_rules: all tests passed\n");
    return 0;
}
