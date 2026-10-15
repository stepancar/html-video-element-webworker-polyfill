import { polyfill2dCanvasApi } from "./polyfills/canvas2d.ts";
import { polyfillCreateImageBitmap, polyfillVideoFrame } from "./polyfills/image-bitmap.ts";
import { polyfillWebglAPI } from "./polyfills/webgl.ts";
import { polyfillWebgpu } from "./polyfills/webgpu.ts";
import { polyfillDocument } from "./worker/document.ts";

export function installWorkerPolyfills(): void {
  polyfillDocument();
  polyfill2dCanvasApi();
  polyfillWebglAPI();
  polyfillWebgpu();
  polyfillCreateImageBitmap();
  polyfillVideoFrame();
}
