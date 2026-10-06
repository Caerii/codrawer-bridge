# Keyboard latency, tablet to glasses (2026-10-06)

How long a keystroke on the Pebble K380s (bonded to the Paper Pro) takes to show on the G2's
status strip, hop by hop, before and after the changes of 2026-10-06. Harness:
`scripts/dev/keylat.py` (its header explains what each hop's two timestamps are and how the
tablet's clock is aligned), plus the app's per-key tracer `apps/even-g2/src/keylat.ts`.

## The path and where each hop is measured

```
K380s ─BLE─▶ controller ─▶ kernel evdev ─▶ bridge keyboard reader ─▶ `key` (ts) ─▶ router (on the tablet)
      ─Wi-Fi─▶ phone app: link → hud/keyboard.ts → text pacing (glasses/text.ts) → host call ─▶ G2
```

| Hop | How it is measured |
| --- | --- |
| BLE | not timestampable; bounded by the LE connection interval (read from BlueZ's stored parameters and btmon) |
| kernel → bridge | not observable: the bridge stamps `ts` when its blocking read returns, within a wakeup of the kernel's event |
| router + Wi-Fi | `keylat.py relay`: two clients on the PC, one key through the tablet's router to the other, half the trip |
| app wait | app receive → the text update carrying the key starts (performance.now, keylat.ts) |
| glasses | that update's start → the host's answer |

The app hops were measured in the simulator on a local Rust router (`-router-only -serve :8582`),
with `?simtext=70` holding every text update 70 ms (the G2's measured text cost, ADR 006; the
simulator's own is ~4 ms), 200 keys per run injected by `keylat.py inject` at fixed gaps. The
user was not typing during the work, so no real-typing tap (`keylat.py tap`) was collected.

## Results (ms, median / p95)

| Hop | Before | After |
| --- | --- | --- |
| BLE (interval 25 ms, peripheral latency 20; btmon) | ~12 / 25 (mean / max wait for a connection event) | same; ~4–8 / 15 with `KEYBOARD_FAST_LINK=1` |
| kernel → bridge | < 1 | < 1 |
| router + Wi-Fi (tablet router → LAN client) | 16 / 51 | 16 / 51 (unchanged) |
| app wait, keys 150 ms apart | 77 / 171 | 0 / 0 |
| app wait, keys 80 ms apart | 90 / 184 | 0 / 0 |
| app wait, keys 40 ms apart (faster than the link) | 92 / 187 | 42 / 76 |
| glasses text update (simulated G2 cost) | 76–78 / 83–91 | 77 / 84–87 |
| **app total, 150 ms apart** | **155 / 253** | **77 / 87** |
| **app total, 80 ms apart** | **167 / 258** | **77 / 88** |
| **app total, 40 ms apart** | **170 / 268** | **120 / 154** |
| key → glasses, end to end (sum of medians, 80 ms apart) | ~195 | ~105 |

Before, a key waited for the next 50 ms render tick and then for the 150 ms typing floor; the
floor, not the link, set the pace. After, the key handler offers the text itself and the only
wait is a call already on the wire: one update in flight, always the newest text, so at normal
typing speed (keys further apart than one ~70–80 ms update) every key goes at once, and in a
fast burst the keys typed during an update share the next one.

## Keyboard reconnect

- While the radio is up, the **kernel** reconnects the keyboard: btmon shows a continuous
  passive background scan (LE 1M, 30 ms window every 60 ms, accept-all filter), i.e. BlueZ has
  the bonded HID device on the kernel's auto-connect list; a keypress makes the K380s advertise
  and the controller connects. The keeper's `bluetoothctl connect` attempts (every ~72 s while the
  keyboard sleeps: a 15 s client timeout, BlueZ keeps paging ~40 s at 100 % scan duty, then the
  32 s back-off) were never on that path.
- The tablet's **suspend** powers Bluetooth off (`sleep-wifi.sh`); on resume the chip reloads
  its firmware and hci0 is back ~5 s after wake (03:40:43 wake → 03:40:48.9 MGMT up). The old
  keeper could be mid-sleep for up to 32 s then. The event-driven keeper sweeps on the adapter's
  `Powered → true` signal instead.
- From the journal, the keyboard's kernel input node appearing → the bridge opening it took
  0.3, 0.6, 2.9 and 4.2 s on the four natural reconnects of 2026-10-05/06: the bridge rescanned
  /proc every 5 s. The idle-CPU work of the same day made both engines wait on inotify for
  /dev/input instead, which removes that wait.
- Radio up → keyboard connected was 18.3 s (boot) and 24.7 s (resume) in the two cases on
  record; whether the user pressed a key earlier is not known, so these are upper bounds, not a
  wake-to-type measurement. A wake-to-`[keyboard] using input device` measurement needs a natural
  keypress after the keyboard slept; the keeper now logs every Connected/Powered change
  (`journalctl -u codrawer-bluetooth`), so the next one is in the journal.

## BLE connection parameters

`/var/lib/bluetooth/<adapter>/DC:D8:86:44:8B:E9/info` (on /home, so it survives updates) holds
what the K380s asked for and BlueZ loads into the kernel at power-on:

```
[ConnectionParameters]
MinInterval=16   # 20 ms
MaxInterval=20   # 25 ms
Latency=20       # may skip 20 events while idle (≈0.5 s)
Timeout=210      # 2.1 s supervision timeout
```

and btmon on two reconnects saw `LE Enhanced Connection Complete`: interval 25.00 ms, latency
20, supervision timeout 2100 ms. That is what a key report waits for: up to 25 ms, ~12 ms on
average.

debugfs is not available on this kernel (no `debugfs` in /proc/filesystems), so the kernel-wide
`conn_min_interval` knobs cannot be changed, and `btmgmt` is not installed. `hcitool lecup`
(HCI LE Connection Update, sent by the central) is: `KEYBOARD_FAST_LINK=1` in bridge.env makes the
keeper request interval 7.5–15 ms, latency 30, timeout 2.1 s on every connect. A key report
waits for the next connection event, so the mean radio wait drops from ~12 ms to ~4–8 ms (max 25
→ 15). Its effect on the controller was not exercised on the device (the keyboard slept
throughout), only in keeper_test.sh. With latency 30 an idle keyboard still wakes its radio about every 0.47 s (vs ~0.5 s now);
while typing it exchanges up to 3× more packets, so battery life drops somewhat. Default off: the
saving (~5 ms) is small next to the app's, and the keyboard may renegotiate its own parameters.

## Typer (replies into the tablet)

Both engines plan a reply as bursts (typer.rs, typer.go), at a speed chosen at runtime with
`typer_config` (docs/protocol.md): `careful` (one keystroke per write, 12 ms after each: ~4.8 s for
400 characters), `fast` (a word and its separator, ≤ 16 keystrokes, per `write()`: ~0.9 s) and
`instant` (bursts of up to 10 keystrokes 40 ms apart, never past an Enter: ~1.6 s). Every keystroke
keeps its own SYN frames, so the event stream is the same at every speed. `instant`'s numbers are
guesses until calibrated. The burst cap comes from an unverified reading of the kernel: evdev sizes
each reader's buffer for a keyboard like the bridge's at 64 events, and a keystroke is 4 events
(6 with Shift).

**Baseline, 2026-10-06** (the 2b84fa9 release, `careful`, one run into a scratch text box, sent
through a stand-in router as a `term` reply and read back from the saved `.rm` with rmscene):

- Sent `\n--- careful ---\nThe quick brown fox … 0123456789.\nTHE QUICK BROWN FOX … DOG! @#$%^&*()-_=+[]{};:'",.<>/?|`~ end-careful\n`.
- Arrived `-he quick brown fox … 0123456789.` / `THE QUICK BROWN FOX … DOG! @#$%&*()-_=+;:'",.<>/?| end-careful`.
- ``^ [ ] { } ` ~`` never arrive. xochitl's US Type Folio table has no key for them, and five of
  the PC keys are dead keys there (keyboard-and-text.md § 2.1). The typer now presses keys from
  xochitl's own table for the tablet's keyboard language and never a dead key. It leaves out what
  the table cannot type (or substitutes, `TYPE_SUBSTITUTE=1`) and reports it in a `typer_note`.
- The leading `--- careful ---`, its Enter and the `T` after it were lost except one `-`. The
  most likely cause is xochitl's guard against accidental typing: it ignores keys while the pen
  is close or a touch is down (keyboard-and-text.md § 2.2). An autoformat on a leading `--` is
  ruled out by the binary's rule, which needs a single `-` and a space. The typer now waits until
  the pen is out of range and the screen untouched for 300 ms, presses End to re-enter text mode
  after pen activity or a pause, and settles 150 ms after each Enter.
- Everything else arrived complete and in order.

**Calibration** (`scripts/dev/typerbench.py`, with the user's go-ahead and a scratch text box
focused): a stand-in router the bridge is pointed at for the duration. Its `calibrate` plan types
`enter0` (a leading Enter, no settle), `enter150` (with the settle), `dash` (a line opening with
`--` and no Enter: A against B), then `fast` and `instant` at 40, 20, 10 and 5 ms per 10-key burst
and 10 ms per 16-key burst. `instant` should become the fastest run with no dropped or reordered
characters, with margin: the next slower step.
