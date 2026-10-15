/**
 * Side-effect entry: `import "html-video-element-webworker-polyfill/auto"`
 * inside a worker installs every polyfill.
 */
import { installWorkerPolyfills } from "./install.ts";

installWorkerPolyfills();
