import {
  CHANNEL,
  COMMON_MIME_TYPES,
  type CanPlayTypeResult,
  type ClientMessage,
  type FrameMetadata,
  type HostMessage,
  MEDIA_EVENTS,
  MIRRORED_PROPERTIES,
  type MediaState,
  type MessageEndpoint,
  type Ranges,
  type SerializedError,
  isProtocolMessage,
} from "../shared/protocol.ts";
import { assertMainThread, isMainThread, isMessageEndpoint } from "../shared/environment.ts";

export interface VideoHostOptions {
  container?: HTMLElement | null;
  onVideoCreated?: (video: HTMLVideoElement, id: number) => void;
  onVideoDisposed?: (video: HTMLVideoElement, id: number) => void;
}

export interface VideoHost {
  readonly videos: ReadonlyMap<number, HTMLVideoElement>;
  dispose(): void;
}

type Distribute<T> = T extends unknown ? Omit<T, typeof CHANNEL> : never;
type OutgoingHostMessage = Distribute<HostMessage>;

const FRAME_EVENTS = new Set(["loadeddata", "seeked"]);

const SILENT_STATE_POLL_INTERVAL = 16;
const SILENT_STATE_POLLS = 32;

interface Entry {
  video: HTMLVideoElement;
  frameCallback: number | null;
  lastFrameTimestamp: number | null;
  frameDuration: number | null;
  detach: () => void;
}

const FRAME_WAIT_TIMEOUT = 500;
const TIMESTAMP_EPSILON = 1000;

const hosted = new WeakSet<object>();

