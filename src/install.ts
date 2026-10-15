import { polyfill2dCanvasApi } from "./polyfills/canvas2d.ts";
import { polyfillCreateImageBitmap, polyfillVideoFrame } from "./polyfills/image-bitmap.ts";
import { polyfillWebglAPI } from "./polyfills/webgl.ts";
import { polyfillWebgpu } from "./polyfills/webgpu.ts";
import { polyfillDocument } from "./worker/document.ts";
import { assertWorker } from "./shared/environment.ts";

export function installWorkerPolyfills(): void {
  assertWorker("installWorkerPolyfills()");
  polyfillDocument();
  polyfill2dCanvasApi();
  polyfillWebglAPI();
  polyfillWebgpu();
  polyfillCreateImageBitmap();
  polyfillVideoFrame();
}
