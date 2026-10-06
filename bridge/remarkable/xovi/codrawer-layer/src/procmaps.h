// procmaps.h: recognising xochitl's display buffer in /proc/self/maps, as pure code.
//
// `grab` (grab.cpp) copies the screen out of xochitl's own memory instead of asking Qt to render
// it. The buffer is an anonymous mapping just over one frame: 1620 × 2160 pixels at 4 bytes a
// pixel with a row stride of 6528 bytes (Probe 1's read-only fbgrab tool,
// docs/investigations/ui-automation.md "grab"). This header decides, line by line, whether a
// mapping is that buffer; tests/procmaps_test.cpp feeds it real-format lines.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace procmaps {

constexpr size_t kStride = 6528;  // bytes per row
constexpr size_t kWidth = 1620, kHeight = 2160;  // pixels
constexpr size_t kSlack = size_t(1) << 20;  // a mapping may exceed one frame by less than this

// One line of /proc/<pid>/maps: true when it is a readable mapping of a frame's size (at least
// kStride × kHeight bytes, less than that plus kSlack) that the filter below lets through, with
// its start address and size.
inline bool frameMapping(const char *line, uintptr_t &base, size_t &size) {
    unsigned long a = 0, b = 0;
    char perms[8] = {0};
    char path[256] = {0};
    const int fields = std::sscanf(line, "%lx-%lx %7s %*s %*s %*s %255s", &a, &b, perms, path);
    if (fields >= 5 && path[0]) return false;  // named mapping
    if (perms[0] != 'r') return false;
    const size_t sz = b - a;
    if (sz >= kStride * kHeight && sz < kStride * kHeight + kSlack) {
        base = uintptr_t(a);
        size = sz;
        return true;
    }
    return false;
}

}  // namespace procmaps
