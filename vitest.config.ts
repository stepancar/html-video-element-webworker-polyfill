import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const gpuArgs =
  process.platform === "darwin"
    ? ["--use-angle=metal"]
    : ["--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"];

export default defineConfig({
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
