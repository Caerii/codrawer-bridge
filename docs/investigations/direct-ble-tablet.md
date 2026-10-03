# Direct BLE: Paper Pro → Even G2 without the phone

Status: investigation (2026-10-02). No production code. Read-only probes only (nothing was paired,
bonded, trusted or connected; no Bluetooth settings changed).
Related: ADR 006 (latency budget), ADR 007 (surface composition), `docs/remarkable_bluetooth.md`.

## Verdict

**Go for a probe. Do not commit to the integration until the probe has measured stock-firmware ack
latency for a 128×64 frame.**

- **Protocol: yes.** A non-phone central can create its own page and push images with the
  reverse-engineered protocol. The Even app's session state is not needed; the central builds it
  with a fixed prelude, CREATE, then REBUILD. `g2flash/demos/video-bench.ts` does exactly this
  with no phone.
- **Tablet radio: yes.** The IW612 supports LE central with an existing LE link (the keyboard),
  2M PHY, Data Length Extension (251 B) and 8×251 B LE buffers. BlueZ 5.86 and D-Bus are present.
- **Exclusive, not shared.** An arm only advertises when no central holds it. Phone and tablet
  can't both drive the glasses at once on stock firmware. Direct mode is a mode switch.
- **Latency gain is real but smaller than ADR 006 implies.** The "~60 ms + 20 ms/KB" desktop
  figure has no bench behind it in this repo. g2-kit's own stock-firmware numbers contradict it
  (8.8 KB/s, 400–500 ms per 4 KB fragment). Stock firmware also never sees PNG on the wire: it
  gets a 4-bpp BMP (4,214 B for 128×64), and the bottleneck is probably the glasses' BMP decode,
  not BLE. Direct BLE removes the Wi-Fi hop, the WebView→Flutter→PNG→BMP conversion and the
  no-overlap rule (`sendFailed`). It also lets us use stock 2.2.6.10's LZ4 image compression.
  Expected loupe update: **~60–150 ms vs ~190 ms today**. Only the probe can narrow that range.
- **Biggest tablet-side risk: autosuspend kills the link.** The kernel's Bluetooth suspend
  notifier is active on this tablet, and it disconnects every LE link before deep suspend. The
  tablet slept 3–22 s at a time between pen bursts during this investigation. A direct session
  must hold a wake lock (≈2.6–3.4 W awake draw measured, so ~13–17 h on a full 43 Wh battery) or
  accept a 1.5–2.5 s reconnect after every idle period.

## 1. Protocol feasibility

### What the kit does from a desktop today

Transport: `C:\Github\g2-kit-unofficial\ble\ble.ts`. The code is canonical; the docs are partly stale (see "Doc drift" below).

| Item | Evidence |
| --- | --- |
| Two peripherals, names `Even G2_<serial>_<L\|R>_<mac3>` | `ble/ble.ts:178` (`NAME_RE`), `ble/docs/transport.md:3-8` |
| Command channel: service `00002760-08c2-11e1-9073-0e8ac72e5450`, write `…5401` (write-without-response), notify `…5402` | `ble/ble.ts:180-182`; same UUIDs in `g2flash.py:50-52` ("CTRL") |
| Render/stream channel `…6401/6402` (mic LC3 etc., unframed) | `ble/ble.ts:184-186` |
| Connect: plain `connectAsync()` + discover + subscribe. **No pairing/bonding step anywhere** in kit or g2flash | `ble/ble.ts:297-358`, `g2flash.py:416-434` (bleak, "Linux/BlueZ exact-address path") |
| Envelope `aa 21 seq len totFrags fragIdx sid flag <pb…> [crc16 LE on last frag]`. CRC-16/CCITT-FALSE over the concatenated pb. 232 B chunks, so each BLE write is ≤ 240 B. All fragments of one message share `seq` | `ble/envelope.ts:1-90`; "validated byte-for-byte vs capture" in `g2flash.py:18-20` |
| Request flag `0x20`; acks echo `MagicRandom` (pb field 2); keep magic in 100..255 | `ble/envelope.ts:28`, `ble/README.md` "Magic counter" |
| Writes on one arm must not interleave (single reassembly buffer) | `ble/docs/gotchas.md:83-104`, `ble/ble.ts:378-399` |

