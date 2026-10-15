import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createVideoHost } from "../src/host/index.ts";
import type { WorkerVideoElement } from "../src/worker/index.ts";
import { fixtures, startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker;
beforeEach(() => {
  w = startWorker();
});
afterEach(() => w.dispose());

describe("creation", () => {
  test("createVideoElement() returns an HTMLVideoElement-like object backed by a main-thread <video>", async () => {
    const result = await w.run(({ createVideoElement, WorkerVideoElement }) => {
      const video = createVideoElement();
      return {
        isElement: video instanceof WorkerVideoElement,
        isEventTarget: video instanceof EventTarget,
        tagName: video.tagName,
        paused: video.paused,
        readyState: video.readyState,
        networkState: video.networkState,
        duration: video.duration,
        currentFrame: video.currentFrame,
        constants: [video.HAVE_ENOUGH_DATA, WorkerVideoElement.NETWORK_NO_SOURCE],
      };
    });
    expect(result).toEqual({
      isElement: true,
      isEventTarget: true,
      tagName: "VIDEO",
      paused: true,
      readyState: 0,
      networkState: 0,
      duration: Number.NaN,
      currentFrame: null,
      constants: [4, 3],
    });
    await expect.poll(() => w.host.videos.size).toBe(1);
    expect(w.host.videos.values().next().value).toBeInstanceOf(HTMLVideoElement);
  });

  test("polyfillDocument() makes document.createElement('video') work", async () => {
    const result = await w.run(({ polyfillDocument }) => {
      polyfillDocument();
      const video = document.createElement("video");
      let unsupported = "";
      try {
        document.createElement("div");
      } catch (error) {
        unsupported = (error as DOMException).name;
      }
      return {
        instanceOfHTMLVideoElement: video instanceof HTMLVideoElement,
        localName: video.localName,
        unsupported,
      };
    });
    expect(result).toEqual({ instanceOfHTMLVideoElement: true, localName: "video", unsupported: "NotSupportedError" });
  });

  test("the auto entry installs every polyfill", async () => {
    const worker = new Worker(new URL("./auto-worker.ts", import.meta.url), { type: "module" });
    const host = createVideoHost(worker);
    const result = await new Promise((resolve) =>
      worker.addEventListener("message", (event) => "document" in event.data && resolve(event.data)),
    );
    host.dispose();
    worker.terminate();
    expect(result).toEqual({ document: true, isVideo: true, drawImagePatched: true, texImage2DPatched: true });
  });
});

describe("loading", () => {
  test("mirrors metadata and readiness after loading", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        const events: string[] = [];
        for (const type of [
          "loadstart",
          "durationchange",
          "loadedmetadata",
          "loadeddata",
          "canplay",
          "canplaythrough",
        ]) {
          video.addEventListener(type, () => events.push(type));
        }
        video.src = src;
        await helpers.once(video, "loadeddata");
        await helpers.waitFor(() => events.includes("canplaythrough"));
        return {
          events,
          src: video.src,
          currentSrc: video.currentSrc,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          duration: video.duration,
          readyState: video.readyState,
          networkState: video.networkState,
          frame: video.currentFrame && {
            width: video.currentFrame.displayWidth,
            height: video.currentFrame.displayHeight,
            timestamp: video.currentFrame.timestamp,
            color: helpers.colorName(helpers.pixelOf(video.currentFrame)),
          },
          seekable: [video.seekable.length, video.seekable.start(0), video.seekable.end(0)],
          buffered: video.buffered.length > 0,
        };
      },
      { src: fixtures.colors },
    );
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
    const result = await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      video.src = "fixtures/colors.webm";
      return video.src;
    });
    expect(result).toBe(new URL("./fixtures/colors.webm", new URL("./worker-harness.ts", import.meta.url)).href);
  });

  test("reports errors for unsupported sources", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        let handlerCalled = false;
        video.onerror = () => {
          handlerCalled = true;
        };
        video.src = src;
        await helpers.once(video, "error");
        return {
          code: video.error?.code,
          isMediaError: video.error?.MEDIA_ERR_SRC_NOT_SUPPORTED === 4,
          networkState: video.networkState,
          handlerCalled,
        };
      },
      { src: `${location.origin}/does-not-exist.webm` },
    );
    expect(result).toEqual({ code: 4, isMediaError: true, networkState: 3, handlerCalled: true });
  });

  test("src = '' and removeAttribute('src') + load() unload the media and drop the frame", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.src = src;
        await helpers.once(video, "loadeddata");
        const before = video.currentFrame !== null;

        video.src = "";
        const syncAfterEmpty = { readyState: video.readyState, frame: video.currentFrame };
        await helpers.once(video, "emptied");

        video.src = src;
        await helpers.once(video, "loadeddata");
        video.removeAttribute("src");
        video.load();
        await helpers.once(video, "emptied");
        // networkState settles after a stable state, without an event.
        await helpers.sleep(50);
        return {
          before,
          syncAfterEmpty,
          hasAttribute: video.hasAttribute("src"),
          readyState: video.readyState,
          networkState: video.networkState,
          frame: video.currentFrame,
        };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({
      before: true,
      syncAfterEmpty: { readyState: 0, frame: null },
      hasAttribute: false,
      readyState: 0,
      networkState: [...w.host.videos.values()][0]!.networkState,
      frame: null,
    });
  });

  test("switching sources mid-playback never surfaces stale frames or events", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { colors, pattern }) => {
        const video = createVideoElement();
        video.muted = true;
        video.loop = true;
        video.src = colors;
        await video.play();
        await helpers.sleep(300);

        const seen: string[] = [];
        let staleFrames = 0;
        const onFrame = () => {
          if (video.currentFrame?.displayWidth === 160) staleFrames++;
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        for (const type of ["timeupdate", "emptied", "loadstart", "loadeddata"]) {
          video.addEventListener(type, () => {
            seen.push(`${type}:${video.currentFrame?.displayWidth ?? "none"}`);
          });
        }
        video.src = pattern;
        const syncFrame = video.currentFrame;
        await helpers.once(video, "loadeddata");
        return {
          syncFrame,
          staleFrames,
          first: seen[0],
          // The load algorithm itself fires timeupdate (position reset to 0); none may carry an old frame.
          noFrameBeforeLoaded: seen.slice(0, -1).every((entry) => entry.endsWith(":none")),
          last: seen.at(-1),
          width: video.videoWidth,
        };
      },
      { colors: fixtures.colors, pattern: fixtures.pattern },
    );
    expect(result).toEqual({
      syncFrame: null,
      staleFrames: 0,
      first: "emptied:none",
      noFrameBeforeLoaded: true,
      last: "loadeddata:320",
      width: 320,
    });
  });

  test("canPlayType answers synchronously", async () => {
    const result = await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      return [
        video.canPlayType("video/webm"),
        video.canPlayType('video/webm; codecs="vp9"'),
        video.canPlayType("video/x-nope"),
      ];
    });
    expect(result).toEqual(["maybe", "probably", ""]);
  });
});

