# codrawer-bridge — working notes for Claude

Stroke-native co-drawing: a reMarkable Paper Pro streams pen strokes and keystrokes to a
desktop router; clients (Even G2 glasses app, web viewer, iPad) render; agents join the same
session (AI ink, an even-terminal Claude Code session, drawings attached to turns). This is the
hardware half of SIG's GLASS-04 plan (`docs/sig-integration.md`). Decisions live in `docs/adr/`.

## Start here

- `docs/adr/007-surface-composition.md` — how tablet, glasses, desktop and SIG compose (router
  session = composition point; glasses optional; `Caerii/smart_remarkable` owns tablet-native
  render-back).
- `docs/even-g2-testing.md` — device loops, Developer Mode on both devices, firewall, CORS.
- `docs/remarkable_bluetooth.md` — bringing up the Paper Pro's dormant Bluetooth; keyboard pairing traps.
- `apps/even-g2/README.md` — the glasses app: tunables, commands, editor, bench, SDK facts learned.
- `docs/protocol.md` — the wire protocol (canonical).

## Bring the stack up (desktop, Windows / Git Bash)

`scripts/dev/up.sh` does all of this idempotently. By hand:

```bash
# 1. terminal backend (Claude Code sessions live here; token is fixed for the router)
even-terminal start --token sig-glasses --provider claude --cwd C:/Github/tool-codrawer-bridge -p 3456

# 2. router (port 8000 is taken on this machine; 8577 is the convention)
CODRAWER_TERM_URL=http://127.0.0.1:3456 CODRAWER_TERM_TOKEN=sig-glasses \
CODRAWER_TERM_CWD=C:/Github/tool-codrawer-bridge \
CODRAWER_MODEL_SERVER_URL= CODRAWER_AI_AUTO_ENABLED=0 CODRAWER_AGENTIC_ENABLED=0 \
uv run uvicorn codrawer_bridge.server.app:app --host 0.0.0.0 --port 8577

# 3. glasses app (port 5188; 5173 is another project's Vite). HMR host = this PC's LAN IP.
cd apps/even-g2 && VITE_HMR_HOST=192.168.50.2 pnpm dev

# 4. simulator on its OWN session so tests never touch the real one
evenhub-simulator --automation-port 9898 "http://localhost:5188/?ws=ws://localhost:8577/ws/simtest"
```

Phone: Even app → Even Hub tab → developer section (top right; unlocked by signing in at
hub.evenrealities.com with the same account, then force-quitting the app) → Scan QR of
`http://192.168.50.2:5188` (`evenhub qr --url http://192.168.50.2:5188`).

Tablet (`192.168.50.156` on Wi-Fi, `10.11.99.1` on USB, ssh key installed; it sleeps within
~2 minutes and drops SSH — wake it first):

The tablet hosts the stroke router itself (`-serve :8577` in the bridge; the glasses app's packaged
default is `ws://192.168.50.156:8577/ws/session1`); the desktop router is only needed for AI and
`/term` (`CODRAWER_TABLET_UPLINK=1 scripts/dev/up.sh --tablet` points the tablet back at it).
The tablet autosleeps and drops Wi-Fi when idle, so the phone reconnects once you wake it.
Everything codrawer runs on the tablet lives in `/home/root/codrawer` (signed releases under
`releases/`, `current`/`previous` symlinks, `bridge.env`, `release.pub`); the only root-partition
file is the stub `codrawer-boot.service`, which starts `current/boot.sh` at boot (verified across
a cold reboot 2026-10-02). See `docs/investigations/durable-install.md`.

```bash
scripts/dev/deploy-tablet.sh            # build, sign, upload, activate (60 s health check, auto-rollback)
ssh root@192.168.50.156 sh /home/root/codrawer/current/boot.sh doctor     # status
ssh root@192.168.50.156 sh /home/root/codrawer/current/boot.sh rollback   # previous release
ssh root@192.168.50.156 "journalctl -u codrawer-bridge -f"
```

After a reMarkable OS update the stub is gone (only `/home` survives): `scripts/dev/tablet-guard.sh`
re-adds it automatically when running, or run `deploy-tablet.sh`, or a phone shortcut with the key
from `scripts/dev/make-repair-key.sh`. Signing key: `~/.codrawer/release.key` (never commit it).
To ship a release that runs on a new OS version, add its `IMG_VERSION` to `boot/compat.conf`.

