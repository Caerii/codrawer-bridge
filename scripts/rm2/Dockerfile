# Isolated ARMv7 runtime; none of these libraries replace the tablet's system files.
FROM --platform=linux/arm/v7 node:22-bookworm-slim AS node
FROM --platform=linux/arm/v7 python:3.11-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3-pil libstdc++6 && rm -rf /var/lib/apt/lists/*
# Debian's Pillow extension uses the same CPython 3.11 ABI; avoid compiling it under emulation.
RUN pip install --no-cache-dir --target=/opt/python 'httpx==0.28.1' 'websockets==15.0.1' && \
    cp -a /usr/lib/python3/dist-packages/PIL /opt/python/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/arm-linux-gnueabihf/libatomic.so.1 /usr/local/lib/libatomic.so.1
RUN mkdir -p /out/bin /out/lib /out/python /out/lib/python3.11 && \
    cp /usr/local/bin/python3.11 /usr/local/bin/node /out/bin/ && \
    cp -a /usr/local/lib/python3.11/. /out/lib/python3.11/ && \
    rm -rf /out/lib/python3.11/site-packages /out/lib/python3.11/ensurepip && \
    cp -a /opt/python/. /out/python/ && \
    cp -L /usr/local/lib/libpython3.11.so.1.0 /out/lib/ && \
    cp -L /usr/local/lib/libatomic.so.1 /out/lib/ && \
    cp -L /lib/ld-linux-armhf.so.3 /out/lib/ && \
    cp -L /lib/arm-linux-gnueabihf/*.so* /out/lib/ && \
    find /out -type d -name __pycache__ -exec rm -rf {} +
FROM scratch AS runtime
COPY --from=build /out/ /