Session sequence (no phone involved):

1. Connect R, then L, then settle 800 ms (`ble/session.ts:66-70`).
2. **Prelude**: a fixed 27-byte frame on sid `0x01` (app-launch type 2), acked with magic 156
   (`ble/messages.ts:565-573`, `ble/session.ts:74-79`). Without it every EvenHub write is
   silently dropped (`ble/docs/gotchas.md:24-26`).
3. **CREATE** (sid `0xe0` Cmd=0): a startup list page, plus extra container names to reserve
   (`ble/messages.ts:215-262`). video-bench uses `b<suffix>` and reserves `c<suffix>`
   (`g2flash/demos/video-bench.ts:434-437`).
4. **REBUILD** (Cmd=7) declaring the image container(s) (`ble/messages.ts:464-486`,
   `video-bench.ts:438-442`). Then wait 300 ms "to let the container replicate" (`video-bench.ts:443-445`).
5. **Warmup**: the first Cmd=3 stream after a new image page is silently dropped (firmware bug).
   Send a sacrificial frame first (`ui/image-streamer.ts:393-402`).
6. **Cmd=3 UpdateImageRawData** per frame: container id/name, `MapSessionId` (bump per frame),
   `MapTotalSize`, `CompressMode`, `MapFragmentIndex`, ≤4096 B `MapRawData` per message.
   6144 B is rejected with error 7 (`ble/messages.ts:505-531`, `ble/image.ts:200-219`).
7. **Heartbeat** Cmd=12 every 5 s after the first CREATE. The plugin task dies after ~10 s
   without traffic (`ble/docs/gotchas.md:73-81`, `ble/docs/containers.md:108-113`).
   g2flash additionally beats sid `0x80` about every 12–15 s during OTA (`g2flash.py:28-29`).

**Answer to "must the phone set it up first?"** No. Every piece of state (plugin task, page,
containers) is created by the central over BLE. The Even app is just another central that
happens to do the same thing. `video-bench.ts` runs this whole sequence from a laptop with the
phone's Bluetooth off.

### Image format on the wire (important for the design)

- Stock firmware takes a **4-bpp indexed BMP** (14+40 B headers, 16-entry gray palette,
  bottom-up rows padded to 4 B) (`ble/image.ts:3-11, 47-95`). The PNG we hand the Even SDK is
  decoded and re-encoded by the phone host (`apps/even-g2/src/strokes.ts:347-350` notes the host
  "converts to Gray4 itself"). So the phone's 190 ms-regardless-of-PNG-size result fits:
  **the glasses always receive the same 4,214 B BMP for a 128×64 loupe.** Shrinking the PNG
  could never help.
- Stock caps an image container at 288×144 (`g2flash/README.md:33`).
- **Stock 2.2.6.10 added `CompressMode` 1 = RLE and 2 = LZ4 block**. The firmware inflates into
  `malloc(W*H)`, so the compressed payload must inflate to ≤ W·H bytes (128×64 → 8,192 ≥ 4,214 OK).
  An unknown mode is "treated as raw" and shows garbage, so gate it on the firmware version
  (`g2flash/demos/video-bench.ts:27-36, 104-109`; `demos/lz4.ts:1-19` has a 130-line block
  compressor). A mostly-empty ink loupe should LZ4 down to a few hundred bytes, i.e. one
  Cmd=3 message of 1–3 BLE writes instead of two messages of ~19 writes.

### Arms

