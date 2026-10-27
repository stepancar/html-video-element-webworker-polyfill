import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import { EFFECTS, type Effect } from "../effects.ts";
import { type AudioOutput, createAudioOutput } from "html-video-element-webworker-polyfill/canvas-video";
import { Lab } from "./lab.ts";
import type { LabCommand, LabEvent } from "./protocol.ts";

hljs.registerLanguage("javascript", javascript);

const SOURCES: Array<{ label: string; src: string }> = [
  { label: "Test pattern · H.264 MP4", src: new URL("frames-h264.mp4", document.baseURI).href },
  {
    label: "Big Buck Bunny · VP9 WebM",
    src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm",
  },
  { label: "Short pattern · VP9 WebM", src: new URL("pattern.webm", document.baseURI).href },
];

type Mode = "worker" | "main";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let mode: Mode = "worker";
let effect: Effect = "edges";
let source: string | Blob = SOURCES[0]!.src;
let worker: Worker | null = null;
let audioOutput: AudioOutput | null = null;
let lab: Lab | null = null;
let send: (command: LabCommand) => void = () => {};
let generation = 0;
let playing = false;
let running = false;
let current = -1;
let total = 0;

function showError(message: string | null): void {
  const error = $("error");
  error.hidden = !message;
  error.textContent = message ?? "";
}

if (typeof VideoDecoder === "undefined" || !("transferControlToOffscreen" in HTMLCanvasElement.prototype)) {
  showError("This demo needs WebCodecs and OffscreenCanvas. Try a recent Chrome, Edge or Safari.");
  throw new Error("Unsupported browser");
}

function formatTime(seconds: number): string {
  return `${seconds.toFixed(3)} s`;
}

function onEvent(event: LabEvent, owner: number): void {
  if (owner !== generation) return;
  switch (event.type) {
    case "loaded":
      showError(null);
      return;
    case "error":
      showError(event.message);
      return;
    case "state": {
      current = event.index;
      playing = event.playing;
      running = event.running;
      total = event.total;
      const seek = $<HTMLInputElement>("seek");
      seek.max = String(Math.max(0, total - 1));
      if (document.activeElement !== seek) seek.value = String(Math.max(0, current));
      $("time").textContent = `Frame ${Math.max(0, current)} / ${Math.max(0, total - 1)} · ${formatTime(event.time)}`;
      $("play").classList.toggle("playing", playing);
      $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
      $("run").textContent = running ? "Stop" : "Process every frame";
      return;
    }
    case "run":
      $("stat-run").textContent = Math.round(event.fps).toLocaleString("en-US");
      $("run-note").textContent =
        `${event.done.toLocaleString("en-US")} of ${event.total.toLocaleString("en-US")} frames · median step ${event.medianMs.toFixed(1)} ms${event.finished ? " · done" : ""}`;
  }
}

function mount(): void {
  generation++;
  const owner = generation;
  worker?.terminate();
  worker = null;
  audioOutput?.close();
  audioOutput = null;
  lab?.dispose();
  lab = null;
  showError(null);
  playing = false;
  running = false;
  total = 0;
  current = -1;
  const sourceCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");
  $("source-slot").replaceChildren(sourceCanvas);
  $("output-slot").replaceChildren(outputCanvas);
  const label = mode === "worker" ? "Web Worker" : "Main thread";
  for (const id of ["source-tag", "output-tag"]) {
    $(id).textContent = label;
    $(id).className = `tag ${mode === "worker" ? "worker" : "main"}`;
  }
  if (mode === "worker") {
    const instance = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const offscreenSource = sourceCanvas.transferControlToOffscreen();
    const offscreenOutput = outputCanvas.transferControlToOffscreen();
    audioOutput = createAudioOutput();
    const audio = audioOutput.port;
    instance.postMessage({ type: "init", source: offscreenSource, output: offscreenOutput, audio }, [
      offscreenSource,
      offscreenOutput,
      audio,
    ]);
    instance.onmessage = (message: MessageEvent<LabEvent>) => onEvent(message.data, owner);
    instance.onerror = (error) => showError(error.message || "Worker failed");
    worker = instance;
    send = (command) => instance.postMessage(command);
  } else {
    const instance = new Lab(sourceCanvas, outputCanvas, (event) => onEvent(event, owner));
    lab = instance;
    send = (command) => void instance.handle(command);
  }
  send({ type: "effect", effect });
  send({ type: "load", src: source });
}

function setPressed(container: HTMLElement, attribute: string, value: string): void {
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  }
}

function syncControls(): void {
  setPressed($("mode"), "mode", mode);
}

$("mode").addEventListener("click", (event) => {
  const value = (event.target as HTMLElement).closest("button")?.dataset.mode as Mode | undefined;
  if (!value || value === mode) return;
  mode = value;
  syncControls();
  mount();
});

for (const item of EFFECTS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = item.label;
  button.setAttribute("aria-pressed", String(item.value === effect));
  button.addEventListener("click", () => {
    effect = item.value;
    for (const chip of $("effects").children) chip.setAttribute("aria-pressed", String(chip === button));
    send({ type: "effect", effect });
  });
  $("effects").append(button);
}

for (const item of SOURCES) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = item.label;
  button.setAttribute("aria-pressed", String(item.src === source));
  button.addEventListener("click", () => {
    source = item.src;
    for (const chip of $("sources").children) chip.setAttribute("aria-pressed", String(chip === button));
    mount();
  });
  $("sources").append(button);
}

$<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  source = file;
  for (const chip of $("sources").children) chip.setAttribute("aria-pressed", "false");
  mount();
});

$("prev").addEventListener("click", () => send({ type: "step", delta: -1 }));
$("next").addEventListener("click", () => send({ type: "step", delta: 1 }));
$("play").addEventListener("click", () => {
  audioOutput?.resume();
  send({ type: playing ? "pause" : "play" });
});
$<HTMLInputElement>("seek").addEventListener("input", (event) => {
  send({ type: "frame", index: Number((event.target as HTMLInputElement).value) });
});
$("run").addEventListener("click", () => send({ type: running ? "stop" : "run" }));

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    send({ type: "step", delta: event.key === "ArrowRight" ? step : -step });
  } else if (event.key === " ") {
    event.preventDefault();
    send({ type: playing ? "pause" : "play" });
  }
});

for (const block of document.querySelectorAll<HTMLElement>("pre code.language-javascript")) {
  hljs.highlightElement(block);
}

syncControls();
mount();
