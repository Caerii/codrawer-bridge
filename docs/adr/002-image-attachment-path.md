# ADR 002 — How a drawing reaches the model

Status: proposed (2026-09-27) · Owner: SIG platform · Related: ADR 001, ADR 003

## Context

The models behind the terminal session are multimodal. The question is which hop the pixels
cross and in what form. even-terminal's `POST /api/prompt` accepts only `text`, `sessionId`,
`provider` and `cwd` (verified in `dist/routes/core.js`), so it cannot carry an image block.
The Claude Agent SDK it wraps can: user messages may be content blocks including base64
images. Claude Code's `Read` tool also returns a PNG to the model as an image block.

## Decision

Three paths, in order of adoption:

1. **Now — file plus Read.** On a `term_prompt` the router renders the turn's ink to
   `<cwd>/.codrawer/turns/turn-<n>.png` and writes the simplified polylines to
   `turn-<n>.json`, then appends a trailer to the prompt: *"A drawing is attached: read
   `.codrawer/turns/turn-<n>.png` (geometry in `turn-<n>.json`) before answering."* The model
   sees a genuine image one tool call later. No patch to even-terminal.
2. **Next — image content block.** A SIG-maintained even-terminal patch (or the router driving
   the Agent SDK directly, keeping even-terminal as the phone/glasses front end) accepts an
   `images` array and builds a multimodal user message. Same turn, no tool call, cannot be
   skipped.
3. **Always — geometry as text.** The polyline JSON accompanies every image so the model can
   measure, diff two turns, and reply with ink in the same coordinate frame (ADR 003).

**Render spec.** Render from the stroke store, never from a screenshot. Page frame fixed to
the tablet's aspect (1620×2160 → portrait), long side 1024 px. This turn's strokes drawn
dark, earlier ink light grey, AI ink dashed, so the model knows what was just added. A thin
border marks the page so normalized coordinates in the reply map back. Empty pages are not
attached.

**Attachment default.** A `term_prompt` attaches the turn's ink automatically when any new
strokes exist; `attach: "page"` attaches the whole page; `attach: "none"` opts out. The
glasses show *✎ N strokes attached*.

## Consequences

- Path 1 costs about one second and one tool round trip per turn with ink; acceptable.
- The rendered PNG is part of the turn record (ADR 001) and is what the web viewer's
  "what did the agent see" affordance shows.
- Path 2 is tracked as work on the SIG fork of even-terminal; when it lands the trailer is
  dropped and the same renderer feeds the content block.
