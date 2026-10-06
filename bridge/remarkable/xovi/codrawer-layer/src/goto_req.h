// goto_req.h: a "take me there" request, checked and converted, as pure code.
//
// navigate.h opens a document, turns to a page and can flash a region. Its requests come from
// three places with one meaning: the bridge's `{"op":"goto",…}` socket line (inksock.cpp), the
// automation command `goto_doc` (autoinput.cpp) and the probe command `goto_doc` (commands.cpp).
// What a valid request is, and how its region becomes page units, is decided here with no Qt, so
// tests/goto_req_test.cpp pins it, and it matches the bridge's own check (agentink/goto.go,
// agent_ink.rs):
//
//   doc      a document uuid (8-4-4-4-12 hex)
//   page     a page uuid, or a page index 0..99999 counted from 0 (xochitl's own `currentPage`),
//            or absent (the document opens where it was last left)
//   region   [x0, y0, x1, y1] normalised to the page like every protocol point
//            (x = (x_rm + w/2)/w, y = y_rm/h), each in −0.5..1.5, x0 < x1, y0 < y1
//   flash    show the region briefly; only with a region
//   mode     "go" (the user's own tap asked for it) or "offer" (shown in the dock until the user
//            taps it); anything else is an offer
#pragma once

#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

namespace gotoreq {

struct Region {
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
};

struct Request {
    std::string doc;
    std::string pageId;   // a page uuid, or ""
    int pageIndex = -1;   // a page index, or −1
    bool hasRegion = false;
    Region region;        // normalised (see above)
    bool flash = false;
    bool go = false;      // false: an offer
    std::string reason;
};

inline bool isUuid(const std::string &s) {
    if (s.size() != 36) return false;
    for (size_t i = 0; i < 36; ++i) {
        const char c = s[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return false;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
    return true;
}

// A page word: a uuid, or 1..5 digits. Sets pageId or pageIndex; false if it is neither.
inline bool parsePage(const std::string &s, Request &r) {
    if (isUuid(s)) {
        r.pageId = s;
        return true;
    }
    if (s.empty() || s.size() > 5) return false;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
    }
    r.pageIndex = std::atoi(s.c_str());
    return true;
}

inline bool regionOk(const Region &g) {
    const double v[4] = {g.x0, g.y0, g.x1, g.y1};
    for (double x : v) {
        if (!(x >= -0.5 && x <= 1.5)) return false;
    }
    return g.x0 < g.x1 && g.y0 < g.y1;
}

// "x0,y0,x1,y1" (the probe command's form); false unless four numbers and regionOk.
inline bool parseRegion(const std::string &s, Region &g) {
    std::vector<double> v;
    size_t start = 0;
    while (start <= s.size()) {
        const size_t comma = s.find(',', start);
        const std::string part = s.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
        char *end = nullptr;
        const double d = std::strtod(part.c_str(), &end);
        if (part.empty() || *end != 0) return false;
        v.push_back(d);
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    if (v.size() != 4) return false;
    g = Region{v[0], v[1], v[2], v[3]};
    return regionOk(g);
}

// The region in page units (x centred, y down from the top) on a page w × h page units wide and
// high, as a rect: left, top, width, height.
struct PageRect {
    double x, y, w, h;
};
inline PageRect toPageUnits(const Region &g, double w, double h) {
    return PageRect{g.x0 * w - w / 2, g.y0 * h, (g.x1 - g.x0) * w, (g.y1 - g.y0) * h};
}

}  // namespace gotoreq
