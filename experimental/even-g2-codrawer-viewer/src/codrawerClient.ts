import { EventEmitter } from "events";
import type {
  Stroke,
  StrokePoint,
  CodrawerMessage,
  StrokeBeginMessage,
  StrokePtsMessage,
  StrokeEndMessage,
} from "./strokeTypes";

/**
 * A simple WebSocket client for the codrawer-bridge protocol.
 *
 * This class maintains an in-memory map of strokes and surfaces
 * higher-level events when strokes start, receive points or end.  It
 * does not perform any rendering itself — consumers should call
 * `getStrokes()` to retrieve the current set of strokes and pass them
 * into a rasteriser.
 */
export class CodrawerClient extends EventEmitter {
  private ws?: WebSocket;
  private strokes: Map<string, Stroke> = new Map();
  private lastCursor: StrokePoint | null = null;

  constructor(private url: string) {
    super();
  }

  /**
   * Connect to the WebSocket server.  Returns a promise that
   * resolves once the connection is open.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use the native WebSocket if available, otherwise fall back to
      // the `ws` package for Node.js.  This allows the same code to
      // run both in a browser environment and under Node for testing.
      const WSImpl: typeof WebSocket = (typeof WebSocket !== "undefined"
        ? WebSocket
        : require("ws"));
      const socket = new WSImpl(this.url);
      this.ws = socket;

      socket.onopen = () => {
        resolve();
      };
      socket.onerror = (err) => {
        reject(err);
      };
      socket.onmessage = (event: MessageEvent) => {
        try {
          const msg: CodrawerMessage = JSON.parse(
            (event as any).data?.toString?.() ?? event.data
          );
          this.handleMessage(msg);
        } catch (e) {
          console.warn("Failed to parse message", e);
        }
      };
    });
  }

  /**
   * Returns a snapshot of all strokes in their current state.  This
   * shallowly clones the underlying array to protect internal state.
   */
  getStrokes(): Stroke[] {
    return Array.from(this.strokes.values());
  }

  /**
   * Returns the most recent cursor position if one exists.  This is
   * derived from the last point appended to any stroke.  Use this to
   * centre a viewport around the active pen.
   */
  getLastCursor(): StrokePoint | null {
    return this.lastCursor;
  }

  /**
   * Internal dispatcher for protocol messages.  Updates the stroke
   * map and emits events.
   */
  private handleMessage(msg: CodrawerMessage) {
    switch (msg.t) {
      case "stroke_begin":
      case "ai_stroke_begin": {
        const data = msg as StrokeBeginMessage;
        // Remove any stale stroke with the same id
        const stroke: Stroke = {
          id: data.id,
          layer: data.layer,
          brush: data.brush,
          points: [],
          complete: false,
          updatedAt: Date.now(),
        };
        this.strokes.set(stroke.id, stroke);
        this.emit("strokeBegin", stroke);
        break;
      }
      case "stroke_pts":
      case "ai_stroke_pts": {
        const data = msg as StrokePtsMessage;
        const stroke = this.strokes.get(data.id);
        if (!stroke) {
          // If we receive points for an unknown stroke create it on the fly.
          this.strokes.set(data.id, {
            id: data.id,
            layer: msg.t.startsWith("ai") ? "ai" : "user",
            brush: "pen",
            points: data.pts.slice(),
            complete: false,
            updatedAt: Date.now(),
          });
        } else {
          stroke.points.push(...data.pts);
          stroke.updatedAt = Date.now();
        }
        // Update cursor to the last point in this batch
        if (data.pts.length > 0) {
          this.lastCursor = data.pts[data.pts.length - 1];
        }
        this.emit("strokePts", data.id);
        break;
      }
      case "stroke_end":
      case "ai_stroke_end": {
        const data = msg as StrokeEndMessage;
        const stroke = this.strokes.get(data.id);
        if (stroke) {
          stroke.complete = true;
          stroke.updatedAt = Date.now();
          this.emit("strokeEnd", stroke.id);
        }
        break;
      }
    }
  }

  /**
   * Remove completed strokes whose last update occurred longer ago
   * than the given retention period.  In a long-running session
   * codrawer-bridge will accumulate many strokes; pruning prevents
   * the viewer from wasting resources on strokes that are no longer
   * visible or relevant.  Only completed strokes are pruned; if a
   * stroke is still being drawn it will remain until finished.
   *
   * @param retentionMs milliseconds to retain completed strokes
   */
  pruneOldStrokes(retentionMs: number) {
    const now = Date.now();
    for (const [id, stroke] of this.strokes) {
      if (
        stroke.complete &&
        stroke.updatedAt !== undefined &&
        now - stroke.updatedAt > retentionMs
      ) {
        this.strokes.delete(id);
      }
    }
  }
}

export default CodrawerClient;