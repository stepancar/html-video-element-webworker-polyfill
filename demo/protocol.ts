import type { Effect } from "./effects.ts";

export type ToWorker =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "source"; src: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; time: number }
  | { type: "effect"; effect: Effect }
  | { type: "work"; ms: number }
  | { type: "processing"; enabled: boolean };

export interface WorkerStatus {
  type: "status";
  currentTime: number;
  duration: number;
  paused: boolean;
  width: number;
  height: number;
  frames: number;
  processMs: number;
  error: string | null;
}
