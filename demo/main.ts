import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import { createVideoHost } from "html-video-element-webworker-polyfill/host";
import { EFFECTS, type Effect, applyEffect, busyWait } from "./effects.ts";
import type { ToWorker, WorkerStatus } from "./protocol.ts";

hljs.registerLanguage("javascript", javascript);

const SOURCES = [
  {
    label: "Big Buck Bunny",
    src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm",
  },
  {
    label: "Sintel",
    src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.480p.vp9.webm",
  },
  { label: "Test pattern", src: new URL("pattern.webm", document.baseURI).href },
];

type Mode = "worker" | "main";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const workerCanvas = $<HTMLCanvasElement>("worker-canvas");
const mainCanvas = $<HTMLCanvasElement>("main-canvas");
const seek = $<HTMLInputElement>("seek");

function showError(message: string | null): void {
  const error = $("error");
  error.hidden = !message;
  error.textContent = message ?? "";
}

if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype) || typeof VideoFrame === "undefined") {
  showError("This demo needs OffscreenCanvas and WebCodecs VideoFrame. Try a recent Chrome, Edge, Firefox or Safari.");
  throw new Error("Unsupported browser");
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const host = createVideoHost(worker, { container: $("video-slot") });
const send = (message: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(message, transfer);

const offscreen = workerCanvas.transferControlToOffscreen();
send({ type: "init", canvas: offscreen }, [offscreen]);

let status: WorkerStatus | null = null;
let mode: Mode = "worker";
let effect: Effect = "edges";
let extraWork = 25;

function realVideo(): HTMLVideoElement | undefined {
  return host.videos.values().next().value;
}

function chips<T>(
  id: string,
  items: Array<{ label: string; value: T }>,
  initial: T,
  onSelect: (value: T) => void,
): (value: T | undefined) => void {
  const container = $(id);
  const buttons = items.map(({ label, value }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = label;
    button.addEventListener("click", () => {
      select(value);
      onSelect(value);
    });
    container.append(button);
    return { button, value };
  });
  const select = (value: T | undefined): void => {
    for (const entry of buttons) entry.button.setAttribute("aria-pressed", String(entry.value === value));
  };
  select(initial);
  return select;
}

chips("effects", EFFECTS, effect, (value) => {
  effect = value;
  send({ type: "effect", effect: value });
  processOnMain();
});

const selectSource = chips(
  "sources",
  SOURCES.map(({ label, src }) => ({ label, value: src })),
  SOURCES[0]!.src,
  (src) => setSource(src),
);

function setSource(src: string): void {
  showError(null);
  send({ type: "source", src });
}

let objectUrl: string | null = null;
$<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  selectSource(undefined);
  setSource(objectUrl);
});

const work = $<HTMLInputElement>("work");
work.addEventListener("input", () => {
  extraWork = Number(work.value);
  $("work-value").textContent = `${extraWork} ms`;
  send({ type: "work", ms: extraWork });
});
send({ type: "work", ms: extraWork });

const MODE_TEXT: Record<Mode, { tag: string; title: string; subtitle: string; hint: string }> = {
  worker: {
    tag: "Web Worker",
    title: "Frames processed in the worker",
    subtitle: "Pulled with requestVideoFrameCallback, filtered pixel by pixel in JS.",
    hint: "The heavy work runs in the worker. The animation below stays smooth.",
  },
  main: {
    tag: "Main thread",
    title: "Frames processed on the main thread",
    subtitle: "The same filter, run where video processing usually has to live.",
    hint: "Now every frame blocks the page: watch the red bars and try scrolling.",
  },
};

const mainContext = mainCanvas.getContext("2d", { willReadFrequently: true })!;
let mainFrames = 0;
let mainProcessMs = 0;

function setMode(next: Mode): void {
  mode = next;
  for (const button of $("mode").querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === next));
  }
  const text = MODE_TEXT[next];
  const tag = $("output-tag");
  tag.textContent = text.tag;
  tag.classList.toggle("main", next === "main");
  $("output-title").textContent = text.title;
  $("output-subtitle").textContent = text.subtitle;
  $("mode-hint").textContent = text.hint;
  workerCanvas.hidden = next !== "worker";
  mainCanvas.hidden = next !== "main";
  send({ type: "processing", enabled: next === "worker" });
  mainFrames = 0;
  processOnMain();
  renderMetric();
}

for (const button of $("mode").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => setMode(button.dataset.mode as Mode));
}

