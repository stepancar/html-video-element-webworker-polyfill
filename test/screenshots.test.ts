import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { fixtures, showBitmap, startWorker, type TestWorker } from "./harness.ts";

/**
 * Visual regression tests: the worker renders video frames through the
 * polyfilled APIs into an OffscreenCanvas, the bitmap is shown on the page and
 * compared against the reference screenshot in `__screenshots__`.
 */

let w: TestWorker;
beforeEach(() => {
  w = startWorker();
  document.body.style.margin = "0";
});
afterEach(() => w.dispose());

test("canvas 2d: filmstrip of seeked frames", async () => {
  const bitmap = await w.run(
    async ({ createVideoElement, polyfill2dCanvasApi, helpers }, { src }) => {
      polyfill2dCanvasApi();
      const video = createVideoElement();
      video.src = src;
      await helpers.once(video, "loadeddata");
      const canvas = new OffscreenCanvas(640, 360);
      const ctx = canvas.getContext("2d")!;
      const times = [0, 0.5, 1, 1.5];
      for (const [index, time] of times.entries()) {
        video.currentTime = time;
        await helpers.once(video, "seeked");
        ctx.drawImage(video as unknown as CanvasImageSource, (index % 2) * 320, Math.floor(index / 2) * 180);
      }
      return canvas.transferToImageBitmap();
    },
    { src: fixtures.pattern },
  );
  showBitmap(bitmap, "filmstrip");
  await expect.element(page.getByTestId("filmstrip")).toMatchScreenshot("canvas2d-filmstrip");
});

test("canvas 2d: two videos composited picture-in-picture", async () => {
  const bitmap = await w.run(
    async ({ createVideoElement, polyfill2dCanvasApi, helpers }, { pattern, colors }) => {
      polyfill2dCanvasApi();
      const main = createVideoElement();
      const pip = createVideoElement();
      main.src = pattern;
      pip.src = colors;
      await Promise.all([helpers.once(main, "loadeddata"), helpers.once(pip, "loadeddata")]);
      main.currentTime = 1;
      pip.currentTime = 0.6;
      await Promise.all([helpers.once(main, "seeked"), helpers.once(pip, "seeked")]);
      const canvas = new OffscreenCanvas(320, 180);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(main as unknown as CanvasImageSource, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(196, 106, 112, 64);
      ctx.drawImage(pip as unknown as CanvasImageSource, 200, 110, 104, 56);
      return canvas.transferToImageBitmap();
    },
    { pattern: fixtures.pattern, colors: fixtures.colors },
  );
  showBitmap(bitmap, "pip");
  await expect.element(page.getByTestId("pip")).toMatchScreenshot("canvas2d-pip");
});

test("webgl: frame uploaded with texImage2D and rendered through a shader", async () => {
  const bitmap = await w.run(
    async ({ createVideoElement, polyfillWebglAPI, helpers }, { src }) => {
      polyfillWebglAPI();
      const video = createVideoElement();
      video.src = src;
      await helpers.once(video, "loadeddata");
      video.currentTime = 1.2;
      await helpers.once(video, "seeked");

      const canvas = new OffscreenCanvas(320, 180);
      const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true })!;
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };
      const program = gl.createProgram();
      gl.attachShader(
        program,
        compile(
          gl.VERTEX_SHADER,
          `#version 300 es
          out vec2 uv;
          void main() {
            vec2 xy = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
            uv = vec2(xy.x, 1.0 - xy.y);
            gl_Position = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
          }`,
        ),
      );
      gl.attachShader(
        program,
        compile(
          gl.FRAGMENT_SHADER,
          `#version 300 es
          precision mediump float;
          uniform sampler2D frame;
          in vec2 uv;
          out vec4 color;
          void main() {
            // Left half: original. Right half: inverted luminance.
            vec4 c = texture(frame, uv);
            float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            color = uv.x < 0.5 ? c : vec4(vec3(1.0 - l), 1.0);
          }`,
        ),
      );
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video as unknown as TexImageSource);
      gl.viewport(0, 0, 320, 180);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return canvas.transferToImageBitmap();
    },
    { src: fixtures.pattern },
  );
  showBitmap(bitmap, "webgl");
  await expect.element(page.getByTestId("webgl")).toMatchScreenshot("webgl-shader");
});

test("webgpu: frame imported with importExternalTexture", async ({ skip }) => {
  const bitmap = await w.run(
    async ({ createVideoElement, polyfillWebgpu, helpers }, { src }) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      polyfillWebgpu();
      const video = createVideoElement();
      video.src = src;
      await helpers.once(video, "loadeddata");
      video.currentTime = 0.5;
      await helpers.once(video, "seeked");

      const canvas = new OffscreenCanvas(320, 180);
      const context = canvas.getContext("webgpu")!;
      context.configure({ device, format: "rgba8unorm", alphaMode: "opaque" });
      const module = device.createShaderModule({
        code: `
          @group(0) @binding(0) var s: sampler;
          @group(0) @binding(1) var t: texture_external;
          struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
          @vertex fn vs(@builtin(vertex_index) i: u32) -> V {
            let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
            return V(vec4f(xy * 2.0 - 1.0, 0.0, 1.0), vec2f(xy.x, 1.0 - xy.y));
          }
          @fragment fn fs(v: V) -> @location(0) vec4f {
            // Mirror the frame horizontally to prove it went through the shader.
            return textureSampleBaseClampToEdge(t, s, vec2f(1.0 - v.uv.x, v.uv.y));
          }`,
      });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      });
      device.pushErrorScope("validation");
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: device.createSampler() },
          { binding: 1, resource: device.importExternalTexture({ source: video as unknown as VideoFrame }) },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (await device.popErrorScope()) return null;
      await device.queue.onSubmittedWorkDone();
      return canvas.transferToImageBitmap();
    },
    { src: fixtures.pattern },
  );
  if (!bitmap) skip("WebGPU cannot import external images in this browser environment");
  showBitmap(bitmap!, "webgpu");
  await expect.element(page.getByTestId("webgpu")).toMatchScreenshot("webgpu-external-texture");
});
