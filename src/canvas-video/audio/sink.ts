import { queueTask } from "../pipeline/signal.ts";

export interface AudioChunk {
  at: number;
  sampleRate: number;
  frames: number;
  channels: Float32Array[];
  rate: number;
}

export interface AudioSink {
  onconsumed: (() => void) | null;
  schedule(chunk: AudioChunk): void;
  stop(): void;
  setVolume(volume: number): void;
  resume(): void;
  close(): void;
}

export interface WebAudioSinkOptions {
  context?: AudioContext;
  destination?: AudioNode;
}

type PortMessage =
  | { type: "schedule"; chunk: AudioChunk }
  | { type: "stop" }
  | { type: "volume"; value: number }
  | { type: "resume" }
  | { type: "close" };

const REANCHOR_THRESHOLD = 0.02;

export class WebAudioSink implements AudioSink {
  onconsumed: (() => void) | null = null;
  readonly #options: WebAudioSinkOptions;
  readonly #nodes = new Set<AudioBufferSourceNode>();
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #volume = 1;
  #next = -1;
  #closed = false;

  constructor(options: WebAudioSinkOptions = {}) {
    this.#options = options;
  }

  get context(): AudioContext {
    return this.#ensure();
  }

  schedule(chunk: AudioChunk): void {
    if (this.#closed) return;
    const context = this.#ensure();
    const duration = chunk.frames / chunk.sampleRate / chunk.rate;
    const desired = this.#toContextTime(chunk.at);
    let when = this.#next >= 0 && Math.abs(desired - this.#next) < REANCHOR_THRESHOLD ? this.#next : desired;
    let offset = 0;
    const earliest = context.currentTime + 0.005;
    if (when < earliest) {
      offset = earliest - when;
      when = earliest;
    }
    if (offset >= duration) {
      this.#next = -1;
      queueTask(() => this.onconsumed?.());
      return;
    }
    const buffer = context.createBuffer(chunk.channels.length, chunk.frames, chunk.sampleRate);
    chunk.channels.forEach((data, channel) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, channel));
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = chunk.rate;
    node.connect(this.#gain!);
    node.onended = () => {
      this.#nodes.delete(node);
      node.disconnect();
      this.onconsumed?.();
    };
    node.start(when, offset * chunk.rate);
    this.#nodes.add(node);
    this.#next = when + duration - offset;
  }

  stop(): void {
    for (const node of this.#nodes) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    this.#nodes.clear();
    this.#next = -1;
  }

  setVolume(volume: number): void {
    this.#volume = volume;
    if (this.#gain) this.#gain.gain.value = volume;
  }

  resume(): void {
    if (this.#closed) return;
    const context = this.#ensure();
    if (context.state === "suspended") void context.resume().catch(() => {});
  }

  close(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
    this.#gain?.disconnect();
    if (this.#context && !this.#options.context) void this.#context.close().catch(() => {});
  }

  #ensure(): AudioContext {
    if (this.#context) return this.#context;
    const context = this.#options.context ?? new AudioContext({ latencyHint: "playback" });
    const gain = context.createGain();
    gain.gain.value = this.#volume;
    gain.connect(this.#options.destination ?? context.destination);
    this.#context = context;
    this.#gain = gain;
    return context;
  }

  #toContextTime(at: number): number {
    const context = this.#context!;
    const now = at - performance.timeOrigin;
    const stamp = context.getOutputTimestamp();
    if (stamp.contextTime && stamp.performanceTime) {
      return stamp.contextTime + (now - stamp.performanceTime) / 1000;
    }
    const latency = context.outputLatency || context.baseLatency || 0;
    return context.currentTime + (now - performance.now()) / 1000 - latency;
  }
}

export class PortAudioSink implements AudioSink {
  onconsumed: (() => void) | null = null;
  readonly #port: MessagePort;

  constructor(port: MessagePort) {
    this.#port = port;
    port.onmessage = () => this.onconsumed?.();
  }

  schedule(chunk: AudioChunk): void {
    this.#post(
      { type: "schedule", chunk },
      chunk.channels.map((channel) => channel.buffer as ArrayBuffer),
    );
  }

  stop(): void {
    this.#post({ type: "stop" });
  }

  setVolume(volume: number): void {
    this.#post({ type: "volume", value: volume });
  }

  resume(): void {
    this.#post({ type: "resume" });
  }

  close(): void {
    this.#post({ type: "close" });
    this.#port.close();
  }

  #post(message: PortMessage, transfer: Transferable[] = []): void {
    this.#port.postMessage(message, transfer);
  }
}

export interface AudioOutput {
  readonly port: MessagePort;
  readonly context: AudioContext;
  resume(): void;
  close(): void;
}

export function createAudioOutput(options: WebAudioSinkOptions = {}): AudioOutput {
  const sink = new WebAudioSink(options);
  const channel = new MessageChannel();
  const port = channel.port1;
  sink.onconsumed = () => port.postMessage(null);
  port.onmessage = (event: MessageEvent<PortMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "schedule":
        return sink.schedule(message.chunk);
      case "stop":
        return sink.stop();
      case "volume":
        return sink.setVolume(message.value);
      case "resume":
        return sink.resume();
      case "close":
        return sink.close();
    }
  };
  const unlock = () => sink.resume();
  const events = ["pointerdown", "keydown", "touchend"];
  for (const type of events) addEventListener(type, unlock, { capture: true });
  return {
    port: channel.port2,
    get context() {
      return sink.context;
    },
    resume: () => sink.resume(),
    close() {
      for (const type of events) removeEventListener(type, unlock, { capture: true });
      sink.close();
      port.close();
    },
  };
}
