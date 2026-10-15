import { FRAME_SOURCE } from "../shared/frame-source.ts";
import {
  type CanPlayTypeResult,
  type FrameMetadata,
  type HostMessage,
  MEDIA_EVENTS,
  type MediaState,
  type MessageEndpoint,
} from "../shared/protocol.ts";
import { type Bridge, type ElementReceiver, bridgeFor } from "./bridge.ts";
import { WorkerMediaError, WorkerTimeRanges } from "./media-types.ts";

export interface CreateVideoElementOptions {
  /**
   * Endpoint connected to the main-thread `VideoHost`. Defaults to the worker
   * global scope (or whatever was passed to `configureVideoTransport`).
   */
  transport?: MessageEndpoint;
}

export type VideoFrameRequestCallback = (now: number, metadata: FrameMetadata) => void;

type EventHandler = ((this: WorkerVideoElement, event: Event) => unknown) | null;

interface MirroredProps {
  autoplay: boolean;
  controls: boolean;
  crossOrigin: string | null;
  defaultMuted: boolean;
  defaultPlaybackRate: number;
  disablePictureInPicture: boolean;
  disableRemotePlayback: boolean;
  height: number;
  loop: boolean;
  playsInline: boolean;
  poster: string;
  preload: "" | "none" | "metadata" | "auto";
  preservesPitch: boolean;
  width: number;
}

const EMPTY_STATE: MediaState = {
  currentSrc: "",
  currentTime: 0,
  duration: Number.NaN,
  ended: false,
  error: null,
  muted: false,
  networkState: 0,
  paused: true,
  playbackRate: 1,
  readyState: 0,
  seeking: false,
  videoHeight: 0,
  videoWidth: 0,
  volume: 1,
  buffered: [],
  played: [],
  seekable: [],
  quality: null,
};

/** State reset performed synchronously by the media element load algorithm. */
const LOAD_RESET: Partial<MediaState> = {
  currentTime: 0,
  duration: Number.NaN,
  ended: false,
  error: null,
  paused: true,
  readyState: 0,
  seeking: false,
  videoHeight: 0,
  videoWidth: 0,
  buffered: [],
  played: [],
  seekable: [],
};

/** Content attributes and the IDL properties they reflect. */
const ATTRIBUTES: Record<string, { prop: string; type: "bool" | "string" | "number" | "nullable" }> = {
  autoplay: { prop: "autoplay", type: "bool" },
  controls: { prop: "controls", type: "bool" },
  crossorigin: { prop: "crossOrigin", type: "nullable" },
  disablepictureinpicture: { prop: "disablePictureInPicture", type: "bool" },
  disableremoteplayback: { prop: "disableRemotePlayback", type: "bool" },
  height: { prop: "height", type: "number" },
  loop: { prop: "loop", type: "bool" },
  muted: { prop: "defaultMuted", type: "bool" },
  playsinline: { prop: "playsInline", type: "bool" },
  poster: { prop: "poster", type: "string" },
  preload: { prop: "preload", type: "string" },
  src: { prop: "src", type: "string" },
  width: { prop: "width", type: "number" },
};

/** Internal per-element state, kept off the public object. */
class Internals implements ElementReceiver {
  readonly element: WorkerVideoElement;
  readonly bridge: Bridge;
  readonly id: number;
  state: MediaState = { ...EMPTY_STATE };
  props: MirroredProps = {
    autoplay: false,
    controls: false,
    crossOrigin: null,
    defaultMuted: false,
    defaultPlaybackRate: 1,
    disablePictureInPicture: false,
    disableRemotePlayback: false,
    height: 0,
    loop: false,
    playsInline: false,
    poster: "",
    preload: "metadata",
    preservesPitch: true,
    width: 0,
  };
  src = "";
  srcObject: unknown = null;
  hasSrcAttribute = false;
  /** Holder shared with the finalizer so the frame can be closed after GC. */
  readonly frame: { current: VideoFrame | null } = { current: null };
  /** Property -> sequence number of the latest optimistic local write. */
  readonly localWrites = new Map<string, number>();
  readonly frameCallbacks = new Map<number, VideoFrameRequestCallback>();
  nextFrameCallbackId = 1;
  readonly handlers = new Map<string, { handler: EventHandler; listener: (event: Event) => void }>();
  /** Sequence number of the latest local load (src/srcObject/load()); older events and frames are stale. */
  loadSeq = 0;
  disposed = false;

