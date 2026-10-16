# html-video-element-webworker-polyfill

[![CI](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml/badge.svg)](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/html-video-element-webworker-polyfill)](https://www.npmjs.com/package/html-video-element-webworker-polyfill)

[`HTMLVideoElement`][HTMLVideoElement] for [Web Workers][Web Workers].
**[Live demo](https://stepancar.github.io/html-video-element-webworker-polyfill/)** ·
**[npm package](https://www.npmjs.com/package/html-video-element-webworker-polyfill)**

```sh
npm install html-video-element-webworker-polyfill
```

## 1. Get video frames in a worker and draw them on a canvas

`main.js`

```js
import { createVideoHost } from "html-video-element-webworker-polyfill/host";

const worker = new Worker("./worker.js", { type: "module" });
createVideoHost(worker);

const canvas = document.querySelector("canvas").transferControlToOffscreen();
worker.postMessage({ canvas }, [canvas]);
```

`worker.js`

```js
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";
import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";

polyfillDocument();
polyfill2dCanvasApi();

self.addEventListener("message", ({ data }) => {
  if (!data.canvas) return;
  const ctx = data.canvas.getContext("2d");
  const video = document.createElement("video");
  video.muted = true;
  video.src = "movie.mp4";
  video.play();
  video.requestVideoFrameCallback(function draw() {
    ctx.drawImage(video, 0, 0, ctx.canvas.width, ctx.canvas.height);
    video.requestVideoFrameCallback(draw);
  });
});
```

[Open in StackBlitz][example-process]

## 2. Connect to an existing video and manage it from a worker

`index.html`

```html
<video id="player" src="movie.mp4"></video>
```

`main.js`

```js
import { createVideoHost } from "html-video-element-webworker-polyfill/host";

createVideoHost(new Worker("./worker.js", { type: "module" }));
```

`worker.js`

```js
import { connectToHostVideo } from "html-video-element-webworker-polyfill/worker";

const video = await connectToHostVideo("#player");
video.currentTime = 42;
```

[Open in StackBlitz][example-manage]

## 3. React to a video created by the worker and add it to the page

`main.js`

```js
import { createVideoHost } from "html-video-element-webworker-polyfill/host";

createVideoHost(new Worker("./worker.js", { type: "module" }), {
  onVideoCreated(video) {
    if (video.id === "preview") document.body.append(video);
  },
});
```

`worker.js`

```js
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";

polyfillDocument();

const video = document.createElement("video");
video.id = "preview";
video.muted = true;
video.src = "movie.mp4";
video.play();
```

[Open in StackBlitz][example-create]

## Why not WebCodecs?

[WebCodecs][WebCodecs] gives you a decoder, not a player: you demux containers yourself, configure codecs, feed chunks
and find keyframes to seek. `HTMLVideoElement` already handles every format the browser can play and seeks
frame-accurately. It just does not exist in workers. This package makes it available there.

## API

| Import                                               | Exports                                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `html-video-element-webworker-polyfill/host`         | `createVideoHost(worker, { container?, onVideoCreated?, canConnect? })` — main thread                                                          |
| `html-video-element-webworker-polyfill/worker`       | `createVideoElement()`, `connectToHostVideo(selector)`, `polyfillDocument()` ([`document.createElement`][createElement]), `WorkerVideoElement` |
| `html-video-element-webworker-polyfill/canvas2d`     | `polyfill2dCanvasApi()` — [`drawImage`][drawImage], [`createPattern`][createPattern]                                                           |
| `html-video-element-webworker-polyfill/webgl`        | `polyfillWebglAPI()` — [`texImage2D`][texImage2D] and friends, [WebGL][WebGL] 1 and 2                                                          |
| `html-video-element-webworker-polyfill/webgpu`       | `polyfillWebgpu()` — [`copyExternalImageToTexture`][copyExternalImageToTexture], [`importExternalTexture`][importExternalTexture]              |
| `html-video-element-webworker-polyfill/image-bitmap` | `polyfillCreateImageBitmap()` — [`createImageBitmap`][createImageBitmap], `polyfillVideoFrame()` — [`new VideoFrame`][VideoFrame constructor]  |
| `html-video-element-webworker-polyfill/auto`         | installs every worker polyfill                                                                                                                 |

The worker element implements the [`HTMLVideoElement`][HTMLVideoElement] API, plus `currentFrame` (the
[`VideoFrame`][VideoFrame] on screen) and `dispose()`.

## Notes

- Cross-origin media needs [CORS][CORS].
- The package shares the worker's `postMessage` channel with your code, so check your own messages, as in example 1.
- Requires [`VideoFrame`][VideoFrame] and [`requestVideoFrameCallback`][requestVideoFrameCallback]: Chrome/Edge 94+,
  Firefox 132+, Safari 17+.

## License

Apache-2.0

[example-process]: https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/process-frames?file=worker.js&initialPath=/index.html&startScript=start
[example-manage]: https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/manage-existing-video?file=worker.js&initialPath=/index.html&startScript=start
[example-create]: https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/create-and-mount?file=worker.js&initialPath=/index.html&startScript=start
[HTMLVideoElement]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement
[Web Workers]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
[WebCodecs]: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
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
[CORS]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
