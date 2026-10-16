import { afterEach, describe, expect, test } from "vitest";
import { startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker | undefined;
afterEach(() => {
  w?.dispose();
  w = undefined;
  for (const element of document.querySelectorAll("[data-page-element]")) element.remove();
});

describe("element id", () => {
  test("an id set right after creation is visible in onVideoCreated", async () => {
    // Arrange
    const slot = document.createElement("div");
    slot.dataset.pageElement = "";
    document.body.append(slot);
    const created: string[] = [];
    w = startWorker({
      hostOptions: {
        onVideoCreated(video) {
          created.push(video.id);
          if (video.id === "preview") slot.append(video);
        },
      },
    });

    // Act
    await w.run(({ createVideoElement, state }) => {
      const preview = createVideoElement();
      preview.id = "preview";
      state.videos = [preview, createVideoElement()];
    });

    // Assert
    await expect.poll(() => created).toEqual(["preview", ""]);
    expect(slot.querySelector("video")?.id).toBe("preview");
  });

  test("document.createElement('video') code works unchanged with an id", async () => {
    // Arrange
    const created: string[] = [];
    w = startWorker({ hostOptions: { onVideoCreated: (video) => created.push(video.id) } });
    await w.run(({ polyfillDocument }) => polyfillDocument());

    // Act
    await w.run(() => {
      const video = document.createElement("video");
      video.id = "legacy";
      video.src = "about:blank";
    });

    // Assert
    await expect.poll(() => created).toEqual(["legacy"]);
  });

  test("the worker element exposes its id", async () => {
    // Arrange
    w = startWorker();

    // Act
    const result = await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      video.id = "preview";
      return { id: video.id, attribute: video.getAttribute("id") };
    });

    // Assert
    expect(result).toEqual({ id: "preview", attribute: "preview" });
  });

  test("setting id in the worker updates the real element", async () => {
    // Arrange
    w = startWorker();
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
    });

    // Act
    await w.run(({ state }) => {
      state.video.id = "renamed";
    });

    // Assert
    await expect.poll(() => [...w!.host!.videos.values()][0]?.id).toBe("renamed");
  });

  test("ids are unique within a worker", async () => {
    // Arrange
    w = startWorker();
    await w.run(({ createVideoElement, state }) => {
      state.video = createVideoElement();
      state.video.id = "preview";
    });

    // Act
    const errorName = await w.run(({ createVideoElement, helpers }) =>
      helpers.errorName(() => {
        createVideoElement().id = "preview";
      }),
    );

    // Assert
    expect(errorName).toBe("InvalidStateError");
  });

  test("an id becomes available again after dispose()", async () => {
    // Arrange
    w = startWorker();
    await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      video.id = "preview";
      video.dispose();
    });

    // Act
    const id = await w.run(({ createVideoElement }) => {
      const video = createVideoElement();
      video.id = "preview";
      return video.id;
    });

    // Assert
    expect(id).toBe("preview");
  });

  test("a connected element reports the page element's id", async () => {
    // Arrange
    const page = document.createElement("video");
    page.id = "player";
    page.dataset.pageElement = "";
    document.body.append(page);
    w = startWorker();

    // Act
    const id = await w.run(async ({ connectToHostVideo }) => (await connectToHostVideo("#player")).id);

    // Assert
    expect(id).toBe("player");
  });
});