  constructor(element: WorkerVideoElement, bridge: Bridge) {
    this.element = element;
    this.bridge = bridge;
    this.id = bridge.nextId();
    const frame = this.frame;
    bridge.register(this.id, element, this, () => {
      frame.current?.close();
      frame.current = null;
    });
    bridge.post({ kind: "create", id: this.id, props: {} });
  }

  /** Sends a property write and records the optimistic local values it implies. */
  write(prop: string, value: unknown, local: Partial<MediaState> = {}, transfer?: Transferable[]): number {
    if (this.disposed) return 0;
    const seq = this.bridge.post({ kind: "set", id: this.id, prop, value }, transfer);
    this.applyLocal(seq, local);
    return seq;
  }

  invoke(
    method: "pause" | "load" | "fastSeek" | "removeAttribute",
    args: unknown[],
    local: Partial<MediaState> = {},
  ): number {
    if (this.disposed) return 0;
    const seq = this.bridge.post({ kind: "call", id: this.id, method, args });
    this.applyLocal(seq, local);
    return seq;
  }

  /** Starts a new load locally: like the load algorithm, drop anything queued for the previous source. */
  markLoad(seq: number): void {
    if (seq) this.loadSeq = seq;
  }

  applyLocal(seq: number, local: Partial<MediaState>): void {
    for (const [key, value] of Object.entries(local)) {
      (this.state as unknown as Record<string, unknown>)[key] = value;
      this.localWrites.set(key, seq);
    }
    if ("readyState" in local && (local.readyState ?? 0) < 2) this.setFrame(null);
    this.updatePin();
  }

  /**
   * Like real media elements, stay alive while playing, seeking or loading
   * even if user code holds no reference (listeners may still be waiting).
   */
  updatePin(): void {
    const { paused, seeking, networkState } = this.state;
    this.bridge.pin(this.element, !paused || seeking || networkState === 2);
  }

  applyState(ack: number, state: MediaState): void {
    const target = this.state as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(state)) {
      const pending = this.localWrites.get(key);
      if (pending !== undefined) {
        if (pending > ack) continue;
        this.localWrites.delete(key);
      }
      target[key] = value;
    }
    this.updatePin();
  }

  setFrame(frame: VideoFrame | null): void {
    if (this.frame.current === frame) return;
    this.frame.current?.close();
    this.frame.current = frame;
  }

  receive(message: Extract<HostMessage, { id: number }>): void {
    if (this.disposed || (message.kind !== "state" && message.ack < this.loadSeq)) {
      // Disposed, or produced for a source that was replaced in the meantime.
      if ("frame" in message) message.frame?.close();
      if (this.disposed) return;
    }
    this.applyState(message.ack, message.state);
    if (message.kind !== "state" && message.ack < this.loadSeq) return;
    switch (message.kind) {
      case "state":
        return;
      case "frame":
        this.setFrame(message.frame);
        this.runFrameCallbacks(message.metadata);
        return;
      case "event": {
        if (message.frame) this.setFrame(message.frame);
        else if (message.type === "emptied") this.setFrame(null);
        this.element.dispatchEvent(new Event(message.type));
        if (message.frame && message.metadata) this.runFrameCallbacks(message.metadata);
      }
    }
  }

  runFrameCallbacks(metadata: FrameMetadata): void {
    if (this.frameCallbacks.size === 0) return;
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    const offset = this.bridge.timeOffset;
    const local: FrameMetadata = {
      ...metadata,
      presentationTime: metadata.presentationTime + offset,
      expectedDisplayTime: metadata.expectedDisplayTime + offset,
    };
    const now = performance.now();
    for (const callback of callbacks) {
      try {
        callback.call(this.element, now, local);
      } catch (error) {
        reportError(error);
      }
    }
  }

  resolveUrl(value: string): string {
    if (value === "") return value;
    const base = (globalThis as { location?: { href: string } }).location?.href;
    try {
      return new URL(value, base).href;
    } catch {
      return value;
    }
  }
}

function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (report) report(error);
  else
    setTimeout(() => {
      throw error;
    });
}

const internals = new WeakMap<WorkerVideoElement, Internals>();

