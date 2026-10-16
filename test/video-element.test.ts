import { createVideoHost } from "html-video-element-webworker-polyfill/host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fixtures, startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker;
beforeEach(() => {
  w = startWorker();
});
afterEach(() => w.dispose());

function realVideo(): HTMLVideoElement {
  return [...w.host!.videos.values()][0]!;
}

async function arrangeLoadedVideo(src: string = fixtures.colors, time?: number): Promise<void> {
  await w.run(
    async ({ helpers, state }, args) => {
      state.video = await helpers.loadVideo(args.src, args.time);
    },
    { src, time },
  );
}

describe("creation", () => {
  test("createVideoElement() returns an element in the initial media state", async () => {
    // Arrange
    const { WorkerVideoElement } = await import("html-video-element-webworker-polyfill/worker");

    // Act
    const result = await w.run(({ createVideoElement, WorkerVideoElement: Element }) => {
      const video = createVideoElement();
      return {
        isElement: video instanceof Element,
        isEventTarget: video instanceof EventTarget,
        tagName: video.tagName,
        paused: video.paused,
        readyState: video.readyState,
        networkState: video.networkState,
        duration: video.duration,
        currentFrame: video.currentFrame,
        constants: [video.HAVE_ENOUGH_DATA, Element.NETWORK_NO_SOURCE],
      };
    });

    // Assert
    expect(result).toEqual({
      isElement: true,
      isEventTarget: true,
      tagName: "VIDEO",
      paused: true,
      readyState: 0,
      networkState: 0,
      duration: Number.NaN,
      currentFrame: null,
      constants: [WorkerVideoElement.HAVE_ENOUGH_DATA, WorkerVideoElement.NETWORK_NO_SOURCE],
    });
  });

  test("creating an element creates a real <video> on the main thread", async () => {
    // Arrange
    const before = w.host!.videos.size;

    // Act
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Assert
    await expect.poll(() => w.host!.videos.size).toBe(before + 1);
    expect(realVideo()).toBeInstanceOf(HTMLVideoElement);
  });

  test("polyfillDocument() makes document.createElement('video') return a video element", async () => {
    // Arrange
    await w.run(({ polyfillDocument }) => polyfillDocument());

    // Act
    const result = await w.run(() => {
      const video = document.createElement("video");
      return { isHTMLVideoElement: video instanceof HTMLVideoElement, localName: video.localName };
    });

    // Assert
    expect(result).toEqual({ isHTMLVideoElement: true, localName: "video" });
  });

  test("polyfillDocument() rejects other tags", async () => {
    // Arrange
    await w.run(({ polyfillDocument }) => polyfillDocument());

    // Act
    const errorName = await w.run(({ helpers }) => helpers.errorName(() => document.createElement("div")));

    // Assert
    expect(errorName).toBe("NotSupportedError");
  });

  test("the auto entry installs every worker polyfill", async () => {
    // Arrange
    const worker = new Worker(new URL("./auto-worker.ts", import.meta.url), { type: "module" });
    const host = createVideoHost(worker);

    // Act
    const result = await new Promise((resolve) =>
      worker.addEventListener("message", (event) => "documentPolyfilled" in event.data && resolve(event.data)),
    );
    host.dispose();
    worker.terminate();

    // Assert
    expect(result).toEqual({ documentPolyfilled: true, drawImageAcceptsElement: true, texImage2DAcceptsElement: true });
  });
});

