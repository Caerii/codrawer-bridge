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
| `termdirect.py` | sends one `term_prompt` (edit the text / `attach` field) and prints the reply |

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