describe("seeking", () => {
  test("the snippet from the README: currentTime + seeked + synchronous frame access", async () => {
    const result = await w.run(
      async ({ helpers, polyfillDocument }, { src }) => {
        polyfillDocument();
        const video = document.createElement("video") as unknown as WorkerVideoElement;
        video.src = src;
        await helpers.once(video, "loadedmetadata");

        const results: unknown[] = [];
        for (const newTime of [0.75, 1.25, 1.75, 0.25]) {
          const seeked = new Promise<void>((resolve) => {
            const handleSeeked = () => {
              video.removeEventListener("seeked", handleSeeked);
              const frame = video.currentFrame!;
              results.push({
                time: video.currentTime,
                seeking: video.seeking,
                timestamp: frame.timestamp,
                color: helpers.colorName(helpers.pixelOf(frame)),
              });
              resolve();
            };
            video.addEventListener("seeked", handleSeeked);
          });
          video.currentTime = newTime;
          results.push({ syncTime: video.currentTime, syncSeeking: video.seeking });
          await seeked;
        }
        return results;
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual([
      { syncTime: 0.75, syncSeeking: true },
      { time: 0.75, seeking: false, timestamp: 700_000, color: "lime" },
      { syncTime: 1.25, syncSeeking: true },
      { time: 1.25, seeking: false, timestamp: 1_200_000, color: "blue" },
      { syncTime: 1.75, syncSeeking: true },
      { time: 1.75, seeking: false, timestamp: 1_700_000, color: "yellow" },
      { syncTime: 0.25, syncSeeking: true },
      { time: 0.25, seeking: false, timestamp: 200_000, color: "red" },
    ]);
  });

  test("stale state from the main thread never overrides a newer local write", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.src = src;
        await helpers.once(video, "loadeddata");
        const observed: number[] = [];
        const seeked: number[] = [];
        video.addEventListener("seeking", () => observed.push(video.currentTime));
        video.addEventListener("seeked", () => seeked.push(video.currentTime));
        video.currentTime = 0.5;
        video.currentTime = 1.5;
        await helpers.waitFor(() => seeked.includes(1.5));
        return { observed, time: video.currentTime, color: helpers.colorName(helpers.pixelOf(video.currentFrame!)) };
      },
      { src: fixtures.colors },
    );
    expect(result.observed.every((time) => time === 1.5)).toBe(true);
    expect(result.time).toBe(1.5);
    expect(result.color).toBe("yellow");
  });

  test("fastSeek seeks", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.src = src;
        await helpers.once(video, "loadeddata");
        video.fastSeek(1.1);
        await helpers.once(video, "seeked");
        return helpers.colorName(helpers.pixelOf(video.currentFrame!));
      },
      { src: fixtures.colors },
    );
    expect(result).toBe("blue");
  });

  test("currentTime rejects non-finite values", async () => {
    const result = await w.run(({ createVideoElement }) => {
      try {
        createVideoElement().currentTime = Number.NaN;
        return "no error";
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(result).toBe("TypeError");
  });
});

describe("playback", () => {
  test("play() / pause() / ended with events, frames and requestVideoFrameCallback", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.muted = true;
        video.src = src;
        await helpers.once(video, "canplay");
        const events: string[] = [];
        for (const type of ["play", "playing", "pause", "ended", "timeupdate"]) {
          video.addEventListener(type, () => {
            if (events.at(-1) !== type) events.push(type);
          });
        }
        const callbacks: Array<{ mediaTime: number; frameTimestamp: number; now: number }> = [];
        const onFrame = (now: number, metadata: { mediaTime: number }) => {
          callbacks.push({ now, mediaTime: metadata.mediaTime, frameTimestamp: video.currentFrame!.timestamp });
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);

        const playPromise = video.play();
        const pausedSync = video.paused;
        await playPromise;
        await helpers.once(video, "ended");
        return {
          pausedSync,
          events,
          ended: video.ended,
          paused: video.paused,
          currentTime: video.currentTime,
          callbacks,
          played: video.played.length,
          quality: video.getVideoPlaybackQuality().totalVideoFrames,
        };
      },
      { src: fixtures.colors },
    );
    expect(result.pausedSync).toBe(false);
    expect(result.events[0]).toBe("play");
    expect(result.events).toContain("playing");
    expect(result.events.slice(-2)).toEqual(["pause", "ended"]);
    expect(result.ended).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.currentTime).toBeCloseTo(2, 1);
    expect(result.callbacks.length).toBeGreaterThan(5);
    for (const callback of result.callbacks) {
      expect(callback.frameTimestamp).toBeCloseTo(callback.mediaTime * 1e6, -4);
      expect(callback.now).toBeGreaterThan(0);
    }
    const mediaTimes = result.callbacks.map((callback) => callback.mediaTime);
    expect(mediaTimes.toSorted((a, b) => a - b)).toEqual(mediaTimes);
    expect(result.played).toBeGreaterThan(0);
    expect(result.quality).toBeGreaterThan(0);
  });

  test("pause() stops playback and is reflected synchronously", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.muted = true;
        video.loop = true;
        video.src = src;
        await video.play();
        await helpers.sleep(300);
        video.pause();
        const pausedSync = video.paused;
        await helpers.once(video, "pause");
        const time = video.currentTime;
        await helpers.sleep(300);
        return { pausedSync, paused: video.paused, stable: video.currentTime === time };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ pausedSync: true, paused: true, stable: true });
  });

  test("loop keeps playing past the end", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.muted = true;
        video.loop = true;
        video.playbackRate = 4;
        video.src = src;
        await video.play();
        let wrapped = false;
        let last = 0;
        await helpers.waitFor(() => {
          if (video.currentTime < last) wrapped = true;
          last = video.currentTime;
          return wrapped;
        });
        video.pause();
        return { wrapped, ended: video.ended };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ wrapped: true, ended: false });
  });

  test("play() rejects with the main-thread error", async () => {
    const result = await w.run(
      async ({ createVideoElement }, { src }) => {
        const video = createVideoElement();
        video.src = src;
        try {
          await video.play();
          return "resolved";
        } catch (error) {
          return (error as DOMException).name;
        }
      },
      { src: `${location.origin}/does-not-exist.webm` },
    );
    expect(result).toBe("NotSupportedError");
  });
});

