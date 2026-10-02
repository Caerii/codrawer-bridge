#!/bin/sh
# Load the NXP Bluetooth driver, start bluetoothd, then hand over to the keyboard keeper.
# Codex autosleeps (/sys/power/autosleep = mem) and a suspend during firmware load wedges the
# chip ("FW already running" + HCI Reset timeouts) until the next reboot, so hold a wake lock.
DIR=$(cd "$(dirname "$0")" && pwd)
LOCK=codrawer-bt
up() { hciconfig hci0 2>/dev/null | grep -qw UP; }

echo $LOCK > /sys/power/wake_lock
for attempt in 1 2 3; do
  modprobe btnxpuart
  for i in $(seq 1 30); do [ -d /sys/class/bluetooth/hci0 ] && break; sleep 1; done
  systemctl start bluetooth.service
  for i in $(seq 1 20); do up && break 2; sleep 1; done   # AutoEnable=true powers it on
  echo "hci0 not up (attempt $attempt); reloading btnxpuart"
  systemctl stop bluetooth.service
  rmmod btnxpuart
  sleep 2
done
echo $LOCK > /sys/power/wake_unlock

up || { echo "hci0 never came up; the chip is likely wedged until a reboot"; exit 1; }
echo "hci0 up"
exec sh "$DIR/keyboard-keeper.sh"
