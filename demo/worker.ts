import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";
import { type Effect, applyEffect, busyWait } from "./effects.ts";
import type { ToWorker, WorkerStatus } from "./protocol.ts";

polyfillDocument();
polyfill2dCanvasApi();

const video = document.createElement("video");
video.muted = true;
video.loop = true;
video.crossOrigin = "anonymous";

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let effect: Effect = "edges";
let extraWork = 0;
let processing = true;
let frames = 0;
let processMs = 0;
let error: string | null = null;

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
  frames++;
  processMs = performance.now() - started;
  report();
}

function onVideoFrame(): void {
  processFrame();
  video.requestVideoFrameCallback(onVideoFrame);
}
video.requestVideoFrameCallback(onVideoFrame);
video.addEventListener("seeked", processFrame);
video.addEventListener("loadeddata", processFrame);

for (const type of ["play", "pause", "timeupdate", "durationchange", "emptied"]) {
  video.addEventListener(type, report);
}
video.addEventListener("loadstart", () => {
  error = null;
});
video.addEventListener("error", () => {
  error = video.error?.message || "This video cannot be played.";
  report();
});

function report(): void {
  const status: WorkerStatus = {
    type: "status",
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    width: video.videoWidth,
    height: video.videoHeight,
    frames,
    processMs,
    error,
  };
  self.postMessage(status);
}

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message?.type) {
    case "init":
      ctx = message.canvas.getContext("2d", { willReadFrequently: true });
      break;
    case "source":
      video.src = message.src;
      video.play().catch(() => {});
      break;
    case "play":
      video.play().catch(() => {});
      break;
    case "pause":
      video.pause();
      break;
    case "seek":
      video.currentTime = message.time;
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
