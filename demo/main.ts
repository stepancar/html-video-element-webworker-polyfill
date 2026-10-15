import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import { type VideoHost, createVideoHost } from "html-video-element-webworker-polyfill/host";
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

const MEASURE_INTERVAL = 500;
const SMOOTHING = 0.35;

type Mode = "worker" | "main";

interface Stream {
  index: number;
  worker: Worker;
  host: VideoHost;
  workerCanvas: HTMLCanvasElement;
  mainCanvas: HTMLCanvasElement;
  mainContext: CanvasRenderingContext2D;
  label: HTMLElement;
  status: WorkerStatus | null;
  watched: HTMLVideoElement | null;
  mainProcessed: number;
  mainFps: number;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function showError(message: string | null): void {
  const error = $("error");
  error.hidden = !message;
  error.textContent = message ?? "";
}

if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype) || typeof VideoFrame === "undefined") {
  showError("This demo needs OffscreenCanvas and WebCodecs VideoFrame. Try a recent Chrome, Edge, Firefox or Safari.");
  throw new Error("Unsupported browser");
}

let streams: Stream[] = [];
let mode: Mode = "worker";
let effect: Effect = "edges";
let extraWork = 25;
let source = SOURCES[0]!.src;
let playing = true;
let count = 4;

const measured: Record<Mode, number | null> = { worker: null, main: null };
let warmup = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function send(stream: Stream, message: ToWorker, transfer: Transferable[] = []): void {
  stream.worker.postMessage(message, transfer);
}

function broadcast(message: ToWorker): void {
  for (const stream of streams) send(stream, message);
}

function createStream(index: number): Stream {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const host = createVideoHost(worker, { container: index === 0 ? $("video-slot") : null });

  const tile = el("div", "tile");
  const workerCanvas = el("canvas");
  const mainCanvas = el("canvas");
  mainCanvas.hidden = true;
  const label = el("span", "tile-label");
  tile.append(workerCanvas, mainCanvas, label);
  $("tiles").append(tile);

  const stream: Stream = {
    index,
    worker,
    host,
    workerCanvas,
    mainCanvas,
    mainContext: mainCanvas.getContext("2d", { willReadFrequently: true })!,
    label,
    status: null,
    watched: null,
    mainProcessed: 0,
    mainFps: 0,
  };

  const offscreen = workerCanvas.transferControlToOffscreen();
  send(stream, { type: "init", canvas: offscreen, index }, [offscreen]);
  send(stream, { type: "effect", effect });
  send(stream, { type: "work", ms: extraWork });
  send(stream, { type: "processing", enabled: mode === "worker" });
  send(stream, { type: "source", src: source, play: playing });

  worker.addEventListener("message", (event: MessageEvent<WorkerStatus>) => {
    if (event.data?.type !== "status") return;
    stream.status = event.data;
    watchRealVideo(stream);
    renderLabel(stream);
    if (stream.index === 0) renderTransport(event.data);
    if (event.data.error) showError(`Could not play this video: ${event.data.error}`);
  });
  return stream;
}

function setCount(next: number): void {
  count = next;
  for (const stream of streams) {
    stream.host.dispose();
    stream.worker.terminate();
  }
  $("tiles").replaceChildren();
  $("tiles").dataset.count = String(next);
  streams = Array.from({ length: next }, (_, index) => createStream(index));
  for (const button of $("threads").querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.count) === next));
  }
  $("label-workers").textContent = next === 1 ? "1 worker" : `${next} workers`;
  $("video-subtitle").textContent =
    next === 1
      ? "Created, played and seeked by the worker."
      : `Worker 1's element. The other ${next - 1} workers each drive their own, kept off the page.`;
  resetMeasurements();
  renderMode();
}

function realVideo(stream: Stream): HTMLVideoElement | undefined {
  return stream.host.videos.values().next().value;
}

