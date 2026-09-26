# Even G2 Codrawer Viewer

This project contains a reference implementation of a **CoDrawer Viewer** for the
Even Realities G2 heads‑up display.  The code is designed to act as a thin
client for the [codrawer‑bridge](https://github.com/Caerii/codrawer-bridge) server:

- **codrawerClient.ts** implements a small protocol client that connects to the
  bridge over WebSockets, maintains a normalised stroke model and emits
  higher‑level events when strokes start, update and complete.
- **strokeRasterizer.ts** provides utilities for turning the normalised stroke
  representation into a raster image.  It uses the [`skia-canvas`](https://www.npmjs.com/package/skia-canvas)
  library, which is already available in this repository, to draw green ink on
  a dark background and supports cropping around the current cursor or
  rendering the entire page at reduced resolution.
- **g2Display.ts** is a stub implementation of the Even G2 display API.  The
  real Even SDK exposes a JavaScript bridge inside a WebView; here we provide
  an abstraction layer so that the rest of the code can be developed and
  exercised without actual hardware.  During development the stub simply
  writes images to disk and logs events to the console.
- **main.ts** wires everything together: it connects to a `codrawer-bridge`
  session, listens for strokes, rasterises them every few hundred
  milliseconds, and forwards the resulting frames to the G2 display stub.

The intent of this structure is to support rapid iteration and testing.  You
can run `node src/main.ts` with a live `codrawer-bridge` server on the same
network to see your ink appear in the generated preview images.  A mock
server and some example tests live in `src/mockServer.ts`; these can be
executed with `npm test`.

> **Note:** This code is meant as a starting point for a real Even Hub
>  plugin.  The `g2Display.ts` module contains stub methods that will need
>  to be replaced with calls into the Even Realities JavaScript bridge once
>  the application is packaged as a plugin and run inside the Even Hub
>  environment.

## Installation

This package does not declare any new dependencies beyond what is already
available in the root of this repository.  It relies on `skia-canvas` for
drawing; this library is present under `node_modules`.  If you copy these
files into a new project you should add it to your `package.json`.


The project can be installed with either `npm` or `pnpm`.  We
recommend using [`pnpm`](https://pnpm.io/) because it installs
dependencies efficiently and produces a repeatable lockfile.

```bash
# using pnpm
pnpm install

# or if you prefer npm
npm install
```

The provided `package.json` defines a `build` script that compiles the
TypeScript sources into JavaScript using the TypeScript compiler and a
`start` script that runs the transpiled `dist/main.js` with Node.js.
If you are using pnpm, you can run these scripts via `pnpm run build`
and `pnpm run start`.  All of the usual `npm` commands (install, run,
test) work with pnpm without modification.

## Running the mock

To exercise the viewer without connecting to an actual tablet or the G2
hardware run:

```bash
pnpm install
pnpm test
```

The test script starts a mock codrawer server that emits a handful of
randomised strokes.  As the strokes stream in the viewer rasterises them and
writes PNG frames into the `mock_output` directory.  Inspect these files to
verify that the rasterisation logic behaves as expected.  When you are
satisfied with the behaviour replace the stub implementation in
`g2Display.ts` with calls into the Even Hub SDK.

### Environment variables

Several environment variables allow you to customise the viewer without
editing code:

| Variable              | Default                        | Description                                                                         |
|-----------------------|--------------------------------|-------------------------------------------------------------------------------------|
| `CODRAWER_URL`        | `ws://localhost:8000/ws/session1` | The WebSocket URL of your codrawer-bridge session                                    |
| `FRAME_WIDTH`         | `200`                          | Width of the generated image in pixels (20–200 suggested for G2)                     |
| `FRAME_HEIGHT`        | `100`                          | Height of the generated image in pixels (20–100 suggested for G2)                    |
| `RENDER_INTERVAL_MS`  | `200`                          | How often to re-render the frame, in milliseconds                                    |
| `MODE`                | `full`                         | Cropping mode: `full` renders the whole page; `follow` crops around the stylus       |
| `HIGHLIGHT`           | `all`                          | Layer emphasis: `user` brightens user strokes, `ai` brightens AI strokes, `all` balances both |
| `RETENTION_MS`        | `300000` (5 minutes)           | Milliseconds to keep completed strokes before pruning them from memory |
| `USE_EVEN_HUB`        | unset/false                    | When `true` the viewer uses the Even Hub bridge to send 4‑bit greyscale frames via the SDK; when unset or `false` it writes PNG files via the stub |
| `OUTPUT_DIR`          | `mock_output`                  | Directory where PNG or raw greyscale frames are written when running locally |

For example, to run the viewer in follow mode emphasising your own ink, use:

```bash
pnpm start --filter even-g2-codrawer-viewer -- \
  MODE=follow HIGHLIGHT=user FRAME_WIDTH=200 FRAME_HEIGHT=100
```

### Using the Even Hub bridge

By default the viewer writes PNG frames to disk via the `g2Display.ts` stub.
When you are ready to test against the actual Even Realities G2 hardware or
simulator you can opt into the Even Hub integration by setting the
`USE_EVEN_HUB` environment variable to `true`.  In this mode the code
creates a page and image container on the glasses via the Even Hub SDK and
sends 4‑bit greyscale frames using `updateImageRawData`.  The stub
implementation provided in `src/evenHubBridge.ts` demonstrates how to
convert PNG images into greyscale and queue updates so that calls do not
overlap (the SDK prohibits concurrent image updates【812841837835490†L76-L107】).  When running on the
glasses ensure that:

1. Your `app.json` declares a network permission for the `codrawer-bridge`
   server.  The Even Hub only allows connections to whitelisted origins and
   requires that the server return appropriate CORS headers【272077029315183†L69-L111】.
2. You create a text container (with `isEventCapture:1`) and an image
   container between 20–200 px wide and 20–100 px tall【90077158515851†L82-L87】.  The stub does this in
   `evenHubBridge.ts` via `initPage()`; replace this with
   `bridge.createStartUpPageContainer()` when integrating the real SDK.
3. You await each call to `updateImageRawData` before sending another
   image update.  The stub chains calls to enforce this and writes raw
   greyscale frames into the `mock_output` directory for inspection【812841837835490†L76-L107】.
4. You handle input events via `bridge.onEvenHubEvent()` and update
   variables such as `MODE`, `HIGHLIGHT` or whether the viewer is
   running.  The sample code toggles between freeze/unfreeze on click,
   cycles highlight layers on double click, and switches cropping modes
   on swipe.【629388601496577†L62-L90】

To enable the Even Hub bridge:

```bash
pnpm start --filter even-g2-codrawer-viewer -- \
  USE_EVEN_HUB=true CODRAWER_URL=ws://<your-server>/ws/session1 FRAME_WIDTH=200 FRAME_HEIGHT=100
```

When `USE_EVEN_HUB=true` the viewer ignores the `mock_output` directory,
performs greyscale conversion internally and calls the Even SDK.  When
running locally or in tests leave `USE_EVEN_HUB` unset or false and the
viewer will write PNG images into `mock_output` for manual inspection.