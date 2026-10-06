// check.h: the host tests' one assertion macro. Each test file is its own program (test.sh builds
// and runs every tests/*_test.cpp); `CHECK` counts failures, `finish` reports and sets the exit
// status.
#pragma once

#include <cstdio>

static int failures = 0;
#define CHECK(x)                                                                 \
    do {                                                                         \
        if (!(x)) {                                                              \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #x);             \
            ++failures;                                                          \
        }                                                                        \
    } while (0)

static inline int finish(const char *name) {
    if (failures) {
        std::printf("%s: %d failure(s)\n", name, failures);
        return 1;
    }
    std::printf("%s: all tests passed\n", name);
    return 0;
}
