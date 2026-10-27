import { ALL_FORMATS, BlobSource, Input, Source, UrlSource } from "mediabunny";
import { isWorker } from "../shared/environment.ts";
import { FRAME_SOURCE } from "../shared/frame-source.ts";
import { MEDIA_EVENTS } from "../shared/protocol.ts";
import { WorkerMediaError, WorkerTimeRanges } from "../worker/media-types.ts";
import { type AudioSink, PortAudioSink, WebAudioSink, type WebAudioSinkOptions } from "./audio/sink.ts";
import {
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  Player,
  PlayerError,
  type PlayerListener,
} from "./pipeline/player.ts";
import { queueTask } from "./pipeline/signal.ts";

export interface CanvasVideoElementOptions {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  readAhead?: number;
  frameQueueSize?: number;
  hardwareAcceleration?: HardwareAcceleration;
  requestInit?: Omit<RequestInit, "signal">;
  audio?: false | MessagePort | AudioSink | WebAudioSinkOptions;
}

export interface CanvasVideoFrameMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
}

export type CanvasVideoFrameCallback = (now: number, metadata: CanvasVideoFrameMetadata) => void;

type EventHandler = ((this: CanvasVideoElement, event: Event) => unknown) | null;
type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const TIMEUPDATE_INTERVAL = 250;
const PROGRESS_INTERVAL = 350;
const CONTAINER_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/ogg",
  "video/mp2t",
]);

export class CanvasVideoElement extends EventTarget {
  static readonly NETWORK_EMPTY = 0 as const;
  static readonly NETWORK_IDLE = 1 as const;
  static readonly NETWORK_LOADING = 2 as const;
  static readonly NETWORK_NO_SOURCE = 3 as const;
  static readonly HAVE_NOTHING = 0 as const;
  static readonly HAVE_METADATA = 1 as const;
  static readonly HAVE_CURRENT_DATA = 2 as const;
  static readonly HAVE_FUTURE_DATA = 3 as const;
  static readonly HAVE_ENOUGH_DATA = 4 as const;
  readonly NETWORK_EMPTY = 0 as const;
  readonly NETWORK_IDLE = 1 as const;
  readonly NETWORK_LOADING = 2 as const;
  readonly NETWORK_NO_SOURCE = 3 as const;
  readonly HAVE_NOTHING = 0 as const;
  readonly HAVE_METADATA = 1 as const;
  readonly HAVE_CURRENT_DATA = 2 as const;
  readonly HAVE_FUTURE_DATA = 3 as const;
  readonly HAVE_ENOUGH_DATA = 4 as const;

  readonly tagName = "VIDEO" as const;
  readonly nodeName = "VIDEO" as const;
  readonly localName = "video" as const;

  autoplay = false;
  controls = false;
  crossOrigin: string | null = null;
  defaultMuted = false;
  disablePictureInPicture = true;
  disableRemotePlayback = true;
  id = "";
  loop = false;
  playsInline = true;
  poster = "";
  preload: "" | "none" | "metadata" | "auto" = "auto";
  preservesPitch = true;
  width = 0;
  height = 0;

  readonly #options: CanvasVideoElementOptions;
  readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly #context: CanvasContext | null;
  readonly #frameCallbacks = new Map<number, CanvasVideoFrameCallback>();
  readonly #audioSink: AudioSink | null;
  #nextCallbackId = 1;
  #src = "";
  #srcObject: Blob | Source | null = null;
  #currentSrc = "";
  #input: Input | null = null;
  #player: Player | null = null;
  #generation = 0;
  #networkState = 0;
  #readyState = 0;
  #error: WorkerMediaError | null = null;
  #paused = true;
  #ended = false;
  #seeking = false;
  #defaultPosition = 0;
  #duration = Number.NaN;
  #videoWidth = 0;
  #videoHeight = 0;
  #playbackRate = 1;
  #defaultPlaybackRate = 1;
  #volume = 1;
  #muted = false;
  #loadedData = false;
  #lastTimeUpdate = 0;
  #lastProgress = 0;
  #disposed = false;

