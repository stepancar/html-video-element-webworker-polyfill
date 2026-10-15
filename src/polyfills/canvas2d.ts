import { assertWorker } from "../shared/environment.ts";
import { patchMethod, unwrapArgs } from "../shared/frame-source.ts";

export function polyfill2dCanvasApi(): void {
  assertWorker("polyfill2dCanvasApi()");
  const scope = globalThis as {
    OffscreenCanvasRenderingContext2D?: { prototype: object };
    CanvasRenderingContext2D?: { prototype: object };
  };
  for (const ctor of [scope.OffscreenCanvasRenderingContext2D, scope.CanvasRenderingContext2D]) {
    patchMethod(ctor?.prototype, "drawImage", unwrapArgs);
    patchMethod(ctor?.prototype, "createPattern", unwrapArgs, () => null);
  }
}
