#!/usr/bin/env bash
# Host test of the injected QML (qml/dock.qml): load it offscreen with Qt 6 on the desktop, once
# with a stand-in for xochitl's `ark.controls` (the native-button route) and once without (the
# fallback route). Any QML warning fails the test: on the tablet a warning naming our file trips
# boot/xovi.sh's XOVI_NO_INJECT gate. Docker; the image (Debian trixie's Qt 6.8 QML runtime) is
# built once and cached as codrawer-qml-test:trixie.
#   bridge/remarkable/xovi/codrawer-layer/qmltest.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=codrawer-qml-test:trixie

if ! docker image inspect "$image" > /dev/null 2>&1; then
    printf '%s\n' 'FROM debian:trixie-slim' \
        'RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends qml-qt6 qml6-module-qtquick qml6-module-qtquick-controls qml6-module-qtquick-templates qml6-module-qtquick-window qml6-module-qtqml-workerscript qml6-module-qtquick-layouts && rm -rf /var/lib/apt/lists/*' |
        docker build -q -t "$image" - > /dev/null
fi

mount=$( (cd "$here" && pwd -W 2> /dev/null) || echo "$here")
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount:/src:ro" -w /src -e QT_QPA_PLATFORM=offscreen -e LANG=C.UTF-8 "$image" sh -euc '
    status=0
    for route in native fallback; do
        if [ $route = native ]; then export QML_IMPORT_PATH=/src/tests/qml/stub; else unset QML_IMPORT_PATH; fi
        out=$(/usr/lib/qt6/bin/qml tests/qml/dock_test.qml 2>&1 || true)
        echo "$out" | sed "s/^/  [$route] /"
        echo "$out" | grep -q "dock_test: PASS ($route)" || status=1
        # any warning (a line naming a .qml file and a line number) fails the run
        if echo "$out" | grep -E "\.qml:[0-9]+" > /dev/null; then status=1; fi
    done
    [ $status = 0 ] && echo "qmltest: all tests passed" || { echo "qmltest: FAILED"; exit 1; }
'