function $(element: WorkerVideoElement): Internals {
  const value = internals.get(element);
  if (!value) throw new TypeError("Illegal invocation");
  return value;
}

/**
 * An `HTMLVideoElement`-compatible object that lives in a worker. The real
 * element lives on the main thread (see `createVideoHost`); state, events and
 * decoded frames are mirrored here so they can be read synchronously.
 */
export class WorkerVideoElement extends EventTarget {
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

  constructor(options: CreateVideoElementOptions = {}) {
    super();
    internals.set(this, new Internals(this, bridgeFor(options.transport)));
  }

  // ---- non-standard API -------------------------------------------------------

  /**
   * The decoded frame currently presented by the element, or `null` when there
   * is none. The frame is owned by the element and is closed as soon as a newer
   * frame arrives: call `clone()` to keep it longer.
   */
  get currentFrame(): VideoFrame | null {
    const frame = $(this).frame.current;
    return frame && frame.format !== null ? frame : null;
  }

  /** Whether `dispose()` was called. */
  get disposed(): boolean {
    return $(this).disposed;
  }

  /**
   * Releases the main-thread element and the current frame. Called
   * automatically when the element is garbage-collected, but calling it
   * explicitly frees resources deterministically.
   */
  dispose(): void {
    const core = $(this);
    if (core.disposed) return;
    core.bridge.post({ kind: "dispose", id: core.id });
    core.disposed = true;
    core.setFrame(null);
    core.frameCallbacks.clear();
    core.bridge.unregister(core.id, core, this);
    core.state = { ...EMPTY_STATE };
    core.localWrites.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // ---- source ---------------------------------------------------------------------

  get src(): string {
    return $(this).src;
  }
  set src(value: string) {
    const core = $(this);
    core.src = core.resolveUrl(String(value));
    core.hasSrcAttribute = true;
    core.markLoad(core.write("src", core.src, { ...LOAD_RESET, currentSrc: "", networkState: 0 }));
  }

  get srcObject(): unknown {
    return $(this).srcObject;
  }
  /**
   * Accepts `null` or a `MediaSourceHandle` (from a `MediaSource` created in
   * this worker). The handle is transferred to the main thread.
   */
  set srcObject(value: unknown) {
    const core = $(this);
    core.srcObject = value ?? null;
    const transfer = value ? [value as Transferable] : [];
    core.markLoad(core.write("srcObject", value ?? null, { ...LOAD_RESET, currentSrc: "", networkState: 0 }, transfer));
  }

  get currentSrc(): string {
    return $(this).state.currentSrc;
  }

  // ---- read-only state -------------------------------------------------------------

  get duration(): number {
    return $(this).state.duration;
  }
  get paused(): boolean {
    return $(this).state.paused;
  }
  get ended(): boolean {
    return $(this).state.ended;
  }
  get seeking(): boolean {
    return $(this).state.seeking;
  }
  get readyState(): number {
    return $(this).state.readyState;
  }
  get networkState(): number {
    return $(this).state.networkState;
  }
  get videoWidth(): number {
    return $(this).state.videoWidth;
  }
  get videoHeight(): number {
    return $(this).state.videoHeight;
  }
  get error(): MediaError | null {
    const error = $(this).state.error;
    return error ? new WorkerMediaError(error) : null;
  }
  get buffered(): TimeRanges {
    return new WorkerTimeRanges($(this).state.buffered);
  }
  get played(): TimeRanges {
    return new WorkerTimeRanges($(this).state.played);
  }
  get seekable(): TimeRanges {
    return new WorkerTimeRanges($(this).state.seekable);
  }

  // ---- playback state -----------------------------------------------------------

  get currentTime(): number {
    return $(this).state.currentTime;
  }
  set currentTime(value: number) {
    const time = Number(value);
    if (!Number.isFinite(time)) {
      throw new TypeError("Failed to set the 'currentTime' property: The provided double value is non-finite.");
    }
    const core = $(this);
    const local: Partial<MediaState> = { currentTime: time, ended: false };
    if (core.state.readyState > 0) local.seeking = true;
    core.write("currentTime", time, local);
  }

  fastSeek(time: number): void {
    const core = $(this);
    const local: Partial<MediaState> = { currentTime: time, ended: false };
    if (core.state.readyState > 0) local.seeking = true;
    core.invoke("fastSeek", [time], local);
  }

  get volume(): number {
    return $(this).state.volume;
  }
  set volume(value: number) {
    const volume = Number(value);
    if (!(volume >= 0 && volume <= 1)) {
      throw new DOMException(
        `Failed to set the 'volume' property: The volume provided (${value}) is outside the range [0, 1].`,
        "IndexSizeError",
      );
    }
    $(this).write("volume", volume, { volume });
  }

  get muted(): boolean {
    return $(this).state.muted;
  }
  set muted(value: boolean) {
    $(this).write("muted", Boolean(value), { muted: Boolean(value) });
  }

  get playbackRate(): number {
    return $(this).state.playbackRate;
  }
  set playbackRate(value: number) {
    $(this).write("playbackRate", Number(value), { playbackRate: Number(value) });
  }

  // ---- mirrored attributes ---------------------------------------------------------

  get autoplay(): boolean {
    return $(this).props.autoplay;
  }
  set autoplay(value: boolean) {
    this.#mirror("autoplay", Boolean(value));
  }
  get controls(): boolean {
    return $(this).props.controls;
  }
  set controls(value: boolean) {
    this.#mirror("controls", Boolean(value));
  }
  get crossOrigin(): string | null {
    return $(this).props.crossOrigin;
  }
  set crossOrigin(value: string | null) {
    this.#mirror("crossOrigin", value === null ? null : String(value));
  }
  get defaultMuted(): boolean {
    return $(this).props.defaultMuted;
  }
  set defaultMuted(value: boolean) {
    this.#mirror("defaultMuted", Boolean(value));
  }
  get defaultPlaybackRate(): number {
    return $(this).props.defaultPlaybackRate;
  }
  set defaultPlaybackRate(value: number) {
    this.#mirror("defaultPlaybackRate", Number(value));
  }
  get disablePictureInPicture(): boolean {
    return $(this).props.disablePictureInPicture;
  }
  set disablePictureInPicture(value: boolean) {
    this.#mirror("disablePictureInPicture", Boolean(value));
  }
  get disableRemotePlayback(): boolean {
    return $(this).props.disableRemotePlayback;
  }
  set disableRemotePlayback(value: boolean) {
    this.#mirror("disableRemotePlayback", Boolean(value));
  }
  get height(): number {
    return $(this).props.height;
  }
  set height(value: number) {
    this.#mirror("height", Math.max(0, Math.trunc(Number(value))) || 0);
  }
  get width(): number {
    return $(this).props.width;
  }
  set width(value: number) {
    this.#mirror("width", Math.max(0, Math.trunc(Number(value))) || 0);
  }
  get loop(): boolean {
    return $(this).props.loop;
  }
  set loop(value: boolean) {
    this.#mirror("loop", Boolean(value));
  }
  get playsInline(): boolean {
    return $(this).props.playsInline;
  }
  set playsInline(value: boolean) {
    this.#mirror("playsInline", Boolean(value));
  }
  get poster(): string {
    return $(this).props.poster;
  }
  set poster(value: string) {
    this.#mirror("poster", $(this).resolveUrl(String(value)));
  }
  get preload(): MirroredProps["preload"] {
    return $(this).props.preload;
  }
  set preload(value: MirroredProps["preload"]) {
    const normalized = String(value).toLowerCase();
    this.#mirror("preload", (["none", "metadata", "auto"].includes(normalized) ? normalized : "auto") as never);
  }
  get preservesPitch(): boolean {
    return $(this).props.preservesPitch;
  }
  set preservesPitch(value: boolean) {
    this.#mirror("preservesPitch", Boolean(value));
  }

  #mirror<K extends keyof MirroredProps>(prop: K, value: MirroredProps[K]): void {
    const core = $(this);
    core.props[prop] = value;
    core.write(prop, value);
  }

