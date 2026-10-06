# What codrawer changes on your tablet

Read this before you install codrawer on a reMarkable Paper Pro. It lists every file codrawer
puts on the tablet, what runs and with which privileges, what it never touches, what it opens on
your network, and how to remove all of it. Each statement is checked against the scripts that do
the work: [`bridge/remarkable/boot/install.sh`](../bridge/remarkable/boot/install.sh),
[`boot.sh`](../bridge/remarkable/boot/boot.sh), [`xovi.sh`](../bridge/remarkable/boot/xovi.sh), the three units in
[`boot/units/`](../bridge/remarkable/boot/units) and
[`scripts/dev/deploy-tablet.sh`](../scripts/dev/deploy-tablet.sh). The reasoning behind the layout
is in [`investigations/durable-install.md`](investigations/durable-install.md).

Before codrawer, you will have made two changes yourself (see
[`remarkable_setup.md`](remarkable_setup.md)): Developer Mode, which factory-resets the tablet,
disables disk encryption and shows a boot warning; and SSH, with your key in
`/home/root/.ssh/authorized_keys`. codrawer does not change either.

## What is installed

**One file on the root partition.** The stub unit `codrawer-boot.service`, plus its enable link,
in the rootfs's own `/etc/systemd/system/` (and `multi-user.target.wants/`). The stub never changes
between codrawer versions: at boot it runs `/home/root/codrawer/current/boot.sh start`, and on stop
`boot.sh stop`. `install.sh` writes it by remounting `/` read-write for the copy, through a bind
mount of `/` (it never unmounts the `/etc` overlay), then remounts `/` read-only.

**A copy of the stub in the live `/etc`.** `/etc` is an overlay whose upper layer is tmpfs, and
files added underneath a mounted overlay are not visible until the next boot. So `install.sh` also
copies the stub and its enable link into the live `/etc/systemd/system/`. That copy is in memory and
is gone at the next reboot; the rootfs copy is the one every later boot uses.

**Everything else under `/home/root/codrawer/`:**