describe("properties", () => {
  test("writable properties are mirrored to the main-thread element", async () => {
    const result = await w.run(async ({ createVideoElement, helpers }) => {
      const video = createVideoElement();
      const events: string[] = [];
      video.onvolumechange = () => events.push("volumechange");
      video.onratechange = () => events.push("ratechange");
      video.volume = 0.25;
      video.muted = true;
      video.playbackRate = 2;
      video.defaultPlaybackRate = 1.5;
      video.loop = true;
      video.autoplay = false;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.playsInline = true;
      video.preservesPitch = false;
      video.width = 320;
      video.height = 240;
      video.poster = "https://example.com/poster.png";
      await helpers.waitFor(() => events.length >= 4);
      let rangeError = "";
      try {
        video.volume = 2;
      } catch (error) {
        rangeError = (error as DOMException).name;
      }
      return {
        events,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate,
        rangeError,
        attributes: {
          loop: video.getAttribute("loop"),
          crossorigin: video.getAttribute("crossorigin"),
          width: video.getAttribute("width"),
          autoplay: video.hasAttribute("autoplay"),
        },
      };
    });
    expect(result).toEqual({
      // Both playbackRate and defaultPlaybackRate fire ratechange.
      events: ["volumechange", "volumechange", "ratechange", "ratechange"],
      volume: 0.25,
      muted: true,
      playbackRate: 2,
      rangeError: "IndexSizeError",
      attributes: { loop: "", crossorigin: "anonymous", width: "320", autoplay: false },
    });
    const video = [...w.host.videos.values()][0]!;
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
      poster: video.poster,
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
      poster: "https://example.com/poster.png",
    });
  });

  test("setAttribute / removeAttribute reflect to properties", async () => {
    const result = await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      video.setAttribute("loop", "");
      video.setAttribute("muted", "");
      video.setAttribute("crossorigin", "use-credentials");
      video.setAttribute("width", "64");
      const set = [video.loop, video.defaultMuted, video.crossOrigin, video.width];
      video.removeAttribute("loop");
      video.removeAttribute("crossorigin");
      return { set, removed: [video.loop, video.crossOrigin] };
    });
    expect(result).toEqual({ set: [true, true, "use-credentials", 64], removed: [false, null] });
  });

  test("on<event> handler properties replace each other", async () => {
    const result = await w.run(async ({ createVideoElement, helpers }) => {
      const video = createVideoElement();
      const calls: string[] = [];
      video.onvolumechange = () => calls.push("first");
      video.onvolumechange = () => calls.push("second");
      video.volume = 0.5;
      await helpers.once(video, "volumechange");
      video.onvolumechange = null;
      video.volume = 0.6;
      await helpers.once(video, "volumechange");
      return { calls, handler: video.onvolumechange };
    });
    expect(result).toEqual({ calls: ["second"], handler: null });
  });
});