describe("loading", () => {
  test("setting src loads the media and mirrors its metadata and first frame", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      const video = createVideoElement();
      const events: string[] = [];
      for (const type of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) {
        video.addEventListener(type, () => events.push(type));
      }
      state.video = video;
      state.events = events;
    });

    // Act
    const result = await w.run(
      async ({ helpers, state }, { src }) => {
        const { video } = state;
        const events = state.events as string[];
        video.src = src;
        await helpers.waitFor(() => events.includes("canplaythrough"));
        const frame = video.currentFrame!;
        return {
          events,
          src: video.src,
          currentSrc: video.currentSrc,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          duration: video.duration,
          readyState: video.readyState,
          frame: {
            width: frame.displayWidth,
            height: frame.displayHeight,
            timestamp: frame.timestamp,
            color: helpers.colorName(helpers.pixelOf(frame)),
          },
          seekable: [video.seekable.length, video.seekable.start(0), video.seekable.end(0)],
          buffered: video.buffered.length > 0,
        };
      },
      { src: fixtures.colors },
    );

    // Assert
    expect(result.events.slice(0, 4)).toEqual(["loadstart", "durationchange", "loadedmetadata", "loadeddata"]);
    expect(result.src).toBe(fixtures.colors);
    expect(result.currentSrc).toBe(fixtures.colors);
    expect(result.videoWidth).toBe(160);
    expect(result.videoHeight).toBe(120);
    expect(result.duration).toBeCloseTo(2, 1);
    expect(result.readyState).toBeGreaterThanOrEqual(2);
    expect(result.frame).toEqual({ width: 160, height: 120, timestamp: 0, color: "red" });
    expect(result.seekable[0]).toBe(1);
    expect(result.seekable[2]).toBeCloseTo(2, 1);
    expect(result.buffered).toBe(true);
  });

  test("relative URLs resolve against the worker script", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    const src = await w.run(({ state }) => {
      state.video.src = "fixtures/colors.webm";
      return state.video.src;
    });

    // Assert
    expect(src).toBe(new URL("./fixtures/colors.webm", new URL("./worker-harness.ts", import.meta.url)).href);
  });

  test("unsupported sources report a MediaError and call onerror", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      const video = createVideoElement();
      state.handlerCalled = false;
      video.onerror = () => {
        state.handlerCalled = true;
      };
      state.video = video;
    });

    // Act
    const result = await w.run(
      async ({ helpers, state }, { src }) => {
        state.video.src = src;
        await helpers.once(state.video, "error");
        return {
          code: state.video.error?.code,
          isMediaError: state.video.error?.MEDIA_ERR_SRC_NOT_SUPPORTED === 4,
          networkState: state.video.networkState,
          handlerCalled: state.handlerCalled,
        };
      },
      { src: `${location.origin}/does-not-exist.webm` },
    );

    // Assert
    expect(result).toEqual({ code: 4, isMediaError: true, networkState: 3, handlerCalled: true });
  });

  test("src = '' drops the frame synchronously", async () => {
    // Arrange
    await arrangeLoadedVideo();

    // Act
    const result = await w.run(({ state }) => {
      state.video.src = "";
      return { readyState: state.video.readyState, frame: state.video.currentFrame };
    });

    // Assert
    expect(result).toEqual({ readyState: 0, frame: null });
  });

  test("removeAttribute('src') + load() unloads the media", async () => {
    // Arrange
    await arrangeLoadedVideo();

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const { video } = state;
      video.removeAttribute("src");
      video.load();
      await helpers.once(video, "emptied");
      await helpers.waitFor(() => video.networkState === video.NETWORK_EMPTY, 2000).catch(() => {});
      return {
        hasAttribute: video.hasAttribute("src"),
        readyState: video.readyState,
        networkState: video.networkState,
        frame: video.currentFrame,
      };
    });

    // Assert
    expect(result).toEqual({ hasAttribute: false, readyState: 0, networkState: realVideo().networkState, frame: null });
  });

  test("switching sources mid-playback never surfaces stale frames or events", async () => {
    // Arrange
    await w.run(
      async ({ createVideoElement, helpers, state }, { src }) => {
        const video = createVideoElement();
        video.muted = true;
        video.loop = true;
        video.src = src;
        await video.play();
        await helpers.sleep(300);
        const seen: string[] = [];
        state.seen = seen;
        state.staleFrames = 0;
        const onFrame = () => {
          if (video.currentFrame?.displayWidth === 160) state.staleFrames = (state.staleFrames as number) + 1;
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        for (const type of ["timeupdate", "emptied", "loadstart", "loadeddata"]) {
          video.addEventListener(type, () => seen.push(`${type}:${video.currentFrame?.displayWidth ?? "none"}`));
        }
        state.video = video;
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(
      async ({ helpers, state }, { src }) => {
        state.video.src = src;
        const syncFrame = state.video.currentFrame;
        await helpers.once(state.video, "loadeddata");
        return {
          syncFrame,
          seen: state.seen as string[],
          staleFrames: state.staleFrames,
          width: state.video.videoWidth,
        };
      },
      { src: fixtures.pattern },
    );

    // Assert
    expect(result.syncFrame).toBeNull();
    expect(result.staleFrames).toBe(0);
    expect(result.seen[0]).toBe("emptied:none");
    expect(result.seen.slice(0, -1).every((entry) => entry.endsWith(":none"))).toBe(true);
    expect(result.seen.at(-1)).toBe("loadeddata:320");
    expect(result.width).toBe(320);
  });

  test("canPlayType answers synchronously", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    const answers = await w.run(({ state }) => [
      state.video.canPlayType("video/webm"),
      state.video.canPlayType('video/webm; codecs="vp9"'),
      state.video.canPlayType("video/x-nope"),
    ]);

    // Assert
    expect(answers).toEqual(["maybe", "probably", ""]);
  });
});

