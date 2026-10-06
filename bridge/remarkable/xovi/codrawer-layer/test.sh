#!/usr/bin/env bash
# Host tests for codrawer-layer's pure parts (src/auto_rules.h, cmdline.h, inject_conf.h,
# ink_protocol.h, line_layout.h, procmaps.h): no Qt, no device. Each tests/*_test.cpp is its
# own program; inject_conf_test also parses the shipped inject.conf.
#   bridge/remarkable/xovi/codrawer-layer/test.sh
# Any image with a native g++ (buildpack-deps based; rust:1.92 is cached here).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=${CODRAWER_HOST_CXX_IMAGE:-rust:1.92}

mount=$( (cd "$here" && pwd -W 2> /dev/null) || echo "$here")
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount:/src" -w /src "$image" sh -euc '
    for t in tests/*_test.cpp; do
        name=$(basename "$t" .cpp)
        g++ -std=c++17 -Wall -Wextra -Werror -O1 -Isrc -o "/tmp/$name" "$t"
        "/tmp/$name" inject.conf
    done
'
