import {
  CHANNEL,
  type CanPlayTypeResult,
  type ClientMessage,
  type HostMessage,
  type MessageEndpoint,
  isProtocolMessage,
} from "../shared/protocol.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OutgoingMessage = DistributiveOmit<ClientMessage, typeof CHANNEL | "seq">;

/** Receives host messages addressed to one element. Implemented by the element internals. */
export interface ElementReceiver {
  receive(message: Extract<HostMessage, { id: number }>): void;
}

interface Finalizable {
  id: number;
  /** Owned resources to release when the element is garbage-collected. */
  release: () => void;
}

/**
 * Worker-side end of the channel. One bridge exists per endpoint; it routes
 * host messages to elements, keeps track of pending calls and releases
 * main-thread resources of elements that were garbage-collected.
 */
export class Bridge {
  readonly endpoint: MessageEndpoint;
  /** Offset (ms) to add to a main-thread `performance.now()` value to express it in this realm. */
  timeOffset = 0;

  #seq = 0;
  #nextId = 1;
  #nextCallId = 1;
  readonly #receivers = new Map<number, WeakRef<ElementReceiver>>();
  /** Strong references to elements that are potentially playing (see HTML spec "garbage collection" for media). */
  readonly #pinned = new Set<object>();
  readonly #calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #canPlayType = new Map<string, CanPlayTypeResult>();
  readonly #registry: FinalizationRegistry<Finalizable> | null;

  constructor(endpoint: MessageEndpoint) {
    this.endpoint = endpoint;
    this.#registry =
      typeof FinalizationRegistry === "function"
        ? new FinalizationRegistry<Finalizable>(({ id, release }) => {
            release();
            this.#receivers.delete(id);
            this.post({ kind: "dispose", id });
          })
        : null;
    endpoint.addEventListener("message", this.#onMessage);
    endpoint.start?.();
    this.post({ kind: "hello" });
  }

  nextId(): number {
    return this.#nextId++;
  }

  /** Posts a message and returns its sequence number. */
  post(message: OutgoingMessage, transfer: Transferable[] = []): number {
    const seq = ++this.#seq;
    this.endpoint.postMessage({ ...message, [CHANNEL]: 1, seq }, transfer);
    return seq;
  }

  /** Posts a call that expects a result; returns its sequence number and the result promise. */
  call(message: OutgoingMessage & { kind: "call" }, transfer?: Transferable[]): [number, Promise<unknown>] {
    const callId = this.#nextCallId++;
    const promise = new Promise((resolve, reject) => this.#calls.set(callId, { resolve, reject }));
    return [this.post({ ...message, callId }, transfer), promise];
  }

  register(id: number, element: object, receiver: ElementReceiver, release: () => void): void {
    this.#receivers.set(id, new WeakRef(receiver));
    this.#registry?.register(element, { id, release }, receiver);
  }

  unregister(id: number, receiver: ElementReceiver, element: object): void {
    this.#receivers.delete(id);
    this.#registry?.unregister(receiver);
    this.#pinned.delete(element);
  }

  pin(element: object, pinned: boolean): void {
    if (pinned) this.#pinned.add(element);
    else this.#pinned.delete(element);
  }

  canPlayType(type: string): CanPlayTypeResult {
    const cached = this.#canPlayType.get(type);
    if (cached !== undefined) return cached;
    // Ask the main thread so the next call gets the authoritative answer.
    const callId = this.#nextCallId++;
    this.#calls.set(callId, {
      resolve: (value) => this.#canPlayType.set(type, value as CanPlayTypeResult),
      reject: () => {},
    });
    this.post({ kind: "canPlayType", type, callId });
    return guessCanPlayType(type);
  }

  #onMessage = (event: MessageEvent): void => {
    if (!isProtocolMessage(event.data)) return;
    const message = event.data as HostMessage;
    switch (message.kind) {
      case "welcome": {
        this.timeOffset = message.timeOrigin - performance.timeOrigin;
        for (const [type, result] of Object.entries(message.canPlayType)) this.#canPlayType.set(type, result);
        return;
      }
      case "result": {
        const call = this.#calls.get(message.callId);
        if (!call) return;
        this.#calls.delete(message.callId);
        if (message.error) call.reject(new DOMException(message.error.message, message.error.name));
        else call.resolve(message.value);
        return;
      }
      default: {
        const receiver = this.#receivers.get(message.id)?.deref();
        if (receiver) receiver.receive(message);
        else if ("frame" in message) message.frame?.close();
      }
    }
  };
}

/** Typical codecs per container, used to answer container-only queries. */
const CONTAINER_CODECS: Record<string, string[]> = {
  "video/webm": ["vp8", "vp9", "av01.0.05M.08"],
  "video/mp4": ["avc1.42E01E", "av01.0.05M.08", "hvc1.1.6.L93.B0", "vp09.00.10.08"],
  "audio/webm": ["opus", "vorbis"],
  "audio/mp4": ["mp4a.40.2", "opus", "flac"],
};

/** Best-effort synchronous answer before the main thread has replied. */
function guessCanPlayType(type: string): CanPlayTypeResult {
  const MediaSourceCtor = (globalThis as { MediaSource?: { isTypeSupported(type: string): boolean } }).MediaSource;
  if (!MediaSourceCtor) return "";
  if (/codecs\s*=/i.test(type)) return MediaSourceCtor.isTypeSupported(type) ? "probably" : "";
  if (MediaSourceCtor.isTypeSupported(type)) return "maybe";
  const container = type.split(";")[0]!.trim().toLowerCase();
  const codecs = CONTAINER_CODECS[container] ?? [];
  return codecs.some((codec) => MediaSourceCtor.isTypeSupported(`${container}; codecs="${codec}"`)) ? "maybe" : "";
}

const bridges = new WeakMap<object, Bridge>();
let defaultEndpoint: MessageEndpoint | undefined;

export function bridgeFor(endpoint: MessageEndpoint | undefined): Bridge {
  const target = endpoint ?? defaultEndpoint ?? (globalThis as unknown as MessageEndpoint);
  if (typeof target.postMessage !== "function") {
    throw new TypeError(
      "html-video-element-webworker-polyfill: no message endpoint. Call configureVideoTransport() or pass `transport`.",
    );
  }
  let bridge = bridges.get(target);
  if (!bridge) {
    bridge = new Bridge(target);
    bridges.set(target, bridge);
  }
  return bridge;
}

/**
 * Sets the endpoint used by elements created without an explicit `transport`.
 * Defaults to the worker global scope (`self`).
 */
export function configureVideoTransport(endpoint: MessageEndpoint): void {
  defaultEndpoint = endpoint;
}