| Path | What it is |
| --- | --- |
| `releases/<version>/` | a release: the bridge binaries (Go `codrawer_bridge_native`, and Rust `codrawer_bridge_rs` when built), the boot scripts, the three units, `compat.conf`, `xovi-compat.conf`, the XOVI payload `xovi/` (`xovi.so`, `start`, `stock`, `codrawer-layer.so`), a `MANIFEST` and its ed25519 signature `MANIFEST.sig`. The three newest are kept, plus `current` and `previous`. |
| `current`, `previous` | symlinks to the active release and the one before it (`boot.sh rollback` swaps them) |
| `bridge.env` | your settings (router address, input devices, pairing code `ROUTER_TOKEN`, engine). Seeded once from `bridge.env.example`, never overwritten. |
| `release.pub` | the public key releases must be signed with. Uploaded by `deploy-tablet.sh` on first install (trust on first use, over your SSH session). |
| `state/` | `os_version` (the OS seen at the last boot) and `os_changed` (set when that differs); `xovi_status` (XOVI's last verdict) and `xovi_pending` (an XOVI start being checked) |
| `DISABLED` | not created by codrawer: create it yourself as a kill switch (`boot.sh start` then starts nothing, XOVI included) |
| `XOVI_DISABLED` | XOVI's kill switch, first line the reason: written by `boot.sh xovi off` or by the crash guard (see "XOVI") |

**At every boot, in memory only.** `boot.sh start` copies `codrawer-bluetooth.service`,
`codrawer-bridge.service` and `codrawer-xovi.service` from the current release into
`/run/systemd/system/` (tmpfs), writes `/run/codrawer/env` (OS version, whether it is listed in
`compat.conf`, codrawer version), starts the first two, and then asks systemd, without waiting, to
run the third (see "XOVI"). Nothing in `/run` survives a reboot.

**`/home/root/xovi/`**, when a release carries the XOVI payload and the OS is one it was tested on:
XOVI's own directory, in XOVI's own layout (`xovi.so`, `start`, `stock`, `extensions.d/codrawer-layer.so`,
`exthome/`, `services/xochitl.service/`, `scripts/`). codrawer installs and updates those files
from the release; anything else you put there is left alone.

**Outside codrawer's directory, only if you opt in:**

- If you use Vellum (`/home/root/.vellum` exists), `install.sh` adds the hook
  `/home/root/.vellum/hooks/post-os-upgrade/codrawer`, so `vellum reenable` restores codrawer too.
- `scripts/dev/make-repair-key.sh` (run by you, never automatically) appends one restricted key,
  commented `codrawer-repair`, to `/home/root/.ssh/authorized_keys`. It can only run
  `install.sh --if-needed`; it cannot open a shell.

On your computer, `deploy-tablet.sh` keeps the release signing key in `~/.codrawer/release.key`
(private; never commit or share it) and builds releases under `.codrawer/` in the repository.

## What runs

The bridge and Bluetooth units run as **root** (they set no `User=`): reading input devices, creating a virtual
keyboard and loading a kernel module all need it on the tablet.

- **`codrawer-bridge.service`** runs the bridge (`run-bridge.sh` picks Go or Rust from `ENGINE`).
  It reads the pen (`/dev/input/event2`) without grabbing it (`NO_GRAB=1`), so xochitl keeps
  drawing as usual, and reads a paired Bluetooth keyboard without grabbing it unless you set
  `KEYBOARD_GRAB=1`. With `SERVE_ADDR=:8577` it hosts the stroke router (see the network section).
  After pen activity it holds a timed kernel wake lock (`codrawer-pen`, 3 s) so the last stroke
  leaves before the tablet suspends.
- **`codrawer-bluetooth.service`** brings up Bluetooth, which the Paper Pro ships but never
  starts: under a wake lock it loads the stock kernel module `btnxpuart`, starts the stock
  `bluetooth.service` (BlueZ), retries up to three times, then keeps your paired keyboards
  connected (`keyboard-keeper.sh`, which also powers the controller on). Pairings live in
  `/var/lib/bluetooth`, which reMarkable itself keeps under `/home`. Pairing a keyboard is a step
  you do by hand ([`remarkable_bluetooth.md`](remarkable_bluetooth.md)).
- **The virtual keyboard.** With `TYPE_REPLIES=1` (the default in `bridge.env.example`) the bridge
  creates a virtual keyboard through `/dev/uinput` and types terminal replies (`term` messages
  from a desktop router running Claude Code) into whatever text field you have focused, exactly
  as a keyboard would. The tablet's own router never relays `term` messages from clients, so this
  happens only when the tablet streams to a desktop router (`CODRAWER_TABLET_UPLINK=1`). Set
  `TYPE_REPLIES=0` to turn it off.

## XOVI (the codrawer-layer extension inside xochitl)

**What it does.** [XOVI](https://github.com/asivery/xovi) is a community loader that starts
xochitl with extra code preloaded (`LD_PRELOAD`). codrawer ships one extension for it,
`codrawer-layer.so` ([README](../bridge/remarkable/xovi/codrawer-layer/README.md)). From inside
xochitl it reads which tool the toolbar has selected, ten times a second, and writes it to
`/run/codrawer/tool` (in memory). That is how the bridge knows a stroke made with the tip is an
erase when you picked the toolbar Eraser; without XOVI those strokes stream as ink. The extension
hooks no xochitl function and changes no document; its other commands (in the README) run only
when written to `/tmp/codrawer-layer/cmd` by hand.

**How it starts.** XOVI's own start is *tethered*: it mounts an in-memory directory over
`/etc/systemd/system/xochitl.service.d`, writes the `LD_PRELOAD` setting there, and restarts
xochitl once. Nothing is written to the root partition or the persistent `/etc`, so a reboot alone
would return the tablet to stock. codrawer repeats that start after every boot, from
`codrawer-xovi.service` (`boot.sh` → `xovi.sh boot`), which runs after the bridge has started and
which nothing waits for. It starts XOVI only if all of these hold:

1. the current release contains the payload (`xovi/` in the release, covered by its signature);
2. the OS version is listed in the release's `xovi-compat.conf` (today 3.29.0.149 only), a
   separate, stricter list than `compat.conf`;
3. `/home/root/codrawer/XOVI_DISABLED` does not exist;
4. the previous attempt finished its check (`state/xovi_pending` is absent; if one is found, XOVI
   is disabled with that reason);
5. xochitl has been running, unchanged, for 20 s.

**The crash guard.** For 60 s after the start it watches xochitl. If systemd restarts xochitl
even once, its process changes, or it stays down for 10 s, codrawer runs XOVI's `stock` at once
(one more xochitl restart, now without XOVI) and writes `XOVI_DISABLED` with the reason and time.
It does this on the first restart because xochitl's own unit allows only four starts in ten
minutes before it puts the tablet into emergency mode. It also clears xochitl's start counter
before each restart it causes, so going back to stock never meets that limit. After 60 s stable,
XOVI counts as healthy. In all, XOVI costs one xochitl restart per boot, about 20 s after xochitl
first appears.

**Turning it off.**

```sh
sh /home/root/codrawer/current/boot.sh xovi off   # stock xochitl now, and at every later boot
sh /home/root/codrawer/current/boot.sh xovi on    # remove the kill switch, start under the gates
sh /home/root/codrawer/current/boot.sh doctor     # xovi=running | disabled (reason) | untested OS … | payload missing | stock (…)
```

`xovi off` writes `XOVI_DISABLED` and, if XOVI is running, restarts xochitl without it. Creating
the file by hand (`touch /home/root/codrawer/XOVI_DISABLED`) and rebooting does the same. A
reboot with the kill switch present always comes up stock.

**Removing XOVI completely.**

```sh
sh /home/root/codrawer/current/boot.sh xovi off   # back to stock now, and keep it off
rm -rf /home/root/xovi /tmp/codrawer-layer        # XOVI's files and the extension's scratch
```

Nothing else remains: the drop-in was only ever in memory, and `/run/codrawer/tool` goes at the
next reboot. Removing codrawer (below) also stops XOVI from coming back, since the stub that
starts it is gone; run `boot.sh xovi off` first to leave XOVI at once rather than at the next reboot.

## What it never does

- **It never writes xochitl's data** (your notebooks, documents, templates, settings). The page
  watcher, when enabled (`PAGE_WATCH`, only on OS versions listed in `compat.conf` when `auto`),
  only reads the open page's saved `.rm` file. The bridge opens no file under xochitl's data
  directory for writing. The one way text reaches a document is the virtual keyboard above, and
  then it is xochitl that saves what was typed, as with your own typing.
- **It never changes the OS update setting**, or any reMarkable setting. Keep updates on: an update
  replaces the root partition and drops the stub, and nothing else. `deploy-tablet.sh`,
  `scripts/dev/tablet-guard.sh`, the Vellum hook or the repair key re-add it; until then codrawer
  simply does not start, and the tablet works as stock.
- **It never unmounts `/etc`** (that would drop the `/etc/dropbear` bind and can break SSH), and
  never writes to the root partition except the stub and its link. XOVI's drop-in is an in-memory
  mount, never a file in the persistent `/etc`.

## Network surface

- **Port 8577, all interfaces, plain WebSocket (no TLS).** `GET /healthz` answers `{"ok":true}` to
  anyone (the health check uses it). `/ws/<session>` is the stroke router: anyone who joins sees the
  live ink and the saved page, and can draw, clear the page and edit the shared document.
- **The pairing code.** `deploy-tablet.sh` generates one (`ROUTER_TOKEN`, 8 characters) on first
  install. Every client not on the tablet itself must present it (`?token=` or
  `Authorization: Bearer`); a wrong or missing code is refused (close code 4401). Clients on
  loopback (the bridge's own pen stream) are exempt. Without `ROUTER_TOKEN` in `bridge.env` the
  router is open to anyone on the network. The code travels in clear on your LAN: treat it as a
  door code for a trusted Wi-Fi network, not as protection on a public one.
- Nothing else listens. The bridge makes outgoing connections only to the router it is configured
  for (`DESKTOP_WS`; loopback by default).

## Removing codrawer completely

On the tablet (`ssh root@<tablet-ip>`; wake it first):

```sh
# 1. Stop codrawer and remove the stub from the root partition (and the units from /run).
sh /home/root/codrawer/current/install.sh --remove

# 2. Remove the in-memory copy of the stub from the live /etc (it would also vanish at reboot).
rm -f /etc/systemd/system/codrawer-boot.service \
      /etc/systemd/system/multi-user.target.wants/codrawer-boot.service

# 0. First, return xochitl to stock (no-op if XOVI is not running).
sh /home/root/codrawer/current/boot.sh xovi off

# 3. Remove the opt-in extras, if you used them, and XOVI's files.
rm -rf /home/root/xovi /tmp/codrawer-layer
rm -f /home/root/.vellum/hooks/post-os-upgrade/codrawer
sed -i '/codrawer-repair/d' /home/root/.ssh/authorized_keys

# 4. Remove codrawer's directory: releases, settings, pairing code, state.
rm -rf /home/root/codrawer

# 5. Reboot, which also unloads the Bluetooth driver codrawer loaded.
systemctl --no-block reboot
```

`install.sh --remove` stops the stub and codrawer's three units (stopping `codrawer-xovi` ends
only its guard; step 0 is what returns xochitl to stock), deletes the stub (and the two units older
codrawer versions installed there) from the rootfs's `/etc`, deletes the units in
`/run/systemd/system` and reloads systemd. It leaves step 2 to you because that copy is in memory
anyway, and keeps `/home/root/codrawer` so a remove can be undone with `install.sh --if-needed`.

Verify after the reboot:

```sh
ls /etc/systemd/system | grep codrawer           # nothing
systemctl list-units --all 'codrawer*'           # 0 loaded units
ls /home/root/codrawer /home/root/xovi           # No such file or directory
grep xochitl.service.d /proc/mounts              # nothing: xochitl runs stock
wget -q -T 3 -O - http://127.0.0.1:8577/healthz  # fails: nothing listens on 8577
```

Bluetooth pairings you made stay in `/var/lib/bluetooth` (remove them with `bluetoothctl remove
<address>`). On your computer, delete `~/.codrawer/` if you no longer need the signing and repair
keys. Developer Mode and SSH over Wi-Fi are reMarkable settings you turned on; turning them off is
described in reMarkable's own documentation.
