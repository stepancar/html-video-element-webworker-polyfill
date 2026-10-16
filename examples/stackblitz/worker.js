import { polyfillDocument } from "https://esm.sh/html-video-element-webworker-polyfill@0.1/worker";
import { polyfill2dCanvasApi } from "https://esm.sh/html-video-element-webworker-polyfill@0.1/canvas2d";

polyfillDocument();
polyfill2dCanvasApi();

const video = document.createElement("video");
video.crossOrigin = "anonymous";
video.muted = true;
video.loop = true;
video.src =
  "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm";

let ctx;

function render() {
  if (!ctx || video.readyState < video.HAVE_CURRENT_DATA) return;
  ctx.canvas.width = video.videoWidth;
  ctx.canvas.height = video.videoHeight;
  ctx.filter = "grayscale(1) contrast(1.4)";
  ctx.drawImage(video, 0, 0);
  self.postMessage({
    type: "log",
    text: `worker drew frame at ${video.currentTime.toFixed(2)}s (${video.videoWidth}×${video.videoHeight})`,
  });
}

video.addEventListener("loadeddata", render);
video.addEventListener("seeked", render);
video.requestVideoFrameCallback(function onFrame() {
  render();
  video.requestVideoFrameCallback(onFrame);
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "canvas") {
    ctx = message.canvas.getContext("2d");
    render();
  }
  if (message.type === "play") video.play();
  if (message.type === "pause") video.pause();
  if (message.type === "seek") video.currentTime = message.progress * video.duration;
});