- Events (taps, scroll, wear) come from **R only** (`ble/docs/gotchas.md:106-113`).
- video-bench sends setup and heartbeat to R. It can send image data to **either** arm, and the
  ack always returns on R: "the arms sync internally" (`video-bench.ts:54-58, 466-485`). This
  contradicts `ble/docs/transport.md:5-8` ("no internal bus").
- The kit always connects both arms (`ble/session.ts:66-68`). **Unknown:** whether an R-only
  session renders on both lenses, and whether the firmware tolerates L being unconnected (L
  would then keep advertising and the phone could grab it). Plan for two links and test R-only
  in the probe.

### Phone and tablet sharing

Not possible on stock firmware. An arm stops advertising while a central holds it. Every direct
tool tells you to quit the Even app or turn off the phone's Bluetooth first (`g2flash/README.md:110-113`,
`demos/README.md:201-203`, `g2flash.py:427`). This investigation's scan confirms it from the
tablet: 24 LE devices in 20 s, no `Even G2_*` (see §2). So "phone keeps the menu, tablet pushes
images" can't be done over BLE. The split that works is **the tablet as the only central in direct
mode**. Menu input still works because R-arm events (click/scroll) reach whoever is connected.
The phone app (Even Hub, Wi-Fi) is the fallback when direct mode is off.

### Doc drift in g2-kit (don't port from the docs)

`ble/docs/transport.md:22-24` lists service `6E40FFF0…`/`fff1`/`fff2`. `ble/docs/envelope.md`
describes a header with a 4-byte magic and a big-endian CRC over the header. Both disagree with
the code (`ble.ts:180-186`, `envelope.ts:1-90`), and g2flash independently confirms the code.
`ble/docs/images.md:138-147` claims ~20 fps for 48×48 and ~12 fps for 4×144×144 (~41 KB/frame,
which is impossible at the 8.8 KB/s it states two lines later). Treat those as unverified.

## 2. Tablet feasibility

### Probed on the tablet (2026-10-02 21:25 UTC, Codex build 20260924063239, kernel 6.12.49)

```
hci0  Bus: UART  BD 24:FD:FA:01:30:94  HCI/LMP version 0x0f  Manufacturer: NXP (37)
bluetoothctl: 5.86   Powered: yes  Pairable: no  Roles: central, peripheral
LE Read Local Supported Features  → 7F FD 00 FF 8F 00 00 00
    bit5 Data Length Extension=1, bit8 LE 2M PHY=1, bit11 Coded PHY=1, bit14 CSA#2=1, Conn Param Req=1
LE Read Buffer Size [v2]          → ACL 251 B × 8 packets (ISO 1 × 15)
LE Read Max Data Length           → TX 251 B / 17040 µs, RX 251 B / 17040 µs
LE Read Suggested Default DL      → 251 B / 17040 µs   (DLE already at max by default)
hcitool con                       → < LE DC:D8:86:44:8B:E9 handle 3840 state 5 lm CENTRAL  (Pebble K380s)
bluetoothctl --timeout 20 scan on → 24 LE devices, none matching "Even" / "G2_"
Wi-Fi: wlan0 channel 10 (2457 MHz) 20 MHz, HE-MCS 11, -54 dBm
Tools: bluetoothctl, btmon, hcitool, busctl, dbus-send present; btmgmt, gatttool, python3 absent
/sys/kernel/debug not mounted; /etc/bluetooth/main.conf has no [LE] section (kernel defaults)
```

Interpretation:

- **Central role + coexistence:** the tablet is already LE central to the keyboard (handle
  0x0F00). Two more LE links (L and R arms) means 3 concurrent LE central links, well within what
  a BT 5.x controller schedules. The cost is airtime sharing: the keyboard's connection events
  and the glasses' share one radio. **Wi-Fi is on 2.4 GHz channel 10, the same band**, on the
  same IW612 combo chip, so Wi-Fi/BT coexistence arbitration applies. Put the tablet on 5 GHz
  before measuring.
