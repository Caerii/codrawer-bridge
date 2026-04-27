import asyncio
import websockets
import json

async def test_ws():
    uri = "ws://localhost:8577/ws/test"
    async with websockets.connect(uri) as websocket:
        print(f"Connected to {uri}")
        
        # Wait for hello
        greeting = await websocket.recv()
        print(f"Received: {greeting}")
        
        # Send a test stroke begin
        msg = {
            "t": "stroke_begin",
            "id": "test_stroke_1",
            "ts": 123456789
        }
        await websocket.send(json.dumps(msg))
        print(f"Sent: {msg}")
        
        # Receive broadcast (if any)
        # Note: the server broadcasts to OTHER clients, so we might not see our own
        # unless we have two connections.
        
        print("Test complete.")

if __name__ == "__main__":
    try:
        asyncio.run(test_ws())
    except Exception as e:
        print(f"Error: {e}")
