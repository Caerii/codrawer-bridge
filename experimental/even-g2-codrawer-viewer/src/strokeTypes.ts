/**
 * Shared type definitions for the CoDrawer Viewer.  Strokes are
 * represented as a series of normalised points with a pressure value.
 */

export type StrokePoint = [number, number, number];

/**
 * A stroke is a list of points along with metadata describing its
 * provenance.  `layer` distinguishes user ink from AI suggestions.
 */
export interface Stroke {
  /**
   * Unique identifier for the stroke.  Matches the `id` field in
   * codrawer‑bridge messages.
   */
  id: string;

  /**
   * Which layer this stroke belongs to.  When set to `"ai"` the
   * rasteriser renders it dimmer to help distinguish it from user
   * input.
   */
  layer: "user" | "ai";

  /**
   * The brush name.  This is currently unused by the viewer but is
   * preserved for completeness.  Future iterations might draw
   * different brush types (pen, pencil, marker, eraser) with
   * different styles.
   */
  brush: string;

  /**
   * The points that constitute this stroke.  Each point is a tuple
   * `[x, y, p]` where `x` and `y` are normalised coordinates in
   * `[0, 1]` and `p` is the stylus pressure in `[0, 1]`.
   */
  points: StrokePoint[];

  /**
   * Indicates whether the stroke has finished.  While a stroke is
   * active new points may be appended to it.
   */
  complete: boolean;

  /**
   * Timestamp (milliseconds since epoch) of the most recent update to
   * this stroke.  Used for pruning old strokes from the model.
   */
  updatedAt?: number;
}

/**
 * Envelope type for messages arriving over the codrawer WebSocket.
 */
export type CodrawerMessage =
  | StrokeBeginMessage
  | StrokePtsMessage
  | StrokeEndMessage;

export interface StrokeBeginMessage {
  t: "stroke_begin" | "ai_stroke_begin";
  id: string;
  layer: "user" | "ai";
  brush: string;
}

export interface StrokePtsMessage {
  t: "stroke_pts" | "ai_stroke_pts";
  id: string;
  pts: StrokePoint[];
}

export interface StrokeEndMessage {
  t: "stroke_end" | "ai_stroke_end";
  id: string;
}