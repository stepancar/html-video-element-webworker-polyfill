import { assertWorker } from "../shared/environment.ts";
import { patchMethod, unwrapArgs } from "../shared/frame-source.ts";

const UPLOAD_METHODS = ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D"] as const;

export function polyfillWebglAPI(): void {
  assertWorker("polyfillWebglAPI()");
  const scope = globalThis as {
    WebGLRenderingContext?: { prototype: object };
    WebGL2RenderingContext?: { prototype: object };
  };
  for (const ctor of [scope.WebGLRenderingContext, scope.WebGL2RenderingContext]) {
    for (const method of UPLOAD_METHODS) patchMethod(ctor?.prototype, method, unwrapArgs);
  }
}
