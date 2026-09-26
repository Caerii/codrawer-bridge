import CodrawerClient from "./codrawerClient";
import { rasteriseStrokes } from "./strokeRasterizer";
import G2Display from "./g2Display";
import EvenHubBridge from "./evenHubBridge";

// Read configuration from environment variables.  These allow the
// script to be customised without altering source code.
const CODRAWER_URL = process.env.CODRAWER_URL ?? "ws://localhost:8000/ws/session1";
const FRAME_WIDTH = parseInt(process.env.FRAME_WIDTH ?? "200", 10);
const FRAME_HEIGHT = parseInt(process.env.FRAME_HEIGHT ?? "100", 10);
const RENDER_INTERVAL_MS = parseInt(process.env.RENDER_INTERVAL_MS ?? "200", 10);

// Display mode controls the cropping strategy.  Supported values:
//   "full"  — render the entire page
//   "follow" — crop around the last cursor position
const MODE = (process.env.MODE as string) ?? "full";

// Highlight layer controls which strokes receive highest contrast.  Supported
// values:
//   "user"   — emphasise user strokes
//   "ai"     — emphasise AI strokes
//   "all"    — balanced rendering of all strokes
const HIGHLIGHT = (process.env.HIGHLIGHT as string) ?? "all";

// How long to keep completed strokes around.  In milliseconds.
const RETENTION_MS = parseInt(process.env.RETENTION_MS ?? "300000", 10); // default 5 minutes

// Whether to use the Even Hub bridge (true) or the local G2Display stub (false).
// When set to "true" the viewer will attempt to initialise a page via the
// Even Hub SDK and will send 4‑bit greyscale frames using
// `updateImageRawData`.  When false the stub writes PNGs to disk.  This
// environment variable allows you to run the same code in both
// environments without modifications.
const USE_EVEN_HUB = process.env.USE_EVEN_HUB === "true";
const MAX_TICKS = parseInt(process.env.MAX_TICKS ?? "0", 10); // 0 = run indefinitely

// Optional output directory for the stub.  When using the Even Hub
// SDK this value is ignored.
const OUTPUT_DIR = process.env.OUTPUT_DIR;