## Facts that cost hours (do not rediscover)

- **Pen device is `/dev/input/event2`** (Elan marker). The auto-probe picks `event0`, the power key.
- **Tablet has no `pkill`, BusyBox `head`/`tail` need `-n`, BusyBox `sed` cannot strip ANSI.**
  Kill with `kill $(ps | grep … | awk '{print $1}')` or `killall`.
- **Even app host rejects any string `imageData`** (base64 raw or PNG) with `sendFailed`; PNG **bytes
  as a number array** works. Never call `shutDownPageContainer` automatically — on the device it
  exits the app. Click arrives as a `sysEvent` with **no** `eventType` (protobuf omits 0); scroll
  arrives as a `textEvent` (1 up, 2 down) on the event-capture container.
- **G2 latency is per call, not per byte:** ~104 ms per image send, ~83 ms per text update,
  ~165 ms per rebuild; phone path ≈ 70 ms + 120 ms/KB, direct BLE ≈ 60 ms + 20 ms/KB (ADR 006).
- **even-terminal `/api/prompt` is text-only** (`text`, `sessionId`, `provider`, `cwd`); a bare prompt
  creates a session and returns its id. Drawings reach the model as files it `Read`s (ADR 002).
- **even-terminal ≥ 0.10 will not start without `~/.even-terminal/config.json`** and its setup
  wizard needs a TTY; `config <key> <value>` refuses to create the file. Create it with the
  package's own `createDefaultConfig`/`saveConfig` (bin/config.js), then token/provider. It binds
  127.0.0.1 by default. API used by the router is unchanged (`/api/prompt`, `/api/events?sessionId=`).
- **G2 image updates cost ~200 ms each on stock firmware, phone or direct BLE alike** (one at a
  time; text updates ~60 ms): measured 2026-10-02, ADR 006.
- **Keep asyncio tasks referenced** in the router (`_spawn`); dropped tasks were collected mid-flight.
- **The bridge must select on socket errors, not only after a pen read** (fixed; keep it that way).
- **Git Bash converts `/hw` arguments into `C:/Program Files/Git/hw`**: set `MSYS_NO_PATHCONV=1`
  for the harness scripts. Python heredocs in Bash mangle backslashes — put patch scripts in files.
- **Tablet `/etc` is tmpfs-backed** (overlay on `/var/volatile`): runtime edits vanish on reboot,
  and files written *under* the mounted overlay (rootfs) are not visible until the next boot —
  write both (install.sh does). Reboot over SSH with `systemctl --no-block reboot`: a backgrounded
  `reboot` dies with the session.
  Persist via the rootfs (see `bridge/remarkable/boot/install.sh`) or `/home`. Never load the
  Bluetooth driver while the tablet autosleeps: the chip wedges until reboot (hold a wake lock).
- **Windows Swift-Pairs any keyboard in pairing mode**; turn the PC's Bluetooth off before pairing
  a keyboard to the tablet. The Pebble's address changes per channel.

## Conventions

- **Literate code (Knuth-style), at the quality of rmscene/rmc.** Every module opens with a prose
  overview: the problem it solves, the facts it rests on (cite ADRs, `docs/investigations/*.md`,
  measurements), how data flows. Sections in reading order, why before how; every exported item
  documents intent, invariants and units (normalized page coords, ms, px). No comments that
  restate code; every prose claim must be true of the code. Release builds strip symbols.

- `uv run …` for Python, `pnpm` for Node (never npm), Go 1.22+ for the bridge, Bun for `g2-kit`.
- Router runtime state (`.codrawer-term-sessions.json`, `.codrawer/`) is gitignored.
- Commits: `feat|fix|docs|chore(scope): …`, with the SIG provenance trailers when an agent commits.
- Test without hardware: `scripts/dev/README.md` (keysend / termlisten / replay_to) + the simulator's
  automation API on 9898.

## Where things stand (2026-09-27)

Verified on hardware: tablet → router → glasses ink; keyboard transcript + `/` completion; `/term`
to Claude Code with the turn's ink attached (the agent Reads the PNG + geometry and answers);
replies typed into the tablet's focused text field; `/snap`, `/text`, New drawing. Verified in the
simulator only: the `/edit` document editor and `doc` sharing. Next: smart_remarkable as a
session participant, mic/dictation, a codrawer MCP server for agent ink, direct BLE bench.
