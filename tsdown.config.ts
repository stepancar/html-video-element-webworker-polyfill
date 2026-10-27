import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    host: "src/host/index.ts",
    worker: "src/worker/index.ts",
    canvas2d: "src/polyfills/canvas2d.ts",
    webgl: "src/polyfills/webgl.ts",
    webgpu: "src/polyfills/webgpu.ts",
    "image-bitmap": "src/polyfills/image-bitmap.ts",
    auto: "src/auto.ts",
    "canvas-video": "src/canvas-video/index.ts",
  },
  format: "esm",
  platform: "browser",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