- **MTU / DLE / PHY:** a 240 B write + 3 B ATT + 4 B L2CAP = 247 B fits one 251 B LL PDU.
  BlueZ negotiates ATT MTU on connect (we need ≥ 243). 2M PHY is supported locally; whether the
  G2 (Ambiq Apollo510b per `g2flash.py:63-66`) accepts it is unknown. Read it back with
  `hcitool cmd 0x08 0x0030 <handle>` (LE Read PHY) once connected. At 1M PHY a 251 B PDU is
  ~2.1 ms of air; at 2M ~1.1 ms. **Wire time isn't the bottleneck for a ≤4 KB frame.**
- **Connection interval:** Linux defaults to 30–50 ms (`le_conn_min/max_interval` 0x18/0x28), and
  main.conf sets nothing. Average added latency is about half an interval per direction. Ask for
  7.5–15 ms: per-connection with `hcitool lecup --handle H --min 6 --max 12` for the probe, then
  via mgmt *Load Connection Parameters* or a main.conf `[LE]` section (needs `install.sh` to put
  it in the rootfs, since `/etc` is tmpfs). The peripheral may counter-request its own interval.
- **Go stack options:**
  - **BlueZ over D-Bus (recommended).** Use `tinygo-org/bluetooth` (pure Go via godbus; scan,
    connect, discover, write-without-response, notify) or `muka/go-bluetooth`. Both are cgo-free
    and cross-compile with the existing `GOOS=linux GOARCH=arm64` build. For the hot path, use
    BlueZ `AcquireWrite`/`AcquireNotify` on `…5401/…5402` to get a SEQPACKET fd. That avoids a
    D-Bus round trip per 240 B write (≈1–3 ms each on the A53) and a PropertiesChanged signal per
    notification. bluetoothd keeps owning the keyboard, the bonds and the keeper.
  - **HCI user channel** (go-ble/ble, paypal/gatt): **rejected**. It needs hci0 down to
    bluetoothd, which drops the keyboard.
  - **Raw L2CAP ATT socket (CID 4)** from Go via `x/sys/unix`: possible, but it fights
    bluetoothd's own GATT client on the same bearer. Only worth it if D-Bus proves to be the
    bottleneck.
- **Pairing:** the kit and g2flash never pair, so the command channel likely needs no encryption.
  If it does, BlueZ will try to raise security on an ATT auth error. The tablet is currently
  `Pairable: no`, so the kernel answers SMP with no-bonding and no keys get stored. Keep it that
  way for the probe and run `btmon` to catch any SMP traffic.
- **Autosleep and the link (key finding):** `/sys/power/autosleep = mem`. `suspend_stats`:
  156 successes, 37 failures since boot. bluetoothd logs `Controller resume with wake event 0x0`
  after every suspend, so the kernel's Bluetooth suspend notifier runs on this controller.
  In 6.12 `hci_suspend_sync` disconnects all links (reason 0x15, power off) before suspending.
  The journal shows the tablet sleeping 3–22 s between pen bursts (`[bridge] … resumed after
  ~22s asleep`). The pen bridge only takes a 3 s timed wake lock per pen activity
  (`bridge/remarkable/native/bridge.go:266-270`). So **a direct G2 session will drop whenever
  the tablet sleeps**, and the glasses' 10 s heartbeat watchdog would kill the plugin task anyway.
  Reconnect costs scan + connect + discover + prelude ≈ 1.2–1.8 s (`ble/docs/transport.md:65-70`),
  plus CREATE, REBUILD and warmup.
  Design consequence: hold a named wake lock (`codrawer-g2`) for as long as direct mode is
  active, and release it after N minutes without pen/key input.
