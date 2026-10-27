import type { Effect } from "../effects.ts";

export type LabCommand =
  | { type: "load"; src: string | Blob }
  | { type: "step"; delta: number }
  | { type: "frame"; index: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "run" }
  | { type: "stop" }
  | { type: "effect"; effect: Effect };

export interface LabState {
  type: "state";
  index: number;
  total: number;
  time: number;
  duration: number;
  playing: boolean;
  running: boolean;
}

export interface LabRun {
  type: "run";
  done: number;
  total: number;
  fps: number;
  medianMs: number;
  finished: boolean;
}

export type LabEvent = LabState | LabRun | { type: "error"; message: string } | { type: "loaded" };
