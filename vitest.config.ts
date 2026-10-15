import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Use the real GPU on macOS; elsewhere fall back to SwiftShader (WebGPU tests
// skip themselves when the software adapter cannot import external images).
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
            // Lets tests force garbage collection to exercise FinalizationRegistry cleanup.
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
          // Video decoding and GPU paths differ per OS, so references are per platform
          // (`*-chromium-darwin.png`, `*-chromium-linux.png`; see scripts/update-linux-screenshots.sh).
          comparatorOptions: { threshold: 0.2, allowedMismatchedPixelRatio: 0.01 },
        },
      },
    },
  },
});