- **Battery:** measured now with the tablet awake (SSH, screen on): `max1726x_battery`
  `CURRENT_AVG` -309 mA, `POWER_NOW` -3.16 W at 8.28 V; `CHARGE_FULL` 5,270 mAh (2S, ≈43 Wh).
  An always-awake tablet lasts roughly 13–17 h, versus the stock multi-week standby. Radio cost
  for two BLE links at 7.5–15 ms intervals is small next to keeping the SoC out of deep suspend.

## 3. Expected latency and the bottleneck

| Stage | Phone path today | Direct from tablet (estimate) |
| --- | --- | --- |
| Pen → stroke batch | bridge batch 60 Hz (`native/main.go:29`) → ws | in-process, no batch needed (≤1 ms) |
| Tablet → renderer | Wi-Fi WebSocket to phone (2.4 GHz) | none |
| Rasterize + encode | WebView canvas → PNG → SDK bridge → Flutter → PNG decode → BMP | Go rasterizer → 4-bpp BMP → LZ4 (<1 ms) |
| BLE transfer | 4,214 B BMP (~19 writes) | ~0.2–0.8 KB LZ4 (1–3 writes) + wait for connection event (~½ interval) |
| On-glasses decode + render + ack | included | **unknown; dominant** |
| Total per loupe update | **~190 ms measured, serial, ~5 fps; overlap → `sendFailed`** | **~60–150 ms**, window 2 allowed |

Why the bottleneck is on the glasses:

- g2-kit measured on stock (2026-04-14): a 20,854 B 288×144 BMP took ~2.4 s serial, "bottlenecked
  by ~400–500 ms firmware ack latency per 4 KB fragment — not BLE wire time"
  (`ble/messages.ts:501-504`). That's ~8.8 KB/s (`ble/docs/images.md:146`).
- g2flash says the stock BMP loader "decodes with two function calls per pixel". The CFW's
  `raw4`/`delta` modes exist to bypass that CPU cost. Then 288×144 reaches ~22 fps on the CFW
  (`demos/video-bench.ts:17-25`, `demos/README.md:248-251`).
- So on stock firmware, cost scales with **pixels per container**, not bytes. The 128×64 loupe
  has 8,192 px, about 1/5 of 288×144. Scaling the kit's figure linearly gives ~100 ms or more of
  firmware time. The phone's 190 ms is an upper bound that includes phone overhead.

ADR 006's "desktop direct BLE ≈ 60 ms + 20 ms/KB, ~9.5 fps per container" has no script or log
behind it in this repo (it first appears in commit `31f0230`, an ADR-drafting commit). It should
be re-measured, and the ADR 006 rule (">30% moves need a note") then applies. The "≤ 80 ms direct"
budget may need a smaller loupe (e.g. 96×48 = 4,608 px) on stock, or the CFW `delta` mode, which
sends only the changed bounding box and fits ink almost perfectly.

## 4. Risks

