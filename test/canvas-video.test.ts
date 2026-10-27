import { CanvasVideoElement } from "html-video-element-webworker-polyfill/canvas-video";
import { afterEach, describe, expect, test } from "vitest";
import h264Url from "./fixtures/frames.mp4?url";
import vp9Mp4Url from "./fixtures/frames-vp9.mp4?url";
import webmUrl from "./fixtures/frames.webm?url";

const FPS = 30;
const SOURCES = {
  "H.264 MP4": { url: new URL(h264Url, location.href).href, codec: "avc1.64000d" },
  "VP9 MP4": { url: new URL(vp9Mp4Url, location.href).href, codec: "vp09.00.10.08" },
  "VP9 WebM": { url: new URL(webmUrl, location.href).href, codec: "vp09.00.10.08" },
};

const created: CanvasVideoElement[] = [];
afterEach(() => {
  for (const video of created.splice(0)) video.dispose();
});

function createVideo(): CanvasVideoElement {
  const element = new CanvasVideoElement();
  created.push(element);
  return element;
}

function once(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

async function loaded(url: string): Promise<CanvasVideoElement> {
  const element = createVideo();
  element.src = url;
  await once(element, "loadeddata");
  return element;
}

async function seekToFrame(element: CanvasVideoElement, frame: number): Promise<number> {
  element.currentTime = (frame + 0.5) / FPS;
  await once(element, "seeked");
  return Math.round((element.currentFrame!.timestamp * FPS) / 1e6);
}

for (const [name, { url, codec }] of Object.entries(SOURCES)) {
  describe(name, async () => {
    const { supported } = await VideoDecoder.isConfigSupported({ codec });

    test.skipIf(!supported)("loads metadata and the first frame onto its canvas", async () => {
      // Arrange
      const element = createVideo();
      const events: string[] = [];
      for (const type of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay"]) {
        element.addEventListener(type, () => events.push(type));
      }

      // Act
      element.src = url;
      await once(element, "canplay");

      // Assert
      expect(events).toEqual(["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay"]);
      expect(element.duration).toBeCloseTo(4, 1);
      expect([element.videoWidth, element.videoHeight]).toEqual([320, 180]);
      expect([element.canvas.width, element.canvas.height]).toEqual([320, 180]);
      expect(element.readyState).toBe(4);
      expect(element.currentFrame?.timestamp).toBe(0);
    });

    test.skipIf(!supported)("steps forward frame by frame through a GOP", async () => {
      // Arrange
      const element = await loaded(url);
      const frames = Array.from({ length: 40 }, (_, i) => 50 + i);

      // Act
      const shown: number[] = [];
      for (const frame of frames) shown.push(await seekToFrame(element, frame));

      // Assert
      expect(shown).toEqual(frames);
    });

    test.skipIf(!supported)("steps backward frame by frame across a keyframe", async () => {
      // Arrange
      const element = await loaded(url);
      const frames = Array.from({ length: 30 }, (_, i) => 75 - i);

      // Act
      const shown: number[] = [];
      for (const frame of frames) shown.push(await seekToFrame(element, frame));

      // Assert
      expect(shown).toEqual(frames);
    });

    test.skipIf(!supported)("lands on frame i when seeking exactly to i / fps", async () => {
      // Arrange
      const element = await loaded(url);
      const frames = Array.from({ length: 119 }, (_, i) => i + 1);

      // Act
      const shown: number[] = [];
      for (const frame of frames) {
        element.currentTime = (frame * 1000) / FPS / 1000;
        await once(element, "seeked");
        shown.push(Math.round((element.currentFrame!.timestamp * FPS) / 1e6));
      }

      // Assert
      expect(shown).toEqual(frames);
    });

    test.skipIf(!supported)("lands on the right frame for random seeks", async () => {
      // Arrange
      const element = await loaded(url);
      const frames = [110, 3, 64, 119, 0, 59, 60, 61, 30];

      // Act
      const shown: number[] = [];
      for (const frame of frames) shown.push(await seekToFrame(element, frame));

      // Assert
      expect(shown).toEqual(frames);
    });

    test.skipIf(!supported)("keeps currentTime exactly at the seek target", async () => {
      // Arrange
      const element = await loaded(url);

      // Act
      element.currentTime = 1.2345;
      const seeking = element.seeking;
      await once(element, "seeked");

      // Assert
      expect(seeking).toBe(true);
      expect(element.seeking).toBe(false);
      expect(element.currentTime).toBe(1.2345);
    });

    test.skipIf(!supported)("plays to the end and fires ended", async () => {
      // Arrange
      const element = await loaded(url);
      element.currentTime = 3.5;
      await once(element, "seeked");
      const events: string[] = [];
      for (const type of ["play", "playing", "timeupdate", "pause", "ended"]) {
        element.addEventListener(type, () => events.push(type));
      }

      // Act
      await element.play();
      await once(element, "ended");

      // Assert
      expect(events.slice(0, 2)).toEqual(["play", "playing"]);
      expect(events.slice(-2)).toEqual(["pause", "ended"]);
      expect(element.paused).toBe(true);
      expect(element.ended).toBe(true);
      expect(element.currentTime).toBeCloseTo(4, 1);
      expect(Math.round((element.currentFrame!.timestamp * FPS) / 1e6)).toBe(119);
    });

    test.skipIf(!supported)("fires seeking, timeupdate and seeked in order", async () => {
      // Arrange
      const element = await loaded(url);
      const events: string[] = [];
      for (const type of ["seeking", "timeupdate", "seeked"]) {
        element.addEventListener(type, () => events.push(type));
      }

      // Act
      element.currentTime = 2;
      await once(element, "seeked");

      // Assert
      expect(events).toEqual(["seeking", "timeupdate", "seeked"]);
    });

    test.skipIf(!supported)("only the last of overlapping seeks completes", async () => {
      // Arrange
      const element = await loaded(url);
      let seeked = 0;
      element.addEventListener("seeked", () => seeked++);

      // Act
      element.currentTime = 3;
      element.currentTime = 0.5;
      element.currentTime = (80 + 0.5) / FPS;
      await once(element, "seeked");
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Assert
      expect(seeked).toBe(1);
      expect(Math.round((element.currentFrame!.timestamp * FPS) / 1e6)).toBe(80);
    });

    test.skipIf(!supported)("reports buffered ranges from progressive range loading", async () => {
      // Arrange
      const element = await loaded(url);

      // Act
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Assert
      expect(element.buffered.length).toBeGreaterThan(0);
      expect(element.buffered.start(0)).toBe(0);
    });

    test.skipIf(!supported)("works inside a dedicated worker", async () => {
      // Arrange
      const worker = new Worker(new URL("./canvas-video-worker.ts", import.meta.url), { type: "module" });
      const frames = [10, 11, 12, 70, 69, 5];

      // Act
      const result = new Promise<{ shown: number[]; width: number; height: number }>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
      });
      worker.postMessage({ src: url, frames });
      const { shown, width, height } = await result;
      worker.terminate();

      // Assert
      expect(shown).toEqual(frames);
      expect([width, height]).toEqual([320, 180]);
    });
  });
}