  constructor(options: CanvasVideoElementOptions = {}) {
    super();
    this.#options = options;
    this.#canvas = options.canvas ?? new OffscreenCanvas(300, 150);
    this.#context = this.#canvas.getContext("2d", { alpha: false }) as CanvasContext | null;
    this.#audioSink = createSink(options.audio);
  }

  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.#canvas;
  }

  get currentFrame(): VideoFrame | null {
    const frame = this.#player?.currentFrame ?? null;
    return frame && frame.format !== null ? frame : null;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get src(): string {
    return this.#src;
  }
  set src(value: string) {
    this.#src = resolveUrl(String(value));
    this.#load();
  }

  get srcObject(): Blob | Source | null {
    return this.#srcObject;
  }
  set srcObject(value: Blob | Source | null) {
    this.#srcObject = value ?? null;
    this.#load();
  }

  get currentSrc(): string {
    return this.#currentSrc;
  }
  get networkState(): number {
    return this.#networkState;
  }
  get readyState(): number {
    return this.#readyState;
  }
  get error(): MediaError | null {
    return this.#error;
  }
  get paused(): boolean {
    return this.#paused;
  }
  get ended(): boolean {
    return this.#ended;
  }
  get seeking(): boolean {
    return this.#seeking;
  }
  get duration(): number {
    return this.#duration;
  }
  get videoWidth(): number {
    return this.#videoWidth;
  }
  get videoHeight(): number {
    return this.#videoHeight;
  }

  get currentTime(): number {
    const player = this.#player;
    if (!player || this.#readyState === 0) return this.#defaultPosition;
    return player.currentTime / 1e6;
  }
  set currentTime(value: number) {
    const time = Number(value);
    if (!Number.isFinite(time)) {
      throw new TypeError("Failed to set the 'currentTime' property: The provided double value is non-finite.");
    }
    const player = this.#player;
    if (!player || this.#readyState === 0) {
      this.#defaultPosition = time;
      return;
    }
    this.#seek(time);
  }

  fastSeek(time: number): void {
    this.currentTime = time;
  }

  get buffered(): TimeRanges {
    return new WorkerTimeRanges(this.#player?.buffered ?? []);
  }
  get seekable(): TimeRanges {
    return new WorkerTimeRanges(Number.isFinite(this.#duration) ? [[0, this.#duration]] : []);
  }
  get played(): TimeRanges {
    return new WorkerTimeRanges([]);
  }

  get playbackRate(): number {
    return this.#playbackRate;
  }
  set playbackRate(value: number) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new DOMException(`The provided playback rate (${value}) is not supported.`, "NotSupportedError");
    }
    if (rate === this.#playbackRate) return;
    this.#playbackRate = rate;
    this.#player?.setRate(rate);
    this.#fire("ratechange");
  }
  get defaultPlaybackRate(): number {
    return this.#defaultPlaybackRate;
  }
  set defaultPlaybackRate(value: number) {
    this.#defaultPlaybackRate = Number(value);
    this.#fire("ratechange");
  }

  get volume(): number {
    return this.#volume;
  }
  set volume(value: number) {
    const volume = Number(value);
    if (!(volume >= 0 && volume <= 1)) {
      throw new DOMException(
        `Failed to set the 'volume' property: The volume provided (${value}) is outside the range [0, 1].`,
        "IndexSizeError",
      );
    }
    if (volume === this.#volume) return;
    this.#volume = volume;
    this.#applyVolume();
    this.#fire("volumechange");
  }
  get muted(): boolean {
    return this.#muted;
  }
  set muted(value: boolean) {
    if (Boolean(value) === this.#muted) return;
    this.#muted = Boolean(value);
    this.#applyVolume();
    this.#fire("volumechange");
  }

  play(): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new DOMException("The element has been disposed.", "InvalidStateError"));
    }
    if (this.#error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED) {
      return Promise.reject(new DOMException("The element has no supported sources.", "NotSupportedError"));
    }
    if (this.#networkState === 0 && (this.#src || this.#srcObject)) this.#load();
    this.#applyVolume();
    this.#audioSink?.resume();
    if (this.#ended || (this.#player && this.#player.currentTime >= this.#player.duration)) this.#seek(0);
    if (this.#paused) {
      this.#paused = false;
      this.#ended = false;
      this.#fire("play");
      if (this.#loadedData) {
        this.#player?.play();
        this.#fire("playing");
      }
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.#networkState === 0 && (this.#src || this.#srcObject)) this.#load();
    if (this.#paused) return;
    this.#paused = true;
    this.#player?.pause();
    this.#fire("timeupdate");
    this.#fire("pause");
  }

  load(): void {
    this.#load();
  }

  canPlayType(type: string): CanPlayTypeResult {
    const container = String(type).split(";")[0]!.trim().toLowerCase();
    return CONTAINER_TYPES.has(container) ? "maybe" : "";
  }

  getVideoPlaybackQuality(): VideoPlaybackQuality {
    return {
      creationTime: performance.now(),
      droppedVideoFrames: this.#player?.droppedFrames ?? 0,
      totalVideoFrames: this.#player?.presentedFrames ?? 0,
      corruptedVideoFrames: 0,
      totalFrameDelay: 0,
    } as VideoPlaybackQuality;
  }

  requestVideoFrameCallback(callback: CanvasVideoFrameCallback): number {
    const handle = this.#nextCallbackId++;
    this.#frameCallbacks.set(handle, callback);
    return handle;
  }

  cancelVideoFrameCallback(handle: number): void {
    this.#frameCallbacks.delete(handle);
  }

  requestPictureInPicture(): Promise<never> {
    return Promise.reject(new DOMException("Picture-in-Picture is not supported.", "NotSupportedError"));
  }

  getAttribute(name: string): string | null {
    if (name.toLowerCase() === "src") return this.#src || null;
    return null;
  }

  setAttribute(name: string, value: string): void {
    if (name.toLowerCase() === "src") this.src = value;
  }

  removeAttribute(name: string): void {
    if (name.toLowerCase() !== "src") return;
    this.#src = "";
    this.#load();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    this.#teardown();
    this.#audioSink?.close();
    this.#frameCallbacks.clear();
    this.#readyState = 0;
    this.#networkState = 0;
    this.#paused = true;
    this.#seeking = false;
    this.#ended = false;
    this.#loadedData = false;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #fire(type: string): void {
    const generation = this.#generation;
    queueTask(() => {
      if (generation === this.#generation || type === "emptied" || type === "abort") {
        this.dispatchEvent(new Event(type));
      }
    });
  }

  #applyVolume(): void {
    this.#audioSink?.setVolume(this.#muted ? 0 : this.#volume);
  }

  #teardown(): void {
    this.#player?.close();
    this.#player = null;
    this.#input?.dispose();
    this.#input = null;
  }

  #seek(time: number): void {
    const player = this.#player;
    if (!player) return;
    const clamped = Math.min(Math.max(0, time), Number.isFinite(this.#duration) ? this.#duration : time);
    this.#seeking = true;
    this.#ended = false;
    player.seek(clamped);
    this.#fire("seeking");
  }

  #load(): void {
    if (this.#disposed) return;
    const hadMedia = this.#networkState !== 0 || this.#readyState !== 0;
    if (this.#networkState === 2) this.#fire("abort");
    const generation = ++this.#generation;
    this.#teardown();
    if (hadMedia) this.#fire("emptied");
    this.#readyState = 0;
    this.#error = null;
    this.#ended = false;
    this.#seeking = false;
    this.#paused = true;
    this.#duration = Number.NaN;
    this.#loadedData = false;
    const source = this.#createSource();
    if (!source) {
      this.#networkState = 0;
      this.#currentSrc = "";
      return;
    }
    this.#currentSrc = this.#srcObject ? "" : this.#src;
    this.#networkState = 2;
    this.#fire("loadstart");
    void this.#open(source, generation);
  }

  #createSource(): Source | null {
    const object = this.#srcObject;
    if (object instanceof Source) return object;
    if (object instanceof Blob) return new BlobSource(object);
    if (!this.#src) return null;
    const init = { ...this.#options.requestInit };
    if (this.crossOrigin === "use-credentials") init.credentials = "include";
    return new UrlSource(this.#src, { requestInit: init });
  }

  async #open(source: Source, generation: number): Promise<void> {
    const input = new Input({ source, formats: ALL_FORMATS });
    this.#input = input;
    try {
      const [track, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        this.#audioSink ? input.getPrimaryAudioTrack().catch(() => null) : null,
      ]);
      if (generation !== this.#generation) return;
      if (!track) throw new PlayerError(MEDIA_ERR_SRC_NOT_SUPPORTED, "The media has no video track.");
      const audio = audioTrack && this.#audioSink ? { track: audioTrack, sink: this.#audioSink } : null;
      const player = await Player.create(track, audio, this.#listener(generation), {
        readAhead: this.#options.readAhead ?? 3,
        frameQueueSize: this.#options.frameQueueSize ?? 8,
        hardwareAcceleration: this.#options.hardwareAcceleration ?? "no-preference",
      });
      if (generation !== this.#generation) {
        player.close();
        return;
      }
      this.#player = player;
      player.setRate(this.#playbackRate);
      this.#duration = player.duration / 1e6;
      this.#resize(player.width, player.height);
      this.#readyState = 1;
      this.#fire("durationchange");
      this.#fire("loadedmetadata");
      this.#seeking = true;
      player.seek(Math.min(Math.max(0, this.#defaultPosition), this.#duration || 0));
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#failed(errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }

  #failed(code: number, message: string): void {
    this.#error = new WorkerMediaError({ code, message });
    this.#networkState = this.#readyState === 0 ? 3 : 1;
    this.#player?.pause();
    this.#fire("error");
  }

  #listener(generation: number): PlayerListener {
    const live = () => generation === this.#generation;
    return {
      frame: (frame) => {
        if (!live()) return;
        this.#draw(frame);
        if (this.#player?.playing) {
          const now = performance.now();
          if (now - this.#lastTimeUpdate >= TIMEUPDATE_INTERVAL) {
            this.#lastTimeUpdate = now;
            this.#fire("timeupdate");
          }
        }
        this.#runFrameCallbacks(frame);
      },
      seeked: () => {
        if (!live()) return;
        this.#seeking = false;
        if (!this.#loadedData) {
          this.#loadedData = true;
          this.#readyState = 4;
          this.#networkState = 1;
          this.#fire("loadeddata");
          this.#fire("canplay");
          this.#fire("canplaythrough");
          if (this.autoplay && this.#paused) this.#paused = false;
          if (!this.#paused) {
            this.#player?.play();
            this.#fire("play");
            this.#fire("playing");
          }
          return;
        }
        this.#fire("timeupdate");
        this.#fire("seeked");
      },
      waiting: () => {
        if (!live()) return;
        this.#readyState = 2;
        this.#fire("waiting");
      },
      playing: () => {
        if (!live()) return;
        this.#readyState = 4;
        this.#fire("canplay");
        this.#fire("playing");
      },
      ended: () => {
        if (!live()) return;
        if (this.loop) {
          this.#seek(0);
          this.#player?.play();
          return;
        }
        this.#ended = true;
        this.#paused = true;
        this.#fire("timeupdate");
        this.#fire("pause");
        this.#fire("ended");
      },
      progress: () => {
        if (!live()) return;
        const now = performance.now();
        if (now - this.#lastProgress < PROGRESS_INTERVAL) return;
        this.#lastProgress = now;
        this.#fire("progress");
      },
      error: (code, message) => {
        if (live()) this.#failed(code, message);
      },
    };
  }

  #resize(width: number, height: number): void {
    if (width === this.#videoWidth && height === this.#videoHeight) return;
    const initial = this.#videoWidth === 0;
    this.#videoWidth = width;
    this.#videoHeight = height;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    if (!initial) this.#fire("resize");
  }

  #draw(frame: VideoFrame): void {
    this.#resize(frame.displayWidth, frame.displayHeight);
    this.#context?.drawImage(frame, 0, 0, this.#canvas.width, this.#canvas.height);
  }

  #runFrameCallbacks(frame: VideoFrame): void {
    if (this.#frameCallbacks.size === 0) return;
    const callbacks = [...this.#frameCallbacks.values()];
    this.#frameCallbacks.clear();
    const now = performance.now();
    const metadata: CanvasVideoFrameMetadata = {
      presentationTime: now,
      expectedDisplayTime: now,
      width: frame.displayWidth,
      height: frame.displayHeight,
      mediaTime: frame.timestamp / 1e6,
      presentedFrames: this.#player?.presentedFrames ?? 0,
    };
    queueTask(() => {
      for (const callback of callbacks) {
        try {
          callback.call(this, now, metadata);
        } catch (error) {
          reportError(error);
        }
      }
    });
  }
}

export interface CanvasVideoElement {
  [FRAME_SOURCE](): VideoFrame | null;
  onabort: EventHandler;
  oncanplay: EventHandler;
  oncanplaythrough: EventHandler;
  ondurationchange: EventHandler;
  onemptied: EventHandler;
  onencrypted: EventHandler;
  onended: EventHandler;
  onerror: EventHandler;
  onloadeddata: EventHandler;
  onloadedmetadata: EventHandler;
  onloadstart: EventHandler;
  onpause: EventHandler;
  onplay: EventHandler;
  onplaying: EventHandler;
  onprogress: EventHandler;
  onratechange: EventHandler;
  onresize: EventHandler;
  onseeked: EventHandler;
  onseeking: EventHandler;
  onstalled: EventHandler;
  onsuspend: EventHandler;
  ontimeupdate: EventHandler;
  onvolumechange: EventHandler;
  onwaiting: EventHandler;
  onwaitingforkey: EventHandler;
}

Object.defineProperty(CanvasVideoElement.prototype, FRAME_SOURCE, {
  configurable: true,
  value(this: CanvasVideoElement): VideoFrame | null {
    return this.currentFrame;
  },
});

const handlers = new WeakMap<CanvasVideoElement, Map<string, { handler: EventHandler; listener: EventListener }>>();

for (const type of MEDIA_EVENTS) {
  Object.defineProperty(CanvasVideoElement.prototype, `on${type}`, {
    configurable: true,
    enumerable: true,
    get(this: CanvasVideoElement): EventHandler {
      return handlers.get(this)?.get(type)?.handler ?? null;
    },
    set(this: CanvasVideoElement, handler: EventHandler) {
      let map = handlers.get(this);
      if (!map) {
        map = new Map();
        handlers.set(this, map);
      }
      const existing = map.get(type);
      if (typeof handler !== "function") {
        if (existing) this.removeEventListener(type, existing.listener);
        map.delete(type);
        return;
      }
      if (existing) {
        existing.handler = handler;
        return;
      }
      const entry = {
        handler,
        listener: (event: Event) => {
          if (entry.handler?.call(this, event) === false) event.preventDefault();
        },
      };
      map.set(type, entry);
      this.addEventListener(type, entry.listener);
    },
  });
}

export function createCanvasVideoElement(options?: CanvasVideoElementOptions): CanvasVideoElement {
  return new CanvasVideoElement(options);
}

function createSink(option: CanvasVideoElementOptions["audio"]): AudioSink | null {
  if (option === false) return null;
  if (typeof MessagePort !== "undefined" && option instanceof MessagePort) return new PortAudioSink(option);
  if (option && "schedule" in option) return option;
  if (isWorker() || typeof AudioContext === "undefined") return null;
  return new WebAudioSink((option as WebAudioSinkOptions | undefined) ?? {});
}

function resolveUrl(value: string): string {
  if (value === "") return value;
  const base = (globalThis as { location?: { href: string } }).location?.href;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function errorCode(error: unknown): number {
  if (error instanceof PlayerError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError || /fetch|HTTP|network/i.test(message)) return MEDIA_ERR_NETWORK;
  return MEDIA_ERR_SRC_NOT_SUPPORTED;
}

function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (report) report(error);
  else
    setTimeout(() => {
      throw error;
    });
}