| Risk | Likelihood / impact | Mitigation |
| --- | --- | --- |
| **Keyboard keeper steals the glasses.** `keyboard-keeper.sh:54` reconnects **every Paired device** every 8–32 s | Certain if the glasses ever get paired on the tablet; the phone would lose them repeatedly | Never pair the glasses. If they ever are, give the keeper an allowlist (keyboard address) first |
| Bonding the glasses to the tablet evicts the phone's bond (G2 keeps bonds in a small NV region, `g2flash.py:68-70`) | Unknown; recovery would be a re-pair from the Even app | Don't pair: kit and g2flash work unbonded. Keep `Pairable: no` and watch `btmon` for SMP |
| Phone app reconnects and grabs an arm when the tablet lets go (or grabs L if we only hold R) | Likely while the Even app runs | Direct mode = phone Bluetooth off or Even app force-quit; hold both arms; document the mode switch |
| Firmware OTA changes the protocol | Medium. 2.2.6.10 already added CompressMode; the prelude is a captured constant | Read the firmware version at connect (sid 0x09, as `demos/detect-cfw.ts` does). Allowlist tested versions and fall back to the phone path. Keep LZ4 behind a version ≥ 2.2.6.10 gate |
| Wedging the plugin task (interleaved writes, stuck MapSessionId, ack misses) | Known and documented | One write lock per arm; bump session id by 2 after an abort; tolerate ≤3 ack misses (`ble/docs/images.md:92-118`, `ui/image-streamer.ts:494-517`) |
| `dev_config` sid 0x80 writes can soft-brick | Only if poked | Never write sid 0x80 beyond the heartbeat (`ble/docs/gotchas.md:136-140`) |
| CFW (`g2flash`) | Voids warranty, real brick risk (README:7-11) | Out of scope for stock plan; separate later decision |
| Tablet battery with the wake lock | Certain: ~2.6–3.4 W awake | Idle release (e.g. 2–5 min); show direct mode state on the lens |
| 2.4 GHz Wi-Fi/BT coex on the IW612 | Medium: jitter on both | 5 GHz SSID for the tablet; measure with and without |
| Chip wedge if the radio is reloaded during suspend (`remarkable_bluetooth.md:85-88`) | Existing | Direct mode never reloads the driver; it only uses bluetoothd |
| Glasses battery | Low/unknown: the same traffic as the phone path | Measure via the sid 0x09 battery query over a session |

## 5. Phased plan

### Phase 0: baseline from the desktop (½ day, no tablet code)

Turn off the phone's Bluetooth. On the PC, run g2flash's `video-bench.ts` against stock firmware
with `G2_MODE=bmp` and `G2_MODE=lz4` (if the glasses are on 2.2.6.10+), with `G2_IMG_W=128
G2_IMG_H=64`, `G2_WINDOW=1` and `2`. Also run `detect-cfw.ts` to get the firmware version. This
gives the real per-frame ack latency (avg/p90/p99 are printed) and replaces ADR 006's unsourced
row. Also sweep 64×32, 96×48 and 288×144 to fit the per-pixel cost model. (CLAUDE.md: Bun is
the runtime for g2-kit.)

### Phase 1: smallest tablet probe (1–1.5 days)

1. Wake the tablet. Turn off the phone's Bluetooth. Take a temporary wake lock for the probe's
   lifetime. Check the arms advertise:
   `bluetoothctl --timeout 15 scan on | grep -a "Even G2_"`.
2. `g2probe`: a throwaway Go binary (`GOOS=linux GOARCH=arm64`, `tinygo-org/bluetooth`) that:
   - scans by name regex
   - connects R then L (flag: R-only)
   - discovers `…5401/…5402` and subscribes
   - sends the 27-byte prelude
   - sends CREATE, REBUILD for one 128×64 image container, and a warmup frame
   - pushes N frames of a moving dot, as BMP and LZ4, window 1 and 2
   - logs per-frame write→ack latency percentiles
   - sends a heartbeat every 5 s, then disconnects

   Envelope, CRC and the five protobuf messages are hand-encoded with
   `google.golang.org/protobuf/encoding/protowire`, using field numbers from
   `g2-kit-unofficial/ble/gen/EvenHub_pb.ts`.
3. Run `btmon` alongside to record ATT MTU, PHY, connection interval, and any SMP. Repeat after
   `hcitool lecup` to 7.5–15 ms.

**Pass:** an image visible on the lens from the tablet, no bond created, keyboard still working,
and a measured p50/p90 for 128×64. **Go to Phase 2 if p50 ≤ ~120 ms** (a clear win over 190 ms
plus the Wi-Fi hop). If not, stay on the phone path and consider the CFW `delta` mode as a
separate decision.

### Phase 2: integration (≈5–8 days)

The work lives in **`bridge/remarkable/native/g2/`, a Go package inside the bridge binary**. It is
fed by the **in-process router** (`router/router.go:1-3` already runs on the tablet via `-serve`;
the bridge connects to `ws://127.0.0.1:8577`). It isn't a new surface: it's a local session
client, like the glasses app, so ADR 007 rule 6 (glasses machinery stays out of the router)
holds.

