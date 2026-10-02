# Durable install on the Paper Pro across OS updates (research + design, 2026-10-02)

Question: how does the reMarkable community keep modifications alive across Paper Pro
(Codex, "ferrari", aarch64) OS updates? What is the most durable install we can build that is
also the easiest to restore? **Hard requirements:** automatic OS updates stay ON. The stack should
come back by itself or with one action. Our own components need a versioned, signed update channel
with rollback. Fragile pieces must be gated by OS version.

Method: we read the community projects' install scripts and sources (not only their READMEs),
plus the reMarkable docs and the community guide. Nothing was run on the tablet. Every on-device
claim below that we have not observed ourselves is marked **verify**, with the read-only command
that would check it (section 8).

## 1. TL;DR

- **Nothing in the community survives a Paper Pro OS update unaided.** Every project keeps its
  payload in `/home` and has a re-enable step:
  - xovi: `xovi/start` on every boot, plus `xovi/rebuild_hashtable` per OS version.
  - xovi-tripletap: `enable.sh`.
  - Vellum: `vellum reenable` (reManager has a button for it).
  - Entware: `--reenable`.
  - goMarkableStream: `install`.
  - remagic: `remagic setup`.
  - KOReader installer: "Maintenance Mode".

  The state of the art is "data in `/home`, plus one idempotent re-enable command", and our
  `install.sh` plus `deploy-tablet.sh` is already at that level.
- **No stock hook in `/home` runs at boot.** We found no persistent systemd path, no udev path, no
  swupdate post-install hook, and no `authorized_keys` trick that gets something to run after an
  update without some external action.
- **Survives updates:** developer mode, the `rm-ssh-over-wlan` setting, `/home/root/.ssh/authorized_keys`
  and the Bluetooth bonds. On the Paper Pro the dropbear host key is bind-mounted from
  `/home/root/.dropbear`, so it probably survives too. That last point is **verify**: the
  community FAQ says host keys regenerate, but that text predates the Paper Pro.
- **Recommendation:**
  1. Put one tiny, never-changing stub unit on the rootfs. Everything else (unit files, scripts,
     versioned releases) lives in `/home/root/codrawer` and is started from there.
  2. Restore the stub after an update in this order:
     - **(A) Self-heal by pre-staging.** When the OS has staged an update (`swu_status == 1`), and
       again at shutdown, copy the stub into the *inactive* root slot, so the new OS boots with it.
       This is novel and experimental, but its failure mode is benign.
     - **(B) Desktop doctor.** The router auto-heals over SSH (the remarkable_linlink pattern).
     - **(C) One-action fallbacks.** A phone SSH shortcut using a forced-command key; a
       `vellum reenable` hook, which also puts us on reManager's Reenable button; or
       `deploy-tablet.sh`.
  3. Add OS-update detection with a notification in our app, a signed update channel with
     automatic rollback, and an OS-version compatibility table that gates the display-buffer reader.

## 2. What an update does on Codex (facts we rely on)

