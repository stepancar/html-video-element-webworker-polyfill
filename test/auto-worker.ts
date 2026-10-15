import "../src/auto.ts";

const PATCHED = Symbol.for("html-video-element-webworker-polyfill.patched");
const patched = (fn: unknown) => Boolean((fn as Record<symbol, unknown>)[PATCHED]);

self.postMessage({
  document: typeof document !== "undefined",
  isVideo: document.createElement("video") instanceof HTMLVideoElement,
  drawImagePatched: patched(OffscreenCanvasRenderingContext2D.prototype.drawImage),
  texImage2DPatched: patched(WebGL2RenderingContext.prototype.texImage2D),
});
