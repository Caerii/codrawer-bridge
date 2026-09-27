# ADR 006 — Latency budget per surface

Status: accepted (2026-09-27, measured) · Owner: SIG platform · Related: `apps/even-g2/README.md`

## Context

Measured on real hardware during the first live loop (Paper Pro → router → phone → G2):

| Path | Cost |
| --- | --- |
| Even Hub image update via the phone | ~70 ms + ~120 ms per KB (damage-wm); a 288×144 Gray8 frame measured 200–500 ms |
| Even Hub text update | ~83 ms per call |
| Page rebuild | ~165 ms flat |
| Desktop direct BLE image | ~60 ms + ~20 ms per KB; ~9.5 fps ceiling per container |
| Tablet → router stroke batch | LAN, tens of ms |

Per-call overhead dominates on the glasses; payload size is secondary. The phone host
rejects any string `imageData`; PNG bytes as a number array is the working encoding.

## Decision

- **Live ink on the glasses goes through one small container** (the loupe, 128×64 default),
  latest-wins, throttled to its own measured round trip. The full canvas refreshes once per
  stroke. Two image containers per frame are never pushed.
- **Text never competes with ink.** Status updates are held during a stroke and sent at most
  every 2 s, except while typing (150 ms floor) so the line follows the keys.
- **Budgets:** pen-to-glasses loupe ≤ 150 ms on the phone path, ≤ 80 ms direct; keystroke-to-
  glasses ≤ 200 ms; terminal token-to-glasses ≤ 300 ms after coalescing; a page rebuild
  (view switch) ≤ 200 ms and never mid-stroke.
- **Frames are PNG bytes**, binarized, sent as a number array; raw Gray8/Gray4 remain
  available for measurement (`?fmt=`).
- **Direct BLE (desktop or tablet) is the path to sub-100 ms** and is pursued on stock
  firmware first; custom firmware (g2flash) is the path to full-frame delta streaming.

## Consequences

- The on-device bench (`?bench=1`) is the regression test for this ADR; numbers that move
  by more than 30% require a note here.
- Any new surface (iPad, web) documents its own numbers in the same table before it is
  considered part of the loop.