  // ---- attributes -----------------------------------------------------------------

  getAttribute(name: string): string | null {
    const core = $(this);
    const attribute = ATTRIBUTES[name.toLowerCase()];
    if (!attribute) return null;
    if (attribute.prop === "src") return core.hasSrcAttribute ? core.src : null;
    const value = (this as unknown as Record<string, unknown>)[attribute.prop];
    switch (attribute.type) {
      case "bool":
        return value ? "" : null;
      case "nullable":
        return value === null ? null : String(value);
      default:
        return String(value);
    }
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  setAttribute(name: string, value: string): void {
    const attribute = ATTRIBUTES[name.toLowerCase()];
    if (!attribute) return;
    const target = this as unknown as Record<string, unknown>;
    switch (attribute.type) {
      case "bool":
        target[attribute.prop] = true;
        break;
      case "number":
        target[attribute.prop] = Number.parseInt(value, 10) || 0;
        break;
      default:
        target[attribute.prop] = String(value);
    }
  }

  removeAttribute(name: string): void {
    const attribute = ATTRIBUTES[name.toLowerCase()];
    if (!attribute) return;
    const core = $(this);
    if (attribute.prop === "src") {
      core.src = "";
      core.hasSrcAttribute = false;
      core.invoke("removeAttribute", ["src"]);
      return;
    }
    const target = this as unknown as Record<string, unknown>;
    switch (attribute.type) {
      case "bool":
        target[attribute.prop] = false;
        break;
      case "nullable":
        target[attribute.prop] = null;
        break;
      case "number":
        target[attribute.prop] = 0;
        break;
      default:
        target[attribute.prop] = attribute.prop === "preload" ? "metadata" : "";
    }
  }

  // ---- methods --------------------------------------------------------------------

  play(): Promise<void> {
    const core = $(this);
    if (core.disposed) {
      return Promise.reject(new DOMException("The element has been disposed.", "InvalidStateError"));
    }
    const [seq, promise] = core.bridge.call({ kind: "call", id: core.id, method: "play", args: [] });
    core.applyLocal(seq, { paused: false });
    return promise as Promise<void>;
  }

  pause(): void {
    $(this).invoke("pause", [], { paused: true });
  }

  load(): void {
    const core = $(this);
    core.markLoad(core.invoke("load", [], { ...LOAD_RESET, networkState: 0 }));
  }

  canPlayType(type: string): CanPlayTypeResult {
    return $(this).bridge.canPlayType(String(type));
  }

  getVideoPlaybackQuality(): VideoPlaybackQuality {
    const quality = $(this).state.quality;
    return (quality ?? {
      creationTime: performance.now(),
      droppedVideoFrames: 0,
      totalVideoFrames: 0,
    }) as VideoPlaybackQuality;
  }

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    const core = $(this);
    const handle = core.nextFrameCallbackId++;
    core.frameCallbacks.set(handle, callback);
    return handle;
  }

