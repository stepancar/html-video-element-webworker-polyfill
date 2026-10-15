import { patchMethod, unwrapArgs } from "../shared/frame-source.ts";

/**
 * Teaches `OffscreenCanvasRenderingContext2D` (and `CanvasRenderingContext2D`
 * when present) to accept worker video elements in `drawImage` and
 * `createPattern`. Call once inside the worker. Idempotent.
 */
export function polyfill2dCanvasApi(): void {
  const scope = globalThis as {
    OffscreenCanvasRenderingContext2D?: { prototype: object };
    CanvasRenderingContext2D?: { prototype: object };
  };
  for (const ctor of [scope.OffscreenCanvasRenderingContext2D, scope.CanvasRenderingContext2D]) {
    // Drawing a video that has no data yet is a no-op, as with real elements.
    patchMethod(ctor?.prototype, "drawImage", unwrapArgs);
    patchMethod(ctor?.prototype, "createPattern", unwrapArgs, () => null);
  }
}
