import { createVideoHost } from "html-video-element-webworker-polyfill/host";
import type { Effect, FromWorker, Status, ToWorker } from "./protocol.ts";

const SOURCES = [
  {
    label: "Big Buck Bunny",
    src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.480p.vp9.webm",
  },
  {
    label: "Sintel",
    src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.480p.vp9.webm",
  },
  { label: "Test pattern", src: new URL("pattern.webm", document.baseURI).href },
];

const EFFECTS: Array<{ label: string; value: Effect }> = [
  { label: "Original", value: "none" },
  { label: "Grayscale", value: "grayscale" },
  { label: "Edges", value: "edges" },
  { label: "Chromatic", value: "chromatic" },
  { label: "Pixelate", value: "pixelate" },
  { label: "Vignette", value: "vignette" },
];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype) || typeof VideoFrame === "undefined") {
  const error = $("error");
  error.hidden = false;
  error.textContent =
    "This demo needs OffscreenCanvas and WebCodecs (VideoFrame). Try a recent Chrome, Edge, Firefox or Safari.";
  throw new Error("Unsupported browser");
}

// ---- worker + host -----------------------------------------------------------------

const worker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
// The only video-related code on the main thread: it creates and drives the
// real <video> elements on behalf of the worker.
const host = createVideoHost(worker);

const send = (message: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(message, transfer);

const stage = $<HTMLCanvasElement>("stage").transferControlToOffscreen();
const timeline = $<HTMLCanvasElement>("timeline").transferControlToOffscreen();
send({ type: "init", stage, timeline }, [stage, timeline]);

// ---- controls ------------------------------------------------------------------------

function chips<T>(
  containerId: string,
  items: Array<{ label: string; value: T }>,
  initial: T,
  onSelect: (value: T) => void,
): (value: T | undefined) => void {
  const container = $(containerId);
  const buttons = items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = item.label;
    button.addEventListener("click", () => {
      select(item.value);
      onSelect(item.value);
    });
    container.append(button);
    return { button, value: item.value };
  });
  const select = (value: T | undefined): void => {
    for (const entry of buttons) entry.button.setAttribute("aria-pressed", String(entry.value === value));
  };
  select(initial);
  return select;
}

let currentSource = SOURCES[0]!.src;
const selectSource = chips(
  "sources",
  SOURCES.map((source) => ({ label: source.label, value: source.src })),
  currentSource,
  (src) => setSource(src),
);

chips("effects", EFFECTS, "none" as Effect, (effect) => send({ type: "effect", effect }));

chips(
  "pips",
  [{ label: "Off", value: "" }, ...SOURCES.map((source) => ({ label: source.label, value: source.src }))],
  "",
  (src) => send({ type: "pip", src: src || null }),
);

function setSource(src: string): void {
  currentSource = src;
  $("error").hidden = true;
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

let status: Status | null = null;

$("play").addEventListener("click", () => send({ type: status?.paused === false ? "pause" : "play" }));
$("stage").addEventListener("click", () => send({ type: status?.paused === false ? "pause" : "play" }));
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || (event.target as HTMLElement).matches("input, select, button")) return;
  event.preventDefault();
  send({ type: status?.paused === false ? "pause" : "play" });
});
$<HTMLInputElement>("muted").addEventListener("change", (event) =>
  send({ type: "muted", muted: (event.target as HTMLInputElement).checked }),
);
$<HTMLInputElement>("volume").addEventListener("input", (event) =>
  send({ type: "volume", volume: Number((event.target as HTMLInputElement).value) }),
);
$<HTMLSelectElement>("rate").addEventListener("change", (event) =>
  send({ type: "rate", rate: Number((event.target as HTMLSelectElement).value) }),
);

const scrub = $<HTMLInputElement>("scrub");
let scrubbing = false;
scrub.addEventListener("pointerdown", () => (scrubbing = true));
scrub.addEventListener("pointerup", () => (scrubbing = false));
scrub.addEventListener("input", () => {
  if (!status || !Number.isFinite(status.duration)) return;
  const time = Number(scrub.value) * status.duration;
  send({ type: "seek", time });
  updatePlayhead(Number(scrub.value));
});

// ---- status --------------------------------------------------------------------------

const format = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
};

function updatePlayhead(progress: number): void {
  $("playhead").style.left = `${progress * 100}%`;
}

worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
  if (event.data?.type !== "status") return;
  status = event.data;
  document.body.classList.toggle("playing", !status.paused);
  $("play").setAttribute("aria-label", status.paused ? "Play" : "Pause");
  $("time").textContent = `${format(status.currentTime)} / ${format(status.duration)}`;
  const progress = Number.isFinite(status.duration) && status.duration > 0 ? status.currentTime / status.duration : 0;
  if (!scrubbing) {
    scrub.value = String(progress);
    updatePlayhead(progress);
  }
  $("stat-resolution").textContent = status.width ? `${status.width}×${status.height}` : "–";
  $("stat-ready").textContent = String(status.readyState);
  $("stat-frames").textContent = String(status.framesReceived);
  $("stat-timestamp").textContent =
    status.frameTimestamp === null ? "–" : `${(status.frameTimestamp / 1e6).toFixed(3)} s`;
  $("stat-fps").textContent = String(status.renderFps);
  $("stat-thumbs").textContent = `${status.thumbnails} / 12`;
  const error = $("error");
  error.hidden = !status.error;
  error.textContent = status.error ? `Could not play this video: ${status.error}` : "";
});

setInterval(() => {
  $("stat-elements").textContent = String(host.videos.size);
}, 250);

setSource(currentSource);
