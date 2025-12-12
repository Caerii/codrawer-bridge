#!/usr/bin/env sh
set -eu
systemctl daemon-reload
systemctl enable codrawer-bridge
systemctl restart codrawer-bridge
journalctl -u codrawer-bridge -n 50 --no-pager


