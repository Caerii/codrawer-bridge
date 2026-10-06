// Tests for goto_req.h ("take me there" requests), host-only, no Qt.
#include "goto_req.h"

#include "check.h"

using namespace gotoreq;

int main() {
    CHECK(isUuid("4c0e2d44-91ad-4d94-a473-ac8187400cd7"));
    CHECK(isUuid("4C0E2D44-91AD-4D94-A473-AC8187400CD7"));
    CHECK(!isUuid("4c0e2d44-91ad-4d94-a473-ac8187400cd"));   // 35
    CHECK(!isUuid("4c0e2d44_91ad-4d94-a473-ac8187400cd7"));  // dash in the wrong place
    CHECK(!isUuid("../../../../etc/passwd/xxxxxxxxxxxxxxx"));

    Request r;
    CHECK(parsePage("22227dbf-7a9e-4044-b2e8-42711dd3d680", r) && r.pageId.size() == 36 && r.pageIndex == -1);
    Request q;
    CHECK(parsePage("26", q) && q.pageIndex == 26 && q.pageId.empty());
    CHECK(parsePage("0", q) && q.pageIndex == 0);
    Request bad;
    CHECK(!parsePage("", bad) && !parsePage("-1", bad) && !parsePage("123456", bad) && !parsePage("1.5", bad));

    Region g;
    CHECK(parseRegion("0.1,0.2,0.3,0.4", g) && g.x0 == 0.1 && g.y1 == 0.4);
    CHECK(parseRegion("-0.5,0,1.5,1", g));
    CHECK(!parseRegion("0.3,0.2,0.1,0.4", g));   // x0 > x1
    CHECK(!parseRegion("0.1,0.2,0.3", g));
    CHECK(!parseRegion("0.1,0.2,0.3,0.4,0.5", g));
    CHECK(!parseRegion("0.1,,0.3,0.4", g));
    CHECK(!parseRegion("0.1,0.2,0.3,9", g));     // off the page
    CHECK(!parseRegion("a,b,c,d", g));
    CHECK(!parseRegion("", g));
    CHECK(!regionOk(Region{0, 0, NAN, 1}));

    // normalised -> page units on the Paper Pro's 1620 x 2160 page: x is centred
    const PageRect p = toPageUnits(Region{0.25, 0.5, 0.75, 0.75}, 1620, 2160);
    CHECK(p.x == -405 && p.y == 1080 && p.w == 810 && p.h == 540);
    const PageRect full = toPageUnits(Region{0, 0, 1, 1}, 1620, 2160);
    CHECK(full.x == -810 && full.y == 0 && full.w == 1620 && full.h == 2160);
    return finish("goto_req");
}
