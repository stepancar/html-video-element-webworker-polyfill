import { connectToHostVideo } from "https://esm.sh/html-video-element-webworker-polyfill@0.2/worker";

const video = await connectToHostVideo("#player");

const once = (type) => new Promise((resolve) => video.addEventListener(type, resolve, { once: true }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!Number.isFinite(video.duration)) await once("loadedmetadata");

for (;;) {
  const seeked = once("seeked");
  video.currentTime = Math.random() * video.duration;
  await seeked;
  self.postMessage({ type: "log", text: `The worker jumped to ${video.currentTime.toFixed(2)} s` });
  await sleep(1000);
}
