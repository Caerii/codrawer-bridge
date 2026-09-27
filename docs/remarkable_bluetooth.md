# reMarkable Paper Pro: enabling Bluetooth

Verified 2026-09-27 on a Paper Pro (Codex Linux 6.0.100, kernel 6.12.49, board "reMarkable Ferrari").
The tablet ships with Bluetooth hardware and stack but never brings the radio up.

## What is on the device

| Piece | Detail |
| --- | --- |
| Radio | NXP IW612 Wi-Fi/Bluetooth combo (`iw61x`); Bluetooth is a UART controller on `/dev/ttymxc1` |
| Driver | `btnxpuart` (in `/lib/modules/<kernel>/kernel/drivers/bluetooth/`), not auto-loaded |
| Firmware | `/lib/firmware/nxp/uartspi_n61x_v1.bin.se`, loaded by the driver (412,940 bytes) |
| Stack | BlueZ (`bluetoothd`, `bluetoothctl`, `hciattach`, `btattach`); `bluetooth.service` is enabled but gated on `/sys/class/bluetooth` existing |

## Bring it up (as root over SSH)

```sh
modprobe btnxpuart            # hci0 appears; dmesg shows "FW Download Complete"
systemctl start bluetooth     # bluetoothd; controller advertises as "My reMarkable"
bluetoothctl show             # Powered: yes
bluetoothctl --timeout 10 scan on
```

Make it survive a reboot:

```sh
printf 'btnxpuart\n' > /etc/modules-load.d/btnxpuart.conf
```

Undo: delete that file, `systemctl stop bluetooth`, `rmmod btnxpuart`. Developer mode already
voided the warranty; this changes nothing on disk beyond the one file.

## Pair a Bluetooth keyboard

```sh
bluetoothctl
  power on
  agent KeyboardOnly
  default-agent
  pairable on
  scan on                      # put the keyboard in pairing mode; note its address
  pair  <addr>                 # type the PIN on the keyboard if prompted
  trust <addr>
  connect <addr>
```

The keyboard then appears as `/dev/input/event*` (the same evdev path the stroke bridge reads),
so a keyboard bridge can forward keystrokes into a codrawer session the same way pen strokes go.

## Glasses directly from the tablet

The Even G2 arms are two BLE peripherals (`Even G2_..._L_...` / `_R_...`) that only advertise
when the phone releases them. With the radio up, the tablet can run the reverse-engineered
protocol (see `g2-kit-unofficial`) and drive the lens without the phone or the desktop. That is a
Go port of the kit's transport against BlueZ; not built yet.
