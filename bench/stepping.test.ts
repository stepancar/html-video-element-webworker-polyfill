import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type InputVideoTrack, VideoSampleSink } from "mediabunny";
import { CanvasVideoElement } from "html-video-element-webworker-polyfill/canvas-video";
import { expect, test } from "vitest";

const FPS = 30;
const FILES = ["h264-1080p-gop250.mp4", "vp9-1080p-gop250.webm"];
const FORWARD = Array.from({ length: 60 }, (_, i) => (120 + i + 0.5) / FPS);
const BACKWARD = Array.from({ length: 30 }, (_, i) => (200 - i + 0.5) / FPS);

type Step = (time: number) => Promise<number>;

interface Stepper {
  step: Step;
  close(): void;
}

async function blob(name: string): Promise<Blob> {
  return (await fetch(`/bench/fixtures/${name}`)).blob();
}

async function track(file: Blob): Promise<InputVideoTrack> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("no video track");
  return video;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    }),
  ]);
}

async function run(times: number[], step: Step): Promise<{ total: number; median: number; max: number }> {
  const durations: number[] = [];
  for (const time of times) {
    const start = performance.now();
    const timestamp = await withTimeout(step(time), 10_000);
    durations.push(performance.now() - start);
    expect(Math.round(timestamp * FPS)).toBe(Math.floor(time * FPS));
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    total: Math.round(durations.reduce((a, b) => a + b, 0)),
    median: Math.round(sorted[sorted.length >> 1]! * 10) / 10,
    max: Math.round(sorted.at(-1)! * 10) / 10,
  };
}

async function getSampleStepper(file: Blob): Promise<Stepper> {
  const sink = new VideoSampleSink(await track(file));
  return {
    async step(time) {
      const sample = await sink.getSample(time);
      if (!sample) throw new Error("no sample");
      const timestamp = sample.timestamp;
      sample.close();
      return timestamp;
    },
    close() {},
  };
}

async function lazyIteratorStepper(file: Blob): Promise<Stepper> {
  const sink = new VideoSampleSink(await track(file));
  const queue: number[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* timestamps() {
    while (!done) {
      while (queue.length === 0 && !done) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const next = queue.shift();
      if (next !== undefined) yield next;
    }
  }
  const iterator = sink.samplesAtTimestamps(timestamps())[Symbol.asyncIterator]();
  return {
    async step(time) {
      queue.push(time);
      wake?.();
      const result = await iterator.next();
      const sample = result.value;
      if (!sample) throw new Error("no sample");
      const timestamp = sample.timestamp;
      sample.close();
      return timestamp;
    },
    close() {
      done = true;
      wake?.();
    },
  };
}

async function warmDecoderStepper(file: Blob): Promise<Stepper> {
  const video = await track(file);
  const packets = new EncodedPacketSink(video);
  const config = await video.getDecoderConfig();
  if (!config) throw new Error("no decoder config");
  const frames: VideoFrame[] = [];
  let notify: (() => void) | null = null;
  const signal = () => {
    notify?.();
    notify = null;
  };
  const decoder = new VideoDecoder({
    output(frame) {
      frames.push(frame);
      signal();
    },
    error(error) {
      throw error;
    },
  });
  decoder.addEventListener("dequeue", signal);
  decoder.configure(config);
  let next: Awaited<ReturnType<typeof packets.getKeyPacket>> = null;
  let keySequence = -1;
  let flushed = false;
  let current: VideoFrame | null = null;
  const wait = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });
  const covers = (frame: VideoFrame, time: number) =>
    frame.timestamp <= time * 1e6 + 1 && time * 1e6 < frame.timestamp + (frame.duration ?? 1e6 / FPS);
  return {
    async step(time) {
      const key = await packets.getKeyPacket(time);
      if (!key) throw new Error("no key packet");
      const ahead = current && time * 1e6 >= current.timestamp && key.sequenceNumber === keySequence;
      if (!ahead) {
        decoder.reset();
        decoder.configure(config);
        for (const frame of frames) frame.close();
        frames.length = 0;
        next = key;
        keySequence = key.sequenceNumber;
        flushed = false;
      }
      while (true) {
        while (frames.length > 0 && !covers(frames[0]!, time) && frames[0]!.timestamp < time * 1e6) {
          frames.shift()!.close();
        }
        if (frames[0] && covers(frames[0], time)) {
          current?.close();
          current = frames.shift()!;
          return current.timestamp / 1e6;
        }
        if (next && decoder.decodeQueueSize < 4) {
          decoder.decode(next.toEncodedVideoChunk());
          next = await packets.getNextPacket(next);
          continue;
        }
        if (!next && !flushed) {
          flushed = true;
          await decoder.flush();
          continue;
        }
        await wait();
      }
    },
    close() {
      decoder.close();
      current?.close();
      for (const frame of frames) frame.close();
    },
  };
}

async function nativeStepper(file: Blob): Promise<Stepper> {
  const video = document.createElement("video");
  video.muted = true;
  video.src = URL.createObjectURL(file);
  await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  return {
    step(time) {
      return new Promise<number>((resolve) => {
        video.requestVideoFrameCallback((_, metadata) => resolve(metadata.mediaTime));
        video.currentTime = time;
      });
    },
    close() {
      URL.revokeObjectURL(video.src);
    },
  };
}

async function canvasVideoStepper(file: Blob): Promise<Stepper> {
  const video = new CanvasVideoElement();
  video.srcObject = file;
  await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  return {
    step(time) {
      return new Promise<number>((resolve) => {
        video.addEventListener("seeked", () => resolve(video.currentFrame!.timestamp / 1e6), { once: true });
        video.currentTime = time;
      });
    },
    close() {
      video.dispose();
    },
  };
}

const STEPPERS: Record<string, (file: Blob) => Promise<Stepper>> = {
  "mediabunny getSample(t)": getSampleStepper,
  "mediabunny samplesAtTimestamps (lazy)": lazyIteratorStepper,
  "warm decoder": warmDecoderStepper,
  "native <video>": nativeStepper,
  CanvasVideoElement: canvasVideoStepper,
};

for (const name of FILES) {
  test(`frame stepping ${name}`, { timeout: 600_000 }, async () => {
    const file = await blob(name);
    const rows: Record<string, unknown>[] = [];
    for (const [label, create] of Object.entries(STEPPERS)) {
      for (const [direction, times] of [
        ["forward 60", FORWARD],
        ["backward 30", BACKWARD],
        ["forward 60 then back 30", [...FORWARD, ...FORWARD.slice(-31, -1).reverse()]],
      ] as const) {
        const stepper = await create(file);
        try {
          const result = await run(times, stepper.step);
          rows.push({ stepper: label, direction, ...result });
        } catch (error) {
          rows.push({ stepper: label, direction, error: String(error) });
        } finally {
          stepper.close();
        }
      }
    }
    console.log(`\n${name}\n${JSON.stringify(rows, null, 1)}`);
  });
}
