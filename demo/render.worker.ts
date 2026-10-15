import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";
import { polyfillWebglAPI } from "html-video-element-webworker-polyfill/webgl";
import {
  createVideoElement,
  polyfillDocument,
  type WorkerVideoElement,
} from "html-video-element-webworker-polyfill/worker";
import type { Effect, FromWorker, ToWorker } from "./protocol.ts";

polyfillDocument();
polyfillWebglAPI();
polyfill2dCanvasApi();

const EFFECTS: Effect[] = ["none", "grayscale", "edges", "chromatic", "pixelate", "vignette"];
const THUMBNAILS = 12;

const video = document.createElement("video");
video.muted = true;
video.loop = true;
video.crossOrigin = "anonymous";
video.preload = "auto";

let pip: WorkerVideoElement | null = null;

let gl: WebGL2RenderingContext;
let program: WebGLProgram;
let uniforms: Record<string, WebGLUniformLocation | null> = {};
let mainTexture: WebGLTexture;
let pipTexture: WebGLTexture;
let timeline: OffscreenCanvasRenderingContext2D;

let effect: Effect = "none";
let framesReceived = 0;
let renders = 0;
let renderFps = 0;
let thumbnails = 0;
let timelineToken = 0;
let pendingSeek: number | null = null;
let errorMessage: string | null = null;

const VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 xy = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(xy.x, 1.0 - xy.y);
  gl_Position = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_main;