describe("seeking", () => {
  test.each([
    { time: 0.75, timestamp: 700_000, color: "lime" },
    { time: 1.25, timestamp: 1_200_000, color: "blue" },
    { time: 1.75, timestamp: 1_700_000, color: "yellow" },
    { time: 0.25, timestamp: 200_000, color: "red" },
  ])("currentTime = $time exposes the seeked frame inside the seeked handler", async (expected) => {
    // Arrange
    await w.run(
      async ({ polyfillDocument, helpers, state }, { src }) => {
        polyfillDocument();
        const video = document.createElement("video") as unknown as typeof state.video;
        video.src = src;
        await helpers.once(video, "loadedmetadata");
        state.video = video;
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(
      ({ helpers, state }, { time }) =>
        new Promise((resolve) => {
          const { video } = state;
          video.addEventListener("seeked", function handleSeeked() {
            video.removeEventListener("seeked", handleSeeked);
            const frame = video.currentFrame!;
            resolve({
              time: video.currentTime,
              seeking: video.seeking,
              timestamp: frame.timestamp,
              color: helpers.colorName(helpers.pixelOf(frame)),
            });
          });
          video.currentTime = time;
        }),
      { time: expected.time },
    );

    // Assert
    expect(result).toEqual({ ...expected, seeking: false });
  });

  test("setting currentTime is reflected synchronously", async () => {
    // Arrange
    await arrangeLoadedVideo();

    // Act
    const result = await w.run(({ state }) => {
      state.video.currentTime = 1.25;
      return { currentTime: state.video.currentTime, seeking: state.video.seeking };
    });

    // Assert
    expect(result).toEqual({ currentTime: 1.25, seeking: true });
  });

  test.each([
    { name: "a distant previous frame", history: [], time: 1.25, timestamp: 1_200_000, color: "blue" },
    { name: "a nearby previous frame", history: [0.75, 1.25], time: 1.75, timestamp: 1_700_000, color: "yellow" },
  ])("seeked waits for the new frame when the main thread still shows $name", async (scenario) => {
    // Arrange
    await w.run(
      async ({ helpers, state }, { src, history }) => {
        state.video = await helpers.loadVideo(src);
        for (const time of history) await helpers.seekTo(state.video, time);
        const events: string[] = [];
        state.events = events;
        for (const type of ["timeupdate", "seeked"]) state.video.addEventListener(type, () => events.push(type));
      },
      { src: fixtures.colors, history: scenario.history },
    );
    const real = realVideo();
    const NativeVideoFrame = globalThis.VideoFrame;
    const injection = { previous: null as VideoFrame | null, armed: false, count: 0 };
    real.addEventListener("seeking", () => {
      injection.armed = true;
    });
    globalThis.VideoFrame = new Proxy(NativeVideoFrame, {
      construct(target, args: unknown[]) {
        if (args[0] === real && injection.armed && !real.seeking && injection.previous) {
          injection.armed = false;
          injection.count++;
          return new target(injection.previous);
        }
        const frame = Reflect.construct(target, args) as VideoFrame;
        if (args[0] === real) {
          injection.previous?.close();
          injection.previous = new target(frame);
        }
        return frame;
      },
    });
    injection.previous = new NativeVideoFrame(real);

    // Act
    const result = await w.run(
      async ({ helpers, state }, { time }) => {
        await helpers.seekTo(state.video, time);
        const frame = state.video.currentFrame!;
        return {
          timestamp: frame.timestamp,
          color: helpers.colorName(helpers.pixelOf(frame)),
          events: state.events as string[],
        };
      },
      { time: scenario.time },
    );
    globalThis.VideoFrame = NativeVideoFrame;
    injection.previous?.close();

    // Assert
    expect(injection.count).toBeGreaterThan(0);
    expect(result).toEqual({ timestamp: scenario.timestamp, color: scenario.color, events: ["timeupdate", "seeked"] });
  });

  test("stale state from the main thread never overrides a newer local write", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => {
      const observed: number[] = [];
      const seeked: number[] = [];
      state.observed = observed;
      state.seeked = seeked;
      state.video.addEventListener("seeking", () => observed.push(state.video.currentTime));
      state.video.addEventListener("seeked", () => seeked.push(state.video.currentTime));
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      state.video.currentTime = 0.5;
      state.video.currentTime = 1.5;
      await helpers.waitFor(() => (state.seeked as number[]).includes(1.5));
      return {
        observed: state.observed as number[],
        time: state.video.currentTime,
        color: helpers.colorName(helpers.pixelOf(state.video.currentFrame!)),
      };
    });

    // Assert
    expect(result.observed.every((time) => time === 1.5)).toBe(true);
    expect(result.time).toBe(1.5);
    expect(result.color).toBe("yellow");
  });

  test("fastSeek() seeks", async () => {
    // Arrange
    await arrangeLoadedVideo();

    // Act
    const color = await w.run(async ({ helpers, state }) => {
      const seeked = helpers.once(state.video, "seeked");
      state.video.fastSeek(1.1);
      await seeked;
      return helpers.colorName(helpers.pixelOf(state.video.currentFrame!));
    });

    // Assert
    expect(color).toBe("blue");
  });

  test("currentTime rejects non-finite values", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    const errorName = await w.run(({ helpers, state }) =>
      helpers.errorName(() => {
        state.video.currentTime = Number.NaN;
      }),
    );

    // Assert
    expect(errorName).toBe("TypeError");
  });
});

