#!/bin/sh
# Reconnect bonded Bluetooth keyboards whenever they drop (BLE keyboards sleep and do not
# always re-initiate). Run by codrawer-bluetooth.service (via bt-up.sh); with no argument it keeps
# every paired device connected, or pass one address.
#
# A connect attempt pages the radio for up to 15 s, so while a keyboard stays off the keeper
# backs off (8 s doubling to 32 s) instead of paging every 8 s; a keyboard that wakes on a
# keypress usually reconnects by itself well within that. The bridge's keyboard reader
# (native/keyboard.go) reopens the input node whenever the keyboard comes back.
wait=8
while true; do
  bluetoothctl show 2>/dev/null | grep -q 'Powered: yes' || bluetoothctl power on >/dev/null 2>&1
  missing=0
  for K in ${1:-$(bluetoothctl devices Paired 2>/dev/null | awk '{print $2}')}; do
    if ! bluetoothctl info "$K" 2>/dev/null | grep -q 'Connected: yes'; then
      timeout 15 bluetoothctl connect "$K" >/dev/null 2>&1 || missing=1
    fi
  done
  if [ "$missing" = 1 ]; then
    wait=$((wait * 2)); [ "$wait" -gt 32 ] && wait=32
  else
    wait=8
  fi
  sleep "$wait"
done
