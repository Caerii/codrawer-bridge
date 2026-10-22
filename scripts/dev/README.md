# Dev harness scripts (router-side, no hardware needed)

Run with `uv run python scripts/dev/<name>.py …` from the repo root. They talk to the router
over the codrawer WebSocket protocol; the default session is `simtest` so nothing you do here
touches the real tablet/glasses session (`CODRAWER_WS=ws://127.0.0.1:8577/ws/session1` to change).

| Script | Does |
| --- | --- |
| `keysend.py "<text>" [delay]` | types `<text>` into the session as `key` messages the way the tablet keyboard would; `\n` Enter, `\t` Tab, `^k` Ctrl+K, `#Up;` / `#Home;` / `#Del;` named keys. On Git Bash set `MSYS_NO_PATHCONV=1` or a leading `/hw` becomes a Windows path. |
| `termlisten.py <secs>` | prints every `term` message (terminal replies) for N seconds |
| `keytail.py <logfile> <secs>` | persistent key decoder: appends committed and partial lines to a file |
| `deploy-tablet.sh` | builds the bridge and deploys it + boot files to the tablet, restarts, health-checks |
| `replay_to.py <ws-url> <recording.jsonl> <secs>` | streams a recording's strokes into any session, capping idle gaps |
| `typerbench.py [--plan calibrate\|quick] [RUN…]` | typer calibration: a stand-in router on :8590 that the tablet bridge is pointed at (DESKTOP_WS); types a test reply at each speed via `typer_config` + `term` and writes what it sent to `typerbench-expected.txt`. Types into the tablet's focused field: only with the user's go-ahead and a scratch text box. |
| `termdirect.py` | sends one `term_prompt` (edit the text / `attach` field) and prints the reply |
| `inktest.py [--host …] [--allow-doc <title>]` | **on the tablet** (not the harness): native agent ink regression. Reads the automation `state` and `-page-dump`, sends an X in a circle as `ai` strokes through the tablet's router to a free spot on the visible page, waits for `ink: ok` and the save, and checks the saved strokes land on target (PASS/FAIL with the numbers). Refuses unless native agent ink is on and the open notebook is "codrawer: test". Writes one mark into that notebook. |
| `showcase.py` | the README showcase: eight scripted scenes (pens, a simulated agent, `stroke_delete` animation) played into a Rust router on :8580 and recorded from the simulator (:9902) and a headless browser into `docs/media/showcase.{mp4,gif}`; `--preview DIR` renders each scene's page without a router. Run line in its header. |
| `demo_story.py --gif … --mp4 …` | plays and records the README demo (four acts, three participants) in the simulator; see its header |
| `agentd-service.ps1 install/status/restart/update/uninstall` | manages the per-user agentd task from a pinned worktree; see below |

## Managed agentd on Windows

Copy `agentd-config.example.toml` to `~/.codrawer-agentd/config.toml`. Set the tablet address
and the absolute `source` and `checkout` paths. The config parser rejects unknown fields and
wrong types; `term_cwd` and `state_dir` default to the source checkout, preserving the existing
page threads and dock settings. The TOML and token cache stay outside Git.

```powershell
pwsh -File scripts/dev/agentd-service.ps1 validate
pwsh -File scripts/dev/agentd-service.ps1 install
pwsh -File scripts/dev/agentd-service.ps1 status
pwsh -File scripts/dev/agentd-service.ps1 restart
```

`install` creates a detached worktree, installs Python and hand-worker dependencies, and registers
an interactive per-user logon task; it does not start another responder. `restart` refuses while
an Ask is accepted or health is stale. After testing a candidate worktree, `update` stops the
task between Asks, advances the pinned checkout, and restarts it, restoring the previous commit
if the switch fails. `uninstall` removes only the task; it retains checkout, configuration, and
state. `status` reports the Task Scheduler state separately from the OS lock and health snapshot.

Simulator automation (`evenhub-simulator --automation-port 9898 …`):
`curl http://127.0.0.1:9898/api/screenshot/glasses -o shot.png`,
`curl -X POST http://127.0.0.1:9898/api/input -d '{"action":"click"}'`, `curl 'http://127.0.0.1:9898/api/console?since_id=0'`.

## Addresses

The shell scripts (`deploy-tablet.sh`, `qr.sh`, `up.sh`, `tablet-guard.sh`, `engine-bench.sh`,
`make-repair-key.sh`) reach the tablet and this PC through two variables. Their defaults are the
maintainer's LAN, so set both for yours:

```bash
export CODRAWER_TABLET=192.168.1.20   # the tablet's Wi-Fi address (10.11.99.1 over USB)
export CODRAWER_LAN_IP=192.168.1.10   # this PC's LAN address, which the phone loads the app from
```

## Packaging the glasses app for your tablet

`scripts/dev/pack.sh` builds `apps/even-g2/codrawer.ehpk` that starts on your tablet's router
(`CODRAWER_TABLET`) and may also reach this PC's router (`CODRAWER_LAN_IP`). The Even app enforces
a package's network whitelist, so a package only reaches the routers it was built for; the pairing
code is asked for once on the phone and remembered.
