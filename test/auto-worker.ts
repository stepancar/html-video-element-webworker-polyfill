import "html-video-element-webworker-polyfill/auto";

function accepts(call: () => unknown): boolean {
  try {
    call();
    return true;
  } catch {
    return false;
  }
}

const video = document.createElement("video");
const gl = new OffscreenCanvas(1, 1).getContext("webgl2")!;

self.postMessage({
  documentPolyfilled: video instanceof HTMLVideoElement && video.tagName === "VIDEO",
  drawImageAcceptsElement: accepts(() =>
    new OffscreenCanvas(1, 1).getContext("2d")!.drawImage(video as unknown as CanvasImageSource, 0, 0),
  ),
  texImage2DAcceptsElement: accepts(() =>
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video as unknown as TexImageSource),
  ),
});
