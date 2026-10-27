import {
  type AudioChunk,
  type AudioSink,
  CanvasVideoElement,
  createAudioOutput,
} from "html-video-element-webworker-polyfill/canvas-video";
import { afterEach, describe, expect, test } from "vitest";
import aacUrl from "./fixtures/av.mp4?url";
import opusUrl from "./fixtures/av.webm?url";

const SOURCES = {
  "Opus in WebM": { url: new URL(opusUrl, location.href).href, codec: "opus", sampleRate: 48000 },
  "AAC in MP4": { url: new URL(aacUrl, location.href).href, codec: "mp4a.40.2", sampleRate: 48000 },
};

class RecordingSink implements AudioSink {
  onconsumed: (() => void) | null = null;
  chunks: AudioChunk[] = [];
  stops = 0;
  volume = 1;
  resumed = 0;

  schedule(chunk: AudioChunk): void {
    this.chunks.push(chunk);
    queueMicrotask(() => this.onconsumed?.());
  }
  stop(): void {
    this.stops++;
  }
  setVolume(volume: number): void {
    this.volume = volume;
  }
  resume(): void {
    this.resumed++;
  }
  close(): void {}
}

const created: CanvasVideoElement[] = [];
afterEach(() => {
  for (const video of created.splice(0)) video.dispose();
});

function once(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loaded(url: string, audio: CanvasVideoElement["srcObject"] | AudioSink): Promise<CanvasVideoElement> {
  const element = new CanvasVideoElement({ audio: audio as AudioSink });
  created.push(element);
  element.src = url;
  await once(element, "loadeddata");
  return element;
}

for (const [name, { url, codec, sampleRate }] of Object.entries(SOURCES)) {
  describe(name, async () => {
    const { supported } = await AudioDecoder.isConfigSupported({ codec, sampleRate, numberOfChannels: 1 });

    test.skipIf(!supported)("schedules contiguous PCM aligned with the playback clock", async () => {
      // Arrange
      const sink = new RecordingSink();
      const element = await loaded(url, sink);
      element.currentTime = 1;
      await once(element, "seeked");

      // Act
      const playedAt = performance.timeOrigin + performance.now();
      await element.play();
      await wait(600);
      element.pause();

      // Assert
      const chunks = sink.chunks;
      expect(chunks.length).toBeGreaterThan(5);
      expect(chunks[0]!.sampleRate).toBe(sampleRate);
      expect(Math.abs(chunks[0]!.at - playedAt)).toBeLessThan(50);
      for (let i = 1; i < chunks.length; i++) {
        const previous = chunks[i - 1]!;
        const expected = previous.at + (previous.frames / previous.sampleRate) * 1000;
        expect(Math.abs(chunks[i]!.at - expected)).toBeLessThan(1);
      }
      const scheduledMs = chunks.reduce((sum, chunk) => sum + (chunk.frames / chunk.sampleRate) * 1000, 0);
      expect(scheduledMs).toBeGreaterThan(600);
      expect(scheduledMs).toBeLessThan(600 + 2000);
    });

    test.skipIf(!supported)("starts audio at the sample matching currentTime", async () => {
      // Arrange
      const sink = new RecordingSink();
      const element = await loaded(url, sink);
      element.currentTime = 2.5;
      await once(element, "seeked");

      // Act
      const playedAt = performance.timeOrigin + performance.now();
      await element.play();
      await wait(100);
      element.pause();

      // Assert
      const first = sink.chunks[0]!;
      expect(Math.abs(first.at - playedAt)).toBeLessThan(50);
      const tone = first.channels[0]!;
      expect(tone.some((sample) => Math.abs(sample) > 0.05)).toBe(true);
    });

    test.skipIf(!supported)("stops and reschedules audio on pause, seek and rate change", async () => {
      // Arrange
      const sink = new RecordingSink();
      const element = await loaded(url, sink);
      await element.play();
      await wait(200);

      // Act
      const stopsBefore = sink.stops;
      element.currentTime = 2;
      await once(element, "seeked");
      const afterSeek = sink.chunks.length;
      await wait(200);
      element.playbackRate = 2;
      await wait(200);
      element.pause();

      // Assert
      expect(sink.stops).toBeGreaterThan(stopsBefore + 2);
      expect(sink.chunks.length).toBeGreaterThan(afterSeek);
      expect(sink.chunks.at(-1)!.rate).toBe(2);
    });

    test.skipIf(!supported)("applies volume and muted to the sink", async () => {
      // Arrange
      const sink = new RecordingSink();
      const element = await loaded(url, sink);

      // Act
      element.volume = 0.25;
      const volume = sink.volume;
      element.muted = true;
      const muted = sink.volume;
      element.muted = false;

      // Assert
      expect(volume).toBe(0.25);
      expect(muted).toBe(0);
      expect(sink.volume).toBe(0.25);
    });

    test.skipIf(!supported)("keeps frame stepping free of audio decoding", async () => {
      // Arrange
      const sink = new RecordingSink();
      const element = await loaded(url, sink);

      // Act
      for (let frame = 10; frame < 40; frame++) {
        element.currentTime = (frame + 0.5) / 30;
        await once(element, "seeked");
      }

      // Assert
      expect(sink.chunks).toHaveLength(0);
    });

    test.skipIf(!supported)("plays through to ended with audio", async () => {
      // Arrange
      const sink = new RecordingSink();
      const element = await loaded(url, sink);
      element.currentTime = 3.6;
      await once(element, "seeked");

      // Act
      await element.play();
      await once(element, "ended");

      // Assert
      expect(element.currentTime).toBeCloseTo(4, 1);
      expect(sink.chunks.length).toBeGreaterThan(0);
    });

    test.skipIf(!supported)("sends audio from a worker to an output on the main thread", async () => {
      // Arrange
      const output = createAudioOutput();
      const worker = new Worker(new URL("./canvas-video-audio-worker.ts", import.meta.url), { type: "module" });
      const done = new Promise<{ scheduled: number }>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
      });

      // Act
      worker.postMessage({ src: url, port: output.port }, [output.port]);
      const { scheduled } = await done;
      worker.terminate();
      output.close();

      // Assert
      expect(scheduled).toBeGreaterThan(0);
    });
  });
}

test("a worker element without an audio port plays silently", async () => {
  // Arrange
  const worker = new Worker(new URL("./canvas-video-audio-worker.ts", import.meta.url), { type: "module" });
  const done = new Promise<{ scheduled: number; ended: boolean }>((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });

  // Act
  worker.postMessage({ src: new URL(opusUrl, location.href).href, port: null });
  const result = await done;
  worker.terminate();

  // Assert
  expect(result.ended).toBe(true);
});
