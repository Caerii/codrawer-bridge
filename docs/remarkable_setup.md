# reMarkable Paper Pro setup (connect + install)

This is the “make it actually work on hardware” checklist.

## 0) Prereqs

- Paper Pro in **Developer Mode**
- Paper Pro and desktop on the **same LAN** (recommended) or you’ve set up routing so the tablet can reach the desktop
- Desktop server running:

```bash
uv sync
uv pip install -e .
uv run uvicorn codrawer_bridge.server.app:app --reload --host 0.0.0.0 --port 8000
```

## 1) Get the Paper Pro IP + SSH in

Find the device IP (from the tablet’s network settings), then:

```bash
ssh root@<PAPER_PRO_IP>
```

If SSH fails:

- Confirm the device is on Wi‑Fi and reachable (`ping <PAPER_PRO_IP>` from desktop).
- Confirm Developer Mode / SSH is enabled.

## 1.5) Strongly recommended: use SSH keys (don’t save passwords)

Do **not** put the device password in `.env` or scripts. Use SSH keys instead.

On Windows (PowerShell), generate a key if you don’t have one:

```powershell
ssh-keygen -t ed25519 -a 64
```

Then install the public key onto the Paper Pro (replace `<PAPER_PRO_IP>`):

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<PAPER_PRO_IP> "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

After that, `ssh root@<PAPER_PRO_IP>` should no longer prompt for a password.

## 2) Make sure the tablet can reach your desktop server

From the Paper Pro (SSH shell), verify the desktop is reachable on port 8000:

```bash
nc -z -w2 <DESKTOP_IP> 8000 && echo ok
```

If this fails:

- Use the **desktop’s LAN IP**, not `localhost` and not a VPN-only IP.
- Allow inbound connections to port **8000** in your desktop firewall.

## 3) Copy the bridge script to the device

From your desktop (repo root):

```bash
scp bridge/remarkable/codrawer_bridge.py root@<PAPER_PRO_IP>:/home/root/codrawer_bridge.py
```

## 4) Install dependencies on the device (pip)

From your desktop:

```bash
scp bridge/remarkable/scripts/install_deps.sh root@<PAPER_PRO_IP>:/home/root/install_deps.sh
ssh root@<PAPER_PRO_IP> sh /home/root/install_deps.sh
```

We intentionally **do not** use `uv` on-device.

## 4.5) If the device has no Python installed

Some Paper Pro images don’t ship a `python`/`python3` binary.

First, identify what package manager you have:

```sh
cat /etc/os-release || true
command -v opkg || true
command -v apt-get || true
command -v apk || true
```

If you have `opkg` (common on reMarkable community setups), you typically install Python via that package manager.
If you don’t have any package manager available, you’ll need to install one (device-specific) or use a prebuilt Python for your image.

Once `python` exists, re-run step 4 to install `websockets`.

## Alternative (recommended): native bridge binary (no Python required)

Your Codex image may not ship Python or any package manager. In that case, the simplest “just works” approach is a single native binary.

### Build the binary (on your desktop)

From repo root, build for Linux ARM64 (most Paper Pro images are `aarch64`):

```bash
cd bridge/remarkable/native
GOOS=linux GOARCH=arm64 go build -o codrawer_bridge_native .
```

### Copy to the device

```bash
scp bridge/remarkable/native/codrawer_bridge_native root@<PAPER_PRO_IP>:/home/root/codrawer_bridge_native
ssh root@<PAPER_PRO_IP> chmod +x /home/root/codrawer_bridge_native
```

### Run it (no service)

```bash
ssh root@<PAPER_PRO_IP> "DESKTOP_WS=ws://<DESKTOP_IP>:8000/ws/session1 NO_GRAB=1 /home/root/codrawer_bridge_native -ws ws://<DESKTOP_IP>:8000/ws/session1"
```

Note on local ink:

- If the bridge **grabs** the input device (EVIOCGRAB), the reMarkable UI won’t also receive pen events (so you won’t see ink locally).
- Default behavior is **NO_GRAB=1** so local ink keeps working while streaming.

### Dev loop: rebuild → kill → upload → swap → run

When iterating on the native bridge, the simplest loop is:

1) **Build on desktop** (Linux/ARM64):

```bash
cd bridge/remarkable/native
GOOS=linux GOARCH=arm64 go build -o codrawer_bridge_native .
```

1) **Stop the running bridge on device** (if any):

```bash
ssh root@<PAPER_PRO_IP> "killall codrawer_bridge_native 2>/dev/null || true; systemctl stop codrawer-bridge 2>/dev/null || true"
```

1) **Upload and atomically swap** (avoids “dest open … Failure” when overwriting):

```bash
scp bridge/remarkable/native/codrawer_bridge_native root@<PAPER_PRO_IP>:/home/root/codrawer_bridge_native.new
ssh root@<PAPER_PRO_IP> "chmod +x /home/root/codrawer_bridge_native.new && mv -f /home/root/codrawer_bridge_native.new /home/root/codrawer_bridge_native"
```

1) **Run** (streaming while keeping local ink):

```bash
ssh root@<PAPER_PRO_IP> "NO_GRAB=1 /home/root/codrawer_bridge_native -ws ws://<DESKTOP_IP>:8000/ws/session1 -touch-mode auto"
```

### Run it as a systemd service (optional)

```bash
scp bridge/remarkable/systemd/codrawer-bridge-native.service root@<PAPER_PRO_IP>:/etc/systemd/system/codrawer-bridge.service
ssh root@<PAPER_PRO_IP> systemctl daemon-reload
ssh root@<PAPER_PRO_IP> systemctl enable codrawer-bridge
ssh root@<PAPER_PRO_IP> systemctl restart codrawer-bridge
ssh root@<PAPER_PRO_IP> journalctl -u codrawer-bridge -f
```

## 5) Configure the server URL

SSH into the device and edit:

- `/home/root/codrawer_bridge.py`
- Set:
  - `DESKTOP_WS = "ws://<DESKTOP_IP>:8000/ws/session1"`

Alternatively (no file edits), run with an env var:

```bash
ssh root@<PAPER_PRO_IP> "DESKTOP_WS=ws://<DESKTOP_IP>:8000/ws/session1 python /home/root/codrawer_bridge.py"
```

## 6) Run the bridge

```bash
ssh root@<PAPER_PRO_IP> python /home/root/codrawer_bridge.py
```

You should see reconnect logs if the network is flaky. When you start drawing, the server should broadcast `stroke_*` events and emit `ai_stroke_*` after `stroke_end`.

## 7) Optional: systemd service

Copy unit + enable:

```bash
scp bridge/remarkable/systemd/codrawer-bridge.service root@<PAPER_PRO_IP>:/etc/systemd/system/codrawer-bridge.service
scp bridge/remarkable/scripts/enable_service.sh root@<PAPER_PRO_IP>:/home/root/enable_service.sh
ssh root@<PAPER_PRO_IP> sh /home/root/enable_service.sh
```

Tail logs:

```bash
ssh root@<PAPER_PRO_IP> journalctl -u codrawer-bridge -f
```

## Troubleshooting

### Bridge can’t read `/dev/input/event*`

- Run as `root` (recommended). The provided instructions assume `root`.

### No strokes show up

- Confirm `DESKTOP_WS` uses the correct desktop IP and session id.
- Confirm your desktop firewall allows inbound TCP 8000.
- Confirm the input device picker found a device (it selects an `evdev` device that supports `ABS_X/ABS_Y`, preferring `ABS_PRESSURE` + `BTN_TOUCH`).