describe("playback", () => {
  test("play() flips paused synchronously", async () => {
    // Arrange
    await arrangeLoadedVideo();

    // Act
    const pausedSync = await w.run(async ({ state }) => {
      const playing = state.video.play();
      const paused = state.video.paused;
      await playing;
      return paused;
    });

    // Assert
    expect(pausedSync).toBe(false);
  });

  test("playing to the end fires media events and updates the state", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => {
      const events: string[] = [];
      state.events = events;
      for (const type of ["play", "playing", "pause", "ended", "timeupdate"]) {
        state.video.addEventListener(type, () => {
          if (events.at(-1) !== type) events.push(type);
        });
      }
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const ended = helpers.once(state.video, "ended");
      await state.video.play();
      await ended;
      return {
        events: state.events as string[],
        ended: state.video.ended,
        paused: state.video.paused,
        currentTime: state.video.currentTime,
        played: state.video.played.length,
        quality: state.video.getVideoPlaybackQuality().totalVideoFrames,
      };
    });

    // Assert
    expect(result.events[0]).toBe("play");
    expect(result.events).toContain("playing");
    expect(result.events.slice(-2)).toEqual(["pause", "ended"]);
    expect(result.ended).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.currentTime).toBeCloseTo(2, 1);
    expect(result.played).toBeGreaterThan(0);
    expect(result.quality).toBeGreaterThan(0);
  });

  test("requestVideoFrameCallback runs for presented frames with matching metadata", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => {
      const callbacks: Array<{ mediaTime: number; frameTimestamp: number; now: number }> = [];
      state.callbacks = callbacks;
      const onFrame = (now: number, metadata: { mediaTime: number }) => {
        callbacks.push({ now, mediaTime: metadata.mediaTime, frameTimestamp: state.video.currentFrame!.timestamp });
        state.video.requestVideoFrameCallback(onFrame);
      };
      state.video.requestVideoFrameCallback(onFrame);
    });

    // Act
    const callbacks = await w.run(async ({ helpers, state }) => {
      const ended = helpers.once(state.video, "ended");
      await state.video.play();
      await ended;
      return state.callbacks as Array<{ mediaTime: number; frameTimestamp: number; now: number }>;
    });

    // Assert
    expect(callbacks.length).toBeGreaterThan(5);
    for (const callback of callbacks) {
      expect(callback.frameTimestamp).toBeCloseTo(callback.mediaTime * 1e6, -4);
      expect(callback.now).toBeGreaterThan(0);
    }
    const mediaTimes = callbacks.map((callback) => callback.mediaTime);
    expect(mediaTimes.toSorted((a, b) => a - b)).toEqual(mediaTimes);
  });

  test("a slow worker gets the latest frame instead of a growing backlog", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => {
      state.video.loop = true;
      state.processed = 0;
      const onFrame = () => {
        state.processed = (state.processed as number) + 1;
        const end = performance.now() + 200;
        while (performance.now() < end) Math.random();
        state.video.requestVideoFrameCallback(onFrame);
      };
      state.video.requestVideoFrameCallback(onFrame);
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      await state.video.play();
      await helpers.sleep(2000);
      return { processed: state.processed as number, timestamp: state.video.currentFrame!.timestamp / 1e6 };
    });
    const real = realVideo();
    const lag = (real.currentTime - result.timestamp + real.duration) % real.duration;

    // Assert
    expect(result.processed).toBeGreaterThan(3);
    expect(result.processed).toBeLessThan(18);
    expect(lag).toBeLessThan(0.45);
  });

  test("pause() stops playback and is reflected synchronously", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(async ({ helpers, state }) => {
      state.video.loop = true;
      await state.video.play();
      await helpers.sleep(300);
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const paused = helpers.once(state.video, "pause");
      state.video.pause();
      const pausedSync = state.video.paused;
      await paused;
      const time = state.video.currentTime;
      await helpers.sleep(300);
      return { pausedSync, paused: state.video.paused, stable: state.video.currentTime === time };
    });

    // Assert
    expect(result).toEqual({ pausedSync: true, paused: true, stable: true });
  });

  test("loop keeps playing past the end", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => {
      state.video.loop = true;
      state.video.playbackRate = 4;
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      await state.video.play();
      let last = 0;
      const wrapped = await helpers.waitFor(() => {
        const wrappedNow = state.video.currentTime < last;
        last = state.video.currentTime;
        return wrappedNow;
      });
      state.video.pause();
      return { wrapped, ended: state.video.ended };
    });

    // Assert
    expect(result).toEqual({ wrapped: true, ended: false });
  });

  test("play() rejects with the main-thread error", async () => {
    // Arrange
    await w.run(
      ({ createVideoElement, state }, { src }) => {
        state.video = createVideoElement();
        state.video.src = src;
      },
      { src: `${location.origin}/does-not-exist.webm` },
    );

    // Act
    const errorName = await w.run(({ state }) =>
      state.video.play().then(
        () => "resolved",
        (error: DOMException) => error.name,
      ),
    );

    // Assert
    expect(errorName).toBe("NotSupportedError");
  });
});

