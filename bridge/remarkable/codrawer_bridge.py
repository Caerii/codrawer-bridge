#!/usr/bin/env python
from __future__ import annotations

"""
reMarkable Paper Pro bridge daemon.

- Reads /dev/input/event* directly (no evdev dependency)
- Detects pen touch and streams stroke events over WebSocket:
  - stroke_begin
  - stroke_pts (batched)
  - stroke_end

This script is intentionally "dumb": it does not render and does not call models.
"""

import asyncio
import errno
import glob
import json
import os
import struct
import time
import uuid
from dataclasses import dataclass

try:
    import websockets  # type: ignore
except Exception as e:  # pragma: no cover
    raise SystemExit("Missing dependency: websockets. Run scripts/install_deps.sh on device.") from e


DESKTOP_WS = os.getenv("CODRAWER_DESKTOP_WS") or os.getenv("DESKTOP_WS") or "ws://127.0.0.1:8000/ws/session1"
INPUT_DEVICE = os.getenv("CODRAWER_INPUT_DEVICE") or os.getenv("INPUT_DEVICE")  # e.g. /dev/input/event2
BRUSH = "pen"
BATCH_HZ = 60
MAX_BATCH_POINTS = 64
# Default to NOT grabbing so local ink still works while streaming.
# Set CODRAWER_GRAB=1 to grab exclusively (stops local ink).
GRAB_DEVICE = (os.getenv("CODRAWER_GRAB") or "0") in ("1", "true", "True")

# Linux input constants (subset)
EV_KEY = 0x01
EV_ABS = 0x03
BTN_TOUCH = 0x14A
ABS_X = 0x00
ABS_Y = 0x01
ABS_PRESSURE = 0x18


def _now_ms() -> int:
    return int(time.time() * 1000)


def _norm(v: int, vmin: int, vmax: int) -> float:
    if vmax <= vmin:
        return 0.0
    x = (v - vmin) / float(vmax - vmin)
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


@dataclass
class AbsRanges:
    x_min: int
    x_max: int
    y_min: int
    y_max: int
    p_min: int
    p_max: int


def _pick_input_device_path() -> str:
    if INPUT_DEVICE:
        return INPUT_DEVICE

    # Best-effort heuristic: parse /proc/bus/input/devices and pick an event handler
    # whose name looks stylus-ish, otherwise fall back to first /dev/input/event*.
    try:
        text = open("/proc/bus/input/devices", "r", encoding="utf-8", errors="replace").read()
    except Exception:
        text = ""

    best: tuple[int, str] | None = None
    if text:
        blocks = text.split("\n\n")
        for b in blocks:
            name = ""
            handlers: list[str] = []
            for line in b.splitlines():
                if line.startswith("N: Name="):
                    name = line.split("=", 1)[1].strip().strip('"').lower()
                if line.startswith("H: Handlers="):
                    handlers = line.split("=", 1)[1].strip().split()
            event = next((h for h in handlers if h.startswith("event")), None)
            if not event:
                continue
            score = 0
            if any(k in name for k in ("stylus", "pen", "wacom")):
                score += 10
            if "touch" in name:
                score += 2
            path = f"/dev/input/{event}"
            if best is None or score > best[0]:
                best = (score, path)
    if best is not None:
        return best[1]

    candidates = sorted(glob.glob("/dev/input/event*"))
    if not candidates:
        raise RuntimeError("No /dev/input/event* devices found.")
    return candidates[0]


def _ioctl_ioc(dir_: int, type_: int, nr: int, size: int) -> int:
    # Linux ioctl encoding
    IOC_NRBITS = 8
    IOC_TYPEBITS = 8
    IOC_SIZEBITS = 14
    IOC_DIRBITS = 2

    IOC_NRSHIFT = 0
    IOC_TYPESHIFT = IOC_NRSHIFT + IOC_NRBITS
    IOC_SIZESHIFT = IOC_TYPESHIFT + IOC_TYPEBITS
    IOC_DIRSHIFT = IOC_SIZESHIFT + IOC_SIZEBITS

    return (dir_ << IOC_DIRSHIFT) | (type_ << IOC_TYPESHIFT) | (nr << IOC_NRSHIFT) | (size << IOC_SIZESHIFT)


def _ioctl_ior(type_char: str, nr: int, size: int) -> int:
    IOC_READ = 2
    return _ioctl_ioc(IOC_READ, ord(type_char), nr, size)


def _ioctl_iow(type_char: str, nr: int, size: int) -> int:
    IOC_WRITE = 1
    return _ioctl_ioc(IOC_WRITE, ord(type_char), nr, size)


def _evio_grab() -> int:
    # EVIOCGRAB = _IOW('E', 0x90, int)
    return _ioctl_iow("E", 0x90, struct.calcsize("i"))


def _evio_cgabs(abs_code: int) -> int:
    # EVIOCGABS(abs) = _IOR('E', 0x40 + abs, struct input_absinfo)
    # struct input_absinfo: value, min, max, fuzz, flat, resolution (6 ints)
    return _ioctl_ior("E", 0x40 + abs_code, struct.calcsize("6i"))


