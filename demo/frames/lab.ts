import { CanvasVideoElement } from "html-video-element-webworker-polyfill/canvas-video";
import type { Effect } from "../effects.ts";
import { GpuFilter } from "./gpu-filter.ts";
import type { LabCommand, LabEvent } from "./protocol.ts";

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error((target as { error?: MediaError | null }).error?.message ?? "error"));
    target.addEventListener(
      type,
      () => {
        target.removeEventListener("error", onError);
        resolve();
      },
      { once: true },
    );
    target.addEventListener("error", onError, { once: true });
  });
}

export class Lab {
  readonly #sourceCanvas: AnyCanvas;
  readonly #filter: GpuFilter;
  readonly #emit: (event: LabEvent) => void;
  readonly #audio: MessagePort | undefined;
  #video: CanvasVideoElement | null = null;
  #frameDuration = 33_333;
  #effect: Effect = "edges";
  #wanted = 0;
  #shown = -1;
  #busy = false;
  #running = false;
  #playing = false;

  constructor(sourceCanvas: AnyCanvas, output: AnyCanvas, emit: (event: LabEvent) => void, audio?: MessagePort) {
    this.#sourceCanvas = sourceCanvas;
    this.#audio = audio;
    this.#filter = new GpuFilter(output);
    this.#emit = emit;
  }

  dispose(): void {
    this.#running = false;
    this.#playing = false;
    this.#video?.dispose();
    this.#video = null;
  }

  async handle(command: LabCommand): Promise<void> {
    try {
      switch (command.type) {
        case "load":
          return await this.#load(command.src);
        case "step":
          this.#stopPlayback();
          return await this.#goTo(this.#wanted + command.delta);
        case "frame":
          this.#stopPlayback();
          return await this.#goTo(command.index);
        case "play":
          return this.#play();
        case "pause":
          this.#stopPlayback();
          this.#state();
          return;
        case "run":
          return await this.#run();
        case "stop":
          this.#running = false;
          return;
        case "effect":
          this.#effect = command.effect;
          this.#process();
      }
    } catch (error) {
      this.#emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  get #total(): number {
    const duration = this.#video?.duration ?? Number.NaN;
    if (!Number.isFinite(duration)) return 0;
    return Math.max(1, Math.round((duration * 1e6) / this.#frameDuration));
  }

  #timeOf(index: number): number {
    return ((index + 0.5) * this.#frameDuration) / 1e6;
  }

  async #load(src: string | Blob): Promise<void> {
    this.#running = false;
    this.#playing = false;
    this.#video?.dispose();
    const video = new CanvasVideoElement({ canvas: this.#sourceCanvas, audio: this.#audio });
    this.#video = video;
    if (typeof src === "string") video.src = src;
    else video.srcObject = src;
    await once(video, "loadeddata");
    if (this.#video !== video) return;
    this.#frameDuration = video.currentFrame?.duration ?? 33_333;
    this.#wanted = 0;
    this.#shown = 0;
    this.#process();
    this.#emit({ type: "loaded" });
    this.#state();
  }

  async #seek(video: CanvasVideoElement, index: number): Promise<void> {
    const done = once(video, "seeked");
    video.currentTime = this.#timeOf(index);
    await done;
  }

  async #goTo(index: number): Promise<void> {
    const video = this.#video;
    if (!video) return;
    this.#wanted = Math.min(Math.max(0, index), this.#total - 1);
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#video === video && this.#wanted !== this.#shown) {
        const target = this.#wanted;
        await this.#seek(video, target);
        this.#shown = target;
        this.#process();
        this.#state();
      }
    } finally {
      this.#busy = false;
    }
  }

  #process(): void {
    const frame = this.#video?.currentFrame;
    if (!frame) return;
    this.#filter.render(frame, frame.displayWidth, frame.displayHeight, this.#effect);
  }

  #state(): void {
    this.#emit({
      type: "state",
      index: this.#shown,
      total: this.#total,
      time: (this.#shown * this.#frameDuration) / 1e6,
      duration: this.#video?.duration ?? 0,
      playing: this.#playing,
      running: this.#running,
    });
  }

  #play(): void {
    const video = this.#video;
    if (!video || this.#playing) return;
    this.#running = false;
    this.#playing = true;
    const tick = () => {
      if (!this.#playing || this.#video !== video) return;
      const frame = video.currentFrame;
      if (frame) {
        this.#shown = Math.round(frame.timestamp / this.#frameDuration);
        this.#wanted = this.#shown;
        this.#process();
      }
      if (video.paused) this.#playing = false;
      else video.requestVideoFrameCallback(tick);
      this.#state();
    };
    video.requestVideoFrameCallback(tick);
    void video.play();
    this.#state();
  }

  #stopPlayback(): void {
    if (!this.#playing) return;
    this.#playing = false;
    this.#video?.pause();
  }

  async #run(): Promise<void> {
    const video = this.#video;
    if (!video || this.#running) return;
    this.#stopPlayback();
    this.#running = true;
    const total = this.#total;
    const start = this.#shown >= total - 1 ? 0 : this.#shown + 1;
    const durations: number[] = [];
    const started = performance.now();
    let lastReport = 0;
    const report = (done: number, finished: boolean) => {
      const sorted = durations.toSorted((a, b) => a - b);
      this.#emit({
        type: "run",
        done,
        total: total - start,
        fps: done / Math.max(0.001, (performance.now() - started) / 1000),
        medianMs: sorted[sorted.length >> 1] ?? 0,
        finished,
      });
    };
    let index = start;
    for (; index < total && this.#running && this.#video === video; index++) {
      const begun = performance.now();
      await this.#seek(video, index);
      durations.push(performance.now() - begun);
      this.#shown = index;
      this.#wanted = index;
      this.#process();
      if (performance.now() - lastReport > 100) {
        lastReport = performance.now();
        report(index - start + 1, false);
        this.#state();
      }
    }
    this.#running = false;
    report(index - start, true);
    this.#state();
  }
}
