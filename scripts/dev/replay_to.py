# Replay strokes into a chosen session URL for N seconds.
import asyncio, json, sys, time, websockets
URL, PATH, SECS = sys.argv[1], sys.argv[2], float(sys.argv[3])
async def main():
    end = time.time() + SECS
    async with websockets.connect(URL, max_size=2**22) as ws:
        prev = None
        for line in open(PATH, encoding="utf-8"):
            if time.time() > end: break
            o = json.loads(line); m = o.get("msg", o); ts = o.get("ts")
            if not str(m.get("t","")).startswith("stroke_"): continue
            if prev is not None and ts is not None:
                await asyncio.sleep(min(0.3, max(0, ts - prev) / 1500))
            prev = ts
            await ws.send(json.dumps(m))
asyncio.run(main())
