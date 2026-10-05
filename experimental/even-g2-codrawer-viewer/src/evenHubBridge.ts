import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

/**
 * A skeletal implementation of the Even Hub bridge.  This class
 * models the methods your plugin will call on the actual
 * `EvenAppBridge` provided by the `@evenrealities/even_hub_sdk`.
 * In this repository we provide a stubbed version that writes
 * greyscale image data to disk for inspection.  When running on the
 * glasses you would replace these methods with calls into the SDK.
 */
export class EvenHubBridge {
  private outputDir: string;
  private lastUpdate: Promise<void> = Promise.resolve();
  private nextContainerId = 1;
  private textContainerId!: number;
  private imageContainerId!: number;

  constructor(outputDir?: string) {
    this.outputDir = outputDir ?? join(process.cwd(), 'mock_output');
  }

  /**
   * Initialise the page on the glasses.  In a real plugin this would
   * call `createStartUpPageContainer` with a text container (to
   * capture events) and an image container (to display our raster).
   */
  async initPage() {
    await fs.mkdir(this.outputDir, { recursive: true });
    // Assign container IDs.  For the stub we just choose incrementing
    // integers.  In the real SDK you must choose IDs per page.
    this.textContainerId = this.nextContainerId++;
    this.imageContainerId = this.nextContainerId++;
    console.log(
      `EvenHubBridge: initialised page with text container ${this.textContainerId} and image container ${this.imageContainerId}`
    );
    // In the real SDK you would call:
    // await bridge.createStartUpPageContainer(new TextContainerProperty({ ... }))
    // await bridge.createStartUpPageContainer(new ImageContainerProperty({ ... }))
  }

  /**
   * Convert a full‑colour PNG buffer into a 4‑bit greyscale `Uint8Array`.
   * The Even SDK accepts image data as a `number[]`, `Uint8Array`,
   * `ArrayBuffer`, or base64 string with values 0–15 representing 16
   * greyscale levels.  We use `sharp` to decode the PNG and map
   * 8‑bit greyscale values into the 0–15 range.  Each pixel in the
   * resulting array is a single byte containing a value from 0 to 15.
   */
  private async toGreyscale16(pngBuffer: Buffer): Promise<Uint8Array> {
    const { data, info } = await sharp(pngBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const out = new Uint8Array(info.width * info.height);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      out[i] = Math.round((v / 255) * 15);
    }
    return out;
  }

  /**
   * Update the image container with new pixel data.  We queue
   * updates so that concurrent calls do not overlap — the SDK
   * prohibits concurrent `updateImageRawData` calls.  The stub
   * implementation writes the greyscale array to a binary file for
   * inspection; the real implementation would call
   * `bridge.updateImageRawData()` and await its result.
   */
  async updateImage(pngBuffer: Buffer, width: number, height: number) {
    // Chain updates: start after the previous update has finished
    this.lastUpdate = this.lastUpdate.then(async () => {
      const greyscale = await this.toGreyscale16(pngBuffer);
      // In the real SDK you would call something like:
      // await bridge.updateImageRawData(new ImageRawDataUpdate({
      //   containerID: this.imageContainerId,
      //   containerName: 'drawing',
      //   imageData: greyscale,
      //   width,
      //   height,
      // }));
      // For the stub, write the greyscale data to a file
      const filename = `frame-${Date.now()}.raw`; // raw greyscale
      const filepath = join(this.outputDir, filename);
      await fs.writeFile(filepath, greyscale);
      console.log(
        `EvenHubBridge: wrote greyscale image ${width}x${height} to ${filepath}`
      );
    });
    return this.lastUpdate;
  }

  /**
   * Register a callback for events from the glasses.  The real SDK
   * delivers events through `bridge.onEvenHubEvent`.  In the stub we
   * provide a no‑op implementation; tests can call these handlers
   * manually to simulate user input.
   */
  onEvent(handler: (eventType: number) => void) {
    // In the real SDK:
    // const unsubscribe = bridge.onEvenHubEvent(event => {
    //   const textEvent = event.textEvent;
    //   if (!textEvent) return;
    //   handler(textEvent.eventType);
    // });
    // return unsubscribe;
    // Stub: do nothing
  }
}

export default EvenHubBridge;