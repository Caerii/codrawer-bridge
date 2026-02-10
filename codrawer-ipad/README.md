# Codrawer for iPad

This is a native iPad client for the Codrawer bridge, built with SwiftUI and PencilKit.
It features a split-view interface with a Rocq (Coq) Prover IDE and an infinite drawing canvas that syncs with the Codrawer AI backend.

## Structure

- **Sources/Views**: SwiftUI views (SplitLayout, Canvas, Editor).
- **Sources/Models**: JSON protocol definitions mirroring `codrawer_bridge`.
- **Sources/Services**: WebSocket connection and stroke handling.

## How to Build

### Option A: Drag and Drop
1. Create a new iOS App project in Xcode (SwiftUI interface).
2. Delete the default files.
3. Drag the `Codrawer/Sources` folder into your project group.
4. Build and Run on an iPad or Simulator.

### Option B: XCodegen (Recommended)
1. Install `xcodegen`: `brew install xcodegen`
2. Run `xcodegen generate` in this directory.
3. Open `Codrawer.xcodeproj`.

## Features
- **Real-time Drawing**: Uses PencilKit for low-latency input.
- **AI Integration**: Streams strokes to/from the backend via WebSockets.
- **Prover IDE**: Edit `.v` files and view goals side-by-side with your sketches.

## Configuration
The app attempts to connect to `ws://localhost:8000/ws` by default. Change the URL in `ConnectionManager.swift` or the UI if testing on a real device (use your computer's LAN IP).