- `g2/transport`: BlueZ D-Bus connect, AcquireWrite/AcquireNotify, per-arm write lock, ack
  waiters, heartbeat, reconnect with backoff, firmware-version gate.
- `g2/proto`: envelope, CRC, protobuf builders (prelude, CREATE, REBUILD, Cmd=3, Cmd=5 text,
  Cmd=12), event decode for R-arm click/scroll.
- `g2/raster`: port `StrokeStore`/`rasterize`/`LoupeCamera` from `apps/even-g2/src/strokes.ts`
  (~300 lines) to Go → Gray4 BMP → LZ4 block (`pierrec/lz4` `CompressBlock`, or port `demos/lz4.ts`).
- `g2/streamer`: latest-wins loupe with window 2, canvas refresh at stroke end, text status line
  following the ADR 006 rules.
- **Mode switch:** `-glasses direct|off`. Direct holds a `codrawer-g2` wake lock and releases it
  after idle. The keeper gets an address allowlist so it never touches the glasses. The phone app
  keeps working as the Wi-Fi client whenever direct is off.
- Mirror it in the Rust port later if the Rust bridge becomes primary.

### Phase 3: optional

Menu/HUD parity on direct mode (R-arm events → the same commands the Even Hub app has). Then a
CFW decision (`delta` mode for full-canvas streaming), which needs its own ADR because of the
warranty and brick risk.

## Open questions the probe answers

1. Stock-firmware ack latency for 128×64 BMP vs LZ4; window 1 vs 2.
2. Does an R-only session render on both lenses, and does L stay quiet?
3. Negotiated ATT MTU, PHY (2M?), and the interval the G2 accepts.
4. Does any GATT access trigger SMP?
5. Firmware version on our pair (LZ4 needs ≥ 2.2.6.10).
6. Does the Even app (backgrounded, Bluetooth on) re-grab an arm the moment the tablet releases it?

## Measured (2026-10-02): the ~200 ms is the glasses, not the phone

Phase 0 run from the desktop (Windows, noble WinRT) with the phone's Bluetooth off; glasses on
stock firmware **2.3.0.24** (L and R). Benchmark: g2flash `demos/video-bench.ts`, `G2_MODE=lz4`
(stock 4bpp BMP + LZ4, CompressMode=2), a 116-frame synthetic handwriting GIF, binarized.

| Path | Size | Per frame | Notes |
| --- | --- | --- | --- |
| Even app (phone), in-app probe `?probe=1` | 192×144 loupe | med 204 ms (min 173, p90 208) | same for 137 B and 1.9 KB PNGs; 500 ms gaps → 190 ms |
| Even app (phone), in-app probe | 288×144 canvas | med ~200 ms | |
| Even app text update | — | **med 60 ms** | |
| Direct BLE, LZ4, window 1 | 192×144 | **197 ms** (5.07 fps), ack avg 188 | ~1 KB/frame |
| Direct BLE, LZ4, window 1 | 128×64 | **174 ms** (5.76 fps), ack avg 167 | |
| Direct BLE, window 2 | any | stalls (no acks, 12 s timeouts) | stock firmware processes one image at a time |

Conclusion: the per-image cost is the glasses' own processing; bypassing the phone saves ~0–15%,
and overlapping is not possible on stock firmware. RAZKOM/g2-kit (DESIGN.md §10) measured the same
independently: ~200 ms fixed per send rising with edges/texture (detailed tiles 500 ms), bytes and
format barely matter, text updates ~60 ms. Our binarized, mostly blank ink frames already sit at the
blank-tile floor. **No-go on a tablet BLE link for speed**; it stays an option for phone-free use.
Windows note: g2-kit's barrel import loads a macOS-only LC3 library (`/opt/homebrew/lib/liblc3.dylib`)
at import time; the bench used a copy without that export.
