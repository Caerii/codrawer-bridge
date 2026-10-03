import asyncio, json, os, sys, time, websockets
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
async def main(secs):
    async with websockets.connect(os.environ.get("CODRAWER_WS", "ws://127.0.0.1:8577/ws/simtest")) as ws:
        end = time.time() + secs
        while time.time() < end:
            try: raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
            except asyncio.TimeoutError: break
            m = json.loads(raw)
            if m.get("t") == "term": print(time.strftime("%H:%M:%S"), m.get("kind"), "|", str(m.get("text"))[:120].replace("\n", " / "))
asyncio.run(main(float(sys.argv[1])))