export function createVideoHost(endpoint: MessageEndpoint, options: VideoHostOptions = {}): VideoHost {
  assertMainThread("createVideoHost()");
  if (!isMessageEndpoint(endpoint) || (isMainThread() && endpoint === (globalThis as object))) {
    throw new TypeError(
      "html-video-element-webworker-polyfill: createVideoHost() expects the Worker (or a MessagePort connected to it) that uses the polyfill.",
    );
  }
  if (hosted.has(endpoint)) {
    throw new DOMException(
      "html-video-element-webworker-polyfill: createVideoHost() was already called for this endpoint; call dispose() on the existing host first.",
      "InvalidStateError",
    );
  }
  hosted.add(endpoint);
  const entries = new Map<number, Entry>();
  const videos = new Map<number, HTMLVideoElement>();
  let ack = 0;
  let disposed = false;

  const sentNetworkState = new Map<number, number>();
  const post = (message: OutgoingHostMessage, transfer: Transferable[] = []): void => {
    if (disposed) {
      for (const item of transfer) (item as Partial<VideoFrame>).close?.();
      return;
    }
    if ("state" in message) sentNetworkState.set(message.id, message.state.networkState);
    endpoint.postMessage({ ...message, [CHANNEL]: 1 }, transfer);
  };

  const watching = new Map<number, { polls: number }>();
  const sendState = (id: number, video: HTMLVideoElement): void => {
    post({ kind: "state", id, ack, state: snapshot(video) });
    const existing = watching.get(id);
    if (existing) {
      existing.polls = 0;
      return;
    }
    const watch = { polls: 0 };
    watching.set(id, watch);
    const poll = (): void => {
      if (entries.get(id)?.video !== video || ++watch.polls > SILENT_STATE_POLLS) {
        watching.delete(id);
        return;
      }
      if (video.networkState !== sentNetworkState.get(id)) {
        post({ kind: "state", id, ack, state: snapshot(video) });
      }
      setTimeout(poll, SILENT_STATE_POLL_INTERVAL);
    };
    setTimeout(poll, SILENT_STATE_POLL_INTERVAL);
  };

  const welcome = (): void => {
    const probe = document.createElement("video");
    const canPlayType: Record<string, CanPlayTypeResult> = {};
    for (const type of COMMON_MIME_TYPES) canPlayType[type] = probe.canPlayType(type);
    post({ kind: "welcome", timeOrigin: performance.timeOrigin, canPlayType });
  };

  const captureFrame = (entry: Entry): VideoFrame | null => {
    const { video } = entry;
    if (video.readyState < 2 || typeof VideoFrame !== "function") return null;
    try {
      return new VideoFrame(video);
    } catch {
      return null;
    }
  };

  const create = (id: number): void => {
    const video = document.createElement("video");
    video.playsInline = true;
    const entry: Entry = {
      video,
      frameCallback: null,
      lastFrameTimestamp: null,
      frameDuration: null,
      detach: () => {},
    };

    const noteFrame = (frame: VideoFrame): void => {
      entry.lastFrameTimestamp = frame.timestamp;
    };

    let previousPresented: { frames: number; timestamp: number } | null = null;
    const learnFrameDuration = (frame: VideoFrame, presentedFrames: number): void => {
      const previous = previousPresented;
      previousPresented = { frames: presentedFrames, timestamp: frame.timestamp };
      if (!previous || presentedFrames !== previous.frames + 1 || frame.timestamp <= previous.timestamp) return;
      const delta = frame.timestamp - previous.timestamp;
      entry.frameDuration = entry.frameDuration === null ? delta : Math.min(entry.frameDuration, delta);
    };

    const shows = (frame: VideoFrame, target: number): boolean => {
      if (!video.paused && frame.timestamp >= target - TIMESTAMP_EPSILON) return true;
      if (frame.timestamp > target + TIMESTAMP_EPSILON) return false;
      const duration = frame.duration || entry.frameDuration;
      if (duration) return target < frame.timestamp + duration + TIMESTAMP_EPSILON;
      return frame.timestamp !== entry.lastFrameTimestamp;
    };

    const sendEvent = (type: string, frame: VideoFrame | null): void => {
      if (!frame) {
        if (type === "emptied") entry.lastFrameTimestamp = null;
        post({ kind: "event", id, ack, type, state: snapshot(video) });
        return;
      }
      noteFrame(frame);
      post({ kind: "event", id, ack, type, state: snapshot(video), frame, metadata: syntheticMetadata(video, frame) }, [
        frame,
      ]);
    };

    let held: { type: string; target: number; queue: string[]; timer: ReturnType<typeof setTimeout> } | null = null;

    const releaseHeld = (frame: VideoFrame | null): void => {
      if (!held) return;
      const { type, queue, timer } = held;
      held = null;
      clearTimeout(timer);
      sendEvent(type, frame);
      for (const queued of queue) dispatch(queued);
    };

    const dispatch = (type: string): void => {
      if (held) {
        held.queue.push(type);
        return;
      }
      if (!FRAME_EVENTS.has(type)) {
        sendEvent(type, null);
        return;
      }
      const frame = captureFrame(entry);
      const target = video.currentTime * 1e6;
      if (!frame || shows(frame, target)) {
        sendEvent(type, frame);
        return;
      }
      frame.close();
      held = { type, target, queue: [], timer: setTimeout(() => releaseHeld(captureFrame(entry)), FRAME_WAIT_TIMEOUT) };
    };

    const onEvent = (event: Event): void => dispatch(event.type);
    for (const type of MEDIA_EVENTS) video.addEventListener(type, onEvent);

    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      entry.frameCallback = video.requestVideoFrameCallback(onFrame);
      const frame = captureFrame(entry);
      if (!frame) return;
      learnFrameDuration(frame, metadata.presentedFrames);
      if (held) {
        if (shows(frame, held.target)) releaseHeld(frame);
        else frame.close();
        return;
      }
      if (frame.timestamp === entry.lastFrameTimestamp) {
        frame.close();
        return;
      }
      noteFrame(frame);
      post({ kind: "frame", id, ack, state: snapshot(video), frame, metadata: toMetadata(metadata) }, [frame]);
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      entry.frameCallback = video.requestVideoFrameCallback(onFrame);
    }

    entry.detach = () => {
      for (const type of MEDIA_EVENTS) video.removeEventListener(type, onEvent);
      if (entry.frameCallback !== null) video.cancelVideoFrameCallback(entry.frameCallback);
      if (held) clearTimeout(held.timer);
      held = null;
    };

    entries.set(id, entry);
    videos.set(id, video);
    options.container?.append(video);
    options.onVideoCreated?.(video, id);
  };

  const release = (id: number): void => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    videos.delete(id);
    sentNetworkState.delete(id);
    const { video } = entry;
    options.onVideoDisposed?.(video, id);
    entry.detach();
    video.pause();
    video.removeAttribute("src");
    video.srcObject = null;
    video.load();
    video.remove();
  };

  const handle = (message: ClientMessage): void => {
    if ("seq" in message) ack = Math.max(ack, message.seq);
    switch (message.kind) {
      case "hello":
        welcome();
        return;
      case "canPlayType":
        post({ kind: "result", callId: message.callId, value: probeCanPlayType(message.type) });
        return;
      case "create":
        create(message.id);
        break;
      case "dispose":
        release(message.id);
        return;
      case "set": {
        const video = entries.get(message.id)?.video;
        if (!video) return;
        applyProperty(video, message.prop, message.value);
        break;
      }
      case "call": {
        const video = entries.get(message.id)?.video;
        if (!video) {
          if (message.callId !== undefined) {
            post({
              kind: "result",
              callId: message.callId,
              error: { name: "InvalidStateError", message: "The element has been disposed." },
            });
          }
          return;
        }
        invoke(video, message.method, message.args).then(
          (value) => message.callId !== undefined && post({ kind: "result", callId: message.callId, value }),
          (error: unknown) =>
            message.callId !== undefined &&
            post({ kind: "result", callId: message.callId, error: serializeError(error) }),
        );
        break;
      }
    }
    const video = entries.get(message.id)?.video;
    if (video) sendState(message.id, video);
  };

  const onMessage = (event: MessageEvent): void => {
    if (isProtocolMessage(event.data)) handle(event.data as ClientMessage);
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();
  welcome();

  return {
    videos,
    dispose() {
      if (disposed) return;
      for (const id of entries.keys()) release(id);
      endpoint.removeEventListener("message", onMessage);
      hosted.delete(endpoint);
      disposed = true;
    },
  };
}

