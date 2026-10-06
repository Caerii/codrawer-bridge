# The hardware film: a plan for later

Status: planned, not shot (2026-10-06). It needs the maintainer with the devices; everything else
can be prepared in the simulator first. The simulator demo (`scripts/dev/demo_story.py`,
`docs/media/demo.gif`) proves the software. This film proves the experience: real ink leaving a
real pen and arriving on glasses, phones, people and agents.

## Why

The simulator demo shows the app driven by a script. What convinces a viewer is a hand on the
Paper Pro, the latency they can see, and an agent that reads a drawing and answers on the tablet.
Every act below shows something that already works on hardware, except where marked *later*.

## Three cuts from one shoot

| Cut | Length | Where | Content |
| --- | --- | --- | --- |
| Hero GIF | about 15 s | README top | writing, then the multiplayer drop, then wide fit |
| Film | about 90 s | link from README, social | the whole story below, scored with the kitforge trap track (re-timed) |
| Feature shorts | 5–10 s each | docs, posts | one capability each: loupe, multiplayer, keyboard, agent, camera, timelapse |

## The film, act by act

1. **The pen.** Close-up of a hand writing on the Paper Pro. Cut to the glasses view: the loupe
   follows the same pen. Glasses footage comes from the phone's Glasses panel, which shows exactly
   what is sent to the lens, or a through-the-lens shot with the phone camera.
2. **The speed.** A millisecond counter overlay from pen-down on the tablet to ink on the glasses,
   using the measured numbers (ADR 006: about 200 ms per image update on the glasses, router fan-out
   in milliseconds). Real measurements only, no stylised claims.
3. **Together.** A second person in a browser and a third on a phone draw on the same page at the
   same time, each in their own colour; the tablet user answers on paper.
4. **The agent.** The user sketches a diagram, types `/term explain this` on the Bluetooth keyboard,
   and Claude Code reads the drawing (ADR 002) and answers. Its reply types itself into the
   tablet's text field through the virtual keyboard (ADR 005). This works today through the
   desktop router (`scripts/dev/up.sh`, `CODRAWER_TABLET_UPLINK=1`).
5. **The world.** The phone camera backdrop: annotating a real whiteboard or a building, with the
   ink floating over the live video.
6. **The payoff.** ⋯ → Export timelapse: the whole session redraws itself in 10 seconds. End card.
7. *Later*, when the XOVI probe passes (`docs/investigations/native-multiplayer-layer.md`): a
   friend's red strokes appear on the reMarkable's own screen, in their own layer. This becomes the
   climax, between acts 3 and 4.
8. *Later*: two tablets in two cities on one page (needs a router reachable over the internet).

## Shot list for the maintainer (about 10 minutes of footage)

- Phone on a tripod above the tablet, even light, no glare: 3 takes of handwriting (a sentence,
  a diagram, a quick sketch).
- Glasses: the phone's Glasses panel screen-recorded during the same takes. Optionally one
  through-the-lens shot.
- Keyboard: one `/term` question and its typed reply landing on the tablet.
- Camera act: 20 s of drawing over a real scene on the phone.
- A second participant drawing from a laptop browser during one take.

## What can be prepared without the devices

- The latency overlay (from router timestamps in a session recording, ⋯ → Record session).
- The agent act rehearsed in the simulator against the desktop router.
- The timelapse ending exported from a recorded session.
- The trap track re-timed to this structure (`C:\Github\kitforge\demos\codrawer_demo.py`).
