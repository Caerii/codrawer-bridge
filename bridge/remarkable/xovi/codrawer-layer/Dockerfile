# Cross toolchain for codrawer-layer: aarch64 g++ plus Qt 6 arm64 headers and link stubs.
#
# Debian trixie ships Qt 6.8; the Paper Pro runs Qt 6.10.3. Qt 6 keeps binary compatibility
# forward within the major version, so an extension compiled against 6.8 headers and linked
# against 6.8 libraries runs inside xochitl's 6.10 libraries (all symbols carry the Qt_6 tag).
FROM debian:trixie-slim
ARG TARGET_ARCH=arm64
ARG TARGET_TRIPLE=aarch64-linux-gnu
ARG CROSS_LIBC=libc6-dev-arm64-cross
RUN dpkg --add-architecture ${TARGET_ARCH} \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      g++-${TARGET_TRIPLE} ${CROSS_LIBC} binutils python3 make file \
      qt6-base-dev:${TARGET_ARCH} qt6-declarative-dev:${TARGET_ARCH} \
 && rm -rf /var/lib/apt/lists/*
