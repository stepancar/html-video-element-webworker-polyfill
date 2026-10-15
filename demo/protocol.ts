/** Application messages between the demo page and its render worker. */

export type Effect = "none" | "grayscale" | "edges" | "chromatic" | "pixelate" | "vignette";

export type ToWorker =
  | { type: "init"; stage: OffscreenCanvas; timeline: OffscreenCanvas }
  | { type: "source"; src: string }
  | { type: "pip"; src: string | null }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; time: number }
  | { type: "effect"; effect: Effect }
  | { type: "muted"; muted: boolean }
  | { type: "volume"; volume: number }
  | { type: "rate"; rate: number };

export interface Status {
  type: "status";
  currentTime: number;
  duration: number;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  width: number;
  height: number;
  frameTimestamp: number | null;
  framesReceived: number;
  renderFps: number;
  thumbnails: number;
  error: string | null;
}

export type FromWorker = Status;