async function main() {
  const client = new CodrawerClient(CODRAWER_URL);
  // Choose between the Even Hub bridge and the local stub.  If
  // USE_EVEN_HUB is true we initialise the page via the bridge and
  // send greyscale frames; otherwise we fall back to the stubbed
  // G2Display which writes PNG files to disk for inspection.
  let display: {
    updateFrame?: (buf: Buffer) => Promise<void>;
    updateImage?: (buf: Buffer, width: number, height: number) => Promise<void>;
    onEvent?: (handler: (eventType: number) => void) => void;
  };
  if (USE_EVEN_HUB) {
    display = new EvenHubBridge(OUTPUT_DIR);
  } else {
    display = new G2Display(OUTPUT_DIR);
  }

  console.log(`Connecting to ${CODRAWER_URL} …`);
  await client.connect();
  console.log(`Connected to codrawer-bridge.`);

  // If using the Even Hub SDK, initialise the page before rendering
  if (USE_EVEN_HUB) {
    await (display as unknown as EvenHubBridge).initPage();
  }

  // Maintain a running flag to allow pausing/resuming via click events
  let running = true;

  // Register an input handler when using the Even Hub.  The real SDK
  // will deliver events such as click, double click and scroll via
  // onEvenHubEvent; here we interpret them as simple toggles for the
  // viewer.  See the Even documentation for the exact numeric values.
  if (USE_EVEN_HUB && display.onEvent) {
    display.onEvent((eventType: number) => {
      // These numeric codes are placeholders.  When integrating with
      // the real SDK replace them with the constants from the
      // @evenrealities/even_hub_sdk (e.g. CLICK_EVENT = 1,
      // DOUBLE_CLICK_EVENT = 2, SCROLL_TOP_EVENT = 3,
      // SCROLL_BOTTOM_EVENT = 4).  Adjust behaviour as desired.
      switch (eventType) {
        case 1: // CLICK_EVENT: toggle running (freeze/unfreeze)
          running = !running;
          console.log(`EvenHub event: click → running=${running}`);
          break;
        case 2: // DOUBLE_CLICK_EVENT: cycle highlight layer
          if (HIGHLIGHT === "user") {
            process.env.HIGHLIGHT = "ai";
          } else if (HIGHLIGHT === "ai") {
            process.env.HIGHLIGHT = "all";
          } else {
            process.env.HIGHLIGHT = "user";
          }
          console.log(`EvenHub event: double click → HIGHLIGHT=${process.env.HIGHLIGHT}`);
          break;
        case 3: // SCROLL_TOP_EVENT: switch to follow mode
          process.env.MODE = "follow";
          console.log(`EvenHub event: scroll top → MODE=follow`);
          break;
        case 4: // SCROLL_BOTTOM_EVENT: switch to full mode
          process.env.MODE = "full";
          console.log(`EvenHub event: scroll bottom → MODE=full`);
          break;
        default:
          console.log(`EvenHub event: unhandled type ${eventType}`);
      }
    });
  }

  // Helper to pause execution for a given number of milliseconds
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Main render loop.  This function runs indefinitely, rasterising
  // strokes and pushing frames to the chosen display.  It awaits
  // completion of each update to avoid concurrent calls into the
  // Even SDK, as required by the documentation.
  let ticks = 0;
  while (true) {
    if (running) {
      try {
        // Remove old strokes to prevent unbounded memory growth
        client.pruneOldStrokes(RETENTION_MS);
        const strokes = client.getStrokes();
        let crop;
        const mode = process.env.MODE ?? MODE;
        const highlight = (process.env.HIGHLIGHT ?? HIGHLIGHT) as any;
        if (mode === "follow") {
          crop = computeFollowCrop(client.getLastCursor());
        }
        const buf = await rasteriseStrokes(strokes, {
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          crop,
          highlightLayer: highlight,
        });
        if (USE_EVEN_HUB && display.updateImage) {
          await display.updateImage(buf, FRAME_WIDTH, FRAME_HEIGHT);
        } else if (display.updateFrame) {
          await display.updateFrame(buf);
        }
      } catch (err) {
        console.error(`Failed to rasterise frame:`, err);
      }
    }
    await delay(RENDER_INTERVAL_MS);
    ticks += 1;
    if (MAX_TICKS > 0 && ticks >= MAX_TICKS) {
      console.log(`Reached MAX_TICKS=${MAX_TICKS}; exiting render loop.`);
      break;
    }
  }
}

/**
 * Compute a crop rectangle around the current cursor.  Returns
 * undefined if there is no active cursor or if the mode is not
 * follow.  The crop window size is fixed; if the cursor is near an
 * edge the window is clamped to remain within [0, 1].
 */
function computeFollowCrop(
  cursor: [number, number, number] | null
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  if (!cursor) return undefined;
  const [x, y] = cursor;
  const windowWidth = 0.25;
  const windowHeight = 0.125;
  let x0 = x - windowWidth / 2;
  let y0 = y - windowHeight / 2;
  let x1 = x + windowWidth / 2;
  let y1 = y + windowHeight / 2;
  // Clamp horizontally
  if (x0 < 0) {
    x1 -= x0;
    x0 = 0;
  }
  if (x1 > 1) {
    x0 -= x1 - 1;
    x1 = 1;
  }
  // Clamp vertically
  if (y0 < 0) {
    y1 -= y0;
    y0 = 0;
  }
  if (y1 > 1) {
    y0 -= y1 - 1;
    y1 = 1;
  }
  // Ensure the window still has a positive area
  x0 = Math.max(0, Math.min(x0, 1));
  y0 = Math.max(0, Math.min(y0, 1));
  x1 = Math.max(0, Math.min(x1, 1));
  y1 = Math.max(0, Math.min(y1, 1));
  return { x0, y0, x1, y1 };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
