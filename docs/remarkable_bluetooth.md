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

### Make it survive reboots

`/etc` on Codex is an overlay whose upper dir is tmpfs (`/var/volatile/etc`): anything written there
at runtime (`/etc/modules-load.d/…`, `systemctl enable`) is gone after a reboot. What does persist:
the read-only rootfs underneath, and `/home` (reMarkable already bind-mounts `/var/lib/bluetooth`
there, so pairings survive). codrawer's only rootfs file is the stub `codrawer-boot.service`; at
boot it runs `/home/root/codrawer/current/boot.sh`, which puts `codrawer-bluetooth.service` and
`codrawer-bridge.service` into `/run/systemd/system` and starts them (layout, signed releases and
repair after OS updates: `docs/investigations/durable-install.md`):

```sh
scripts/dev/deploy-tablet.sh                                   # from the desktop
ssh root@<tablet> sh /home/root/codrawer/current/boot.sh doctor
ssh root@<tablet> journalctl -u codrawer-bluetooth -f
```

At boot `bt-up.sh` holds a wake lock, loads `btnxpuart`, starts `bluetoothd`, retries the driver
if `hci0` does not come up, then execs `keyboard-keeper.sh` (reconnects every paired device).
Verified across reboots 2026-10-02 on Codex 6.0.105 (reMarkable 3.29.0.149). **An OS update swaps
the root partition and drops the stub**: `tablet-guard.sh`, `deploy-tablet.sh` or the repair key
re-add it (the files in `/home` and the pairing survive).

- **Never bring the chip up while the tablet sleeps.** Codex autosleeps (`/sys/power/autosleep` =
  `mem`, deep suspend every ~1 s with the screen off, SSH still answering). A suspend during the
  firmware load wedges the chip: `FW already running`, then `Opcode 0x0c03 failed: -110` on every
  retry, and only a reboot recovers it. `bt-up.sh` holds `/sys/power/wake_lock` for this reason.

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

### What actually happened pairing a Logitech Pebble K380s (2026-09-27)

Paired, bonded, trusted, connected; appears as `Pebble K380s Keyboard` on `/dev/input/event4`.
The bond persists under `/var/lib/bluetooth/<controller>/`. Things that cost an hour:

- **The PC steals the keyboard.** A Windows machine with Bluetooth on will Swift-Pair a keyboard in
  pairing mode within seconds. Turn the PC radio off and dismiss its popup before pairing to the tablet.
- **The keyboard's address changes per channel** (`…:E8` on the channel bonded to the PC, `…:E9` on
  the next). Re-scan and pair the address you see now, not the one from the last scan.
- **The tablet displays the passkey; the keyboard types it.** `bluetoothctl` auto-registers a
  KeyboardDisplay agent and prints `[agent] Passkey: NNNNNN`; the code lives ~30 s. Read it from the log
  with `grep -a 'Passkey:' | grep -o -E '[0-9]{6}'`: BusyBox `sed` cannot strip the ANSI colour codes
  wrapped around the digits, and `head -n`/`tail -n` are the only forms BusyBox accepts.
- **No `pkill` on Codex.** Use `kill $(ps | grep … | awk '{print $1}')` or `killall`; otherwise every
  "restart" of a pairing script stacks another copy and the copies cancel each other's handshakes
  (`org.bluez.Error.AuthenticationCanceled`).
- A device that is not in pairing mode simply vanishes from `bluetoothctl devices`; scan until it
  appears, then `pair` in the same session.

## Glasses directly from the tablet

The Even G2 arms are two BLE peripherals (`Even G2_..._L_...` / `_R_...`) that only advertise
when the phone releases them. With the radio up, the tablet can run the reverse-engineered
protocol (see `g2-kit-unofficial`) and drive the lens without the phone or the desktop. That is a
Go port of the kit's transport against BlueZ; not built yet.
