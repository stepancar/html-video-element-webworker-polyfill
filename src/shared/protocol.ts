/**
 * Wire protocol between the worker-side `WorkerVideoElement` and the
 * main-thread `VideoHost`. Every message carries the {@link CHANNEL} tag so the
 * polyfill can share a `Worker`/`MessagePort` with application messages.
 */

export const CHANNEL = "__htmlVideoElementWorkerPolyfill" as const;

/** Media events forwarded from the real element to the worker. */
export const MEDIA_EVENTS: readonly string[] = [
  "abort",
  "canplay",
  "canplaythrough",
  "durationchange",
  "emptied",
  "encrypted",
  "ended",
  "error",
  "loadeddata",
  "loadedmetadata",
  "loadstart",
  "pause",
  "play",
  "playing",
  "progress",
  "ratechange",
  "resize",
  "seeked",
  "seeking",
  "stalled",
  "suspend",
  "timeupdate",
  "volumechange",
  "waiting",
  "waitingforkey",
];

/** Writable properties that are mirrored to the real element as-is. */
export const MIRRORED_PROPERTIES: readonly string[] = [
  "autoplay",
  "controls",
  "crossOrigin",
  "defaultMuted",
  "defaultPlaybackRate",
  "disablePictureInPicture",
  "disableRemotePlayback",
  "height",
  "loop",
  "muted",
  "playbackRate",
  "playsInline",
  "poster",
  "preload",
  "preservesPitch",
  "volume",
  "width",
];

export type Ranges = Array<[start: number, end: number]>;

export interface SerializedMediaError {
  code: number;
  message: string;
}

export interface SerializedPlaybackQuality {
  creationTime: number;
  droppedVideoFrames: number;
  totalVideoFrames: number;
}

/** Read-only (or main-thread driven) state of a media element. */
export interface MediaState {
  currentSrc: string;
  currentTime: number;
  duration: number;
  ended: boolean;
  error: SerializedMediaError | null;
  muted: boolean;
  networkState: number;
  paused: boolean;
  playbackRate: number;
  readyState: number;
  seeking: boolean;
  videoHeight: number;
  videoWidth: number;
  volume: number;
  buffered: Ranges;
  played: Ranges;
  seekable: Ranges;
  quality: SerializedPlaybackQuality | null;
}

export interface FrameMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
  captureTime?: number;
  receiveTime?: number;
  rtpTimestamp?: number;
}

export interface SerializedError {
  name: string;
  message: string;
}

// ---- worker -> main ---------------------------------------------------------

export type ClientMessage =
  | { [CHANNEL]: 1; kind: "create"; id: number; seq: number; props: Record<string, unknown> }
  | { [CHANNEL]: 1; kind: "set"; id: number; seq: number; prop: string; value: unknown }
  | {
      [CHANNEL]: 1;
      kind: "call";
      id: number;
      seq: number;
      method: "play" | "pause" | "load" | "fastSeek" | "removeAttribute";
      args: unknown[];
      callId?: number;
    }
  | { [CHANNEL]: 1; kind: "dispose"; id: number; seq: number }
  | { [CHANNEL]: 1; kind: "canPlayType"; type: string; callId: number }
  | { [CHANNEL]: 1; kind: "hello" };

// ---- main -> worker ---------------------------------------------------------

export type HostMessage =
  | {
      [CHANNEL]: 1;
      kind: "event";
      id: number;
      ack: number;
      type: string;
      state: MediaState;
      frame?: VideoFrame;
      metadata?: FrameMetadata;
    }
  | {
      [CHANNEL]: 1;
      kind: "frame";
      id: number;
      ack: number;
      state: MediaState;
      frame: VideoFrame;
      metadata: FrameMetadata;
    }
  | { [CHANNEL]: 1; kind: "state"; id: number; ack: number; state: MediaState }
  | { [CHANNEL]: 1; kind: "result"; callId: number; value?: unknown; error?: SerializedError }
  | {
      [CHANNEL]: 1;
      kind: "welcome";
      timeOrigin: number;
      canPlayType: Record<string, CanPlayTypeResult>;
    };

export type CanPlayTypeResult = "" | "maybe" | "probably";

/** Something we can exchange messages with: a `Worker`, `MessagePort` or worker global scope. */
export interface MessageEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?: () => void;
}

export function isProtocolMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as Record<string, unknown>)[CHANNEL] === 1;
}

/** MIME types probed eagerly so `canPlayType` can answer synchronously in the worker. */
export const COMMON_MIME_TYPES: readonly string[] = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-matroska",
  "application/vnd.apple.mpegurl",
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.4D401E"',
  'video/mp4; codecs="avc1.64001E"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/mp4; codecs="vp09.00.10.08"',
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="av01.0.05M.08"',
  'video/ogg; codecs="theora"',
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
  "audio/flac",
];
