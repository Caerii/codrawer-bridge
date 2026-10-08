# reMarkable 2 setup

See [shared model support](tablet-models.md) for the architecture and settings.
This implementation starts from dev commit 42181ad. The tested tablet is
an ARMv7 reMarkable 2 running firmware 3.28.0.172. Other firmware versions require
separate XOVI validation; this does not claim general firmware compatibility.

## Verified hardware work

- Live Wacom input uses `/dev/input/event1`, swaps axes, and inverts the resulting Y
  axis. A handwritten L rendered upright; the user confirmed live ink on Even G2.
- Saved notebook pages stream at their native 1404 × 1872 page dimensions.
- XOVI follows the selected toolbar tool, including eraser. Detailed eraser size,
  zoom, pan, landscape orientation and long-session behavior still need testing.
- The native ARM32 `Line` layout is 72 bytes. Native ink was inserted successfully
  into a dedicated test layer and then into `codrawer: agent`, with zero misfiled
  commits reported by the extension.
- An Anthropic API request for selected handwriting returned an answer and wrote
  it onto the open notebook. This first full test used the Mac-hosted agent.

## Initial bridge deployment

With Go 1.22+ and SSH key access:

```sh
CODRAWER_TABLET=<tablet-ip> scripts/dev/deploy-rm2.sh
```

`CODRAWER_GO` can specify the Go executable. This builds the static ARMv7 bridge
and starts a transient service. It preserves `/home/root/codrawer-rm2.env`, which
contains the pairing code. The standalone services below replace the transient
unit with a persistent one.

## Standalone tablet runtime

`scripts/rm2/` packages Python 3.11, Node 22, Debian's ARM Pillow library, a bundled
handwriting worker, the Python agent source, and the production G2 web app. These
live under `/home/root/codrawer-agent`; their loader and shared libraries are
private and do not replace tablet system libraries. No source compilation or
package manager is needed on the tablet. Docker with ARMv7 emulation, Node, Python
and installed workspace dependencies are needed on the build computer.

```sh
scripts/rm2/package.sh
```

The output `.codrawer/rm2-build/agent.tar.gz` contains no API keys, local request
logs or notebook files. Unpack it under `/home/root/codrawer-agent`, copy the
service files and installer from `scripts/rm2/` to the tablet, then run
`install-services.sh` there. The installer checks runtime imports before starting
services and preserves existing persistent unit files once as `.before-install`.

Prerequisites from the firmware-specific native integration setup:

- `/home/root/codrawer_bridge_rm2` and `/home/root/codrawer-rm2.env`.
- Valid `ANTHROPIC_API_KEY` in `/home/root/.smart_remarkable.systemd.env` (mode 600).
- Tested guarded XOVI payload under `/home/root/rm2-xovi`, including `xovi.sh`,
  `xovi-compat.conf`, loader, extension, and all four QML/injection configuration
  files in its `xovi/` subdirectory. The OS compatibility file must contain the
  tested firmware only. Never overwrite a currently mapped extension in place.
- `INK_SOCKET=/run/codrawer/ink.sock`, `NATIVE_AGENT_INK=1`,
  `TOOL_FILE=/run/codrawer/tool`, `PAGE_WATCH=on` in the bridge environment.

The services are:

| Unit | Job |
| --- | --- |
| `codrawer-rm2` | Pen, page snapshots and WebSocket router on port 8577 |
| `codrawer-agent` | Local page rendering, Anthropic calls and handwriting |
| `codrawer-web` | Production G2 web app on port 5188 |
| `codrawer-rm2-xovi` | Firmware-gated notebook integration with startup crash guard |

The AI connects to `127.0.0.1` on the tablet. Its API key is loaded by systemd from
the existing protected file, not passed in command-line arguments. Stop the old
Mac agent before enabling the tablet agent, to prevent duplicate answers.

