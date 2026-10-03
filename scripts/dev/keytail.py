# Persistent decoder: joins the session, appends decoded key lines to a file, reconnects on drop.
import asyncio, json, sys, time
import websockets
URL = "ws://127.0.0.1:8577/ws/session1"
OUT = sys.argv[1]
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 900
def log(s):
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(time.strftime("%H:%M:%S ") + s + "\n")
async def run():
    end = time.time() + SECS
    line = ""
    while time.time() < end:
        try:
            async with websockets.connect(URL) as ws:
                log("connected")
                while time.time() < end:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=2)
                    except asyncio.TimeoutError:
                        if line:
                            log(f"typing: {line!r}")
                        continue
                    m = json.loads(raw)
                    if m.get("t") != "key":
                        continue
                    k = m.get("key"); ch = m.get("char") or ""
                    if ch:
                        line += ch
                    elif k == "Backspace":
                        line = line[:-1]
                    elif k == "Enter":
                        log(f"LINE: {line!r}"); line = ""
                    else:
                        log(f"key: {k}")
        except Exception as e:
            log(f"reconnecting ({type(e).__name__})")
            await asyncio.sleep(1)
    if line:
        log(f"partial: {line!r}")
asyncio.run(run())
