#!/usr/bin/env bash
# Build codrawer-layer.so for the reMarkable Paper Pro (aarch64, xochitl on Qt 6.10).
#
#   bridge/remarkable/xovi/codrawer-layer/build.sh
#
# Sources: src/*.cpp (one object per module; README.md "Module map") and xovi.c.
# Output: bridge/remarkable/xovi/codrawer-layer/out/codrawer-layer.so, to be copied into
# /home/root/xovi/extensions.d/ on the tablet (README.md).
#
# The compiler and Qt arm64 headers come from the Dockerfile next to this script (Debian trixie,
# Qt 6.8; built once and cached as codrawer-xovi-build:trixie). No emulation: the cross
# compiler runs natively. xovi.c is xovigen output for codrawer-layer.xovi; regenerate it with
#   python3 <asivery/xovi>/util/xovigen.py -o xovi.c codrawer-layer.xovi
# only when the manifest changes.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image=codrawer-xovi-build:trixie

if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker build -t "$image" "$here"
fi

# Docker Desktop on Windows wants a native path for the bind mount.
mount=$( (cd "$here" && pwd -W 2>/dev/null) || echo "$here")

# -fvisibility=hidden keeps our own functions out of the dynamic symbol table; what stays global
# is _xovi_construct (marked visibility("default") in entry.cpp) and xovi's tables from xovi.c
# (xovi links extensions by symbol name). Weak instantiations of std:: and Qt templates whose
# headers declare default visibility are exported too. --as-needed keeps only the Qt libraries
# actually referenced; xochitl has all of them loaded already. Objects are linked in name order,
# so the same sources give the same .so.
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount:/src" -w /src "$image" sh -euc '
    mkdir -p out
    rm -f out/*.o
    aarch64-linux-gnu-gcc -c -O2 -fPIC -o out/xovi.o xovi.c
    for src in src/*.cpp; do
        aarch64-linux-gnu-g++ -c -O2 -fPIC -std=c++17 -Wall -Wextra -fvisibility=hidden \
            -I/usr/include/aarch64-linux-gnu/qt6 \
            -I/usr/include/aarch64-linux-gnu/qt6/QtCore \
            -I/usr/include/aarch64-linux-gnu/qt6/QtGui \
            -I/usr/include/aarch64-linux-gnu/qt6/QtQuick \
            -I/usr/include/aarch64-linux-gnu/qt6/QtQml \
            -o "out/$(basename "$src" .cpp).o" "$src"
    done
    aarch64-linux-gnu-g++ -shared -Wl,--as-needed -Wl,-z,defs -s -o out/codrawer-layer.so \
        $(ls out/*.o | LC_ALL=C sort) \
        -L/usr/lib/aarch64-linux-gnu -lQt6Quick -lQt6Qml -lQt6Gui -lQt6Core -lpthread
    rm -f out/*.o
    file out/codrawer-layer.so
    aarch64-linux-gnu-readelf -d out/codrawer-layer.so | grep NEEDED
    aarch64-linux-gnu-readelf -V out/codrawer-layer.so | grep -oE "(Qt_6[.0-9]*|GLIBC_[.0-9]*|GLIBCXX_[.0-9]*)" | sort -u | tr "\n" " "; echo
'
sha256sum "$here/out/codrawer-layer.so"