describe("properties", () => {
  test("writable properties are mirrored to the main-thread element", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    await w.run(async ({ helpers, state }) => {
      const { video } = state;
      video.volume = 0.25;
      video.muted = true;
      video.playbackRate = 2;
      video.defaultPlaybackRate = 1.5;
      video.loop = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.playsInline = true;
      video.preservesPitch = false;
      video.width = 320;
      video.height = 240;
      video.poster = "https://example.com/poster.png";
      await helpers.once(video, "ratechange");
    });
    await expect.poll(() => realVideo().poster).toBe("https://example.com/poster.png");
    const video = realVideo();

    // Assert
    expect({
      volume: video.volume,
      muted: video.muted,
      playbackRate: video.playbackRate,
      defaultPlaybackRate: video.defaultPlaybackRate,
      loop: video.loop,
      preload: video.preload,
      crossOrigin: video.crossOrigin,
      playsInline: video.playsInline,
      preservesPitch: video.preservesPitch,
      width: video.width,
      height: video.height,
    }).toEqual({
      volume: 0.25,
      muted: true,
      playbackRate: 2,
      defaultPlaybackRate: 1.5,
      loop: true,
      preload: "auto",
      crossOrigin: "anonymous",
      playsInline: true,
      preservesPitch: false,
      width: 320,
      height: 240,
    });
  });

  test("volume and rate setters fire volumechange and ratechange", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      const video = createVideoElement();
      const events: string[] = [];
      video.onvolumechange = () => events.push("volumechange");
      video.onratechange = () => events.push("ratechange");
      state.video = video;
      state.events = events;
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const events = state.events as string[];
      state.video.volume = 0.25;
      state.video.muted = true;
      state.video.playbackRate = 2;
      state.video.defaultPlaybackRate = 1.5;
      await helpers.waitFor(() => events.length >= 4);
      return {
        events,
        volume: state.video.volume,
        muted: state.video.muted,
        playbackRate: state.video.playbackRate,
      };
    });

    // Assert
    expect(result).toEqual({
      events: ["volumechange", "volumechange", "ratechange", "ratechange"],
      volume: 0.25,
      muted: true,
      playbackRate: 2,
    });
  });

  test("volume outside [0, 1] throws IndexSizeError", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    const errorName = await w.run(({ helpers, state }) =>
      helpers.errorName(() => {
        state.video.volume = 2;
      }),
    );

    // Assert
    expect(errorName).toBe("IndexSizeError");
  });

  test("properties are reflected as attributes", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    const attributes = await w.run(({ state }) => {
      state.video.loop = true;
      state.video.crossOrigin = "anonymous";
      state.video.width = 320;
      return {
        loop: state.video.getAttribute("loop"),
        crossorigin: state.video.getAttribute("crossorigin"),
        width: state.video.getAttribute("width"),
        autoplay: state.video.hasAttribute("autoplay"),
      };
    });

    // Assert
    expect(attributes).toEqual({ loop: "", crossorigin: "anonymous", width: "320", autoplay: false });
  });

  test("setAttribute() updates the reflected properties", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    const properties = await w.run(({ state }) => {
      state.video.setAttribute("loop", "");
      state.video.setAttribute("muted", "");
      state.video.setAttribute("crossorigin", "use-credentials");
      state.video.setAttribute("width", "64");
      return [state.video.loop, state.video.defaultMuted, state.video.crossOrigin, state.video.width];
    });

    // Assert
    expect(properties).toEqual([true, true, "use-credentials", 64]);
  });

  test("removeAttribute() resets the reflected properties", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
      state.video.setAttribute("loop", "");
      state.video.setAttribute("crossorigin", "use-credentials");
    });

    // Act
    const properties = await w.run(({ state }) => {
      state.video.removeAttribute("loop");
      state.video.removeAttribute("crossorigin");
      return [state.video.loop, state.video.crossOrigin];
    });

    // Assert
    expect(properties).toEqual([false, null]);
  });

  test("assigning an on<event> handler replaces the previous one", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      const calls: string[] = [];
      state.calls = calls;
      state.video = createVideoElement();
      state.video.onvolumechange = () => calls.push("first");
      state.video.onvolumechange = () => calls.push("second");
    });

    // Act
    const calls = await w.run(async ({ helpers, state }) => {
      const changed = helpers.once(state.video, "volumechange");
      state.video.volume = 0.5;
      await changed;
      return state.calls as string[];
    });

    // Assert
    expect(calls).toEqual(["second"]);
  });

  test("assigning null to an on<event> handler removes it", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      const calls: string[] = [];
      state.calls = calls;
      state.video = createVideoElement();
      state.video.onvolumechange = () => calls.push("handler");
      state.video.onvolumechange = null;
    });

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const changed = helpers.once(state.video, "volumechange");
      state.video.volume = 0.5;
      await changed;
      return { calls: state.calls as string[], handler: state.video.onvolumechange };
    });

    // Assert
    expect(result).toEqual({ calls: [], handler: null });
  });
});

