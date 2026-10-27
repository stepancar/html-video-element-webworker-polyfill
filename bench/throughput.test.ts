import { CanvasVideoElement } from "html-video-element-webworker-polyfill/canvas-video";
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { test } from "vitest";

const FILES = ["h264-1080p-gop250.mp4", "vp9-1080p-gop250.webm"];
const FPS = 30;
const FRAMES = 600;
const TIMES = Array.from({ length: FRAMES }, (_, i) => (i * 1000) / FPS / 1000);

async function blob(name: string): Promise<Blob> {
  return (await fetch(`/bench/fixtures/${name}`)).blob();
}

async function mediabunnyKnownTimestamps(file: Blob): Promise<number> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!);
  const started = performance.now();
  let count = 0;
  for await (const sample of sink.samplesAtTimestamps(TIMES)) {
    sample?.close();
    count++;
  }
  const fps = count / ((performance.now() - started) / 1000);
  input.dispose();
  return Math.round(fps);
}

async function canvasVideoStepping(file: Blob): Promise<number> {
  const video = new CanvasVideoElement({ audio: false });
  video.srcObject = file;
  await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  const started = performance.now();
  for (const time of TIMES) {
    const done = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    video.currentTime = time;
    await done;
  }
  const fps = FRAMES / ((performance.now() - started) / 1000);
  video.dispose();
  return Math.round(fps);
}

for (const name of FILES) {
  test(`throughput ${name}`, { timeout: 600_000 }, async () => {
    const file = await blob(name);
    const rows: Record<string, number[]> = {};
    const add = (key: string, value: number) => (rows[key] ??= []).push(value);
    await canvasVideoStepping(file);
    for (let round = 0; round < 3; round++) {
      add("mediabunny samplesAtTimestamps(i / fps)", await mediabunnyKnownTimestamps(file));
      add("CanvasVideoElement currentTime = i / fps", await canvasVideoStepping(file));
    }
    for (const key of Object.keys(rows)) rows[key]!.sort((a, b) => a - b);
    console.log(`\n${name}\n${JSON.stringify(rows, null, 1)}`);
  });
}
