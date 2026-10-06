// Tests for procmaps.h (finding the display buffer in /proc/self/maps), host-only.
#include "procmaps.h"

#include "check.h"

using namespace procmaps;

int main() {
    uintptr_t base = 0;
    size_t size = 0;
    // 6528 × 2160 = 14100480 = 0xd72800 bytes: an anonymous frame-sized mapping is the buffer
    CHECK(frameMapping("7f80000000-7f80d72800 rw-p 00000000 00:00 0 \n", base, size));
    CHECK(base == 0x7f80000000u && size == 0xd72800u);
    // up to 1 MiB of slack
    CHECK(frameMapping("7f80000000-7f80e72000 rw-p 00000000 00:00 0\n", base, size));
    CHECK(!frameMapping("7f80000000-7f80e72800 rw-p 00000000 00:00 0\n", base, size));  // exactly +1 MiB
    // too small, or not readable
    CHECK(!frameMapping("7f80000000-7f80d72000 rw-p 00000000 00:00 0\n", base, size));
    CHECK(!frameMapping("7f80000000-7f80d72800 ---p 00000000 00:00 0\n", base, size));
    // garbage
    CHECK(!frameMapping("", base, size));
    CHECK(!frameMapping("not a maps line\n", base, size));
    return finish("procmaps");
}