function processOnMain(): void {
  const video = realVideo();
  if (mode !== "main" || !video || video.readyState < video.HAVE_CURRENT_DATA) return;
  const started = performance.now();
  const { videoWidth: width, videoHeight: height } = video;
  if (mainCanvas.width !== width || mainCanvas.height !== height) {
    mainCanvas.width = width;
    mainCanvas.height = height;
  }
  mainContext.drawImage(video, 0, 0);
  const image = mainContext.getImageData(0, 0, width, height);
  applyEffect(image, effect);
  busyWait(extraWork);
  mainContext.putImageData(image, 0, 0);
  mainFrames++;
  mainProcessMs = performance.now() - started;
  renderMetric();
}

let watchedVideo: HTMLVideoElement | null = null;
function watchRealVideo(): void {
  const video = realVideo();
  if (!video || video === watchedVideo) return;
  watchedVideo = video;
  video.addEventListener("seeked", processOnMain);
  const onFrame = (): void => {
    processOnMain();
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

function format(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function renderMetric(): void {
  if (!status?.width) return;
  const size = `${status.width}×${status.height}`;
  $("process-metric").textContent =
    mode === "worker"
      ? `${size} · ${status.processMs.toFixed(1)} ms per frame in the worker · ${status.frames} frames`
      : `${size} · ${mainProcessMs.toFixed(1)} ms per frame on the main thread · ${mainFrames} frames`;
}

let scrubbing = false;
seek.addEventListener("pointerdown", () => (scrubbing = true));
seek.addEventListener("pointerup", () => (scrubbing = false));
seek.addEventListener("input", () => {
  if (status && Number.isFinite(status.duration)) send({ type: "seek", time: Number(seek.value) * status.duration });
});

$("play").addEventListener("click", () => send({ type: status?.paused === false ? "pause" : "play" }));

worker.addEventListener("message", (event: MessageEvent<WorkerStatus>) => {
  if (event.data?.type !== "status") return;
  status = event.data;
  watchRealVideo();
  document.body.classList.toggle("playing", !status.paused);
  $("play").setAttribute("aria-label", status.paused ? "Play" : "Pause");
  $("time").textContent = `${format(status.currentTime)} / ${format(status.duration)}`;
  if (!scrubbing && Number.isFinite(status.duration) && status.duration > 0) {
    seek.value = String(status.currentTime / status.duration);
  }
  showError(status.error ? `Could not play this video: ${status.error}` : null);
  renderMetric();
});

const monitor = $<HTMLCanvasElement>("monitor");
const monitorContext = monitor.getContext("2d")!;
const frameTimes: number[] = [];
let lastFrame = performance.now();
let ball = 0;

function drawMonitor(now: number): void {
  const delta = now - lastFrame;
  lastFrame = now;
  frameTimes.push(delta);
  const width = monitor.clientWidth;
  const ratio = devicePixelRatio;
  if (monitor.width !== Math.round(width * ratio)) {
    monitor.width = Math.round(width * ratio);
    monitor.height = Math.round(72 * ratio);
  }
  const bars = Math.floor(width / 4);
  while (frameTimes.length > bars) frameTimes.shift();

  const styles = getComputedStyle(document.documentElement);
  monitorContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  monitorContext.clearRect(0, 0, width, 72);
  monitorContext.fillStyle = styles.getPropertyValue("--grid");
  monitorContext.fillRect(0, 72 - 33, width, 1);
  for (const [index, time] of frameTimes.entries()) {
    const height = Math.min(70, time);
    monitorContext.fillStyle = styles.getPropertyValue(time > 34 ? "--bad" : time > 20 ? "--warn" : "--good");
    monitorContext.fillRect(index * 4, 72 - height, 3, height);
  }

  ball = (ball + delta * 0.25) % (width * 2);
  const x = ball < width ? ball : width * 2 - ball;
  monitorContext.fillStyle = styles.getPropertyValue("--accent");
  monitorContext.beginPath();
  monitorContext.arc(Math.min(width - 8, Math.max(8, x)), 12, 7, 0, Math.PI * 2);
  monitorContext.fill();

  const recent = frameTimes.slice(-60);
  const average = recent.reduce((sum, time) => sum + time, 0) / recent.length;
  $("fps").textContent = `${Math.round(1000 / average)} fps · longest frame ${Math.round(Math.max(...recent))} ms`;
  requestAnimationFrame(drawMonitor);
}
requestAnimationFrame(drawMonitor);

setMode("worker");
setSource(SOURCES[0]!.src);

for (const block of document.querySelectorAll<HTMLElement>("pre code.language-javascript")) {
  hljs.highlightElement(block);
}
