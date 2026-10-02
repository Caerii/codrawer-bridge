#!/bin/sh
# Reconnect bonded Bluetooth keyboards whenever they drop (BLE keyboards sleep and do not
# always re-initiate). Run by codrawer-bluetooth.service (via bt-up.sh); with no argument it keeps every
# paired device connected, or pass one address.
while true; do
  bluetoothctl show 2>/dev/null | grep -q 'Powered: yes' || bluetoothctl power on >/dev/null 2>&1
  for K in ${1:-$(bluetoothctl devices Paired 2>/dev/null | awk '{print $2}')}; do
    if ! bluetoothctl info "$K" 2>/dev/null | grep -q 'Connected: yes'; then
      timeout 15 bluetoothctl connect "$K" >/dev/null 2>&1
    fi
  done
  sleep 8
done
