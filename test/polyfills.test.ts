import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fixtures, startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker;
beforeEach(() => {
  w = startWorker();
});
afterEach(() => w.dispose());

describe("Canvas 2D", () => {
  test("drawImage(video, dx, dy) draws the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfill2dCanvasApi, helpers, state }, { src }) => {
        polyfill2dCanvasApi();
        state.video = await helpers.loadVideo(src, 0.6);
      },
      { src: fixtures.colors },
    );

    // Act
    const color = await w.run(({ helpers, state }) => {
      const ctx = new OffscreenCanvas(160, 120).getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(state.video as unknown as CanvasImageSource, 0, 0);
      return helpers.canvasColor(ctx, 80, 60);
    });

    // Assert
    expect(color).toBe("lime");
  });

  test("drawImage(video, dx, dy, dw, dh) scales the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfill2dCanvasApi, helpers, state }, { src }) => {
        polyfill2dCanvasApi();
        state.video = await helpers.loadVideo(src, 1.1);
      },
      { src: fixtures.colors },
    );

    // Act
    const colors = await w.run(({ helpers, state }) => {
      const ctx = new OffscreenCanvas(160, 120).getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(state.video as unknown as CanvasImageSource, 0, 0, 80, 120);
      return [helpers.canvasColor(ctx, 40, 60), helpers.canvasColor(ctx, 120, 60)];
    });

    // Assert
    expect(colors).toEqual(["blue", "black"]);
  });

  test("drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh) draws a region of the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfill2dCanvasApi, helpers, state }, { src }) => {
        polyfill2dCanvasApi();
        state.video = await helpers.loadVideo(src, 1.6);
      },
      { src: fixtures.colors },
    );

    // Act
    const colors = await w.run(({ helpers, state }) => {
      const ctx = new OffscreenCanvas(160, 120).getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(state.video as unknown as CanvasImageSource, 0, 0, 160, 120, 80, 0, 80, 120);
      return [helpers.canvasColor(ctx, 40, 60), helpers.canvasColor(ctx, 120, 60)];
    });

    // Assert
    expect(colors).toEqual(["black", "yellow"]);
  });

  test("drawImage(video) is a no-op while the element has no data", async () => {
    // Arrange
    await w.run(({ createVideoElement, polyfill2dCanvasApi, state }) => {
      polyfill2dCanvasApi();
      state.video = createVideoElement();
    });

    // Act
    const pixel = await w.run(({ state }) => {
      const ctx = new OffscreenCanvas(4, 4).getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(state.video as unknown as CanvasImageSource, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    });

    // Assert
    expect(pixel).toEqual([0, 0, 0, 0]);
  });

  test("createPattern(video) uses the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfill2dCanvasApi, helpers, state }, { src }) => {
        polyfill2dCanvasApi();
        state.video = await helpers.loadVideo(src);
      },
      { src: fixtures.colors },
    );

    // Act
    const color = await w.run(({ helpers, state }) => {
      const ctx = new OffscreenCanvas(400, 300).getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = ctx.createPattern(state.video as unknown as CanvasImageSource, "repeat")!;
      ctx.fillRect(0, 0, 400, 300);
      return helpers.canvasColor(ctx, 300, 250);
    });

    // Assert
    expect(color).toBe("red");
  });

  test("createPattern(video) returns null while the element has no data", async () => {
    // Arrange
    await w.run(({ createVideoElement, polyfill2dCanvasApi, state }) => {
      polyfill2dCanvasApi();
      state.video = createVideoElement();
    });

    // Act
    const pattern = await w.run(({ state }) =>
      new OffscreenCanvas(4, 4).getContext("2d")!.createPattern(state.video as unknown as CanvasImageSource, "repeat"),
    );

    // Assert
    expect(pattern).toBeNull();
  });
});