uniform sampler2D u_pip;
uniform vec2 u_scale;
uniform vec2 u_texel;
uniform int u_effect;
uniform bool u_hasMain;
uniform bool u_hasPip;
uniform vec4 u_pipRect;
in vec2 v_uv;
out vec4 o;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 shade(vec2 uv) {
  vec3 c = texture(u_main, uv).rgb;
  if (u_effect == 1) return vec3(luma(c));
  if (u_effect == 2) {
    float tl = luma(texture(u_main, uv + u_texel * vec2(-1, -1)).rgb);
    float t  = luma(texture(u_main, uv + u_texel * vec2( 0, -1)).rgb);
    float tr = luma(texture(u_main, uv + u_texel * vec2( 1, -1)).rgb);
    float l  = luma(texture(u_main, uv + u_texel * vec2(-1,  0)).rgb);
    float r  = luma(texture(u_main, uv + u_texel * vec2( 1,  0)).rgb);
    float bl = luma(texture(u_main, uv + u_texel * vec2(-1,  1)).rgb);
    float b  = luma(texture(u_main, uv + u_texel * vec2( 0,  1)).rgb);
    float br = luma(texture(u_main, uv + u_texel * vec2( 1,  1)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float e = clamp(length(vec2(gx, gy)) * 1.5, 0.0, 1.0);
    return mix(vec3(0.02, 0.03, 0.08), vec3(0.45, 0.95, 1.0), e);
  }
  if (u_effect == 3) {
    vec2 d = (uv - 0.5) * 0.012;
    return vec3(texture(u_main, uv + d).r, c.g, texture(u_main, uv - d).b);
  }
  if (u_effect == 4) {
    vec2 blocks = 1.0 / (u_texel * 8.0);
    return texture(u_main, (floor(uv * blocks) + 0.5) / blocks).rgb;
  }
  if (u_effect == 5) {
    float v = smoothstep(0.85, 0.25, distance(uv, vec2(0.5)));
    return c * vec3(1.08, 1.0, 0.86) * mix(0.25, 1.0, v);
  }
  return c;
}

void main() {
  vec3 c = vec3(0.035);
  vec2 uv = (v_uv - 0.5) / u_scale + 0.5;
  if (u_hasMain && all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) c = shade(uv);
  if (u_hasPip) {
    vec2 p = (v_uv - u_pipRect.xy) / u_pipRect.zw;
    vec2 border = 3.0 * u_texel / u_pipRect.zw;
    if (all(greaterThanEqual(p, -border)) && all(lessThanEqual(p, 1.0 + border))) {
      c = all(greaterThanEqual(p, vec2(0.0))) && all(lessThanEqual(p, vec2(1.0)))
        ? texture(u_pip, p).rgb
        : vec3(1.0);
    }
  }
  o = vec4(c, 1.0);
}`;

function initGl(canvas: OffscreenCanvas): void {
  gl = canvas.getContext("webgl2", { alpha: false, antialias: false })!;
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "");
    return shader;
  };
  program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  for (const name of ["u_main", "u_pip", "u_scale", "u_texel", "u_effect", "u_hasMain", "u_hasPip", "u_pipRect"]) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  const texture = (unit: number): WebGLTexture => {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  mainTexture = texture(0);
  pipTexture = texture(1);
  gl.uniform1i(uniforms.u_main!, 0);
  gl.uniform1i(uniforms.u_pip!, 1);
}

let renderScheduled = false;
function scheduleRender(): void {
  if (renderScheduled || !gl) return;
  renderScheduled = true;
  const raf = (self as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (raf) raf.call(self, render);
  else setTimeout(render, 16);
}

function render(): void {
  renderScheduled = false;
  const { width, height } = gl.canvas;
  gl.viewport(0, 0, width, height);
  const stageAspect = width / height;

  const hasMain = video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0;
  if (hasMain) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mainTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    const videoAspect = video.videoWidth / video.videoHeight;
    gl.uniform2f(
      uniforms.u_scale!,
      ...((videoAspect > stageAspect ? [1, stageAspect / videoAspect] : [videoAspect / stageAspect, 1]) as [
        number,
        number,
      ]),
    );
    gl.uniform2f(uniforms.u_texel!, 1 / video.videoWidth, 1 / video.videoHeight);
  }
  gl.uniform1i(uniforms.u_hasMain!, hasMain ? 1 : 0);
  gl.uniform1i(uniforms.u_effect!, EFFECTS.indexOf(effect));

  const pipFrame = pip?.currentFrame ?? null;
  if (pipFrame) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, pipTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pipFrame);
    const w = 0.28;
    const h = (w * stageAspect * pipFrame.displayHeight) / pipFrame.displayWidth;
    gl.uniform4f(uniforms.u_pipRect!, 1 - w - 0.03, 1 - h - 0.05, w, h);
  }
  gl.uniform1i(uniforms.u_hasPip!, pipFrame ? 1 : 0);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
  renders++;
  postStatus();
}

function onVideoFrame(): void {
  framesReceived++;
  scheduleRender();
  video.requestVideoFrameCallback(onVideoFrame);
}
video.requestVideoFrameCallback(onVideoFrame);

for (const type of ["loadeddata", "seeked", "emptied", "resize"]) video.addEventListener(type, scheduleRender);
for (const type of ["play", "pause", "durationchange", "timeupdate", "waiting", "playing", "seeking"]) {
  video.addEventListener(type, postStatus);
}
video.addEventListener("seeked", () => {
  if (pendingSeek !== null) {
    video.currentTime = pendingSeek;
    pendingSeek = null;
  }
});
video.addEventListener("loadstart", () => {
  errorMessage = null;
});
video.addEventListener("error", () => {
  errorMessage = video.error?.message || `Media error ${video.error?.code}`;
  postStatus();
});

function setPip(src: string | null): void {
  pip?.dispose();
  pip = null;
  if (src) {
    pip = createVideoElement();
    pip.muted = true;
    pip.loop = true;
    pip.crossOrigin = "anonymous";
    pip.src = src;
    const current = pip;
    const onFrame = (): void => {
      if (current.disposed) return;
      scheduleRender();
      current.requestVideoFrameCallback(onFrame);
    };
    current.requestVideoFrameCallback(onFrame);
    current.play().catch(() => {});
  }
  scheduleRender();
}

async function buildTimeline(src: string): Promise<void> {
  const token = ++timelineToken;
  const { width, height } = timeline.canvas;
  timeline.fillStyle = "#111";
  timeline.fillRect(0, 0, width, height);
  thumbnails = 0;
  postStatus();

  const probe = createVideoElement();
  probe.muted = true;
  probe.crossOrigin = "anonymous";
  probe.preload = "auto";
  probe.src = src;
  try {
    await once(probe, "loadeddata");
    const slot = width / THUMBNAILS;
    for (let i = 0; i < THUMBNAILS; i++) {
      if (token !== timelineToken) break;
      probe.currentTime = ((i + 0.5) * probe.duration) / THUMBNAILS;
      await once(probe, "seeked");
      if (token !== timelineToken) break;
      const scale = Math.max(slot / probe.videoWidth, height / probe.videoHeight);
      const sw = slot / scale;
      const sh = height / scale;
      timeline.drawImage(
        probe as unknown as CanvasImageSource,
        (probe.videoWidth - sw) / 2,
        (probe.videoHeight - sh) / 2,
        sw,
        sh,
        Math.round(i * slot),
        0,
        Math.ceil(slot),
        height,
      );
      timeline.fillStyle = "rgba(0, 0, 0, 0.6)";
      timeline.fillRect(Math.round((i + 1) * slot) - 1, 0, 1, height);
      thumbnails = i + 1;
      postStatus();
    }
  } catch {
  } finally {
    probe.dispose();
  }
}

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (event: Event): void => {
      target.removeEventListener(type, done);
      target.removeEventListener("error", done);
      if (event.type === "error") reject(new Error("media error"));
      else resolve();
    };
    target.addEventListener(type, done);
    target.addEventListener("error", done);
  });
}

let statusScheduled = false;
function postStatus(): void {
  if (statusScheduled) return;
  statusScheduled = true;
  queueMicrotask(() => {
    statusScheduled = false;
    const status: FromWorker = {
      type: "status",
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      seeking: video.seeking,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      frameTimestamp: (video as unknown as WorkerVideoElement).currentFrame?.timestamp ?? null,
      framesReceived,
      renderFps,
      thumbnails,
      error: errorMessage,
    };
    self.postMessage(status);
  });
}

setInterval(() => {
  renderFps = renders;
  renders = 0;
  postStatus();
}, 1000);

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message?.type) {
    case "init":
      initGl(message.stage);
      timeline = message.timeline.getContext("2d")!;
      scheduleRender();
      break;
    case "source":
      pendingSeek = null;
      video.src = message.src;
      video.play().catch(() => {});
      void buildTimeline(message.src);
      break;
    case "pip":
      setPip(message.src);
      break;
    case "play":
      video.play().catch((error: Error) => {
        errorMessage = error.message;
        postStatus();
      });
      break;
    case "pause":
      video.pause();
      break;
    case "seek":
      if (video.seeking) pendingSeek = message.time;
      else video.currentTime = message.time;
      postStatus();
      break;
    case "effect":
      effect = message.effect;
      scheduleRender();
      break;
    case "muted":
      video.muted = message.muted;
      break;
    case "volume":
      video.volume = message.volume;
      break;
    case "rate":
      video.playbackRate = message.rate;
      break;
  }
});
