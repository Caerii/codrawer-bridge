# hand

A biomechanical, biophysical handwriting simulator for codrawer's AI ink. Personas write text
the way a particular hand would: a sigma-lognormal motor plan (Plamondon's Kinematic Theory)
re-timed toward the two-thirds power law, tracked by a damped shoulder–elbow–wrist–finger arm
with 8–12 Hz physiological tremor, pressure from the movement, and pauses, hesitations and
self-corrections from a cognitive layer. Pure TypeScript, no DOM; it runs in the browser
(apps/hand-lab) and in Node (the CLI). The model, its sources and the measurements:
[docs/investigations/hand-simulator.md](../../docs/investigations/hand-simulator.md).

```ts
import { simulate, sketcher, toProtocol, perform } from 'hand'

const result = simulate([{ text: 'what if', confidence: 0.9 }, { text: 'ink could travel?', confidence: 0.4 }], sketcher, { seed: 7 })
// result.strokes: [{ pts: [[x_mm, y_mm, pressure, t_ms], …], kind, word, down, up }, …]
// result.flights: the pen-ups between them (lift, land, distance)
const messages = toProtocol(result, { origin: [0.1, 0.3], color: '#7c5cff' }) // stroke_* on layer "ai", real ts
await perform(result, { send: (m) => ws.send(JSON.stringify(m)), userActive: () => userIsWriting })
```

Personas (`src/persona.ts`, plain objects; `definePersona` merges overrides onto the defaults):
`archivist`, `sketcher`, `elder`, `mathematician`, `calligrapher`, and `mirror(userStats(strokes))`,
which adapts tempo, size, pressure and lean to the user's recent strokes.

## CLI

```bash
pnpm --filter hand cli "what if ink could travel?" --persona sketcher --ws ws://localhost:8577/ws/handlab
pnpm --filter hand cli "2 + 2 = 4" --persona mathematician --out turn.jsonl   # for scripts/dev/replay_to.py
```

`--ws` streams at the simulated timing and yields while anyone else in the session is drawing.
Options: `--x --y` (where the first baseline starts, normalized), `--scale`, `--width` (mm),
`--confidence`, `--seed`, `--color`, `--lull`.

## Glyphs

`src/glyphs.json` is generated from A. V. Hershey's public-domain single-line fonts and committed:

```bash
pnpm --filter hand glyphs   # uv run --with Hershey-Fonts python scripts/gen_glyphs.py
```

## Tests

`pnpm --filter hand test`: lognormal integration against the analytic velocity, the power-law
exponent at the pen tip (drawn curves and cursive text), the tremor band, determinism per seed,
bounds, monotonic timing, arm stability across its parameter ranges, confidence and corrections,
protocol output and the yielding player.
