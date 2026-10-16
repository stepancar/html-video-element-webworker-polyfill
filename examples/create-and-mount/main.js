import { createVideoHost } from "https://esm.sh/html-video-element-webworker-polyfill@0.2/host";

const worker = new Worker("./worker.js", { type: "module" });

createVideoHost(worker, {
  onVideoCreated(video) {
    if (video.id === "from-worker") document.querySelector("#slot").append(video);
  },
});

worker.addEventListener("message", (event) => {
  if (event.data.type === "log") document.querySelector("#log").textContent = event.data.text;
});
