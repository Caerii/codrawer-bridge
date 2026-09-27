import asyncio, json, os, sys, time, websockets
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
URL = os.environ.get("CODRAWER_WS", "ws://127.0.0.1:8577/ws/simtest")
async def main():
    async with websockets.connect(URL) as ws:
        await ws.recv()
        await ws.send(json.dumps({"t": "term_prompt", "text": "Reply with exactly the words: page attach check. No tools.", "attach": "page", "ts": int(time.time()*1000)}))
        end = time.time() + 45
        while time.time() < end:
            try: raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
            except asyncio.TimeoutError: break
            m = json.loads(raw)
            if m.get("t") == "term": print(time.strftime("%H:%M:%S"), m.get("kind"), "|", str(m.get("text"))[:120].replace("\n", " / "))
asyncio.run(main())
