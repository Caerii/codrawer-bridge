# ADR 006 — Latency budget per surface

Status: accepted (2026-09-27, measured) · Owner: SIG platform · Related: `apps/even-g2/README.md`

## Context

Measured on real hardware during the first live loop (Paper Pro → router → phone → G2):

| Path | Cost |
| --- | --- |
| Even Hub image update via the phone | **~200 ms fixed per send** (measured 2026-10-02, `?probe=1`: median 204 ms for a 192×144 loupe whether 137 B or 1.9 KB, 288×144 the same; idle gaps change nothing); rises with edges/texture, not bytes |
| Even Hub text update | **~60 ms** per call (measured 2026-10-02) |
| Page rebuild | ~165 ms flat |
| Direct BLE image (desktop, stock fw 2.3.0.24, LZ4) | **197 ms** at 192×144, **174 ms** at 128×64 (measured 2026-10-02); two in flight stalls |
| Tablet → router stroke batch | ~16 ms batches; LAN / loopback, milliseconds |

The image cost is the glasses' own processing (direct BLE is barely faster than the phone path),
one image at a time. Earlier figures here (~70 ms + 120 ms/KB; direct ~60 ms + 20 ms/KB, 9.5 fps)
were not borne out; see `docs/investigations/direct-ble-tablet.md`. The phone host rejects any
string `imageData`; PNG bytes as a number array is the working encoding (1-bit PNG, `fmt=png1`).

## Decision

- **Live ink on the glasses goes through one container** (the loupe, 192×144 default: size is
  nearly free), latest-wins, drawn just in time when the link frees up. The full canvas refreshes
  after a lull in the writing. Two image sends never overlap (the glasses refuse it).
- **Text never competes with ink.** Status updates are held during a stroke and sent at most
  every 2 s, except while typing (150 ms floor) so the line follows the keys.
- **Budgets:** pen-to-glasses loupe ≤ 250 ms (one ~200 ms send plus the router hop; the old
  ≤ 150/80 ms targets are below what the glasses can do); keystroke-to-glasses ≤ 200 ms; terminal token-to-glasses ≤ 300 ms after coalescing; a page rebuild
  (view switch) ≤ 200 ms and never mid-stroke.
- **Frames are PNG bytes**, binarized, sent as a number array; raw Gray8/Gray4 remain
  available for measurement (`?fmt=`).
- **Direct BLE is not a speed path on stock firmware** (measured above); it remains an option
  for phone-free use. Faster ink needs fewer image sends (text containers at ~60 ms for
  fast-changing readouts), perceived-latency work (prediction), or custom firmware (g2flash
  delta streaming), which we do not use.

## Consequences

- The on-device bench (`?bench=1`) is the regression test for this ADR; numbers that move
  by more than 30% require a note here.
- Any new surface (iPad, web) documents its own numbers in the same table before it is
  considered part of the loop.
