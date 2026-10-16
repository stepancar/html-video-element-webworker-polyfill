import * as polyfill from "html-video-element-webworker-polyfill";

function once(target: EventTarget, type: string, timeout = 10_000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${type}"`)), timeout);
    target.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

function pixelOf(source: CanvasImageSource, x = 1, y = 1): number[] {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, x, y, 1, 1, 0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

function colorName([r = 0, g = 0, b = 0]: number[]): string {
  const on = (v: number) => v > 128;
  const key = `${+on(r)}${+on(g)}${+on(b)}`;
  return { "000": "black", "100": "red", "010": "lime", "001": "blue", "110": "yellow", "111": "white" }[key] ?? key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(check: () => T, timeout = 10_000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

async function loadVideo(src: string, time?: number): Promise<polyfill.WorkerVideoElement> {
  const video = polyfill.createVideoElement();
  video.muted = true;
  video.src = src;
  await once(video, "loadeddata");
  if (time !== undefined) await seekTo(video, time);
  return video;
}

async function seekTo(video: polyfill.WorkerVideoElement, time: number): Promise<void> {
  const seeked = once(video, "seeked");
  video.currentTime = time;
  await seeked;
}

function canvasColor(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): string {
  return colorName([...ctx.getImageData(x, y, 1, 1).data]);
}

function textureColor(gl: WebGLRenderingContext | WebGL2RenderingContext, attach: () => void): string {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  attach();
  const pixel = new Uint8Array(4);
  gl.readPixels(80, 60, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return colorName([...pixel]);
}

const GPU_SIZE: [number, number] = [160, 120];
function gpuUsage(): number {
  return (
    GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT
  );
}

async function gpuDevice(): Promise<GPUDevice | null> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const canvas = new OffscreenCanvas(4, 4);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 4, 4);
  const texture = device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: gpuUsage() });
  device.pushErrorScope("validation");
  device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, [4, 4]);
  return (await device.popErrorScope()) === null ? device : null;
}

function gpuTexture(device: GPUDevice): GPUTexture {
  return device.createTexture({ size: GPU_SIZE, format: "rgba8unorm", usage: gpuUsage() });
}

async function gpuTextureColor(device: GPUDevice, texture: GPUTexture): Promise<string> {
  const bytesPerRow = 768;
  const buffer = device.createBuffer({
    size: bytesPerRow * GPU_SIZE[1],
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, GPU_SIZE);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(buffer.getMappedRange());
  const offset = 60 * bytesPerRow + 80 * 4;
  const color = colorName(Array.from(data.subarray(offset, offset + 4)));
  buffer.unmap();
  return color;
}

function renderExternalTexture(device: GPUDevice, external: GPUExternalTexture): GPUTexture {
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
  const target = gpuTexture(device);
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: device.createSampler() },
      { binding: 1, resource: external },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return target;
}

function errorName(call: () => unknown): string {
  try {
    call();
    return "no error";
  } catch (error) {
    return (error as Error).name;
  }
}

const helpers = {
  once,
  pixelOf,
  colorName,
  sleep,
  waitFor,
  loadVideo,
  seekTo,
  canvasColor,
  textureColor,
  gpuDevice,
  gpuTexture,
  gpuTextureColor,
  renderExternalTexture,
  errorName,
};
export type Helpers = typeof helpers;

export interface State {
  video: polyfill.WorkerVideoElement;
  videos: polyfill.WorkerVideoElement[];
  [key: string]: unknown;
}

export type Lib = typeof polyfill & { helpers: Helpers; state: State };

const lib: Lib = { ...polyfill, helpers, state: {} as State };

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => unknown;

self.addEventListener("message", async (event: MessageEvent) => {
  const data = event.data as { __test?: number; source?: string; args?: unknown };
  if (data?.__test === undefined) return;
  try {
    const fn = new AsyncFunction("lib", "args", `return (${data.source})(lib, args);`);
    const value = await fn(lib, data.args);
    const transfer = collectTransferables(value);
    self.postMessage({ __test: data.__test, value }, { transfer });
  } catch (error) {
    const e = error as Error;
    self.postMessage({
      __test: data.__test,
      error: { name: e?.name, message: e?.message ?? String(error), stack: e?.stack },
    });
  }
});

function collectTransferables(value: unknown, out: Transferable[] = []): Transferable[] {
  if (value instanceof ImageBitmap || value instanceof VideoFrame) out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectTransferables(item, out);
  else if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) collectTransferables(item, out);
  }
  return out;
}
