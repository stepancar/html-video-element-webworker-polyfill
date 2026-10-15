import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const src = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: [
      { find: /^html-video-element-webworker-polyfill\/host$/, replacement: src("host/index.ts") },
      { find: /^html-video-element-webworker-polyfill\/worker$/, replacement: src("worker/index.ts") },
      { find: /^html-video-element-webworker-polyfill\/canvas2d$/, replacement: src("polyfills/canvas2d.ts") },
      { find: /^html-video-element-webworker-polyfill\/webgl$/, replacement: src("polyfills/webgl.ts") },
    ],
  },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
