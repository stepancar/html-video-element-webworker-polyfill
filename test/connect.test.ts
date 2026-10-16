import { afterEach, describe, expect, test } from "vitest";
import { fixtures, startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker | undefined;
afterEach(() => {
  w?.dispose();
  w = undefined;
  for (const element of document.querySelectorAll("[data-page-element]")) element.remove();
});

async function pageVideo(id: string, src?: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.id = id;
  video.muted = true;
  video.dataset.pageElement = "";
  document.body.append(video);
  if (src) {
    const loaded = new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
    video.src = src;
    await loaded;
  }
  return video;
}

async function connect(selector: string): Promise<void> {
  await w!.run(
    async ({ connectToHostVideo, state }, args) => {
      state.video = await connectToHostVideo(args.selector);
    },
    { selector },
  );
}

async function connectError(selector: string): Promise<string> {
  return w!.run(
    ({ connectToHostVideo }, args) =>
      connectToHostVideo(args.selector).then(
        () => "connected",
        (error: DOMException) => error.name,
      ),
    { selector },
  );
}

describe("connectToHostVideo()", () => {
  test("takes control of an existing <video> and mirrors its state and current frame", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    w = startWorker();

    // Act
    const result = await w.run(async ({ connectToHostVideo, helpers }) => {
      const video = await connectToHostVideo("#player");
      return {
        src: video.src,
        duration: video.duration,
        videoWidth: video.videoWidth,
        readyState: video.readyState,
        muted: video.muted,
        color: helpers.colorName(helpers.pixelOf(video.currentFrame!)),
      };
    });

    // Assert
    expect(result.src).toBe(fixtures.colors);
    expect(result.duration).toBeCloseTo(2, 1);
    expect(result.videoWidth).toBe(160);
    expect(result.readyState).toBeGreaterThanOrEqual(2);
    expect(result.muted).toBe(true);
    expect(result.color).toBe("red");
    expect([...w.host!.videos.values()]).toEqual([page]);
    expect(document.querySelectorAll("video")).toHaveLength(1);
  });

  test("setting currentTime in the worker seeks the page's element", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    w = startWorker();
    await connect("#player");

    // Act
    const color = await w.run(async ({ helpers, state }) => {
      await helpers.seekTo(state.video, 1.25);
      return helpers.colorName(helpers.pixelOf(state.video.currentFrame!));
    });

    // Assert
    expect(page.currentTime).toBe(1.25);
    expect(color).toBe("blue");
  });

  test("play() in the worker plays the page's element", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    w = startWorker();
    await connect("#player");

    // Act
    await w.run(({ state }) => state.video.play());

    // Assert
    expect(page.paused).toBe(false);
  });

  test("changes made by the page reach the worker", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    w = startWorker();
    await connect("#player");
    await w.run(({ helpers, state }) => {
      state.seeked = helpers.once(state.video, "seeked");
    });

    // Act
    page.loop = true;
    page.volume = 0.3;
    page.currentTime = 0.75;
    const result = await w.run(async ({ helpers, state }) => {
      await state.seeked;
      return {
        loop: state.video.loop,
        volume: state.video.volume,
        currentTime: state.video.currentTime,
        color: helpers.colorName(helpers.pixelOf(state.video.currentFrame!)),
      };
    });

    // Assert
    expect(result).toEqual({ loop: true, volume: 0.3, currentTime: 0.75, color: "lime" });
  });

  test("playback started by the page fires events in the worker", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    w = startWorker();
    await connect("#player");
    await w.run(({ helpers, state }) => {
      state.playing = helpers.once(state.video, "playing");
    });

    // Act
    await page.play();
    const paused = await w.run(async ({ state }) => {
      await state.playing;
      return state.video.paused;
    });

    // Assert
    expect(paused).toBe(false);
  });

  test("loading started by the page delivers frames to the worker", async () => {
    // Arrange
    const page = await pageVideo("player");
    w = startWorker();
    await connect("#player");
    await w.run(({ helpers, state }) => {
      state.loaded = helpers.once(state.video, "loadeddata");
    });

    // Act
    page.src = fixtures.colors;
    const color = await w.run(async ({ helpers, state }) => {
      await state.loaded;
      return helpers.colorName(helpers.pixelOf(state.video.currentFrame!));
    });

    // Assert
    expect(color).toBe("red");
  });

  test("dispose() releases control and leaves the page's element untouched", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    page.loop = true;
    await page.play();
    w = startWorker();
    await connect("#player");

    // Act
    await w.run(({ state }) => state.video.dispose());

    // Assert
    await expect.poll(() => w!.host!.videos.size).toBe(0);
    expect(page.isConnected).toBe(true);
    expect(page.src).toBe(fixtures.colors);
    expect(page.paused).toBe(false);
  });

  test("host.dispose() leaves connected elements untouched", async () => {
    // Arrange
    const page = await pageVideo("player", fixtures.colors);
    w = startWorker();
    await connect("#player");

    // Act
    w.host!.dispose();

    // Assert
    expect(page.isConnected).toBe(true);
    expect(page.src).toBe(fixtures.colors);
    expect(page.readyState).toBeGreaterThanOrEqual(2);
  });

  test("rejects with NotFoundError when nothing matches the selector", async () => {
    // Arrange
    w = startWorker();

    // Act
    const errorName = await connectError("#missing");

    // Assert
    expect(errorName).toBe("NotFoundError");
  });

  test("rejects with InvalidNodeTypeError when the selector matches something else", async () => {
    // Arrange
    const div = document.createElement("div");
    div.id = "not-a-video";
    div.dataset.pageElement = "";
    document.body.append(div);
    w = startWorker();

    // Act
    const errorName = await connectError("#not-a-video");

    // Assert
    expect(errorName).toBe("InvalidNodeTypeError");
  });

  test("rejects with SyntaxError for an invalid selector", async () => {
    // Arrange
    w = startWorker();

    // Act
    const errorName = await connectError("##");

    // Assert
    expect(errorName).toBe("SyntaxError");
  });

  test("rejects with NotAllowedError when the host refuses the connection", async () => {
    // Arrange
    await pageVideo("player", fixtures.colors);
    w = startWorker({ hostOptions: { canConnect: (_video, selector) => selector !== "#player" } });

    // Act
    const errorName = await connectError("#player");

    // Assert
    expect(errorName).toBe("NotAllowedError");
    expect(w.host!.videos.size).toBe(0);
  });

  test("throws a TypeError for an empty selector", async () => {
    // Arrange
    w = startWorker();

    // Act
    const errorName = await w.run(({ connectToHostVideo, helpers }) => helpers.errorName(() => connectToHostVideo("")));

    // Assert
    expect(errorName).toBe("TypeError");
  });
});
