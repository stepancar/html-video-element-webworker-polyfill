# html-video-element-webworker-polyfill

[![CI](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml/badge.svg)](https://github.com/stepancar/html-video-element-webworker-polyfill/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/html-video-element-webworker-polyfill)](https://www.npmjs.com/package/html-video-element-webworker-polyfill)

Use `HTMLVideoElement` inside a Web Worker. In `worker.ts`:

```ts
const video = document.createElement("video");
video.src = "https://example.com/movie.webm";
video.addEventListener("seeked", () => {
  ctx.drawImage(video, 0, 0);
});
video.currentTime = 12.5;
```

OffscreenCanvas 2D, WebGL and WebGPU accept the element too.

Workers have no DOM, so this package keeps a real `<video>` on the main thread and mirrors it into the worker:
properties and method calls go to the main thread, state and events come back, and every decoded frame is
transferred to the worker as a `VideoFrame`. The worker keeps the current frame, so it can be read **synchronously**
— in a `seeked` handler, a `requestVideoFrameCallback` callback, or anywhere else.

**[Live demo →](https://stepancar.github.io/html-video-element-webworker-polyfill/)** — a small video editor whose
playback, WebGL effects, picture-in-picture and timeline thumbnails are all rendered in a worker.

**[Open the minimal example in StackBlitz →](https://stackblitz.com/github/stepancar/html-video-element-webworker-polyfill/tree/main/examples/stackblitz?file=worker.js&initialPath=/index.html&startScript=start)**

## Why not WebCodecs?

WebCodecs gives you a decoder, not a player. With `VideoDecoder` you demux every container yourself (mp4box.js, a
WebM parser, …), configure codecs, feed chunks, find keyframes to seek and handle streaming and buffering.
`HTMLVideoElement` already does all of that for every format the browser can play — MP4, WebM, MOV, MSE streams, HLS
where supported — and gives you frame-accurate seeking with `currentTime` and `seeked`. For frame processing it is
usually exactly the right tool; it just does not exist in workers. This package makes it available there.

## Install

```sh
npm install html-video-element-webworker-polyfill
```

## Quick start

**Main thread** — serve video elements to the worker. This is the only main-thread code you need; call it right after
creating the worker:

```ts
import { createVideoHost } from "html-video-element-webworker-polyfill/host";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const host = createVideoHost(worker);
```

**Worker** — use the standard API. `polyfillDocument()` enables `document.createElement("video")` and
`polyfill2dCanvasApi()` enables `ctx.drawImage(video, ...)`:

```ts
import { polyfillDocument } from "html-video-element-webworker-polyfill/worker";
import { polyfill2dCanvasApi } from "html-video-element-webworker-polyfill/canvas2d";

polyfillDocument();
polyfill2dCanvasApi();

const canvas = new OffscreenCanvas(640, 360);
const ctx = canvas.getContext("2d")!;

const video = document.createElement("video");
video.muted = true;
video.src = "/movie.webm";

video.addEventListener("loadedmetadata", () => {
  video.currentTime = 10;
});
video.addEventListener("seeked", () => {
  ctx.drawImage(video, 0, 0, 640, 360);
});
```

…or the explicit, non-standard API that needs no global patches:

```ts
import { createVideoElement } from "html-video-element-webworker-polyfill/worker";

const video = createVideoElement();
video.src = "/movie.webm";
await video.play();

video.requestVideoFrameCallback(function onFrame(now, metadata) {
  const frame = video.currentFrame;
  render(frame);
  video.requestVideoFrameCallback(onFrame);
});

video.dispose();
```

`currentFrame` is a `VideoFrame` (or `null`) and is always the frame on screen. `dispose()` releases the element
when you are done.

Prefer a single import? `import "html-video-element-webworker-polyfill/auto"` inside the worker installs every
polyfill.

## Entry points

Every feature is a separate subpath with no side effects (except `auto`), so bundles only contain what you import.
Importing from the package root tree-shakes just as well.

| Import                                               | Where       | Exports                                                                                   | Size (min, approx.) |
| ---------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- | ------------------- |
| `html-video-element-webworker-polyfill/host`         | main thread | `createVideoHost`                                                                         | 10 kB               |
| `html-video-element-webworker-polyfill/worker`       | worker      | `createVideoElement`, `WorkerVideoElement`, `polyfillDocument`, `configureVideoTransport` | 22 kB               |
| `html-video-element-webworker-polyfill/canvas2d`     | worker      | `polyfill2dCanvasApi`                                                                     | 2.6 kB              |
| `html-video-element-webworker-polyfill/webgl`        | worker      | `polyfillWebglAPI`                                                                        | 2.6 kB              |
| `html-video-element-webworker-polyfill/webgpu`       | worker      | `polyfillWebgpu`                                                                          | 2.7 kB              |
| `html-video-element-webworker-polyfill/image-bitmap` | worker      | `polyfillCreateImageBitmap`, `polyfillVideoFrame`                                         | 2.6 kB              |
| `html-video-element-webworker-polyfill/auto`         | worker      | side effect: installs everything above                                                    | 29 kB               |
| `html-video-element-webworker-polyfill`              | both        | all of the above + `installWorkerPolyfills`, `frameOf`                                    | —                   |

`npm run check:treeshake` bundles each import with Rolldown and asserts that e.g. `polyfillWebglAPI` pulls in neither the
element nor the host.

## API

### `createVideoHost(endpoint, options?)` — main thread

`endpoint` is a `Worker` or a `MessagePort`. Several workers can each have their own host, and each host serves any
number of elements. Messages are tagged, so the channel can be shared with your own messages.

```ts
interface VideoHostOptions {
  container?: HTMLElement | null;
  onVideoCreated?(video: HTMLVideoElement, id: number): void;
  onVideoDisposed?(video: HTMLVideoElement, id: number): void;
}

interface VideoHost {
  readonly videos: ReadonlyMap<number, HTMLVideoElement>;
  dispose(): void;
}
```

`container` mounts the real `<video>` elements into the DOM (by default they stay detached). `videos` lists the live
real elements. `dispose()` releases everything, e.g. before `worker.terminate()`.

### `WorkerVideoElement` — worker

An `EventTarget` implementing the `HTMLVideoElement`/`HTMLMediaElement` API:

- **State**: `currentTime` (get/set), `duration`, `paused`, `ended`, `seeking`, `readyState`, `networkState`,
  `videoWidth`, `videoHeight`, `currentSrc`, `error` (`MediaError`), `buffered`/`played`/`seekable` (`TimeRanges`).
- **Settings**: `src`, `srcObject` (a `MediaSourceHandle` from a worker-side `MediaSource`), `muted`, `volume`,
  `playbackRate`, `defaultPlaybackRate`, `defaultMuted`, `loop`, `autoplay`, `preload`, `crossOrigin`, `poster`,
  `playsInline`, `preservesPitch`, `width`, `height`, `controls`, `disablePictureInPicture`, `disableRemotePlayback`.
- **Methods**: `play()` (promise), `pause()`, `load()`, `fastSeek()`, `canPlayType()`, `getVideoPlaybackQuality()`,
  `requestVideoFrameCallback()`, `cancelVideoFrameCallback()`, `getAttribute`/`setAttribute`/`hasAttribute`/
  `removeAttribute` (for reflected attributes such as `src`, `loop`, `muted`, `crossorigin`).
- **Events**: every media event (`loadstart`, `loadedmetadata`, `loadeddata`, `canplay`, `play`, `playing`, `pause`,
  `seeking`, `seeked`, `timeupdate`, `ended`, `error`, `emptied`, `resize`, `volumechange`, `ratechange`, …) via
  `addEventListener` or `on<event>` properties.
- **Non-standard**:
  - `currentFrame: VideoFrame | null` — the frame currently presented. It is owned by the element and closed when the
    next frame arrives; `clone()` it to keep it longer.
  - `dispose()` / `[Symbol.dispose]()` (works with `using`) and `disposed`.

`createVideoElement({ transport? })` creates one. `transport` overrides the endpoint (default: the worker global
scope, or what you passed to `configureVideoTransport`).

### Rendering polyfills — worker

Each patches prototypes once (idempotent) so that the element is accepted wherever a real video is:

| Function                      | Patches                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `polyfill2dCanvasApi()`       | `OffscreenCanvasRenderingContext2D` `drawImage` (all overloads), `createPattern`                                |
| `polyfillWebglAPI()`          | WebGL 1 & 2 `texImage2D`, `texSubImage2D`, `texImage3D`, `texSubImage3D` (all overloads)                        |
| `polyfillWebgpu()`            | `GPUQueue.copyExternalImageToTexture({ source })`, `GPUDevice.importExternalTexture({ source })`                |
| `polyfillCreateImageBitmap()` | `createImageBitmap(video, ...)`                                                                                 |
| `polyfillVideoFrame()`        | `new VideoFrame(video, init)` (a `Proxy`, so `instanceof VideoFrame` is unaffected)                             |
| `polyfillDocument()`          | `document.createElement("video")`, plus `HTMLVideoElement`/`HTMLMediaElement`/`MediaError`/`TimeRanges` globals |

As with real elements, drawing a video that has no data yet is a no-op, while `createImageBitmap`, `new VideoFrame`
and WebGPU throw `InvalidStateError`.

If you do not want global patches, pass `video.currentFrame` (a regular `VideoFrame`) to any of these APIs.

### Environment checks

Every function verifies that it runs where it belongs and throws an `InvalidEnvironmentError` otherwise:

| Runs only on the main thread | Runs only inside a worker                                                                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVideoHost`            | `createVideoElement`, `new WorkerVideoElement()`, `polyfillDocument`, `configureVideoTransport`, `polyfill2dCanvasApi`, `polyfillWebglAPI`, `polyfillWebgpu`, `polyfillCreateImageBitmap`, `polyfillVideoFrame`, `installWorkerPolyfills`, the `auto` entry |

So a worker-side polyfill can never patch `document.createElement` or canvas prototypes of the page by mistake.
`isMainThread()` and `isWorker()` are exported for your own checks.

Common mistakes are reported too:

- `createVideoHost()` throws a `TypeError` unless it gets a `Worker` or `MessagePort`, and an `InvalidStateError` when
  the same endpoint is attached twice (call `dispose()` on the previous host first).
- `createVideoElement({ transport })` and `configureVideoTransport()` throw a `TypeError` for anything that is not a
  message endpoint.
- A worker that creates video elements without a host on the main thread logs a warning after 3 seconds, since its
  videos would never load.

## How it works

```
 worker                                          main thread
 ──────                                          ───────────
 video.currentTime = 5  ── set(seq=7) ─────────▶ realVideo.currentTime = 5
   (reads 5 immediately)                          ◀── state(ack=7) ─────── snapshot
 "seeked" listeners run ◀── event + VideoFrame ── "seeked" fires, new VideoFrame(realVideo)
 video.currentFrame      ◀── frame + metadata ─── requestVideoFrameCallback on realVideo
```

- **Optimistic writes.** Setters update the worker-side state immediately, as browsers do (`currentTime` returns the new
  value, `paused` flips on `play()`). Each command carries a sequence number; state snapshots from the main thread are
  only applied to a property once they acknowledge its latest local write, so stale updates never overwrite it.
- **Events carry state.** Every forwarded event includes a full state snapshot, applied before your listeners run.
  `seeked` and `loadeddata` also carry the new frame, so `currentFrame` is already correct inside the handler.
- **Frames.** The host captures a `VideoFrame` for every presented frame (`requestVideoFrameCallback`) and transfers it
  (zero-copy). The worker closes the previous frame. `requestVideoFrameCallback` metadata is converted to the worker's
  time origin.
- **Backpressure.** Only one frame is in flight at a time. When the worker is busy, the host keeps just the newest
  frame and sends it once the worker is ready, so a slow consumer always sees fresh frames instead of a backlog.
- **Cleanup.** `dispose()` releases the main-thread element and the current frame. Elements that become unreachable are
  released automatically through `FinalizationRegistry`; like real media elements, an element is kept alive while it
  is playing.

## Caveats

- The main thread must be alive: frames are produced there. A long main-thread task delays frames to the worker.
- Cross-origin media needs CORS (`video.crossOrigin = "anonymous"` and an `Access-Control-Allow-Origin` header), or no
  frames can be captured — the same rule as for drawing a video on a canvas.
- Browsers pause video-only media in background tabs to save power; the polyfilled element behaves the same way.
- `canPlayType()` is synchronous. Common types are answered from a table sent by the host; others are guessed with
  `MediaSource.isTypeSupported` and refined once the host has answered.
- `polyfillDocument()` defines `document` in the worker, which may make some libraries think they are on the main
  thread. Use `createVideoElement()` when that matters.
- Requires `VideoFrame` (WebCodecs) and `requestVideoFrameCallback` on the main thread: Chrome/Edge 94+, Firefox 132+,
  Safari 17+ (the test suite runs in Chromium).

## Development

```sh
npm install
npx playwright install chromium
```

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `npm test`                  | browser tests (Vitest browser mode + Playwright)                    |
| `npm run test:update`       | update screenshot references for your platform                      |
| `npm run test:update-linux` | update Linux references in the Playwright Docker image (used by CI) |
| `npm run lint`              | oxlint                                                              |
| `npm run format`            | oxfmt                                                               |
| `npm run typecheck`         | tsc                                                                 |
| `npm run build`             | tsdown → `dist/`                                                    |
| `npm run check:treeshake`   | verify each entry point stays small                                 |
| `npm run demo:dev`          | demo on http://localhost:5173                                       |

The tests run in real Chromium. They cover the whole round trip — loading, seeking with synchronous frame access,
playback, events, properties, many elements, `dispose()`, garbage collection, Media Source Extensions — and every
rendering polyfill, with pixel assertions and screenshot comparisons (`test/__screenshots__`).

### Releasing

Releases are published from GitHub Actions with npm trusted publishing (OIDC): no npm token is stored anywhere, and
every version gets a provenance attestation.

1. Bump `version` in `package.json` and push to `main`.
2. Publish a GitHub release tagged `v<version>`. The `Release` workflow tests, builds and runs `npm publish`.

One-time setup on npmjs.com: package settings → Trusted Publisher → GitHub Actions, with repository
`stepancar/html-video-element-webworker-polyfill` and workflow `release.yml`.

The demo is deployed to GitHub Pages on every push to `main`.

## License

Apache-2.0
