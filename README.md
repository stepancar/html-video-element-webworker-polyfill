# html-video-element-webworker-polyfill

[![CI](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml/badge.svg)](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/html-video-element-webworker-polyfill)](https://www.npmjs.com/package/html-video-element-webworker-polyfill)

Create and control an [`HTMLVideoElement`][HTMLVideoElement] from a [Web Worker][Web Workers] and read its decoded
frames there.

```ts
const video = document.createElement("video");
video.src = "https://example.com/movie.webm";
video.addEventListener("seeked", () => {
  ctx.drawImage(video, 0, 0);
});
video.currentTime = 12.5;
```

**[Live demo](https://stepancar.github.io/html-video-element-webworker-polyfill/)** ·
**[Open in StackBlitz](https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/stackblitz?file=worker.js&initialPath=/index.html&startScript=start)**

## Why not WebCodecs?

[WebCodecs][WebCodecs] gives you a decoder, not a player: you demux containers yourself, configure codecs, feed chunks
and find keyframes to seek. [`HTMLVideoElement`][HTMLVideoElement] already handles every format the browser can play
and gives frame-accurate seeking with [`currentTime`][currentTime] and [`seeked`][seeked] out of the box. It just does not exist in workers. This package makes it available there.

## Install

```sh
npm install html-video-element-webworker-polyfill
```

## Usage

Main thread:

```ts
import { createVideoHost } from "html-video-element-webworker-polyfill/host";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
createVideoHost(worker);
```

Worker:

```ts
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";
import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";

polyfillDocument();
polyfill2dCanvasApi();

const ctx = new OffscreenCanvas(640, 360).getContext("2d")!;
const video = document.createElement("video");
video.src = "/movie.webm";
video.addEventListener("loadedmetadata", () => {
  video.currentTime = 10;
});
video.addEventListener("seeked", () => {
  ctx.drawImage(video, 0, 0, 640, 360);
});
```

Or without global patches:

```ts
import { createVideoElement } from "html-video-element-webworker-polyfill/worker";

const video = createVideoElement();
video.src = "/movie.webm";
await video.play();

video.requestVideoFrameCallback(function onFrame() {
  render(video.currentFrame);
  video.requestVideoFrameCallback(onFrame);
});

video.dispose();
```

## API

| Import                                               | Exports                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `html-video-element-webworker-polyfill/host`         | `createVideoHost(worker, { container? })` — main thread                                                                                       |
| `html-video-element-webworker-polyfill/worker`       | `createVideoElement()`, `WorkerVideoElement`, `polyfillDocument()` — [`document.createElement`][createElement]                                |
| `html-video-element-webworker-polyfill/canvas2d`     | `polyfill2dCanvasApi()` — [`drawImage`][drawImage], [`createPattern`][createPattern]                                                          |
| `html-video-element-webworker-polyfill/webgl`        | `polyfillWebglAPI()` — [`texImage2D`][texImage2D] and friends, [WebGL][WebGL] 1 and 2                                                         |
| `html-video-element-webworker-polyfill/webgpu`       | `polyfillWebgpu()` — [`copyExternalImageToTexture`][copyExternalImageToTexture], [`importExternalTexture`][importExternalTexture]             |
| `html-video-element-webworker-polyfill/image-bitmap` | `polyfillCreateImageBitmap()` — [`createImageBitmap`][createImageBitmap], `polyfillVideoFrame()` — [`new VideoFrame`][VideoFrame constructor] |
| `html-video-element-webworker-polyfill/auto`         | installs every worker polyfill                                                                                                                |

Each entry point is tree-shakeable, so you only ship what you import.

The worker element implements the [`HTMLVideoElement`][HTMLVideoElement] API: properties, [`play()`][play],
[`pause()`][pause], [`load()`][load], seeking, [media events][media events] and
[`requestVideoFrameCallback`][requestVideoFrameCallback]. It adds two non-standard members:

- `currentFrame` — the [`VideoFrame`][VideoFrame] currently on screen, or `null`. It is closed when the next frame
  arrives; [`clone()`][clone] it to keep it.
- `dispose()` — releases the element. Unreferenced elements are also released automatically on garbage collection
  via [`FinalizationRegistry`][FinalizationRegistry].

Calling a main-thread function in a worker, or a worker function on the main thread, throws an
`InvalidEnvironmentError`.

## Notes

- Cross-origin media needs [CORS][CORS] ([`crossOrigin`][crossOrigin] `= "anonymous"`), as with drawing a video on a
  canvas.
- Frames are decoded on the main thread, so it must not be blocked for long.
- Requires [`VideoFrame`][VideoFrame] and [`requestVideoFrameCallback`][requestVideoFrameCallback]: Chrome/Edge 94+,
  Firefox 132+, Safari 17+.

## License

Apache-2.0

[HTMLVideoElement]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement
[Web Workers]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
[WebCodecs]: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
[currentTime]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime
[seeked]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seeked_event
[play]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play
[pause]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/pause
[load]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load
[media events]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement#events
[requestVideoFrameCallback]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
[createElement]: https://developer.mozilla.org/en-US/docs/Web/API/Document/createElement
[drawImage]: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
[createPattern]: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/createPattern
[texImage2D]: https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texImage2D
[WebGL]: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API
[copyExternalImageToTexture]: https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/copyExternalImageToTexture
[importExternalTexture]: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture
[createImageBitmap]: https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
[VideoFrame]: https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame
[VideoFrame constructor]: https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/VideoFrame
[clone]: https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/clone
[FinalizationRegistry]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry
[CORS]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
[crossOrigin]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/crossOrigin