The agent uses the Messages API's documented SSE stream through HTTPX, avoiding
SDK dependencies that require Rust compilation on ARMv7. It rejects HTTP errors,
stream errors and incomplete responses. Handwriting receives accumulated answer
text, matching the other backends' streaming contract.

## G2 pairing without the Mac

Scan a QR containing this URL in Even Hub's developer/Prototype Mode:

```text
http://<tablet-ip>:5188/?ws=ws://<tablet-ip>:8577/ws/session1&view=canvas&ai=1&token=<ROUTER_TOKEN>
```

`ai=1` enables the AI ink layer and AI HUD text; the upstream default hides both.
Both servers now use the tablet address. The old QR containing the computer's
address still depends on the computer; scan the new one. The phone and tablet
must be reachable on the same network. The tablet needs internet for Anthropic.

## Operation and recovery

```sh
systemctl status codrawer-rm2 codrawer-agent codrawer-web codrawer-rm2-xovi
journalctl -u codrawer-agent -n 30 --no-pager
systemctl restart codrawer-agent
```

For stock notebook behavior, run `/bin/sh /home/root/rm2-xovi/xovi.sh off`.
To stop the AI only, run `systemctl stop codrawer-agent`; to keep it stopped after
reboot, run `systemctl disable codrawer-agent`. Logs and rendered request images
stay in `/home/root/codrawer-agent/state` and may contain notebook content.

Tablet sleep drops Wi-Fi; clients reconnect on wake. This setup does not keep the
tablet permanently awake. Rootfs service files may be removed by a firmware
update. Revalidate firmware support before re-enabling XOVI after an update.
Native document navigation (`openPage`) remains incompatible with this firmware;
this setup does not enable or claim that feature. Notebook templates/backgrounds
are not part of the stroke stream.

## Standalone validation (2026-10-08)

On the tested tablet, Python/Pillow/TLS/WebSocket imports and the bundled Node
worker run successfully. All four services are active and enabled. With no Mac
agent or Vite process running, a request sent through the tablet's localhost
router completed with `agent_status: done, ok: true`; native answer strokes were
committed to `codrawer: agent`. The G2 app returned HTTP 200 from the tablet's
port 5188. Initial handwriting-worker warmup took about 9 seconds. Physical G2
pairing with the replacement tablet-hosted QR and a full cold reboot still need
user/hardware confirmation; startup configuration alone does not prove a reboot.

Backend tests: 39 passed, including authenticated request construction, cumulative
text streaming, ignored non-text events, HTTP errors, interrupted streams, page
rendering and answer placement. The math prompt and selected model are unchanged.

## Handwriting geometry calibration

`codrawer-agent.service` sets `CODRAWER_TABLET_MODEL=rm2`. The rM2 profile uses
1404 × 1872 page units at the manufacturer's nominal 226 PPI (about 157.795 ×
210.393 mm). `geometry.py` supplies one shared conversion to placement, line
spacing, baseline offsets and transmitted handwriting. Other installations retain
the legacy Paper Pro profile unless explicitly configured. Geometry regression
tests check that a 20 mm block reserves and draws the same size and starts at the
requested position on both models.

A physical calibration check uses a 20 mm square at normal tablet zoom. Measure
both sides with a ruler; screen zoom or pan must not be mistaken for incorrect
physical scale. Text size, wrap width and line spacing are separate preferences.

## Agent-layer deletion sync

The native extension follows the visible scene controller's layer-count changes
(and checks again on its discovery tick). When `codrawer: agent` disappears on the
same page, it emits `dock_action/agent_layer_deleted`. The router clears AI live
strokes and its cached AI snapshot immediately, preserves user/peer ink, and
suppresses pre-deletion snapshots so reconnecting glasses do not resurrect it.
The agent cancels pending answers on that page. New saves, including an undo or a
new answer, are still accepted. Page switches and unreadable/loading layer lists
are not treated as deletion. The native removal event was observed reaching the
bridge on hardware; physical glasses disappearance timing needs confirmation.