def _get_abs_ranges(fd: int) -> AbsRanges:
    import fcntl

    def read_abs(code: int) -> tuple[int, int]:
        buf = bytearray(struct.calcsize("6i"))
        fcntl.ioctl(fd, _evio_cgabs(code), buf, True)
        _value, mn, mx, _fuzz, _flat, _res = struct.unpack("6i", buf)
        return int(mn), int(mx)

    x_min, x_max = read_abs(ABS_X)
    y_min, y_max = read_abs(ABS_Y)
    try:
        p_min, p_max = read_abs(ABS_PRESSURE)
    except Exception:
        p_min, p_max = 0, 4096
    return AbsRanges(x_min, x_max, y_min, y_max, p_min, p_max)


def _read_event_format(fd: int) -> tuple[str, int]:
    # 64-bit: timeval = 2x 8-byte longs -> 16, plus H H i -> 24 bytes
    # 32-bit: timeval = 2x 4-byte longs -> 8, plus H H i -> 16 bytes
    fmt64 = "qqHHi"
    fmt32 = "llHHi"
    size64 = struct.calcsize(fmt64)
    size32 = struct.calcsize(fmt32)

    # Heuristic: try reading one packet with the larger size first (non-blocking safe)
    try:
        data = os.read(fd, size64)
        if len(data) == size64:
            return fmt64, size64
        if len(data) == size32:
            return fmt32, size32
    except OSError:
        pass
    return fmt64, size64


def _event_reader(path: str, out_q: "asyncio.Queue[tuple[int,int,int]]") -> None:
    """
    Blocking reader in a thread: pushes (type, code, value) to out_q.
    """
    import fcntl

    fd = os.open(path, os.O_RDONLY)
    try:
        if GRAB_DEVICE:
            try:
                fcntl.ioctl(fd, _evio_grab(), struct.pack("i", 1))
            except Exception:
                pass

        # Make non-blocking so thread can exit cleanly if needed
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

        fmt, size = _read_event_format(fd)
        buf = b""
        while True:
            try:
                chunk = os.read(fd, 4096)
                if not chunk:
                    time.sleep(0.01)
                    continue
                buf += chunk
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    time.sleep(0.001)
                    continue
                raise

            while len(buf) >= size:
                pkt, buf = buf[:size], buf[size:]
                _sec, _usec, etype, ecode, evalue = struct.unpack(fmt, pkt)
                try:
                    out_q.put_nowait((int(etype), int(ecode), int(evalue)))
                except Exception:
                    pass
    finally:
        try:
            os.close(fd)
        except Exception:
            pass


async def _run_once(ws_url: str) -> None:
    path = _pick_input_device_path()
    fd = os.open(path, os.O_RDONLY)
    try:
        rng = _get_abs_ranges(fd)
    finally:
        os.close(fd)

    x_raw: int | None = None
    y_raw: int | None = None
    p_raw: int | None = None
    touching = False
    stroke_id: str | None = None
    batch: list[list[float]] = []
    last_flush = time.perf_counter()
    flush_dt = 1.0 / float(BATCH_HZ)

    async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20, max_size=2**22) as ws:
        q: asyncio.Queue[tuple[int, int, int]] = asyncio.Queue(maxsize=4096)
        asyncio.get_running_loop().run_in_executor(None, _event_reader, path, q)

        while True:
            etype, ecode, evalue = await q.get()

            if etype == EV_ABS:
                if ecode == ABS_X:
                    x_raw = int(evalue)
                elif ecode == ABS_Y:
                    y_raw = int(evalue)
                elif ecode == ABS_PRESSURE:
                    p_raw = int(evalue)

            elif etype == EV_KEY and ecode == BTN_TOUCH:
                is_down = bool(evalue)
                if is_down and not touching:
                    touching = True
                    stroke_id = f"u_{uuid.uuid4().hex[:10]}"
                    await ws.send(
                        json.dumps(
                            {"t": "stroke_begin", "id": stroke_id, "layer": "user", "brush": BRUSH, "ts": _now_ms()},
                            separators=(",", ":"),
                        )
                    )
                    batch.clear()
                elif (not is_down) and touching:
                    touching = False
                    if stroke_id is not None and batch:
                        await ws.send(json.dumps({"t": "stroke_pts", "id": stroke_id, "pts": batch}, separators=(",", ":")))
                        batch.clear()
                    if stroke_id is not None:
                        await ws.send(json.dumps({"t": "stroke_end", "id": stroke_id, "ts": _now_ms()}, separators=(",", ":")))
                    stroke_id = None

            # accumulate points when touching and we have x/y
            if touching and stroke_id and (x_raw is not None) and (y_raw is not None):
                p = p_raw if p_raw is not None else rng.p_min
                x = _norm(x_raw, rng.x_min, rng.x_max)
                y = _norm(y_raw, rng.y_min, rng.y_max)
                pr = _norm(p, rng.p_min, rng.p_max)
                batch.append([x, y, pr, float(_now_ms())])

            # flush on schedule or if batch gets big
            now = time.perf_counter()
            if stroke_id and batch and (len(batch) >= MAX_BATCH_POINTS or (now - last_flush) >= flush_dt):
                await ws.send(json.dumps({"t": "stroke_pts", "id": stroke_id, "pts": batch}, separators=(",", ":")))
                batch.clear()
                last_flush = now


async def main() -> None:
    ws_url = DESKTOP_WS
    while True:
        try:
            await _run_once(ws_url)
        except Exception as e:
            # best-effort reconnect loop (device and WiFi can be flaky)
            print(f"[bridge] error: {e!r}; reconnecting in 1s")
            await asyncio.sleep(1.0)


if __name__ == "__main__":
    asyncio.run(main())


