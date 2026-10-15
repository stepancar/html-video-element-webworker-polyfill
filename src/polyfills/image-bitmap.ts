import { frameOf, noFrameError } from "../shared/frame-source.ts";

const PATCHED: unique symbol = Symbol.for("html-video-element-webworker-polyfill.patched") as never;

/**
 * Makes `createImageBitmap(video, ...)` accept worker video elements.
 * Call once inside the worker. Idempotent.
 */
export function polyfillCreateImageBitmap(): void {
  const scope = globalThis as { createImageBitmap?: typeof createImageBitmap & { [PATCHED]?: true } };
  const original = scope.createImageBitmap;
  if (typeof original !== "function" || original[PATCHED]) return;
  const patched = function createImageBitmap(this: unknown, ...args: unknown[]): Promise<ImageBitmap> {
    const frame = frameOf(args[0]);
    if (frame === null) return Promise.reject(noFrameError());
    if (frame) args[0] = frame;
    return (original as (...args: unknown[]) => Promise<ImageBitmap>).apply(this, args);
  } as typeof createImageBitmap & { [PATCHED]?: true };
  patched[PATCHED] = true;
  scope.createImageBitmap = patched;
}

/**
 * Makes `new VideoFrame(video, init)` accept worker video elements. The
 * constructor is wrapped in a `Proxy`, so `instanceof VideoFrame` and the
 * prototype chain of native frames are unaffected. Idempotent.
 */
export function polyfillVideoFrame(): void {
  const scope = globalThis as { VideoFrame?: typeof VideoFrame & { [PATCHED]?: true } };
  const original = scope.VideoFrame;
  if (typeof original !== "function" || original[PATCHED]) return;
  scope.VideoFrame = new Proxy(original, {
    construct(target, args: unknown[], newTarget) {
      const frame = frameOf(args[0]);
      if (frame === null) throw noFrameError();
      if (frame) args[0] = frame;
      return Reflect.construct(target, args, newTarget === scope.VideoFrame ? target : newTarget) as object;
    },
    get(target, key, receiver) {
      if (key === PATCHED) return true;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}
