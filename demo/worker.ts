import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";
import { type Effect, applyEffect, busyWait } from "./effects.ts";
import type { ToWorker, WorkerStatus } from "./protocol.ts";

polyfillDocument();
polyfill2dCanvasApi();

const STREAM_OFFSET = 37;
const STATS_INTERVAL = 500;

const video = document.createElement("video");
video.muted = true;
video.loop = true;
video.crossOrigin = "anonymous";

let index = 0;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let effect: Effect = "edges";
let extraWork = 0;
let processing = true;
let processMs = 0;
let error: string | null = null;

let windowStart = performance.now();
let busy = 0;
let processed = 0;
let fps = 0;
let load = 0;

function offsetTime(time: number): number {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return time;
  return (time + index * STREAM_OFFSET) % duration;
}

function processFrame(): void {
  if (!ctx || !processing || video.readyState < video.HAVE_CURRENT_DATA) return;
  const started = performance.now();
  const { videoWidth: width, videoHeight: height } = video;
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
  }
  ctx.drawImage(video as unknown as CanvasImageSource, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  applyEffect(image, effect);
  busyWait(extraWork);
  ctx.putImageData(image, 0, 0);
  processMs = performance.now() - started;
  busy += processMs;
  processed++;
}

function onVideoFrame(): void {
  processFrame();
  video.requestVideoFrameCallback(onVideoFrame);
}
video.requestVideoFrameCallback(onVideoFrame);
video.addEventListener("seeked", processFrame);
video.addEventListener("loadeddata", processFrame);
video.addEventListener("loadedmetadata", () => {
  if (index > 0) video.currentTime = offsetTime(0);
});

for (const type of ["play", "pause", "seeked", "durationchange", "emptied"]) {
  video.addEventListener(type, report);
}
video.addEventListener("loadstart", () => {
  error = null;
});
video.addEventListener("error", () => {
  error = video.error?.message || "This video cannot be played.";
  report();
});

setInterval(() => {
  const now = performance.now();
  const elapsed = now - windowStart;
  fps = (processed * 1000) / elapsed;
  load = Math.min(1, busy / elapsed);
  windowStart = now;
  busy = 0;
  processed = 0;
  report();
}, STATS_INTERVAL);

function report(): void {
  const status: WorkerStatus = {
    type: "status",
    index,
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    width: video.videoWidth,
    height: video.videoHeight,
    fps,
    load,
    processMs,
    error,
  };
  self.postMessage(status);
}

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message?.type) {
    case "init":
      index = message.index;
      ctx = message.canvas.getContext("2d", { willReadFrequently: true });
      break;
    case "source":
      video.src = message.src;
      if (message.play) video.play().catch(() => {});
      break;
    case "play":
      video.play().catch(() => {});
      break;
    case "pause":
      video.pause();
      break;
    case "seek":
      video.currentTime = offsetTime(message.time);
      break;
    case "effect":
      effect = message.effect;
      processFrame();
      break;
    case "work":
      extraWork = message.ms;
      break;
    case "processing":
      processing = message.enabled;
      processFrame();
      break;
  }
});
