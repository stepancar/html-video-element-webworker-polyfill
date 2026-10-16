import { polyfillDocument } from "https://esm.sh/html-video-element-webworker-polyfill@0.2/worker";

polyfillDocument();

const video = document.createElement("video");
video.id = "from-worker";
video.controls = true;
video.muted = true;
video.loop = true;
video.crossOrigin = "anonymous";
video.src =
  "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm";
video.play();

video.addEventListener("playing", () => {
  self.postMessage({
    type: "log",
    text: `The worker started playback: ${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(0)} s`,
  });
});
