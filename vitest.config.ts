import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const gpuArgs =
  process.platform === "darwin"
    ? ["--use-angle=metal"]
    : ["--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"];

const PACKAGE = "html-video-element-webworker-polyfill";
const ENTRIES: Record<string, string> = {
  "": "index.ts",
  "/host": "host/index.ts",
  "/worker": "worker/index.ts",
  "/canvas2d": "polyfills/canvas2d.ts",
  "/webgl": "polyfills/webgl.ts",
  "/webgpu": "polyfills/webgpu.ts",
  "/image-bitmap": "polyfills/image-bitmap.ts",
  "/auto": "auto.ts",
  "/canvas-video": "canvas-video/index.ts",
};

export default defineConfig({
  resolve: {
    alias: Object.entries(ENTRIES).map(([subpath, file]) => ({
      find: new RegExp(`^${PACKAGE}${subpath}$`),
      replacement: fileURLToPath(new URL(`./src/${file}`, import.meta.url)),
    })),
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      viewport: { width: 800, height: 600 },
      provider: playwright({
        launchOptions: {
          args: [
            "--autoplay-policy=no-user-gesture-required",
            "--js-flags=--expose-gc",
            "--enable-unsafe-webgpu",
            ...gpuArgs,
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
      expect: {
        toMatchScreenshot: {
          comparatorName: "pixelmatch",
          comparatorOptions: { threshold: 0.2, allowedMismatchedPixelRatio: 0.01 },
        },
      },
    },
  },
});
