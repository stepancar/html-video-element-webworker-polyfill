import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fixtures, startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker;
beforeEach(() => {
  w = startWorker();
});
afterEach(() => w.dispose());

describe("Canvas 2D", () => {
  test("drawImage(video) draws the current frame, in all three overloads", async () => {
    const result = await w.run(
      async ({ createVideoElement, polyfill2dCanvasApi, helpers }, { src }) => {
        polyfill2dCanvasApi();
        const video = createVideoElement();
        const canvas = new OffscreenCanvas(160, 120);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const at = (x: number, y: number) => helpers.colorName([...ctx.getImageData(x, y, 1, 1).data]);

        ctx.drawImage(video as unknown as CanvasImageSource, 0, 0); // no data yet: a no-op
        const beforeLoad = [...ctx.getImageData(0, 0, 1, 1).data];

        video.src = src;
        await helpers.once(video, "loadeddata");
        video.currentTime = 0.6;
        await helpers.once(video, "seeked");
        ctx.drawImage(video as unknown as CanvasImageSource, 0, 0);
        const overload3 = at(80, 60);

        video.currentTime = 1.1;
        await helpers.once(video, "seeked");
        ctx.drawImage(video as unknown as CanvasImageSource, 0, 0, 80, 120);
        const overload5 = [at(40, 60), at(120, 60)];

        video.currentTime = 1.6;
        await helpers.once(video, "seeked");
        ctx.drawImage(video as unknown as CanvasImageSource, 0, 0, 160, 120, 80, 0, 80, 120);
        const overload9 = [at(40, 60), at(120, 60)];
        return { beforeLoad, overload3, overload5, overload9 };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({
      beforeLoad: [0, 0, 0, 0],
      overload3: "lime",
      overload5: ["blue", "lime"],
      overload9: ["blue", "yellow"],
    });
  });

  test("createPattern(video) uses the current frame", async () => {
    const result = await w.run(
      async ({ createVideoElement, polyfill2dCanvasApi, helpers }, { src }) => {
        polyfill2dCanvasApi();
        const video = createVideoElement();
        const ctx = new OffscreenCanvas(400, 300).getContext("2d")!;
        const empty = ctx.createPattern(video as unknown as CanvasImageSource, "repeat");
        video.src = src;
        await helpers.once(video, "loadeddata");
        const pattern = ctx.createPattern(video as unknown as CanvasImageSource, "repeat")!;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, 400, 300);
        return { empty, color: helpers.colorName([...ctx.getImageData(300, 250, 1, 1).data]) };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ empty: null, color: "red" });
  });
});

describe("createImageBitmap / VideoFrame", () => {
  test("createImageBitmap(video) snapshots the current frame", async () => {
    const result = await w.run(
      async ({ createVideoElement, polyfillCreateImageBitmap, helpers }, { src }) => {
        polyfillCreateImageBitmap();
        const video = createVideoElement();
        let early = "";
        await createImageBitmap(video as unknown as ImageBitmapSource).catch((error: DOMException) => {
          early = error.name;
        });
        video.src = src;
        await helpers.once(video, "loadeddata");
        video.currentTime = 1.2;
        await helpers.once(video, "seeked");
        const bitmap = await createImageBitmap(video as unknown as ImageBitmapSource);
        const cropped = await createImageBitmap(video as unknown as ImageBitmapSource, 10, 10, 20, 30);
        return {
          early,
          size: [bitmap.width, bitmap.height],
          cropped: [cropped.width, cropped.height],
          color: helpers.colorName(helpers.pixelOf(bitmap)),
        };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ early: "InvalidStateError", size: [160, 120], cropped: [20, 30], color: "blue" });
  });

  test("new VideoFrame(video) copies the current frame and keeps instanceof working", async () => {
    const result = await w.run(
      async ({ createVideoElement, polyfillVideoFrame, helpers }, { src }) => {
        polyfillVideoFrame();
        const video = createVideoElement();
        let early = "";
        try {
          new VideoFrame(video as unknown as CanvasImageSource).close();
        } catch (error) {
          early = (error as DOMException).name;
        }
        video.src = src;
        await helpers.once(video, "loadeddata");
        video.currentTime = 0.6;
        await helpers.once(video, "seeked");
        const copy = new VideoFrame(video as unknown as CanvasImageSource, { timestamp: 42 });
        const native = video.currentFrame!;
        // The copy survives the element moving on to another frame.
        video.currentTime = 1.6;
        await helpers.once(video, "seeked");
        const out = {
          early,
          timestamp: copy.timestamp,
          copyIsVideoFrame: copy instanceof VideoFrame,
          nativeIsVideoFrame: video.currentFrame instanceof VideoFrame,
          sameProto: Object.getPrototypeOf(copy) === VideoFrame.prototype,
          previousFrameClosed: native.format === null,
          copyColor: helpers.colorName(helpers.pixelOf(copy)),
        };
        copy.close();
        return out;
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({
      early: "InvalidStateError",
      timestamp: 42,
      copyIsVideoFrame: true,
      nativeIsVideoFrame: true,
      sameProto: true,
      previousFrameClosed: true,
      copyColor: "lime",
    });
  });
});

describe("WebGL", () => {
  test("texImage2D / texSubImage2D / texImage3D accept the element (WebGL 1 and 2)", async () => {
    const result = await w.run(
      async ({ createVideoElement, polyfillWebglAPI, helpers }, { src }) => {
        polyfillWebglAPI();
        const video = createVideoElement();
        video.src = src;
        await helpers.once(video, "loadeddata");
        const source = video as unknown as TexImageSource;

        const readTexture = (gl: WebGLRenderingContext | WebGL2RenderingContext, attach: () => void) => {
          const fb = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          attach();
          const pixel = new Uint8Array(4);
          gl.readPixels(80, 60, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return helpers.colorName([...pixel]);
        };

        const seek = async (time: number) => {
          video.currentTime = time;
          await helpers.once(video, "seeked");
        };

        // WebGL 1: texImage2D (6-arg overload) then texSubImage2D (7-arg overload)
        const gl1 = new OffscreenCanvas(1, 1).getContext("webgl")!;
        const tex1 = gl1.createTexture();
        gl1.bindTexture(gl1.TEXTURE_2D, tex1);
        await seek(0.2);
        gl1.texImage2D(gl1.TEXTURE_2D, 0, gl1.RGBA, gl1.RGBA, gl1.UNSIGNED_BYTE, source);
        const attach1 = () => gl1.framebufferTexture2D(gl1.FRAMEBUFFER, gl1.COLOR_ATTACHMENT0, gl1.TEXTURE_2D, tex1, 0);
        const webgl1TexImage = readTexture(gl1, attach1);
        await seek(0.7);
        gl1.texSubImage2D(gl1.TEXTURE_2D, 0, 0, 0, gl1.RGBA, gl1.UNSIGNED_BYTE, source);
        const webgl1TexSubImage = readTexture(gl1, attach1);

        // WebGL 2: texImage2D (9-arg overload) and texImage3D into a 2D array texture
        const gl2 = new OffscreenCanvas(1, 1).getContext("webgl2")!;
        const tex2 = gl2.createTexture();
        gl2.bindTexture(gl2.TEXTURE_2D, tex2);
        await seek(1.2);
        gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA8, 160, 120, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, source);
        const webgl2TexImage = readTexture(gl2, () =>
          gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, tex2, 0),
        );
        const tex3 = gl2.createTexture();
        gl2.bindTexture(gl2.TEXTURE_2D_ARRAY, tex3);
        await seek(1.7);
        gl2.texImage3D(gl2.TEXTURE_2D_ARRAY, 0, gl2.RGBA8, 160, 120, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, source);
        const webgl2TexImage3D = readTexture(gl2, () =>
          gl2.framebufferTextureLayer(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, tex3, 0, 0),
        );
        return { webgl1TexImage, webgl1TexSubImage, webgl2TexImage, webgl2TexImage3D, error: gl2.getError() };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({
      webgl1TexImage: "red",
      webgl1TexSubImage: "lime",
      webgl2TexImage: "blue",
      webgl2TexImage3D: "yellow",
      error: 0,
    });
  });

  test("uploads are skipped while the element has no data", async () => {
    const result = await w.run(({ createVideoElement, polyfillWebglAPI }) => {
      polyfillWebglAPI();
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2")!;
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        createVideoElement() as unknown as TexImageSource,
      );
      return gl.getError();
    });
    expect(result).toBe(0);
  });
});

describe("WebGPU", () => {
  test("copyExternalImageToTexture and importExternalTexture accept the element", async ({ skip }) => {
    const capable = await w.run(async () => {
      // Software adapters in some headless setups cannot copy *any* external image.
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      const canvas = new OffscreenCanvas(4, 4);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 4, 4);
      const texture = device.createTexture({
        size: [4, 4],
        format: "rgba8unorm",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.pushErrorScope("validation");
      device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, [4, 4]);
      return (await device.popErrorScope()) === null;
    });
    if (!capable) skip("WebGPU cannot import external images in this browser environment");
    const result = await w.run(
      async ({ createVideoElement, polyfillWebgpu, helpers }, { src }) => {
        const adapter = (await navigator.gpu.requestAdapter())!;
        polyfillWebgpu();
        const device = await adapter.requestDevice();
        const video = createVideoElement();

        const size: [number, number] = [160, 120];
        const bytesPerRow = 768; // 160 * 4 rounded up to a multiple of 256
        const usage =
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING;
        const readPixel = async (texture: GPUTexture) => {
          const buffer = device.createBuffer({
            size: bytesPerRow * size[1],
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, size);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const data = new Uint8Array(buffer.getMappedRange());
          const offset = 60 * bytesPerRow + 80 * 4;
          const pixel = Array.from(data.subarray(offset, offset + 4));
          buffer.unmap();
          return helpers.colorName(pixel);
        };

        let early = "";
        try {
          device.queue.copyExternalImageToTexture(
            { source: video as unknown as GPUCopyExternalImageSource },
            { texture: device.createTexture({ size, format: "rgba8unorm", usage }) },
            size,
          );
        } catch (error) {
          early = (error as DOMException).name;
        }

        video.src = src;
        await helpers.once(video, "loadeddata");
        video.currentTime = 0.7;
        await helpers.once(video, "seeked");
        const copied = device.createTexture({ size, format: "rgba8unorm", usage });
        device.queue.copyExternalImageToTexture(
          { source: video as unknown as GPUCopyExternalImageSource },
          { texture: copied },
          size,
        );
        const copyColor = await readPixel(copied);

        video.currentTime = 1.2;
        await helpers.once(video, "seeked");
        const module = device.createShaderModule({
          code: `
            @group(0) @binding(0) var s: sampler;
            @group(0) @binding(1) var t: texture_external;
            struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
            @vertex fn vs(@builtin(vertex_index) i: u32) -> V {
              let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
              return V(vec4f(xy * 2.0 - 1.0, 0.0, 1.0), vec2f(xy.x, 1.0 - xy.y));
            }
            @fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleBaseClampToEdge(t, s, v.uv); }`,
        });
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
        });
        const target = device.createTexture({ size, format: "rgba8unorm", usage });
        const external = device.importExternalTexture({ source: video as unknown as VideoFrame });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: device.createSampler() },
            { binding: 1, resource: external },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const importColor = await readPixel(target);
        return { early, copyColor, importColor };
      },
      { src: fixtures.colors },
    );
    expect(result).toEqual({ early: "InvalidStateError", copyColor: "lime", importColor: "blue" });
  });
});
