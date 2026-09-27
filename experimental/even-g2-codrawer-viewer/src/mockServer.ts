// Dynamically require the `ws` library.  Avoid importing at the
// top-level so that TypeScript does not attempt to resolve the
// module during compilation when it may not be installed.  At
// runtime this import is required — the mock server will throw if
// `ws` is unavailable.
const WsModule = require("ws");
const WsServer = (WsModule.WebSocketServer as any) ?? WsModule.Server;

/**
 * A small mock implementation of the codrawer-bridge WebSocket API.
 *
 * This script spins up a WebSocket server on a configurable port
 * (`MOCK_PORT`, default 8000) and serves a single `/ws/session1`
 * endpoint.  Whenever a client connects it begins emitting
 * randomised stroke events that approximate a user scribbling on a
 * tablet.  This allows the `main.ts` viewer to be run without
 * requiring a live tablet or codrawer server.
 */
const PORT = parseInt(process.env.MOCK_PORT ?? "8000", 10);
const SESSION_PATH = "/ws/session1";

const server = new WsServer({ port: PORT, path: SESSION_PATH });
console.log(`mockServer listening on ws://localhost:${PORT}${SESSION_PATH}`);

server.on("connection", (ws: any) => {
  console.log("Client connected to mock server");
  simulateClient(ws);
});

/**
 * Emit a series of random strokes to the connected client.  Each
 * stroke is composed of 30–50 points that wander around the canvas.
 * Both user and AI strokes are simulated.  When all strokes are
 * complete the cycle repeats indefinitely.
 */
function simulateClient(ws: WebSocket) {
  let strokeCounter = 0;
  function send(json: any) {
    ws.send(JSON.stringify(json));
  }
  function newStroke(layer: "user" | "ai") {
    const id = `${layer}_mock_${strokeCounter++}`;
    send({ t: layer === "user" ? "stroke_begin" : "ai_stroke_begin", id, layer, brush: "pen" });
    // Choose a random starting point
    let x = Math.random();
    let y = Math.random();
    const points: [number, number, number][] = [];
    const numPoints = 30 + Math.floor(Math.random() * 20);
    for (let i = 0; i < numPoints; i++) {
      // Random walk
      x += (Math.random() - 0.5) * 0.1;
      y += (Math.random() - 0.5) * 0.1;
      // Clamp to [0,1]
      x = Math.max(0, Math.min(1, x));
      y = Math.max(0, Math.min(1, y));
      const pressure = 0.5 + (Math.random() - 0.5) * 0.4;
      points.push([x, y, pressure]);
    }
    // Split into chunks of up to 10 points for streaming
    let idx = 0;
    function sendChunk() {
      const chunk = points.slice(idx, idx + 10);
      if (chunk.length > 0) {
        send({
          t: layer === "user" ? "stroke_pts" : "ai_stroke_pts",
          id,
          pts: chunk,
        });
        idx += chunk.length;
        setTimeout(sendChunk, 50);
      } else {
        send({ t: layer === "user" ? "stroke_end" : "ai_stroke_end", id });
      }
    }
    sendChunk();
  }
  // Emit strokes in sequence forever
  function loop() {
    const layers: ("user" | "ai")[] = ["user", "ai"];
    // Randomise the order of user and AI strokes in each cycle
    for (const layer of layers.sort(() => Math.random() - 0.5)) {
      newStroke(layer);
    }
    // After both strokes have finished start the next cycle
    setTimeout(loop, 3000);
  }
  loop();
}