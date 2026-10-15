import type { Effect } from "./effects.ts";

export type ToWorker =
  | { type: "init"; canvas: OffscreenCanvas; index: number }
  | { type: "source"; src: string; play: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; time: number }
  | { type: "effect"; effect: Effect }
  | { type: "work"; ms: number }
  | { type: "processing"; enabled: boolean };

export interface WorkerStatus {
  type: "status";
  index: number;
  currentTime: number;
  duration: number;
  paused: boolean;
  width: number;
  height: number;
  fps: number;
  load: number;
  processMs: number;
  error: string | null;
}