| Fact | Source |
|---|---|
| An update writes the new image to the *inactive* root slot. A black bar then asks for a restart. Auto-update can install without the user noticing. | [jms1 updates](https://remarkable.jms1.info/info/updates.html) |
| 3.22 and later: swupdate sets `/sys/devices/platform/lpgpr/swu_status`. On reboot, `rm-apply-ota` sees `swu_status == 1` and runs `rootdev --switch`. | [codexctl PR #157](https://github.com/Jayy001/codexctl/pull/157) |
| Paper Pro root slots are partitions **2 and 3** of the base device that `rootdev` reports. The next boot is in `/sys/devices/platform/lpgpr/root_part`, with per-slot `root{a,b}_errcnt`. An update in progress shows up as `fuser` on the other slot. Slots are ext4 (`e2fsck -fn` works). | [remarkable-go/partition](https://github.com/rmitchellscott/remarkable-go/blob/main/partition/partition.go) |
| "The entire root partition is replaced… only `/home` is left untouched." The Paper Pro rootfs is read-only, with overlays that reset at reboot. | [remarkable.guide FAQ](https://remarkable.guide/faqs.html) |
| `/etc` is an overlay: `lowerdir=/etc,upperdir=/var/volatile/etc,workdir=/var/volatile/.etc-work`. | our observation; [vellum mount-restore](https://github.com/vellum-dev/vellum/tree/main/packages/mount-utils) |
| `/etc/dropbear` is a bind of `/home/root/.dropbear` (`etc-dropbear.mount`). | [remagic lib.sh](https://github.com/MaximeRivest/remagic/blob/main/scripts/lib.sh); our observation |
| `/home` is encrypted and unlocked during boot (xochitl is "required on startup when the device is encrypted"). Units that need `/home` must order after `home.mount`. | [xochitl docs](https://developer.remarkable.com/documentation/xochitl), [remagic xovi-boot.service](https://github.com/MaximeRivest/remagic/blob/main/scripts/xovi-boot.service) |
| The OS version is `RELEASE_VERSION=` in `/usr/share/remarkable/update.conf`, or `IMG_VERSION=` in `/etc/os-release`. Vellum, tripletap and remarkable-go all read it this way. | [vellum-cli detect.rs](https://github.com/vellum-dev/vellum-cli/blob/main/src/device/detect.rs), [tripletap main.sh](https://github.com/rmitchellscott/xovi-tripletap/blob/main/main.sh) |
| If xochitl crashes, `rm-emergency` reboots the device, which wipes the volatile `/etc` drop-ins. | [remagic 99-advanced-autostart.sh](https://github.com/MaximeRivest/remagic/blob/main/scripts/99-advanced-autostart.sh) |
| An OS upgrade re-enables "Automatic updates" anyway (the setting lives in the OS image). Our requirement to keep it on matches this default. | [jms1 updates](https://remarkable.jms1.info/info/updates.html) |

## 3. Community tooling: what it installs, how it starts, what an update breaks

| Project | Payload | Start mechanism | After an OS update | Re-enable step |
|---|---|---|---|---|
| **xovi** ([asivery/xovi](https://github.com/asivery/xovi), bundle in [rm-xovi-extensions](https://github.com/asivery/rm-xovi-extensions/releases)) | `/home/root/xovi/` (`xovi.so`, `extensions.d/`, `exthome/`, `services/xochitl.service/`) | **Tethered.** `xovi/start` mounts a **tmpfs** over `/etc/systemd/system/xochitl.service.d`, writes `00-xovi.conf` (`LD_PRELOAD=/home/root/xovi/xovi.so`, `XOVI_ROOT`), then runs daemon-reload and restarts xochitl. It touches nothing persistent, so a reboot goes back to stock. | Its files survive. The qt-resource-rebuilder hashtab is specific to each OS version. | `xovi/rebuild_hashtable` once per OS version, then `xovi/start` after every boot. xovi recommends tripletap rather than editing systemd. |
| **xovi-tripletap** ([repo](https://github.com/rmitchellscott/xovi-tripletap)) | `/home/root/xovi-tripletap/` (`main.sh`, `evtest`, config) | `enable.sh` runs `mount -o remount,rw /` and `umount -R /etc`, copies `xovi-tripletap.service` into the rootfs `/etc/systemd/system`, and enables it. `main.sh` watches `/dev/input/event0` for KEY_POWER (116) ×3 within 2 s and runs `xovi/start`. | The unit is gone. Its own `enable.sh` prints "Re-run xovi-tripletap/enable.sh after software updates." Optional version switching keeps one qt-resource-rebuilder directory per OS version (`prepare-new-version.sh`). | `xovi-tripletap/enable.sh` over SSH. **Trap:** `umount -R /etc` also removes the `/etc/dropbear` bind, which can kill new SSH logins until reboot. remagic ships a repair for it. |
| **AppLoad** ([rm-appload](https://github.com/asivery/rm-appload)) | xovi extension; apps in `/home/root/xovi/exthome/appload/<app>/` (manifest, rcc, optional backend) | Runs inside xochitl when xovi has been started | Same as xovi (hashtab, then start) | Same as xovi |
| **qt-resource-rebuilder / rm-hacks** ([rm-hacks-qmd](https://github.com/asivery/rm-hacks-qmd/blob/master/INSTALL.MD)) | `.qmd` files in `exthome/qt-resource-rebuilder/` | xovi | QMD diffs are pinned to OS versions | New qmd release, `rebuild_hashtable` |
| **Vellum** ([vellum](https://github.com/vellum-dev/vellum), [vellum-cli](https://github.com/vellum-dev/vellum-cli), [guide](https://remarkable.guide/guide/software/vellum.html)) | Everything under `/home/root/.vellum/` (apk database, `bin/`, `share/<pkg>/` units, `hooks/post-os-upgrade/`) | Packages that list `systemdunits=` get generated scripts ([vbuild velbuild.py](https://github.com/Eeems/vbuild/blob/main/vbuild/velbuild.py)): `mount-rw`, then `cp /home/root/.vellum/share/<pkg>/<unit> /etc/systemd/system/`, `systemctl enable --now`, then `mount-restore`. | Units are lost. Detection uses two signals: the rootfs marker `/etc/vellum/reenabled` disappears, and the stored `os_prev` no longer equals `os_cur`. Every `vellum` command then warns "Run 'vellum reenable'". | `vellum reenable` runs every executable in `/home/root/.vellum/hooks/post-os-upgrade/` with `VELLUM_REENABLE=1`, between `mount-rw` and `mount-restore`, then writes the marker. `vellum reenable status` prints ok, needed or unneeded. [reManager](https://github.com/rmitchellscott/reManager) shows "Reenable needed" on connect and has a Reenable button. Version gating uses a virtual `remarkable-os` package (for example `remarkable-os>=3.28 remarkable-os<3.29`). |
| **toltec** ([toltec-dev.org](https://toltec-dev.org/)) | `/opt` bind from home | `opt.mount` plus units | n/a | **Does not support the Paper Pro.** Supports only OS 2.6.1–3.3.2 on rM1/rM2. `toltecctl reenable` was the rM2-era model that Vellum inherited. |
| **Entware** ([rmpp-entware](https://github.com/hmenzagh/rmpp-entware); Vellum `entware`) | `/home/root/.entware`, bind-mounted on `/opt` | `opt.mount` unit written to `/etc/systemd/system` | The mount unit is lost | `rmpp_entware.sh --reenable` / Vellum's `reenable-entware.sh` (recreates `opt.mount`) |
| **KOReader** ([installer](https://github.com/rmppmove-tools/readmarkable-koreader-installation-tool)) | AppLoad app plus tripletap | tripletap and xovi | AppLoad and tripletap are lost | "Maintenance Mode" re-enables them after minor updates. For a major update (3.27 → 3.28) the advice is a full reinstall. |
| **goMarkableStream** ([repo](https://github.com/owulveryck/goMarkableStream); Vellum `gomarkablestream`, gated `remarkable-os>=3.24`) | Binary in `/home/root` | `./goMarkableStream install` writes `/etc/systemd/system/goMarkableStream.service`, which is volatile on the Paper Pro (ours was lost at reboot, see xochitl-pen-data.md) | "You may need to re-download the binary and restart the service." Paper Pro support is "experimental". | Re-run `install` |
| **remagic** ([repo](https://github.com/MaximeRivest/remagic)) | xovi, AppLoad and tripletap | tripletap by default. An opt-in `xovi-boot.service` is persisted into the rootfs with the same bind-`/` trick as our `install.sh`, plus a crash-loop guard (3 fast boots → skip xovi) and a kill switch at `/home/root/.xovi-boot/disable`. | Lost | "After a reMarkable OS update, just run `remagic setup` again." |
| **remarkable_linlink** ([repo](https://github.com/rosoba/remarkable_linlink)) | goMarkableStream with config and token in `/home/root` | Unit in `/etc` | Lost | **A desktop watcher auto-heals**: a GNOME-autostarted `remarkable-stream-watch.sh` notices the missing service and reinstalls it over SSH with `rm-heal.sh`. |
| **rm-ssh-over-wlan** (stock; [guide](https://remarkable.guide/guide/access/ssh.html)) | A setting | stock | **Survives**: "does not need to be re-run after OS updates as it controls a setting which is stored on the home partition" | none |

Patterns worth copying:
- Vellum's two-signal detection: a rootfs marker plus the stored OS version.
- Vellum's hook directory.
- remagic's crash-loop guard and kill switch.
- remarkable_linlink's desktop auto-heal.
- tripletap's and Vellum's per-OS-version gating.
- xovi's "volatile on purpose" injection, which makes it impossible to brick at boot.

## 4. Does anything survive an update by itself?

We checked each candidate against how Codex mounts things.

| Candidate | Verdict |
|---|---|
| Units in `/etc/systemd/system` (rootfs) | Replaced with the slot. This is the problem we are solving. |
| Runtime `/etc` and `/run` (units, `modules-load.d`, udev rules) | tmpfs: lost on every reboot, not only on updates. |
| `~/.config/systemd/user` with linger | Only runs if `user@0.service` is started. The Paper Pro has no logind linger configured for root, and enabling linger itself writes `/var/lib/systemd/linger`. That is on the rootfs or volatile unless bind-mounted. **Not viable** (verify: `systemctl status user@0.service`, `ls /var/lib/systemd/linger`). |
| `/var/lib/bluetooth` and `/etc/dropbear` binds from `/home` | Persist, but only as data. bluetoothd and dropbear do not execute anything from them. |
| `authorized_keys` `command="…"` (dropbear supports `command=`, `no-pty`, `restrict`; [dropbear(8)](https://manpages.debian.org/testing/dropbear-bin/dropbear.8.en.html)) | Persists in `/home/root/.ssh`, but **only runs when someone logs in**. Good for one-action repair (section 6.3), not for unaided healing. |
| `~/.profile` / `~/.bashrc` | Persist, but run only on interactive SSH logins. Useful for a "codrawer needs restoring" banner. |
| swupdate post-install scripts | They ship inside the signed `.swu` image. There is no user hook directory. |
| xochitl config (`~/.config/remarkable/xochitl.conf`) | Data only. No exec hook is known. |
| **Writing into the inactive slot after the update is staged and before the reboot** | **The only route to unaided survival.** The new rootfs is a plain ext4 partition (2 or 3) while it waits. In developer mode we already boot a modified rootfs, so there is no rootfs integrity enforcement on the active slot. Applying the same change to the staged slot before `rm-apply-ota` switches should behave the same way. If the write broke the slot, the bootloader's `root*_errcnt` fallback would return to the old slot. **No community project does this yet. Experimental; verify on one update.** |

Conclusion: only (a) something we already run on the old OS before the reboot, or (b) an external
agent after the reboot (desktop, phone, or a user running `vellum reenable`) can restore boot
services.

## 5. Developer mode and SSH across updates

- **Developer mode** persists until it is disabled through the recovery app. Enabling it causes a
  factory reset ([developer-mode](https://developer.remarkable.com/documentation/developer-mode),
  [FAQ](https://remarkable.guide/faqs.html)).
- **SSH over Wi-Fi** survives (see the table above). `authorized_keys` lives in `/home/root/.ssh`
  and survives.
- **Host key:** the FAQ says it regenerates on every update. That text is from the rM1/rM2 era.
  On the Paper Pro, `/etc/dropbear` is bound from `/home/root/.dropbear`, so the key should
  persist. **Verify after the next update.** Until then, the doctor and `deploy-tablet.sh` should
  treat a changed host key as "tablet updated". Prompt for it, or pin with a dedicated
  `known_hosts` entry; never silently disable checking.
- **Root password** is shown in Settings → About → Copyrights and Licenses. We use keys, so it does
  not matter to us.

## 6. Recommended design

### 6.1 On-device layout (everything under `/home`)

```
/home/root/codrawer/
  releases/<ver>/            codrawer_bridge_native, boot.sh, bt-up.sh, keyboard-keeper.sh,
                             units/*.service, compat.json, MANIFEST (sha256 of each file)
  current -> releases/<ver>  atomic symlink swap (ln -sfn + rename)
  previous -> releases/<ver> rollback target (generalises today's .prev binary)
  bridge.env                 user config (never overwritten)
  stub/codrawer-boot.service the only file that ever goes on the rootfs
  state/  installed-os, installed-at, last-good, boot-count, update-log
  keys/release.pub           ed25519 public key (also embedded in the binary)
  disable                    kill switch (if present: start nothing)
```

### 6.2 Minimise the rootfs footprint: one stub unit

Replace the two rootfs units with **one stub** whose content never changes, so the rootfs is
written only after an OS update:

```ini
[Unit]
Description=codrawer boot stub (logic lives in /home/root/codrawer)
RequiresMountsFor=/home/root
After=home.mount network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh /home/root/codrawer/current/boot.sh start
ExecStop=/bin/sh /home/root/codrawer/current/boot.sh stop     # pre-stage hook, see 6.3 A
TimeoutStopSec=60
[Install]
WantedBy=multi-user.target
```

`boot.sh start` does the following:
1. Honours the `disable` kill switch.
2. Runs a crash-loop guard: N fast boots in a row → start nothing (remagic's pattern).
3. Copies `current/units/*.service` into **`/run/systemd/system/`**, which is volatile and a
   valid unit path.
4. Runs `systemctl daemon-reload` and `systemctl start codrawer-bluetooth codrawer-bridge`.

Unit edits therefore ship like any other file in a release, with no rootfs write. The journal
names (`journalctl -u codrawer-bridge`) stay the same.

We do not touch `xochitl.service`. Our bridge reads evdev with `NO_GRAB=1` and reads `/proc` read-only, so
`rm-emergency` reboot loops caused by us are very unlikely. Keep the guard anyway.

### 6.3 Coming back after an OS update (auto-updates stay ON)

These are layered. Each later layer covers failures of the earlier ones.

**A. Self-heal by pre-staging into the inactive slot (experimental).**
- **Trigger:** the bridge (or `boot.sh watch`) polls `/sys/devices/platform/lpgpr/swu_status`
  every 60 s while awake. The stub's `ExecStop` covers the reboot path: at shutdown the old OS is
  still running and `swu_status` is still 1.
- **Steps:**
  1. Confirm `swu_status == 1`, so an update is staged.
  2. Find the other slot: `rootdev` gives the base device and the running slot; the other is
     `p2` or `p3`.
  3. Check the slot is not busy (`fuser` returns nothing) and is clean (`e2fsck -fn`).
  4. Read its `IMG_VERSION` from a read-only mount.
  5. Mount it rw, copy `stub/codrawer-boot.service` plus its `multi-user.target.wants` symlink,
     sync, unmount, and run `e2fsck -fn` again.
  6. Write `state/prestaged=<new version>`.
- **Gates:**
  - It runs only if the target version is no older than one we have pre-staged successfully
    before. We do not want to learn about a new layout the hard way.
  - The first time, it runs only behind `PRESTAGE=1` in `bridge.env`.
- **Failure handling:** if anything fails, log it and fall through to B or C. The worst
  realistic outcome is "units missing", which is today's behaviour.
- **First real test:** do it attended on the next update and keep the logs.

**B. Desktop doctor (auto, needs the desktop on).** This is remarkable_linlink's pattern in our
router.
- **Trigger:** the router's tablet watcher sees the tablet answer SSH (or ping) while the bridge is
  not connected or `:8577/healthz` is down. It then runs
  `ssh root@tablet sh /home/root/codrawer/current/boot.sh doctor`.
- **`boot.sh doctor`** prints JSON: `os_version`, `installed_os`, `stub_present`,
  `units_active`, `prestaged`, `compat`.
- **Repair:** if the stub is missing, the router either repairs automatically (`AUTO_REPAIR=1`)
  or asks the app first (6.4). The repair is `sh /home/root/codrawer/current/install.sh --stub`.

**C. One action, no computer needed:**
- **Phone shortcut.** Add a second key to `/home/root/.ssh/authorized_keys`:
  `command="sh /home/root/codrawer/current/install.sh --if-needed",restrict ssh-ed25519 AAAA… codrawer-repair`.
  An iOS Shortcuts "Run script over SSH" action (or Termux on Android) using that key repairs in
  one tap over Wi-Fi. SSH over Wi-Fi and `authorized_keys` both survive updates. The key can do
  nothing else.
- **Vellum users.** Install the executable `/home/root/.vellum/hooks/post-os-upgrade/codrawer`,
  which runs `install.sh --stub`. `vellum reenable`, and reManager's Reenable button, then restore
  codrawer together with xovi and the other community mods.
- **`scripts/dev/deploy-tablet.sh`** stays as the developer path. Change it to call
  `install.sh --if-needed` instead of comparing units.

An on-device trigger without SSH, such as triple-pressing the power button, is **not possible
after an update**. Whatever watches the button is itself a boot service that the update removed.
tripletap has exactly this limitation ("re-run enable.sh after software updates").

### 6.4 Detecting an update and notifying

- **Signal 1, rootfs marker** (Vellum's approach): `install.sh` writes `/etc/codrawer/installed`
  into the rootfs lower directory. If it is missing while `state/installed-os` exists, the slot
  was replaced.
- **Signal 2, version compare:** compare the current `IMG_VERSION` with `state/installed-os`.
  Unequal means the OS changed (an upgrade or a downgrade).
- **Who sees it:**
  - After an update without pre-staging, nothing of ours runs on the tablet, so the **desktop
    doctor** detects it. It sends `{"t":"sys","kind":"tablet_os_changed","from":…,"to":…,"repairable":true}`
    on the session. The glasses and web app show **"Tablet updated to 3.x — restore codrawer?"**,
    and confirming sends `{"t":"sys","kind":"tablet_repair"}` to the router, which runs B.
  - With pre-staging, or after a repair, the bridge starts and finds the versions differ. It then:
    1. Records the new version.
    2. Re-runs the compatibility checks in 6.6.
    3. Emits `tablet_os_changed` with `restored:true`, so the app shows "Tablet updated to 3.x —
       codrawer restored (display reader: disabled pending check)".
- **SSH logins:** a `~/.profile` banner prints the same status.

### 6.5 Our own update channel (survives OS updates; signed; rollback)

- **Release format:**
  - A tarball holds the bridge, scripts, `units/`, `compat.json` and a `MANIFEST` with the sha256
    of every file.
  - A detached ed25519 signature covers the MANIFEST and the version. Use Go's `crypto/ed25519`,
    so no extra tooling is needed on the device.
  - CI signs with a private key that never touches the tablet. The public key is embedded in the
    binary and also stored in `keys/release.pub`.
- **Sources:**
  - **Push:** `deploy-tablet.sh` (dev) or the desktop router serving
    `GET /tablet/releases/latest.json`.
  - **Pull:** the bridge checks a release URL, either GitHub Releases or the router, at most once
    a day, and only on Wi-Fi with the screen on.
  - Both sources go through one entry point: `boot.sh update <tarball>`.
- **Apply:**
  1. Verify the signature, then every hash.
  2. Unpack to `releases/<ver>/`.
  3. Point `previous` at the old `current`.
  4. Swap `current` atomically.
  5. Restart the units from `/run`. The rootfs is untouched.
- **Health gate:** the new bridge must answer `/healthz` and see the pen device within 60 s.
  Otherwise `boot.sh` swaps back to `previous`, restarts, and records the failed version so it is
  not retried. The same gate runs at boot through the crash-loop counter.
- **Housekeeping:** keep three releases. `boot.sh rollback` is available by hand.
- Because everything lives in `/home`, OS updates never touch our versions.

### 6.6 Compatibility gating

- `compat.json` (shipped per release) maps OS version ranges to features:

  ```json
  {"tested":["3.27.*","6.0.105"],
   "features":{
     "display_buffer":{"os":[">=6.0.100","<6.1"]},
     "xovi_hooks":{"os":[]},
     "uinput_typing":{"os":[">=3.20"]}}}
  ```

- **Policy at bridge start:**
  - Read `IMG_VERSION`. Core features (pen evdev, keyboard, router) always run, and fall back to
    probing if `event2` disappears.
  - Fragile features run only if the version is in range **and** a runtime self-test passes. The
    display-buffer self-test:
    1. Find xochitl's two anonymous mappings of about 14.1 MB.
    2. Check the stride: 6528 B × 2160 rows.
    3. Read one tile and confirm the pixels are BGRA-plausible.
  - If either check fails, the feature stays off. The router reports
    `{"t":"sys","kind":"feature","name":"display_buffer","state":"disabled","reason":"untested os 6.1.2"}`
    and clients fall back to vector ink.
  - An optional `FORCE_FEATURES=display_buffer` setting in `bridge.env` lets us test new versions.
- **xovi hooks:** we never inject by default. If a future feature needs xovi, follow its tethered
  model: a tmpfs drop-in, never a persistent `LD_PRELOAD`. Gate it on the OS version and on
  `rebuild_hashtable` having run for that version, the way tripletap's version switcher does.

### 6.7 Coexisting with xovi and Vellum

- **Never `umount -R /etc`.** It drops the `/etc/dropbear` bind, which is how tripletap and Vellum's
  `mount-rw` can wedge SSH. Keep our bind-`/` approach, which writes into the lower `/etc` without
  disturbing mounts.
- When `install.sh` runs under `VELLUM_REENABLE=1`, `/` is already rw and the overlay is
  unmounted. In that case **skip our remount-ro trap**, so later hooks are not broken; Vellum's
  `mount-restore` handles it.
- **Never write `/etc/systemd/system/xochitl.service.d`.** xovi tmpfs-mounts over it.
- If the user runs goMarkableStream through Vellum, it binds `:2001`. Our reader is in-process and
  needs no port.
- Ship a Vellum package (VELBUILD with `systemdunits=` and `postosupgrade`) only if we ever
  distribute publicly. The raw hook file is enough for us.

## 7. First implementation steps (in order)

1. **`install.sh` rewrite:**
   - Add the `--stub`, `--if-needed`, `--remove` and `--status` modes.
   - Install only `codrawer-boot.service` (plus its wants link) into the rootfs lower `/etc`.
   - Write `/etc/codrawer/installed` and `state/installed-os`.
   - Respect `VELLUM_REENABLE`.
   - Remove the old two rootfs units when found.
2. **`boot.sh`** with the subcommands `start | stop | doctor | update | rollback | watch`:
   - `start` covers the kill switch, the crash-loop guard, copying units into `/run/systemd/system`
     and starting them.
   - `doctor` prints JSON.
3. **Release layout:** `releases/`, `current`, `previous`. Teach `deploy-tablet.sh` to build a
   signed tarball and call `boot.sh update` (dev key for now).
4. **Router:** add the tablet doctor (SSH probe, `tablet_os_changed` and `tablet_repair` events).
   Add the app banner and confirm action.
5. **Bridge:** report the OS version and feature states in `/healthz`. Gate the display-buffer
   reader on `compat.json` plus its self-test.
6. **Repair key** with a forced command, plus a documented phone shortcut. Install the Vellum hook
   file if `/home/root/.vellum` exists.
7. **Pre-staging (6.3 A)** behind `PRESTAGE=1`. Run it attended on the next OS update and record
   the results here.

## 8. Read-only checks to run on the tablet before building (verify list)

```sh
cat /usr/share/remarkable/update.conf; grep IMG_VERSION /etc/os-release
rootdev; swupdate -g; cat /sys/devices/platform/lpgpr/{swu_status,root_part}
ls /sys/devices/platform/lpgpr/; lsblk -f 2>/dev/null || cat /proc/partitions
grep -E ' / | /etc | /home|dropbear|bluetooth' /proc/mounts
systemctl cat etc-dropbear.mount home.mount; systemctl status user@0.service
systemctl cat rm-apply-ota.service 2>/dev/null   # when does the switch run: shutdown or boot?
ls -la /home/root/.dropbear /etc/dropbear        # host-key persistence
ls /run/systemd/system                           # confirm /run is a live unit path
```

After the next OS update, record:
- whether the host key changed;
- whether `authorized_keys` and SSH over Wi-Fi still work;
- what `install.sh --status` reports;
- if pre-staging was armed, whether the stub came up by itself.
