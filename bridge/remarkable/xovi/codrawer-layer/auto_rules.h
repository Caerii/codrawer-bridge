// auto_rules.h: the UI automation's guardrails and condition language, as pure functions.
//
// docs/investigations/ui-automation.md describes the automation socket. What may be done there is
// decided here, in plain C++ with no Qt, so the rules are tested on the desktop
// (auto_rules_test.cpp, run by test.sh) and the extension cannot drift from what was tested.
//
//   denied(names)      a synthesized tap is refused when the item under the point, or any of its
//                      ancestors, has an objectName or class matching the deny list
//                      (destructive and security-relevant UI: delete, trash, erase all, reset,
//                      factory, passcode, security, account, sync, sign out, the settings menu).
//   editAllowed(title) content changes only in the notebook named exactly "codrawer: test".
//   Cond / parseCond   `wait_for` conditions: `<path> <op> <value>`, op one of == != < <= > >=,
//                      path a dotted key into the state object (`page.index`, `locked`,
//                      `selection.items`), value a number, true/false, or a word (compared as
//                      a string). `evalCond` compares a looked-up value with it.
#pragma once

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <string>
#include <vector>

namespace autorules {

inline std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return s;
}

// Substrings (lower case) that mark UI automation must never touch.
inline const std::vector<std::string> &denyList() {
    static const std::vector<std::string> d = {
        "delete", "trash", "eraseall", "erase_all", "clearpage", "reset", "factory", "passcode",
        "pincode", "security", "account", "sync", "signout", "sign_out", "logout", "log_out",
        "settingsmenu", "unpair", "pairing",
    };
    return d;
}

// The first deny-list word found in any of `names` (objectNames and class names of the item
// under the point and its ancestors), or "" when the tap may go ahead.
inline std::string denied(const std::vector<std::string> &names) {
    for (const std::string &n : names) {
        const std::string l = lower(n);
        for (const std::string &d : denyList()) {
            if (l.find(d) != std::string::npos) return d;
        }
    }
    return "";
}

// The one notebook automation may edit.
inline bool editAllowed(const std::string &title) { return title == "codrawer: test"; }

struct Cond {
    std::string path, op, value;
    bool ok = false;
};

inline Cond parseCond(const std::string &text) {
    Cond c;
    static const char *ops[] = {"==", "!=", "<=", ">=", "<", ">"};
    for (const char *op : ops) {
        const size_t at = text.find(op);
        if (at == std::string::npos) continue;
        auto trim = [](std::string s) {
            const size_t a = s.find_first_not_of(" \t"), b = s.find_last_not_of(" \t");
            return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
        };
        c.path = trim(text.substr(0, at));
        c.op = op;
        c.value = trim(text.substr(at + std::string(op).size()));
        c.ok = !c.path.empty() && !c.value.empty();
        return c;
    }
    return c;
}

// Compares `actual` (the looked-up value as text: a number, true/false, or a string) with the
// condition. Numbers compare as numbers when both sides parse; otherwise only == and != apply.
inline bool evalCond(const Cond &c, const std::string &actual) {
    if (!c.ok) return false;
    char *e1 = nullptr, *e2 = nullptr;
    const double a = std::strtod(actual.c_str(), &e1), b = std::strtod(c.value.c_str(), &e2);
    const bool numeric = !actual.empty() && *e1 == 0 && *e2 == 0;
    if (numeric) {
        if (c.op == "==") return a == b;
        if (c.op == "!=") return a != b;
        if (c.op == "<") return a < b;
        if (c.op == "<=") return a <= b;
        if (c.op == ">") return a > b;
        if (c.op == ">=") return a >= b;
        return false;
    }
    if (c.op == "==") return actual == c.value;
    if (c.op == "!=") return actual != c.value;
    return false;
}

}  // namespace autorules