  cancelVideoFrameCallback(handle: number): void {
    $(this).frameCallbacks.delete(handle);
  }

  requestPictureInPicture(): Promise<never> {
    return Promise.reject(new DOMException("Picture-in-Picture is not available in workers.", "NotSupportedError"));
  }
}

/** `on<event>` handler properties (`onseeked`, `onloadeddata`, ...) and the frame-source hook. */
// Members below are installed on the prototype right after the class.
export interface WorkerVideoElement {
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

Object.defineProperty(WorkerVideoElement.prototype, FRAME_SOURCE, {
  configurable: true,
  value(this: WorkerVideoElement): VideoFrame | null {
    return this.currentFrame;
  },
});

for (const type of MEDIA_EVENTS) {
  Object.defineProperty(WorkerVideoElement.prototype, `on${type}`, {
    configurable: true,
    enumerable: true,
    get(this: WorkerVideoElement): EventHandler {
      return $(this).handlers.get(type)?.handler ?? null;
    },
    set(this: WorkerVideoElement, handler: EventHandler) {
      const core = $(this);
      const existing = core.handlers.get(type);
      if (typeof handler !== "function") {
        if (existing) this.removeEventListener(type, existing.listener);
        core.handlers.delete(type);
        return;
      }
      if (existing) {
        existing.handler = handler;
        return;
      }
      const entry = {
        handler,
        listener: (event: Event) => {
          const result = entry.handler?.call(this, event);
          if (result === false) event.preventDefault();
        },
      };
      core.handlers.set(type, entry);
      this.addEventListener(type, entry.listener);
    },
  });
}

/** Creates a worker-side video element. */
export function createVideoElement(options?: CreateVideoElementOptions): WorkerVideoElement {
  return new WorkerVideoElement(options);
}