describe("createImageBitmap", () => {
  test("createImageBitmap(video) snapshots the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfillCreateImageBitmap, helpers, state }, { src }) => {
        polyfillCreateImageBitmap();
        state.video = await helpers.loadVideo(src, 1.2);
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      const bitmap = await createImageBitmap(state.video as unknown as ImageBitmapSource);
      return { size: [bitmap.width, bitmap.height], color: helpers.colorName(helpers.pixelOf(bitmap)) };
    });

    // Assert
    expect(result).toEqual({ size: [160, 120], color: "blue" });
  });

  test("createImageBitmap(video, sx, sy, sw, sh) crops the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfillCreateImageBitmap, helpers, state }, { src }) => {
        polyfillCreateImageBitmap();
        state.video = await helpers.loadVideo(src);
      },
      { src: fixtures.colors },
    );

    // Act
    const size = await w.run(async ({ state }) => {
      const bitmap = await createImageBitmap(state.video as unknown as ImageBitmapSource, 10, 10, 20, 30);
      return [bitmap.width, bitmap.height];
    });

    // Assert
    expect(size).toEqual([20, 30]);
  });

  test("createImageBitmap(video) rejects while the element has no data", async () => {
    // Arrange
    await w.run(({ createVideoElement, polyfillCreateImageBitmap, state }) => {
      polyfillCreateImageBitmap();
      state.video = createVideoElement();
    });

    // Act
    const errorName = await w.run(({ state }) =>
      createImageBitmap(state.video as unknown as ImageBitmapSource).then(
        () => "resolved",
        (error: DOMException) => error.name,
      ),
    );

    // Assert
    expect(errorName).toBe("InvalidStateError");
  });
});

describe("VideoFrame", () => {
  test("new VideoFrame(video, init) copies the current frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfillVideoFrame, helpers, state }, { src }) => {
        polyfillVideoFrame();
        state.video = await helpers.loadVideo(src, 0.6);
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(({ helpers, state }) => {
      const copy = new VideoFrame(state.video as unknown as CanvasImageSource, { timestamp: 42 });
      return {
        timestamp: copy.timestamp,
        isVideoFrame: copy instanceof VideoFrame,
        sameProto: Object.getPrototypeOf(copy) === VideoFrame.prototype,
        color: helpers.colorName(helpers.pixelOf(copy)),
      };
    });

    // Assert
    expect(result).toEqual({ timestamp: 42, isVideoFrame: true, sameProto: true, color: "lime" });
  });

  test("a copied VideoFrame outlives the element moving to another frame", async () => {
    // Arrange
    await w.run(
      async ({ polyfillVideoFrame, helpers, state }, { src }) => {
        polyfillVideoFrame();
        state.video = await helpers.loadVideo(src, 0.6);
        state.copy = new VideoFrame(state.video as unknown as CanvasImageSource);
        state.previous = state.video.currentFrame;
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(async ({ helpers, state }) => {
      await helpers.seekTo(state.video, 1.6);
      return {
        copyColor: helpers.colorName(helpers.pixelOf(state.copy as VideoFrame)),
        previousClosed: (state.previous as VideoFrame).format === null,
        currentIsVideoFrame: state.video.currentFrame instanceof VideoFrame,
      };
    });

    // Assert
    expect(result).toEqual({ copyColor: "lime", previousClosed: true, currentIsVideoFrame: true });
  });

  test("new VideoFrame(video) throws while the element has no data", async () => {
    // Arrange
    await w.run(({ createVideoElement, polyfillVideoFrame, state }) => {
      polyfillVideoFrame();
      state.video = createVideoElement();
    });

    // Act
    const errorName = await w.run(({ helpers, state }) =>
      helpers.errorName(() => new VideoFrame(state.video as unknown as CanvasImageSource)),
    );

    // Assert
    expect(errorName).toBe("InvalidStateError");
  });
});

describe("WebGL", () => {
  test("WebGL 1 texImage2D(target, level, internalformat, format, type, video)", async () => {
    // Arrange
    await w.run(
      async ({ polyfillWebglAPI, helpers, state }, { src }) => {
        polyfillWebglAPI();
        state.video = await helpers.loadVideo(src, 0.2);
      },
      { src: fixtures.colors },
    );

    // Act
    const color = await w.run(({ helpers, state }) => {
      const gl = new OffscreenCanvas(1, 1).getContext("webgl")!;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.video as unknown as TexImageSource);
      return helpers.textureColor(gl, () =>
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0),
      );
    });

    // Assert
    expect(color).toBe("red");
  });

  test("WebGL 1 texSubImage2D(target, level, x, y, format, type, video)", async () => {
    // Arrange
    await w.run(
      async ({ polyfillWebglAPI, helpers, state }, { src }) => {
        polyfillWebglAPI();
        state.video = await helpers.loadVideo(src, 0.2);
        const gl = new OffscreenCanvas(1, 1).getContext("webgl")!;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.video as unknown as TexImageSource);
        state.gl = gl;
        state.texture = texture;
        await helpers.seekTo(state.video, 0.7);
      },
      { src: fixtures.colors },
    );

    // Act
    const color = await w.run(({ helpers, state }) => {
      const gl = state.gl as WebGLRenderingContext;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, state.video as unknown as TexImageSource);
      return helpers.textureColor(gl, () =>
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.texture as WebGLTexture, 0),
      );
    });

    // Assert
    expect(color).toBe("lime");
  });

  test("WebGL 2 texImage2D(target, level, internalformat, width, height, border, format, type, video)", async () => {
    // Arrange
    await w.run(
      async ({ polyfillWebglAPI, helpers, state }, { src }) => {
        polyfillWebglAPI();
        state.video = await helpers.loadVideo(src, 1.2);
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(({ helpers, state }) => {
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2")!;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        160,
        120,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        state.video as unknown as TexImageSource,
      );
      const color = helpers.textureColor(gl, () =>
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0),
      );
      return { color, error: gl.getError() };
    });

    // Assert
    expect(result).toEqual({ color: "blue", error: 0 });
  });

  test("WebGL 2 texImage3D uploads the current frame into a texture array", async () => {
    // Arrange
    await w.run(
      async ({ polyfillWebglAPI, helpers, state }, { src }) => {
        polyfillWebglAPI();
        state.video = await helpers.loadVideo(src, 1.7);
      },
      { src: fixtures.colors },
    );

    // Act
    const result = await w.run(({ helpers, state }) => {
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2")!;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.RGBA8,
        160,
        120,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        state.video as unknown as TexImageSource,
      );
      const color = helpers.textureColor(gl, () =>
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, 0),
      );
      return { color, error: gl.getError() };
    });

    // Assert
    expect(result).toEqual({ color: "yellow", error: 0 });
  });

  test("uploads are skipped while the element has no data", async () => {
    // Arrange
    await w.run(({ createVideoElement, polyfillWebglAPI, state }) => {
      polyfillWebglAPI();
      state.video = createVideoElement();
    });

    // Act
    const error = await w.run(({ state }) => {
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2")!;
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.video as unknown as TexImageSource);
      return gl.getError();
    });

    // Assert
    expect(error).toBe(0);
  });
});