function watchRealVideo(stream: Stream): void {
  const video = realVideo(stream);
  if (!video || video === stream.watched) return;
  stream.watched = video;
  video.addEventListener("seeked", () => processOnMain(stream));
  const onFrame = (): void => {
    if (!streams.includes(stream)) return;
    processOnMain(stream);
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

function processOnMain(stream: Stream): void {
  const video = realVideo(stream);
  if (mode !== "main" || !video || video.readyState < video.HAVE_CURRENT_DATA) return;
  const { videoWidth: width, videoHeight: height } = video;
  const canvas = stream.mainCanvas;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  stream.mainContext.drawImage(video, 0, 0);
  const image = stream.mainContext.getImageData(0, 0, width, height);
  applyEffect(image, effect);
  busyWait(extraWork);
  stream.mainContext.putImageData(image, 0, 0);
  stream.mainProcessed++;
}

function chips<T>(
  id: string,
  items: Array<{ label: string; value: T }>,
  initial: T,
  onSelect: (value: T) => void,
): (value: T | undefined) => void {
  const container = $(id);
  const buttons = items.map(({ label, value }) => {
    const button = el("button", "chip", label);
    button.type = "button";
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
  broadcast({ type: "effect", effect: value });
  for (const stream of streams) processOnMain(stream);
  resetMeasurements();
});

const selectSource = chips(
  "sources",
  SOURCES.map(({ label, src }) => ({ label, value: src })),
  source,
  (src) => setSource(src),
);

function setSource(src: string): void {
  source = src;
  showError(null);
  broadcast({ type: "source", src, play: playing });
  resetMeasurements();
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
  broadcast({ type: "work", ms: extraWork });
  resetMeasurements();
});

for (const button of $("threads").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => setCount(Number(button.dataset.count)));
}
$("cores").textContent = navigator.hardwareConcurrency
  ? `One video per worker. This device reports ${navigator.hardwareConcurrency} logical cores.`
  : "One video per worker.";

const MODE_TEXT: Record<Mode, { tag: string; title: string; subtitle: string; hint: string }> = {
  worker: {
    tag: "Web Workers",
    title: "Frames processed in the workers",
    subtitle: "Each worker pulls its own frames and filters them pixel by pixel in JS.",
    hint: "Every video is processed in its own worker. The page stays smooth.",
  },
  main: {
    tag: "Main thread",
    title: "Frames processed on the main thread",
    subtitle: "The same filter for every video, all on the one main thread.",
    hint: "All videos share one thread now: throughput drops and the page stutters.",
  },
};

function renderMode(): void {
  for (const button of $("mode").querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  const text = MODE_TEXT[mode];
  const tag = $("output-tag");
  tag.textContent = text.tag;
  tag.classList.toggle("main", mode === "main");
  $("output-title").textContent = text.title;
  $("output-subtitle").textContent = text.subtitle;
  $("mode-hint").textContent = text.hint;
  for (const stream of streams) {
    stream.workerCanvas.hidden = mode !== "worker";
    stream.mainCanvas.hidden = mode !== "main";
    renderLabel(stream);
  }
  renderCounters();
}

function setMode(next: Mode): void {
  mode = next;
  warmup = 2;
  broadcast({ type: "processing", enabled: next === "worker" });
  renderMode();
  for (const stream of streams) processOnMain(stream);
}

for (const button of $("mode").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => setMode(button.dataset.mode as Mode));
}

function renderLabel(stream: Stream): void {
  const name = mode === "worker" ? `Worker ${stream.index + 1}` : "Main thread";
  const fps = mode === "worker" ? (stream.status?.fps ?? 0) : stream.mainFps;
  const busy = mode === "worker" && stream.status ? ` · ${Math.round(stream.status.load * 100)}% busy` : "";
  stream.label.textContent = `${name} · ${fps.toFixed(0)} fps${busy}`;
  stream.label.classList.toggle("main", mode === "main");
}

function resetMeasurements(): void {
  measured.worker = null;
  measured.main = null;
  warmup = 2;
  renderCounters();
}

function renderCounters(): void {
  for (const which of ["main", "worker"] as const) {
    const id = which === "main" ? "main" : "workers";
    const value = measured[which];
    const active = which === mode;
    $(`counter-${id}`).classList.toggle("active", active);
    $(`fps-${id}`).textContent = value === null ? "–" : value.toFixed(0);
    const other = which === "main" ? "Main thread" : "Web Workers";
    $(`note-${id}`).textContent = active
      ? value === null
        ? "Measuring…"
        : "Measuring live"
      : value === null
        ? `Switch to “${other}” to measure.`
        : "Last measured";
  }
}

function measure(): void {
  for (const stream of streams) {
    stream.mainFps = (stream.mainProcessed * 1000) / MEASURE_INTERVAL;
    stream.mainProcessed = 0;
    if (mode === "main") renderLabel(stream);
  }
  if (warmup > 0) {
    warmup--;
    renderCounters();
    return;
  }
  const total =
    mode === "worker"
      ? streams.reduce((sum, stream) => sum + (stream.status?.fps ?? 0), 0)
      : streams.reduce((sum, stream) => sum + stream.mainFps, 0);
  const previous = measured[mode];
  measured[mode] = previous === null ? total : previous + (total - previous) * SMOOTHING;
  renderCounters();
}
setInterval(measure, MEASURE_INTERVAL);

function format(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const seek = $<HTMLInputElement>("seek");
let scrubbing = false;
seek.addEventListener("pointerdown", () => (scrubbing = true));
seek.addEventListener("pointerup", () => (scrubbing = false));
seek.addEventListener("input", () => {
  const duration = streams[0]?.status?.duration ?? Number.NaN;
  if (Number.isFinite(duration)) broadcast({ type: "seek", time: Number(seek.value) * duration });
});

$("play").addEventListener("click", () => {
  playing = streams[0]?.status?.paused ?? !playing;
  broadcast({ type: playing ? "play" : "pause" });
});

function renderTransport(status: WorkerStatus): void {
  document.body.classList.toggle("playing", !status.paused);
  $("play").setAttribute("aria-label", status.paused ? "Play" : "Pause");
  $("time").textContent = `${format(status.currentTime)} / ${format(status.duration)}`;
  if (!scrubbing && Number.isFinite(status.duration) && status.duration > 0) {
    seek.value = String(status.currentTime / status.duration);
  }
}

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

for (const block of document.querySelectorAll<HTMLElement>("pre code.language-javascript")) {
  hljs.highlightElement(block);
}

setCount((navigator.hardwareConcurrency || 4) > 4 ? count : 1);
setMode("worker");
