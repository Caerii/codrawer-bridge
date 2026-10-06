#!/usr/bin/env bash
# Host tests for codrawer-layer's pure parts (auto_rules.h): no Qt, no device.
#   bridge/remarkable/xovi/codrawer-layer/test.sh
# Any image with a native g++ (buildpack-deps based; rust:1.92 is cached here).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=${CODRAWER_HOST_CXX_IMAGE:-rust:1.92}

mount=$( (cd "$here" && pwd -W 2> /dev/null) || echo "$here")
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount:/src" -w /src "$image" sh -euc '
    g++ -std=c++17 -Wall -Wextra -O1 -o /tmp/auto_rules_test auto_rules_test.cpp
    /tmp/auto_rules_test
'
