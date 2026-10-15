/**
 * A tiny, dependency-free contract between the worker video element and the
 * rendering API polyfills. Polyfills only import this module, so pulling in
 * e.g. `polyfillWebglAPI` never drags the whole element implementation along.
 */

/** Registered symbol so that several copies of the package still interoperate. */
export const FRAME_SOURCE: unique symbol = Symbol.for("html-video-element-webworker-polyfill.frame") as never;

export interface FrameSource {
  readonly [FRAME_SOURCE]: () => VideoFrame | null;
}

export function isFrameSource(value: unknown): value is FrameSource {
  return (
    typeof value === "object" && value !== null && typeof (value as Partial<FrameSource>)[FRAME_SOURCE] === "function"
  );
}

/**
 * Returns the current `VideoFrame` of a polyfilled video element, `null` when
 * the element has no decoded data yet, or `undefined` when `value` is not a
 * polyfilled video element at all.
 */
export function frameOf(value: unknown): VideoFrame | null | undefined {
  if (!isFrameSource(value)) return undefined;
  const frame = value[FRAME_SOURCE]();
  // A closed frame has a null format; treat it as "no data".
  return frame && frame.format !== null ? frame : null;
}

const PATCHED: unique symbol = Symbol.for("html-video-element-webworker-polyfill.patched") as never;

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Wraps `proto[name]` so that `transform(args)` runs before the original
 * method. `transform` returns `false` to skip the call (drawing a video with no
 * data is a no-op per spec); the patched method then returns `skipped()`.
 * Idempotent.
 */
export function patchMethod(
  proto: object | undefined,
  name: string,
  transform: (args: unknown[]) => boolean,
  skipped: () => unknown = () => undefined,
): void {
  if (!proto) return;
  const original = (proto as Record<string, unknown>)[name] as (AnyFn & { [PATCHED]?: true }) | undefined;
  if (typeof original !== "function" || original[PATCHED]) return;
  const patched = {
    [name](this: unknown, ...args: unknown[]): unknown {
      if (!transform(args)) return skipped();
      return original.apply(this, args);
    },
  }[name] as AnyFn & { [PATCHED]?: true };
  patched[PATCHED] = true;
  Object.defineProperty(proto, name, {
    value: patched,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** Replaces every polyfilled element in `args` with its frame. Returns false if one has no frame. */
export function unwrapArgs(args: unknown[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const frame = frameOf(args[i]);
    if (frame === undefined) continue;
    if (frame === null) return false;
    args[i] = frame;
  }
  return true;
}

export function noFrameError(): DOMException {
  return new DOMException(
    "The video element has no decoded frame yet (readyState < HAVE_CURRENT_DATA).",
    "InvalidStateError",
  );
}
