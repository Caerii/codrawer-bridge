#!/usr/bin/env bash
# Build the shared extension for Paper Pro (arm64, default) or rM2 (armhf).
#
#   bridge/remarkable/xovi/codrawer-layer/build.sh
#
# Sources: src/*.cpp (one object per module; README.md "Module map") and xovi.c.
# Output: out/codrawer-layer.so (arm64) or out/armhf/codrawer-layer.so, copied into
# /home/root/xovi/extensions.d/ on the tablet (README.md).
#
# The compiler and architecture-specific Qt headers come from the Dockerfile next to this script (Debian trixie,
# Qt 6.8; built once and cached as codrawer-xovi-build:trixie). No emulation: the cross
# compiler runs natively. xovi.c is xovigen output for codrawer-layer.xovi; regenerate it with
#   python3 <asivery/xovi>/util/xovigen.py -o xovi.c codrawer-layer.xovi
# only when the manifest changes.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
arch=${CODRAWER_ARCH:-arm64}
case "$arch" in
 arm64) triple=aarch64-linux-gnu; libc=libc6-dev-arm64-cross; image=codrawer-xovi-build:trixie; outdir=out ;;
 armhf) triple=arm-linux-gnueabihf; libc=libc6-dev-armhf-cross; image=codrawer-xovi-build:rm2; outdir=out/armhf ;;
 *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

# Docker reuses unchanged layers, while respecting toolchain/Dockerfile updates.
docker build --build-arg TARGET_ARCH="$arch" --build-arg TARGET_TRIPLE="$triple" --build-arg CROSS_LIBC="$libc" -t "$image" "$here"

# Docker Desktop on Windows wants a native path for the bind mount.
mount=$( (cd "$here" && pwd -W 2>/dev/null) || echo "$here")

# -fvisibility=hidden keeps our own functions out of the dynamic symbol table; what stays global
# is _xovi_construct (marked visibility("default") in entry.cpp) and xovi's tables from xovi.c
# (xovi links extensions by symbol name). Weak instantiations of std:: and Qt templates whose
# headers declare default visibility are exported too. --as-needed keeps only the Qt libraries
# actually referenced; xochitl has all of them loaded already. Objects are linked in name order,
# so the same sources give the same .so.
MSYS_NO_PATHCONV=1 docker run --rm -e TARGET_TRIPLE="$triple" -e OUT_DIR="$outdir" -v "$mount:/src" -w /src "$image" sh -euc '
    mkdir -p "$OUT_DIR"
    rm -f $OUT_DIR/*.o
    ${TARGET_TRIPLE}-gcc -c -O2 -fPIC -o $OUT_DIR/xovi.o xovi.c
    for src in src/*.cpp; do
        ${TARGET_TRIPLE}-g++ -c -O2 -fPIC -std=c++17 -Wall -Wextra -fvisibility=hidden \
            -I/usr/include/${TARGET_TRIPLE}/qt6 \
            -I/usr/include/${TARGET_TRIPLE}/qt6/QtCore \
            -I/usr/include/${TARGET_TRIPLE}/qt6/QtGui \
            -I/usr/include/${TARGET_TRIPLE}/qt6/QtQuick \
            -I/usr/include/${TARGET_TRIPLE}/qt6/QtQml \
            -o "$OUT_DIR/$(basename "$src" .cpp).o" "$src"
    done
    ${TARGET_TRIPLE}-g++ -shared -Wl,--as-needed -Wl,-z,defs -s -o $OUT_DIR/codrawer-layer.so \
        $(ls $OUT_DIR/*.o | LC_ALL=C sort) \
        -L/usr/lib/${TARGET_TRIPLE} -lQt6Quick -lQt6Qml -lQt6Gui -lQt6Core -lpthread
    rm -f $OUT_DIR/*.o
    file $OUT_DIR/codrawer-layer.so
    ${TARGET_TRIPLE}-readelf -d $OUT_DIR/codrawer-layer.so | grep NEEDED
    ${TARGET_TRIPLE}-readelf -V $OUT_DIR/codrawer-layer.so | grep -oE "(Qt_6[.0-9]*|GLIBC_[.0-9]*|GLIBCXX_[.0-9]*)" | sort -u | tr "\n" " "; echo
'
sha256sum "$here/$outdir/codrawer-layer.so"
