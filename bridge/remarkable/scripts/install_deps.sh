#!/usr/bin/env sh
set -eu

PY=""
if command -v python3 >/dev/null 2>&1; then
  PY="python3"
elif command -v python >/dev/null 2>&1; then
  PY="python"
else
  echo "error: no python interpreter found (python3/python). Install Python on the device first." >&2
  exit 1
fi

"$PY" -m pip install --user websockets


