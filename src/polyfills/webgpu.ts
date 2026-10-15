import { assertWorker } from "../shared/environment.ts";
import { frameOf, noFrameError, patchMethod } from "../shared/frame-source.ts";

export function polyfillWebgpu(): void {
  assertWorker("polyfillWebgpu()");
  const scope = globalThis as { GPUQueue?: { prototype: object }; GPUDevice?: { prototype: object } };
  patchMethod(scope.GPUQueue?.prototype, "copyExternalImageToTexture", unwrapSourceDescriptor);
  patchMethod(scope.GPUDevice?.prototype, "importExternalTexture", unwrapSourceDescriptor);
}

function unwrapSourceDescriptor(args: unknown[]): boolean {
  const descriptor = args[0] as { source?: unknown } | undefined;
  const frame = frameOf(descriptor?.source);
  if (frame === undefined) return true;
  if (frame === null) throw noFrameError();
  args[0] = { ...descriptor, source: frame };
  return true;
}