function applyProperty(video: HTMLVideoElement, prop: string, value: unknown): void {
  try {
    if (prop === "src") video.src = value as string;
    else if (prop === "srcObject") video.srcObject = value as MediaProvider | null;
    else if (prop === "currentTime") video.currentTime = value as number;
    else if (MIRRORED_PROPERTIES.includes(prop)) (video as unknown as Record<string, unknown>)[prop] = value;
  } catch (error) {
    console.warn(`[html-video-element-webworker-polyfill] failed to set "${prop}":`, error);
  }
}

async function invoke(video: HTMLVideoElement, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "play":
      await video.play();
      return undefined;
    case "pause":
      return video.pause();
    case "load":
      return video.load();
    case "fastSeek":
      if (typeof video.fastSeek === "function") video.fastSeek(args[0] as number);
      else video.currentTime = args[0] as number;
      return undefined;
    case "removeAttribute":
      return video.removeAttribute(args[0] as string);
    default:
      throw new DOMException(`Unknown method ${method}`, "NotSupportedError");
  }
}

let canPlayTypeProbe: HTMLVideoElement | undefined;
function probeCanPlayType(type: string): CanPlayTypeResult {
  canPlayTypeProbe ??= document.createElement("video");
  return canPlayTypeProbe.canPlayType(type);
}

function ranges(timeRanges: TimeRanges): Ranges {
  const result: Ranges = [];
  for (let i = 0; i < timeRanges.length; i++) result.push([timeRanges.start(i), timeRanges.end(i)]);
  return result;
}

function snapshot(video: HTMLVideoElement): MediaState {
  const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
  return {
    currentSrc: video.currentSrc,
    currentTime: video.currentTime,
    duration: video.duration,
    ended: video.ended,
    error: video.error ? { code: video.error.code, message: video.error.message } : null,
    muted: video.muted,
    networkState: video.networkState,
    paused: video.paused,
    playbackRate: video.playbackRate,
    readyState: video.readyState,
    seeking: video.seeking,
    videoHeight: video.videoHeight,
    videoWidth: video.videoWidth,
    volume: video.volume,
    buffered: ranges(video.buffered),
    played: ranges(video.played),
    seekable: ranges(video.seekable),
    quality: quality
      ? {
          creationTime: quality.creationTime,
          droppedVideoFrames: quality.droppedVideoFrames,
          totalVideoFrames: quality.totalVideoFrames,
        }
      : null,
  };
}

function toMetadata(metadata: VideoFrameCallbackMetadata): FrameMetadata {
  const result: FrameMetadata = {
    presentationTime: metadata.presentationTime,
    expectedDisplayTime: metadata.expectedDisplayTime,
    width: metadata.width,
    height: metadata.height,
    mediaTime: metadata.mediaTime,
    presentedFrames: metadata.presentedFrames,
  };
  if (metadata.processingDuration !== undefined) result.processingDuration = metadata.processingDuration;
  if (metadata.captureTime !== undefined) result.captureTime = metadata.captureTime;
  if (metadata.receiveTime !== undefined) result.receiveTime = metadata.receiveTime;
  if (metadata.rtpTimestamp !== undefined) result.rtpTimestamp = metadata.rtpTimestamp;
  return result;
}

function syntheticMetadata(video: HTMLVideoElement, frame: VideoFrame): FrameMetadata {
  const now = performance.now();
  const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
  return {
    presentationTime: now,
    expectedDisplayTime: now,
    width: frame.displayWidth,
    height: frame.displayHeight,
    mediaTime: frame.timestamp / 1e6,
    presentedFrames: quality?.totalVideoFrames ?? 0,
  };
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error || error instanceof DOMException) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}
