#!/usr/bin/env bash
# Host tests of the injected QML (qml/dock.qml, live.qml, selection-ask.qml): load each offscreen
# with Qt 6 on the desktop, once with stand-ins for xochitl's modules (tests/qml/stub: ark.controls,
# xofm.libs.epaper, xofm.libs.peninput; the native route) and once without (the fallback route).
# Any QML warning fails the test: on the tablet a warning naming our file trips boot/xovi.sh's
# XOVI_NO_INJECT gate. Docker; the image (Debian trixie's Qt 6.8 QML runtime) is built once and
# cached as codrawer-qml-test:trixie.
#   bridge/remarkable/xovi/codrawer-layer/qmltest.sh             # the tests
#   bridge/remarkable/xovi/codrawer-layer/qmltest.sh --preview   # also out/preview/<style>.gif
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=codrawer-qml-test:trixie
preview=${1:-}

if ! docker image inspect "$image" > /dev/null 2>&1; then
    printf '%s\n' 'FROM debian:trixie-slim' \
        'RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends qml-qt6 qml6-module-qtquick qml6-module-qtquick-controls qml6-module-qtquick-templates qml6-module-qtquick-window qml6-module-qtqml-workerscript qml6-module-qtquick-layouts && rm -rf /var/lib/apt/lists/*' |
        docker build -q -t "$image" - > /dev/null
fi

mkdir -p "$here/out/preview"
mount=$( (cd "$here" && pwd -W 2> /dev/null) || echo "$here")
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount:/src:ro" -v "$mount/out/preview:/cap" -w /src \
    -e QT_QPA_PLATFORM=offscreen -e QT_QUICK_BACKEND=software -e LANG=C.UTF-8 -e PREVIEW="$preview" "$image" sh -euc '
    status=0
    for t in dock live pending done concurrent fast choreo selection; do
        for route in native fallback; do
            if [ $route = native ]; then export QML_IMPORT_PATH=/src/tests/qml/stub; else unset QML_IMPORT_PATH; fi
            extra=""
            if [ "$PREVIEW" = --preview ] && [ $t = live ] && [ $route = native ]; then extra="-- --capture=/cap"; fi
            out=$(timeout 90 /usr/lib/qt6/bin/qml tests/qml/${t}_test.qml $extra 2>&1 || true)  # a hang fails
            echo "$out" | sed "s/^/  [$t $route] /"
            echo "$out" | grep -q "${t}_test: PASS ($route)" || status=1
            # any warning (a line naming a .qml file and a line number) fails the run
            if echo "$out" | grep -E "\.qml:[0-9]+" > /dev/null; then status=1; fi
        done
    done
    [ $status = 0 ] && echo "qmltest: all tests passed" || { echo "qmltest: FAILED"; exit 1; }
'
if [ "$preview" = --preview ]; then
    # frames to GIFs, cropped to where the scene happens (the selection at 500,600 and the answer)
    uv run --quiet --with pillow python - "$here/out/preview" << 'EOF'
import glob, os, sys
from PIL import Image
d = sys.argv[1]
for style in ("pen", "drop", "glyph"):
    files = sorted(glob.glob(os.path.join(d, f"{style}-*.png")))
    if not files:
        continue
    frames = []
    for f in files:
        im = Image.open(f).convert("RGBA")
        bg = Image.new("RGBA", im.size, "white")
        bg.alpha_composite(im)
        frames.append(bg.crop((440, 540, 1000, 1000)).convert("L").convert("P"))
    out = os.path.join(d, f"{style}.gif")
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=100, loop=0)
    print("preview:", out, len(frames), "frames")
EOF
fi
