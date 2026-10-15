import { patchMethod, unwrapArgs } from "../shared/frame-source.ts";

const UPLOAD_METHODS = ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D"] as const;

/**
 * Teaches `WebGLRenderingContext` and `WebGL2RenderingContext` to accept
 * worker video elements in `texImage2D`, `texSubImage2D`, `texImage3D` and
 * `texSubImage3D`. Call once inside the worker. Idempotent.
 */
export function polyfillWebglAPI(): void {
  const scope = globalThis as {
    WebGLRenderingContext?: { prototype: object };
    WebGL2RenderingContext?: { prototype: object };
  };
  for (const ctor of [scope.WebGLRenderingContext, scope.WebGL2RenderingContext]) {
    for (const method of UPLOAD_METHODS) patchMethod(ctor?.prototype, method, unwrapArgs);
  }
}
