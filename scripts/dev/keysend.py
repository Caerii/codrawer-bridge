# Type a string into the session as `key` messages (like the tablet bridge would).
import asyncio, json, sys, websockets
import os
URL = os.environ.get("CODRAWER_WS", "ws://127.0.0.1:8577/ws/simtest")
NAMED = {chr(10): "Enter", chr(8): "Backspace", chr(27): "Escape", chr(9): "Tab"}
async def main(text, delay):
    async with websockets.connect(URL) as ws:
        await ws.recv()
        i = 0
        while i < len(text):
            ch = text[i]
            # ^x = Ctrl+x ; #Left/#Right/#Up/#Down/#Home/#End/#Del = named keys
            if ch == "^" and i + 1 < len(text):
                k = text[i + 1]; i += 2
                m = {"t": "key", "key": k, "code": 0, "repeat": False, "mods": {"shift": False, "ctrl": True, "alt": False, "meta": False}}
                await ws.send(json.dumps(m)); await asyncio.sleep(delay); continue
            if ch == "#":
                j = text.find(";", i)
                name = text[i + 1:j]; i = j + 1
                m = {"t": "key", "key": {"Del": "Delete"}.get(name, name), "code": 0, "repeat": False, "mods": {"shift": False, "ctrl": False, "alt": False, "meta": False}}
                await ws.send(json.dumps(m)); await asyncio.sleep(delay); continue
            i += 1
            if ch in NAMED:
                m = {"t": "key", "key": NAMED[ch], "code": 0, "repeat": False, "mods": {"shift": False, "ctrl": False, "alt": False, "meta": False}}
            else:
                m = {"t": "key", "key": ch, "char": ch, "code": 0, "repeat": False, "mods": {"shift": ch.isupper(), "ctrl": False, "alt": False, "meta": False}}
            await ws.send(json.dumps(m)); await asyncio.sleep(delay)
asyncio.run(main(sys.argv[1].encode().decode("unicode_escape"), float(sys.argv[2]) if len(sys.argv) > 2 else 0.06))
