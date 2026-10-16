# html-video-element-webworker-polyfill

[![CI](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml/badge.svg)](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/html-video-element-webworker-polyfill)](https://www.npmjs.com/package/html-video-element-webworker-polyfill)

[`HTMLVideoElement`][HTMLVideoElement] for [Web Workers][Web Workers]. Create a `<video>` from a worker or take over
one that is already on the page, control it with the standard API and read its decoded frames in the worker.

**[Live demo](https://stepancar.github.io/html-video-element-webworker-polyfill/)**

## Examples

| Open in StackBlitz                           | What it shows                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Process frames][example-process]            | The worker pulls every frame of a video and draws it on an `OffscreenCanvas`.           |
| [Control an existing video][example-control] | A `<video controls>` on the page is driven by the worker, which jumps to random frames. |
| [Create and show a video][example-create]    | The worker creates a `<video>`; the page puts it into the DOM.                          |

## Install

```sh
npm install html-video-element-webworker-polyfill
```

## Usage

The real `<video>` elements always live on the main thread. Connect the worker to them once, right after creating
it:

```ts
import { createVideoHost } from "html-video-element-webworker-polyfill/host";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
createVideoHost(worker);
```

Everything else happens in the worker.

### Process video frames in a worker

```ts
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";
import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";

polyfillDocument();
polyfill2dCanvasApi();

const ctx = new OffscreenCanvas(640, 360).getContext("2d")!;
const video = document.createElement("video");
video.src = "/movie.mp4";
video.addEventListener("loadedmetadata", () => {
  video.currentTime = 10;
});
video.addEventListener("seeked", () => {
  ctx.drawImage(video, 0, 0, 640, 360);
});
```

The decoded frame is ready inside the [`seeked`][seeked] handler. To process playback frame by frame, use
[`requestVideoFrameCallback`][requestVideoFrameCallback].

### Control an existing video

The page has a regular player:

```html
<video id="player" controls src="/movie.mp4"></video>
```

The worker takes control of it:

```ts
import { connectToHostVideo } from "html-video-element-webworker-polyfill/worker";

const video = await connectToHostVideo("#player");
video.currentTime = 42;
await video.play();
```

The element stays where it is. What the user does with its controls, and what other scripts change, reaches the
worker as state and events. `video.dispose()` releases control and leaves the element untouched. To restrict which
elements a worker may take over, pass `canConnect` to `createVideoHost`.

### Create a video in the worker and show it on the page

The worker creates the element as usual and gives it an `id`:

```ts
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";

polyfillDocument();

const video = document.createElement("video");
video.id = "preview";
video.src = "/movie.mp4";
video.play();
```

The page decides where it goes:

```ts
createVideoHost(worker, {
  onVideoCreated(video) {
    if (video.id === "preview") document.querySelector("#slot")!.append(video);
  },
});
```

Properties set right after creation, like `id`, are already applied when `onVideoCreated` runs.

### Without global patches

`createVideoElement()` does the same as `document.createElement("video")` without touching `document`, and
`currentFrame` gives you the frame on screen as a [`VideoFrame`][VideoFrame]:

```ts
import { createVideoElement } from "html-video-element-webworker-polyfill/worker";

const video = createVideoElement();
video.src = "/movie.mp4";
await video.play();

video.requestVideoFrameCallback(function onFrame() {
  render(video.currentFrame);
  video.requestVideoFrameCallback(onFrame);
});
```

## Why not WebCodecs?

[WebCodecs][WebCodecs] gives you a decoder, not a player: you demux containers yourself, configure codecs, feed chunks
and find keyframes to seek. `HTMLVideoElement` already handles every format the browser can play and gives
frame-accurate seeking with [`currentTime`][currentTime] and [`seeked`][seeked]. It just does not exist in workers.
This package makes it available there.

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

Each entry point is tree-shakeable, so you only ship what you import.

The worker element implements the [`HTMLVideoElement`][HTMLVideoElement] API: properties, [`play()`][play],
[`pause()`][pause], [`load()`][load], seeking, [media events][media events] and
[`requestVideoFrameCallback`][requestVideoFrameCallback]. It adds two members:

- `currentFrame` — the [`VideoFrame`][VideoFrame] currently on screen, or `null`. It is closed when the next frame
  arrives; [`clone()`][clone] it to keep it.
- `dispose()` — releases the element. Unreferenced elements are released automatically through
  [`FinalizationRegistry`][FinalizationRegistry].

Calling a main-thread function in a worker, or a worker function on the main thread, throws an
`InvalidEnvironmentError`.

## Notes

- Cross-origin media needs [CORS][CORS] ([`crossOrigin`][crossOrigin] `= "anonymous"`), as with drawing a video on a
  canvas.
- Frames are decoded on the main thread, so it must not be blocked for long.
- The package talks to the worker over the same `postMessage` channel as your code. Tag your own messages, for example
  `{ type: "log" }`, and ignore the rest.
- Requires [`VideoFrame`][VideoFrame] and [`requestVideoFrameCallback`][requestVideoFrameCallback]: Chrome/Edge 94+,
  Firefox 132+, Safari 17+.

## License

Apache-2.0

[example-process]: https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/process-frames?file=worker.js&initialPath=/index.html&startScript=start
[example-control]: https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/control-existing-video?file=worker.js&initialPath=/index.html&startScript=start
[example-create]: https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/create-and-mount?file=worker.js&initialPath=/index.html&startScript=start
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