describe("many elements", () => {
  test("elements are independent", async () => {
    // Arrange
    await w.run(
      async ({ helpers, state }, { src }) => {
        state.videos = await Promise.all([0, 1, 2, 3].map(() => helpers.loadVideo(src)));
      },
      { src: fixtures.colors },
    );

    // Act
    const colors = await w.run(async ({ helpers, state }) => {
      const times = [0.2, 0.7, 1.2, 1.7];
      await Promise.all(state.videos.map((video, index) => helpers.seekTo(video, times[index]!)));
      return state.videos.map((video) => helpers.colorName(helpers.pixelOf(video.currentFrame!)));
    });

    // Assert
    expect(colors).toEqual(["red", "lime", "blue", "yellow"]);
    expect(w.host!.videos.size).toBe(4);
  });
});

describe("cleanup", () => {
  test("dispose() releases the main-thread element and the frame", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await expect.poll(() => w.host!.videos.size).toBe(1);

    // Act
    const result = await w.run(({ state }) => {
      const frame = state.video.currentFrame!;
      state.video.dispose();
      return { disposed: state.video.disposed, frame: state.video.currentFrame, frameClosed: frame.format === null };
    });

    // Assert
    expect(result).toEqual({ disposed: true, frame: null, frameClosed: true });
    await expect.poll(() => w.host!.videos.size).toBe(0);
  });

  test("dispose() can be called twice", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => state.video.dispose());

    // Act
    const errorName = await w.run(({ helpers, state }) => helpers.errorName(() => state.video.dispose()));

    // Assert
    expect(errorName).toBe("no error");
  });

  test("play() after dispose() rejects", async () => {
    // Arrange
    await arrangeLoadedVideo();
    await w.run(({ state }) => state.video.dispose());

    // Act
    const errorName = await w.run(({ state }) =>
      state.video.play().then(
        () => "resolved",
        (error: DOMException) => error.name,
      ),
    );

    // Assert
    expect(errorName).toBe("InvalidStateError");
  });

  test("[Symbol.dispose]() releases the element, so `using` works", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });
    await expect.poll(() => w.host!.videos.size).toBe(1);

    // Act
    await w.run(({ state }) => state.video[Symbol.dispose]());

    // Assert
    await expect.poll(() => w.host!.videos.size).toBe(0);
  });

  test("garbage-collected elements are released automatically", async () => {
    // Arrange
    await w.run(
      async ({ helpers }, { src }) => {
        await helpers.loadVideo(src);
      },
      { src: fixtures.colors },
    );
    await expect.poll(() => w.host!.videos.size).toBe(1);

    // Act
    const collect = async () => {
      await w.run(async () => {
        (globalThis as unknown as { gc: () => void }).gc();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      return w.host!.videos.size;
    };

    // Assert
    await expect.poll(collect, { timeout: 10_000, interval: 100 }).toBe(0);
  });

  test("playing elements are kept alive while unreferenced", async () => {
    // Arrange
    await w.run(
      async ({ helpers }, { src }) => {
        const video = await helpers.loadVideo(src);
        video.loop = true;
        await video.play();
      },
      { src: fixtures.colors },
    );

    // Act
    for (let i = 0; i < 5; i++) {
      await w.run(() => (globalThis as unknown as { gc: () => void }).gc());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Assert
    expect(w.host!.videos.size).toBe(1);
    expect(realVideo().paused).toBe(false);
  });

  test("host.dispose() releases every element", async () => {
    // Arrange
    await w.run(({ createVideoElement, state }) => {
      state.videos = [createVideoElement(), createVideoElement()];
    });
    await expect.poll(() => w.host!.videos.size).toBe(2);

    // Act
    w.host!.dispose();

    // Assert
    expect(w.host!.videos.size).toBe(0);
  });
});

describe("Media Source Extensions", () => {
  test("srcObject accepts a MediaSourceHandle created in the worker", async ({ skip }) => {
    // Arrange
    const supported = await w.run(
      async ({ createVideoElement, state }, { src }) => {
        if (!("MediaSource" in globalThis && "handle" in MediaSource.prototype)) return false;
        state.mediaSource = new MediaSource();
        state.media = await (await fetch(src)).arrayBuffer();
        state.video = createVideoElement();
        return true;
      },
      { src: fixtures.colors },
    );
    if (!supported) skip("MediaSource is not available in workers in this browser");

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const mediaSource = state.mediaSource as MediaSource & { handle: Transferable };
      state.video.srcObject = mediaSource.handle;
      await helpers.once(mediaSource, "sourceopen");
      const buffer = mediaSource.addSourceBuffer('video/webm; codecs="vp9"');
      buffer.appendBuffer(state.media as ArrayBuffer);
      await helpers.once(buffer, "updateend");
      mediaSource.endOfStream();
      await helpers.once(state.video, "loadeddata");
      await helpers.seekTo(state.video, 1.6);
      return {
        srcObjectIsHandle: state.video.srcObject === mediaSource.handle,
        color: helpers.colorName(helpers.pixelOf(state.video.currentFrame!)),
      };
    });

    // Assert
    expect(result).toEqual({ srcObjectIsHandle: true, color: "yellow" });
  });
});