describe("WebGPU", () => {
  test("copyExternalImageToTexture({ source: video }) copies the current frame", async ({ skip }) => {
    // Arrange
    const capable = await w.run(
      async ({ polyfillWebgpu, helpers, state }, { src }) => {
        const device = await helpers.gpuDevice();
        if (!device) return false;
        polyfillWebgpu();
        state.device = device;
        state.video = await helpers.loadVideo(src, 0.7);
        return true;
      },
      { src: fixtures.colors },
    );
    if (!capable) skip("WebGPU cannot import external images in this browser environment");

    // Act
    const color = await w.run(async ({ helpers, state }) => {
      const device = state.device as GPUDevice;
      const texture = helpers.gpuTexture(device);
      device.queue.copyExternalImageToTexture(
        { source: state.video as unknown as GPUCopyExternalImageSource },
        { texture },
        [160, 120],
      );
      return helpers.gpuTextureColor(device, texture);
    });

    // Assert
    expect(color).toBe("lime");
  });

  test("importExternalTexture({ source: video }) samples the current frame", async ({ skip }) => {
    // Arrange
    const capable = await w.run(
      async ({ polyfillWebgpu, helpers, state }, { src }) => {
        const device = await helpers.gpuDevice();
        if (!device) return false;
        polyfillWebgpu();
        state.device = device;
        state.video = await helpers.loadVideo(src, 1.2);
        return true;
      },
      { src: fixtures.colors },
    );
    if (!capable) skip("WebGPU cannot import external images in this browser environment");

    // Act
    const color = await w.run(async ({ helpers, state }) => {
      const device = state.device as GPUDevice;
      const external = device.importExternalTexture({ source: state.video as unknown as VideoFrame });
      return helpers.gpuTextureColor(device, helpers.renderExternalTexture(device, external));
    });

    // Assert
    expect(color).toBe("blue");
  });

  test("copyExternalImageToTexture throws while the element has no data", async ({ skip }) => {
    // Arrange
    const capable = await w.run(async ({ createVideoElement, polyfillWebgpu, helpers, state }) => {
      const device = await helpers.gpuDevice();
      if (!device) return false;
      polyfillWebgpu();
      state.device = device;
      state.video = createVideoElement();
      return true;
    });
    if (!capable) skip("WebGPU cannot import external images in this browser environment");

    // Act
    const errorName = await w.run(({ helpers, state }) => {
      const device = state.device as GPUDevice;
      return helpers.errorName(() =>
        device.queue.copyExternalImageToTexture(
          { source: state.video as unknown as GPUCopyExternalImageSource },
          { texture: helpers.gpuTexture(device) },
          [160, 120],
        ),
      );
    });

    // Assert
    expect(errorName).toBe("InvalidStateError");
  });
});
