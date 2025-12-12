# reMarkable Paper Pro bridge

This folder contains the **device-side** bridge daemon that reads pen input events and streams stroke messages to the desktop server over WebSocket.

For a step-by-step “connect the device + troubleshoot” guide, see `docs/remarkable_setup.md`.

## Install (on the Paper Pro)

1) Copy the bridge script:

```bash
scp bridge/remarkable/codrawer_bridge.py root@<PAPER_PRO_IP>:/home/root/codrawer_bridge.py
```

2) Install dependencies (simple `pip`, not `uv`):

```bash
scp bridge/remarkable/scripts/install_deps.sh root@<PAPER_PRO_IP>:/home/root/install_deps.sh
ssh root@<PAPER_PRO_IP> sh /home/root/install_deps.sh
```

3) Set the desktop WS URL (edit on device):

- In `/home/root/codrawer_bridge.py`, set `DESKTOP_WS` to:
  - `ws://<DESKTOP_IP>:8000/ws/session1`

4) Run it:

```bash
ssh root@<PAPER_PRO_IP> python /home/root/codrawer_bridge.py
```

Note: **`uv` is for desktop dev**. On the Paper Pro we keep it simple and use `python`/`python3` + `pip --user` (depends on device image).

## systemd (optional)

1) Copy unit:

```bash
scp bridge/remarkable/systemd/codrawer-bridge.service root@<PAPER_PRO_IP>:/etc/systemd/system/codrawer-bridge.service
```

2) Enable:

```bash
scp bridge/remarkable/scripts/enable_service.sh root@<PAPER_PRO_IP>:/home/root/enable_service.sh
ssh root@<PAPER_PRO_IP> sh /home/root/enable_service.sh
```


