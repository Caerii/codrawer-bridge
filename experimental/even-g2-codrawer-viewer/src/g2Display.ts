import { promises as fs } from "fs";
import { join } from "path";

/**
 * A stub for the Even Realities G2 display API.
 *
 * The real Even Hub environment injects a JavaScript bridge that
 * exposes methods for creating pages, containers and updating image
 * content.  This stub simulates those operations by writing PNG
 * frames to disk and logging input events.  During development this
 * allows us to verify that the rasteriser and WebSocket client are
 * producing sensible output without needing actual hardware.
 */
export class G2Display {
  private frameCounter = 0;
  private outputDir: string;

  constructor(outputDir?: string) {
    // Default to a `mock_output` directory relative to process cwd
    this.outputDir = outputDir ?? join(process.cwd(), "mock_output");
  }

  /**
   * Ensure the output directory exists.  Called lazily.
   */
  private async ensureDir() {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  /**
   * Update the display with a new frame.  The Even SDK would push
   * binary image data to the connected glasses; here we instead write
   * the frame to disk for inspection.  Frames are numbered
   * sequentially.
   */
  async updateFrame(buffer: Buffer): Promise<void> {
    await this.ensureDir();
    const index = this.frameCounter++;
    const filename = `frame-${String(index).padStart(4, "0")}.png`;
    const filepath = join(this.outputDir, filename);
    await fs.writeFile(filepath, buffer);
    console.log(`G2Display: wrote ${filepath}`);
  }

  /**
   * Stub for handling input events from the G2 touchpad.  In a real
   * implementation this method would be hooked into the Even Hub
   * event system and dispatch gestures (tap, swipe) back to the
   * application to change modes, zoom, etc.
   */
  onInput(event: string, handler: (...args: any[]) => void) {
    // No-op in the stub; could store handlers for testing if desired.
  }
}

export default G2Display;