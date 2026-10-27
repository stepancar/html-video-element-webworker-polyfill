import { playwright } from "@vitest/browser-playwright";
import base from "../vitest.config.ts";

export default {
  ...base,
  test: {
    ...base.test,
    browser: {
      ...base.test?.browser,
      provider: playwright({
        launchOptions: {
          channel: "chrome",
          args: ["--autoplay-policy=no-user-gesture-required", "--js-flags=--expose-gc", "--enable-unsafe-webgpu"],
        },
      }),
    },
  },
};