describe("dispose", () => {
  const url = SOURCES["VP9 WebM"].url;

  test("releases the frame, resets the state and stops all events", async () => {
    // Arrange
    const element = await loaded(url);
    await element.play();
    const events: string[] = [];
    for (const type of ["timeupdate", "seeked", "pause", "ended", "progress", "waiting"]) {
      element.addEventListener(type, () => events.push(type));
    }

    // Act
    element.currentTime = 2;
    element.dispose();
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Assert
    expect(element.disposed).toBe(true);
    expect(element.currentFrame).toBeNull();
    expect(element.readyState).toBe(0);
    expect(element.networkState).toBe(0);
    expect(element.paused).toBe(true);
    expect(element.seeking).toBe(false);
    expect(events).toEqual([]);
  });

  test("rejects play() and ignores new sources afterwards", async () => {
    // Arrange
    const element = await loaded(url);
    element.dispose();
    let loadStarted = false;
    element.addEventListener("loadstart", () => (loadStarted = true));

    // Act
    const play = element.play();
    element.src = url;
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assert
    await expect(play).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(loadStarted).toBe(false);
    expect(element.currentFrame).toBeNull();
  });

  test("can be disposed while it is still loading", async () => {
    // Arrange
    const element = createVideo();
    const events: string[] = [];
    for (const type of ["loadedmetadata", "loadeddata", "error"]) {
      element.addEventListener(type, () => events.push(type));
    }

    // Act
    element.src = url;
    element.dispose();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Assert
    expect(events).toEqual([]);
    expect(element.currentFrame).toBeNull();
  });

  test("works with the using declaration", async () => {
    // Arrange
    const element = await loaded(url);

    // Act
    element[Symbol.dispose]();

    // Assert
    expect(element.disposed).toBe(true);
    expect(element.currentFrame).toBeNull();
  });
});

test("reports MEDIA_ERR_SRC_NOT_SUPPORTED for a file that is not media", async () => {
  // Arrange
  const element = createVideo();

  // Act
  element.src = new URL("/package.json", location.href).href;
  await once(element, "error");

  // Assert
  expect(element.error?.code).toBe(4);
  expect(element.networkState).toBe(3);
});
