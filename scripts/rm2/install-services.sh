#!/bin/sh
# Run on the tablet after unpacking the runtime into /home/root/codrawer-agent.
# Unit files live beside this script. Existing firmware-tested XOVI payload is required.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$(cat /sys/devices/soc0/machine)" = 'reMarkable 2.0' ]
[ "$(uname -m)" = armv7l ]
test -x /home/root/codrawer_bridge_rm2
test -f /home/root/codrawer-rm2.env
test -f /home/root/rm2-xovi/xovi.sh
test -f /home/root/.smart_remarkable.systemd.env
chmod 700 /home/root/codrawer-agent/bin/python /home/root/codrawer-agent/bin/node
chmod 600 /home/root/.smart_remarkable.systemd.env /home/root/codrawer-rm2.env
/home/root/codrawer-agent/bin/python -c 'import ssl, PIL, httpx, websockets; from codrawer_bridge.agentd.service import Agentd; print("Tablet runtime imports OK")'
/home/root/codrawer-agent/bin/node --version
# systemd-run's transient definition takes precedence until it has been retired.
if [ -f /run/systemd/transient/codrawer-rm2.service ]; then
  systemctl stop codrawer-rm2
  rm -f /run/systemd/transient/codrawer-rm2.service
fi
for unit in codrawer-rm2 codrawer-agent codrawer-web codrawer-rm2-xovi; do
  if [ -f "/etc/systemd/system/$unit.service" ] && [ ! -f "$HERE/$unit.service.before-install" ]; then
    cp -p "/etc/systemd/system/$unit.service" "$HERE/$unit.service.before-install"
  fi
  cp "$HERE/$unit.service" "/etc/systemd/system/$unit.service.new"
  mv "/etc/systemd/system/$unit.service.new" "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable codrawer-rm2 codrawer-agent codrawer-web codrawer-rm2-xovi
systemctl restart codrawer-rm2
systemctl start codrawer-rm2-xovi
systemctl restart codrawer-agent codrawer-web
