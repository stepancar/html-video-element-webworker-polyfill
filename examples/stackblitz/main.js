import { createVideoHost } from "https://esm.sh/gh/stepancar/html-video-element-webworker-polyfill@main/src/host/index.ts";

const worker = new Worker("./worker.js", { type: "module" });
createVideoHost(worker, { container: document.querySelector("#video") });

const canvas = document.querySelector("#output").transferControlToOffscreen();
worker.postMessage({ type: "canvas", canvas }, [canvas]);

document.querySelector("#play").addEventListener("click", () => worker.postMessage({ type: "play" }));
document.querySelector("#pause").addEventListener("click", () => worker.postMessage({ type: "pause" }));
document.querySelector("#seek").addEventListener("input", (event) => {
  worker.postMessage({ type: "seek", progress: Number(event.target.value) });
});

worker.addEventListener("message", (event) => {
  if (event.data.type === "log") document.querySelector("#log").textContent = event.data.text;
});