describe("many elements", () => {
  test("elements are independent", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const times = [0.2, 0.7, 1.2, 1.7];
        const videos = times.map(() => createVideoElement());
        for (const video of videos) video.src = src;
        await Promise.all(videos.map((video) => helpers.once(video, "loadeddata")));
        await Promise.all(
          videos.map((video, index) => {
            video.currentTime = times[index]!;
            return helpers.once(video, "seeked");
          }),
        );
        return videos.map((video) => helpers.colorName(helpers.pixelOf(video.currentFrame!)));
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual(["red", "lime", "blue", "yellow"]);
    expect(w.host.videos.size).toBe(4);
  });
});

describe("cleanup", () => {
  test("dispose() releases the main-thread element and the frame", async () => {
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const video = createVideoElement();
        video.src = src;
        await helpers.once(video, "loadeddata");
        const frame = video.currentFrame!;
        video.dispose();
        video.dispose();
        let playError = "";
        try {
          await video.play();
        } catch (error) {
          playError = (error as DOMException).name;
        }
        return { disposed: video.disposed, frame: video.currentFrame, frameClosed: frame.format === null, playError };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ disposed: true, frame: null, frameClosed: true, playError: "InvalidStateError" });
    await expect.poll(() => w.host.videos.size).toBe(0);
  });

  test("`using` disposes at the end of the scope", async () => {
    await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      video[Symbol.dispose]();
    });
    await expect.poll(() => w.host.videos.size).toBe(0);
  });

  test("garbage-collected elements are released automatically", async () => {
    await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        await (async () => {
          const video = createVideoElement();
          video.src = src;
          await helpers.once(video, "loadeddata");
        })();
      },
      { src: fixtures.colors },
    );
    await expect.poll(() => w.host.videos.size).toBe(1);
    await expect
      .poll(
        async () => {
          await w.run(async () => {
            (globalThis as unknown as { gc: () => void }).gc();
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
          return w.host.videos.size;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe(0);
  });

  test("playing elements are kept alive while unreferenced", async () => {
    await w.run(
      async ({ createVideoElement }, { src }) => {
        const video = createVideoElement();
        video.muted = true;
        video.loop = true;
        video.src = src;
        await video.play();
      },
      { src: fixtures.colors },
    );
    for (let i = 0; i < 5; i++) {
      await w.run(() => (globalThis as unknown as { gc: () => void }).gc());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(w.host.videos.size).toBe(1);
    expect([...w.host.videos.values()][0]!.paused).toBe(false);
  });

  test("host.dispose() releases everything", async () => {
    await w.run(({ createVideoElement }) => {
      createVideoElement();
      createVideoElement();
    });
    await expect.poll(() => w.host.videos.size).toBe(2);
    w.host.dispose();
    expect(w.host.videos.size).toBe(0);
  });
});

describe("Media Source Extensions", () => {
  test("srcObject accepts a MediaSourceHandle created in the worker", async () => {
    const supported = await w.run(() => "MediaSource" in globalThis && "handle" in MediaSource.prototype);
    if (!supported) return;
    const result = await w.run(
      async ({ createVideoElement, helpers }, { src }) => {
        const mediaSource = new MediaSource() as MediaSource & { handle: Transferable };
        const video = createVideoElement();
        video.srcObject = mediaSource.handle;
        await helpers.once(mediaSource, "sourceopen");
        const buffer = mediaSource.addSourceBuffer('video/webm; codecs="vp9"');
        buffer.appendBuffer(await (await fetch(src)).arrayBuffer());
        await helpers.once(buffer, "updateend");
        mediaSource.endOfStream();
        await helpers.once(video, "loadeddata");
        video.currentTime = 1.6;
        await helpers.once(video, "seeked");
        return {
          srcObjectIsHandle: video.srcObject === mediaSource.handle,
          color: helpers.colorName(helpers.pixelOf(video.currentFrame!)),
        };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ srcObjectIsHandle: true, color: "yellow" });
  });
});
