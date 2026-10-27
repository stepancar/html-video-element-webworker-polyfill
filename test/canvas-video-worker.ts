import { CanvasVideoElement } from "html-video-element-webworker-polyfill/canvas-video";

self.onmessage = async (event: MessageEvent<{ src: string; frames: number[] }>) => {
  const video = new CanvasVideoElement();
  video.src = event.data.src;
  await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  const shown: number[] = [];
  for (const frame of event.data.frames) {
    video.currentTime = (frame + 0.5) / 30;
    await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    shown.push(Math.round((video.currentFrame!.timestamp * 30) / 1e6));
  }
  const canvas = video.canvas as OffscreenCanvas;
  self.postMessage({ shown, width: canvas.width, height: canvas.height });
  video.dispose();
};
