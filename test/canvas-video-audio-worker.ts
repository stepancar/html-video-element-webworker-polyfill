import { CanvasVideoElement } from "html-video-element-webworker-polyfill/canvas-video";

self.onmessage = async (event: MessageEvent<{ src: string; port: MessagePort | null }>) => {
  const { src, port } = event.data;
  let scheduled = 0;
  let audio: MessagePort | undefined;
  if (port) {
    const tap = new MessageChannel();
    tap.port1.onmessage = (message) => {
      if (message.data?.type === "schedule") scheduled++;
      port.postMessage(message.data, message.data?.chunk?.channels?.map((c: Float32Array) => c.buffer) ?? []);
    };
    port.onmessage = (message) => tap.port1.postMessage(message.data);
    audio = tap.port2;
  }
  const video = new CanvasVideoElement({ audio });
  video.src = src;
  await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  video.currentTime = 3.5;
  await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
  await video.play();
  await new Promise((resolve) => video.addEventListener("ended", resolve, { once: true }));
  self.postMessage({ scheduled, ended: video.ended });
  video.dispose();
};
