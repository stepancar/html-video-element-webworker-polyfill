import { type EncodedPacket, EncodedPacketSink, type InputAudioTrack, type InputVideoTrack } from "mediabunny";
import type { AudioSink } from "../audio/sink.ts";
import { AudioPipeline } from "./audio-pipeline.ts";
import { PacketQueue } from "./packet-queue.ts";
import { Signal, queueTask } from "./signal.ts";

export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export interface PlayerListener {
  frame(frame: VideoFrame): void;
  seeked(): void;
  waiting(): void;
  playing(): void;
  ended(): void;
  progress(): void;
  error(code: number, message: string): void;
}

export interface PlayerOptions {
  readAhead: number;
  frameQueueSize: number;
  hardwareAcceleration: HardwareAcceleration;
}

interface QueuedFrame {
  frame: VideoFrame;
  serial: number;
}

const FORWARD_WINDOW = 1_000_000;
const SNAP_TOLERANCE = 1000;

export class Player {
  readonly duration: number;
  readonly frameDuration: number;
  readonly width: number;
  readonly height: number;
  droppedFrames = 0;
  presentedFrames = 0;
  decodedFrames = 0;
  readonly #config: VideoDecoderConfig;
  readonly #listener: PlayerListener;
  readonly #options: PlayerOptions;
  readonly #packets: EncodedPacketSink;
  readonly #decoder: VideoDecoder;
  readonly #audio: AudioPipeline | null;
  readonly #queue = new PacketQueue();
  readonly #readSignal = new Signal();
  readonly #decodeSignal = new Signal();
  #frames: QueuedFrame[] = [];
  #serial = 0;
  #decoderSerial = 0;
  #needKey = true;
  #readRequest: { time: number; serial: number } | null = null;
  #eofSerial = -1;
  #streamEnd = Number.NEGATIVE_INFINITY;
  #current: VideoFrame | null = null;
  #target: number | null = null;
  #pick = 0;
  #seekToken = 0;
  #fallback: VideoFrame | null = null;
  #playing = false;
  #rate = 1;
  #clockBase = 0;
  #clockWall = 0;
  #pausedTime = 0;
  #stalled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #buffered: [number, number][] = [];

  private constructor(
    track: InputVideoTrack,
    config: VideoDecoderConfig,
    info: { duration: number; frameDuration: number },
    audio: AudioPipeline | null,
    listener: PlayerListener,
    options: PlayerOptions,
  ) {
    this.#config = config;
    this.#audio = audio;
    this.#listener = listener;
    this.#options = options;
    this.#packets = new EncodedPacketSink(track);
    this.duration = info.duration;
    this.frameDuration = info.frameDuration;
    this.width = track.displayWidth;
    this.height = track.displayHeight;
    this.#decoder = new VideoDecoder({
      output: (frame) => this.#output(frame),
      error: (error) => {
        if (!this.#closed) this.#listener.error(MEDIA_ERR_DECODE, error.message);
      },
    });
    this.#decoder.addEventListener("dequeue", () => this.#decodeSignal.notify());
    this.#decoder.configure(config);
    void this.#readLoop();
    void this.#decodeLoop();
  }

  static async create(
    track: InputVideoTrack,
    audio: { track: InputAudioTrack; sink: AudioSink } | null,
    listener: PlayerListener,
    options: PlayerOptions,
  ): Promise<Player> {
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new PlayerError(MEDIA_ERR_SRC_NOT_SUPPORTED, `Unsupported codec ${track.codec ?? ""}.`);
    const config: VideoDecoderConfig = { ...decoderConfig, hardwareAcceleration: options.hardwareAcceleration };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new PlayerError(MEDIA_ERR_SRC_NOT_SUPPORTED, `This browser cannot decode ${config.codec}.`);
    }
    const [metadataDuration, stats, audioDuration, audioPipeline] = await Promise.all([
      track.getDurationFromMetadata(),
      track.computePacketStats(60),
      audio ? audio.track.getDurationFromMetadata().catch(() => null) : null,
      audio ? AudioPipeline.create(audio.track, audio.sink).catch(() => null) : null,
    ]);
    const videoSeconds = metadataDuration ?? (await track.computeDuration());
    const seconds = audioPipeline && audioDuration ? Math.max(videoSeconds, audioDuration) : videoSeconds;
    const rate = stats.averagePacketRate > 0 ? stats.averagePacketRate : 30;
    return new Player(
      track,
      config,
      { duration: Math.round(seconds * 1e6), frameDuration: Math.round(1e6 / rate) },
      audioPipeline,
      listener,
      options,
    );
  }

  get currentFrame(): VideoFrame | null {
    return this.#current;
  }

  get currentTime(): number {
    if (this.#target !== null) return this.#target;
    if (this.#playing && !this.#stalled) return Math.min(this.#clock(), this.duration);
    return this.#pausedTime;
  }

  get hasAudio(): boolean {
    return this.#audio !== null;
  }

  get seeking(): boolean {
    return this.#target !== null;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get stalled(): boolean {
    return this.#stalled;
  }

  get hasFutureFrame(): boolean {
    return this.#frames.length > 0 || this.#eofSerial === this.#serial;
  }

  get buffered(): [number, number][] {
    return this.#buffered.map(([start, end]) => [start / 1e6, end / 1e6]);
  }

  seek(seconds: number): void {
    if (this.#closed) return;
    const target = Math.round(seconds * 1e6);
    const token = ++this.#seekToken;
    this.#audio?.stop();
    const pick = target + Math.min(SNAP_TOLERANCE, this.frameDuration / 4);
    this.#target = target;
    this.#pick = pick;
    this.#pausedTime = target;
    this.#clearTimer();
    if (this.#canServe(pick)) {
      queueTask(() => this.#refresh());
      return;
    }
    if (pick >= this.#streamEnd && this.#streamEnd > Number.NEGATIVE_INFINITY) {
      if (pick - this.#streamEnd <= FORWARD_WINDOW) {
        queueTask(() => this.#refresh());
        return;
      }
      void this.#continueOrRestart(pick, token);
      return;
    }
    this.#restart(pick);
  }

  async #continueOrRestart(target: number, token: number): Promise<void> {
    let key: EncodedPacket | null;
    try {
      key = await this.#packets.getKeyPacket(target / 1e6);
    } catch (error) {
      this.#fail(MEDIA_ERR_NETWORK, error);
      return;
    }
    if (token !== this.#seekToken || this.#closed) return;
    if (key && Math.round(key.timestamp * 1e6) > this.#streamEnd) this.#restart(target);
    this.#refresh();
  }

  play(): void {
    if (this.#playing || this.#closed) return;
    this.#playing = true;
    this.#stalled = false;
    this.#clockBase = this.#target ?? this.#pausedTime;
    this.#clockWall = performance.now();
    if (this.#target === null) this.#startAudio();
    queueTask(() => this.#refresh());
  }

  pause(): void {
    if (!this.#playing) return;
    if (this.#target === null && !this.#stalled) this.#pausedTime = Math.min(this.#clock(), this.duration);
    this.#playing = false;
    this.#stalled = false;
    this.#clearTimer();
    this.#audio?.stop();
  }

  setRate(rate: number): void {
    if (this.#playing && !this.#stalled && this.#target === null) {
      this.#clockBase = this.#clock();
      this.#clockWall = performance.now();
    }
    this.#rate = rate;
    if (this.#playing && !this.#stalled && this.#target === null) this.#startAudio();
    if (this.#playing) this.#refresh();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    this.#audio?.close();
    if (this.#decoder.state !== "closed") this.#decoder.close();
    for (const { frame } of this.#frames) frame.close();
    this.#frames = [];
    this.#queue.clear();
    this.#fallback?.close();
    this.#fallback = null;
    this.#current?.close();
    this.#current = null;
    this.#readSignal.notify();
    this.#decodeSignal.notify();
  }

  #startAudio(): void {
    this.#audio?.start(this.#clockBase, this.#clockWall, this.#rate);
  }

  #clock(): number {
    return this.#clockBase + (performance.now() - this.#clockWall) * 1000 * this.#rate;
  }

  #covers(frame: VideoFrame, time: number): boolean {
    return frame.timestamp <= time && time < frame.timestamp + (frame.duration ?? this.frameDuration);
  }

  #canServe(time: number): boolean {
    return this.#current !== null && this.#covers(this.#current, time);
  }

  #restart(time: number): void {
    this.#serial++;
    if (this.#decoder.state !== "closed") {
      this.#decoder.reset();
      this.#decoder.configure(this.#config);
    }
    this.#decoderSerial = this.#serial;
    this.#needKey = true;
    for (const { frame } of this.#frames) frame.close();
    this.#frames = [];
    this.#releaseFallback();
    this.#queue.clear();
    this.#eofSerial = -1;
    this.#streamEnd = Number.NEGATIVE_INFINITY;
    this.#readRequest = { time, serial: this.#serial };
    this.#readSignal.notify();
    this.#decodeSignal.notify();
  }

  #output(frame: VideoFrame): void {
    if (this.#closed || this.#decoderSerial !== this.#serial) {
      frame.close();
      return;
    }
    this.decodedFrames++;
    this.#frames.push({ frame, serial: this.#decoderSerial });
    this.#refresh();
  }

  #refresh(): void {
    if (this.#closed) return;
    if (this.#frames.some((entry) => entry.serial !== this.#serial)) {
      this.#frames = this.#frames.filter((entry) => {
        if (entry.serial === this.#serial) return true;
        entry.frame.close();
        return false;
      });
    }
    if (this.#target !== null) this.#advanceSeek(this.#pick);
    else if (this.#playing) this.#advancePlayback();
    this.#decodeSignal.notify();
  }

  #advanceSeek(pick: number): void {
    if (this.#current && this.#covers(this.#current, pick)) {
      this.#finishSeek(null);
      return;
    }
    while (this.#frames.length > 0) {
      const { frame } = this.#frames.shift()!;
      const end = frame.timestamp + (frame.duration ?? this.frameDuration);
      this.#streamEnd = end;
      if (end <= pick) {
        this.#fallback?.close();
        this.#fallback = frame;
        continue;
      }
      this.#finishSeek(frame);
      return;
    }
    if (this.#eofSerial === this.#serial) {
      const fallback = this.#fallback;
      this.#fallback = null;
      this.#finishSeek(fallback);
    }
  }

  #finishSeek(frame: VideoFrame | null): void {
    const target = this.#target ?? this.#pausedTime;
    this.#releaseFallback();
    this.#target = null;
    this.#pausedTime = target;
    if (frame) this.#present(frame);
    if (this.#playing) {
      this.#clockBase = target;
      this.#clockWall = performance.now();
      this.#stalled = false;
      this.#startAudio();
    }
    this.#listener.seeked();
    if (this.#playing) this.#advancePlayback();
  }

  #present(frame: VideoFrame): void {
    if (frame === this.#current) return;
    this.#current?.close();
    this.#current = frame;
    this.presentedFrames++;
    this.#listener.frame(frame);
  }

  #advancePlayback(): void {
    this.#clearTimer();
    if (this.#stalled) {
      if (this.#frames.length === 0 && this.#eofSerial !== this.#serial) return;
      this.#stalled = false;
      this.#clockWall = performance.now();
      this.#startAudio();
      this.#listener.playing();
    }
    const now = this.#clock();
    let presented: VideoFrame | null = null;
    while (this.#frames.length > 0) {
      const head = this.#frames[0]!.frame;
      if (head.timestamp > now) break;
      const next = this.#frames[1]?.frame;
      this.#frames.shift();
      this.#streamEnd = head.timestamp + (head.duration ?? this.frameDuration);
      if (next && next.timestamp <= now) {
        head.close();
        this.droppedFrames++;
        continue;
      }
      presented = head;
      break;
    }
    if (presented) this.#present(presented);
    const head = this.#frames[0]?.frame;
    if (head) {
      this.#schedule((head.timestamp - this.#clock()) / 1000 / this.#rate);
      return;
    }
    const currentEnd = this.#current
      ? this.#current.timestamp + (this.#current.duration ?? this.frameDuration)
      : this.#clockBase;
    if (this.#eofSerial === this.#serial) {
      const end = Math.max(currentEnd, this.duration);
      if (now >= end) {
        this.#playing = false;
        this.#audio?.stop();
        this.#pausedTime = this.duration || end;
        this.#listener.ended();
        return;
      }
      this.#schedule((end - now) / 1000 / this.#rate);
      return;
    }
    if (now >= currentEnd) {
      this.#stalled = true;
      this.#audio?.stop();
      this.#clockBase = Math.min(now, currentEnd);
      this.#pausedTime = this.#clockBase;
      this.#listener.waiting();
      return;
    }
    this.#schedule((currentEnd - now) / 1000 / this.#rate);
  }

  #schedule(ms: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#refresh();
      },
      Math.max(0, ms),
    );
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #releaseFallback(): void {
    this.#fallback?.close();
    this.#fallback = null;
  }

  #queueFull(): boolean {
    return this.#queue.duration >= this.#options.readAhead * 1e6 || this.#queue.length >= 600;
  }

  #fail(code: number, error: unknown): void {
    if (this.#closed) return;
    this.#listener.error(code, error instanceof Error ? error.message : String(error));
  }

  #addBuffered(packet: EncodedPacket): void {
    const start = Math.round(packet.timestamp * 1e6);
    const end = start + Math.max(Math.round(packet.duration * 1e6), 1);
    const tolerance = this.frameDuration * 1.5;
    const ranges = this.#buffered;
    let merged: [number, number] = [start, end];
    const kept: [number, number][] = [];
    for (const range of ranges) {
      if (range[1] + tolerance < merged[0] || merged[1] + tolerance < range[0]) kept.push(range);
      else merged = [Math.min(range[0], merged[0]), Math.max(range[1], merged[1])];
    }
    kept.push(merged);
    kept.sort((a, b) => a[0] - b[0]);
    const grew = kept.length !== ranges.length || merged[1] > (ranges.find((r) => r[0] === merged[0])?.[1] ?? -1);
    this.#buffered = kept;
    if (grew) this.#listener.progress();
  }

  async #readLoop(): Promise<void> {
    let next: EncodedPacket | null | undefined;
    let serial = -1;
    while (!this.#closed) {
      const request = this.#readRequest;
      if (request) {
        this.#readRequest = null;
        serial = request.serial;
        try {
          next =
            (await this.#packets.getKeyPacket(request.time / 1e6, { verifyKeyPackets: true })) ??
            (await this.#packets.getFirstPacket());
        } catch (error) {
          this.#fail(MEDIA_ERR_NETWORK, error);
          return;
        }
        continue;
      }
      if (serial !== this.#serial || next === undefined || this.#queueFull()) {
        await this.#readSignal.wait();
        continue;
      }
      if (next === null) {
        this.#queue.push({ serial, packet: null });
        next = undefined;
        this.#decodeSignal.notify();
        continue;
      }
      const packet = next;
      this.#queue.push({ serial, packet });
      this.#addBuffered(packet);
      this.#decodeSignal.notify();
      try {
        next = await this.#packets.getNextPacket(packet);
      } catch (error) {
        this.#fail(MEDIA_ERR_NETWORK, error);
        return;
      }
    }
  }

  async #decodeLoop(): Promise<void> {
    const decoder = this.#decoder;
    while (!this.#closed) {
      const item = this.#queue.peek();
      if (!item) {
        await this.#decodeSignal.wait();
        continue;
      }
      if (item.serial !== this.#serial) {
        this.#queue.shift();
        this.#readSignal.notify();
        continue;
      }
      if (
        decoder.state !== "configured" ||
        this.#frames.length >= this.#options.frameQueueSize ||
        decoder.decodeQueueSize >= 8
      ) {
        if (decoder.state === "closed") return;
        await this.#decodeSignal.wait();
        continue;
      }
      this.#queue.shift();
      this.#readSignal.notify();
      if (!item.packet) {
        try {
          await decoder.flush();
        } catch {
          continue;
        }
        if (item.serial === this.#serial && this.#decoderSerial === item.serial) {
          this.#eofSerial = item.serial;
          this.#needKey = true;
          this.#refresh();
        }
        continue;
      }
      if (this.#needKey) {
        if (item.packet.type !== "key") continue;
        this.#needKey = false;
      }
      decoder.decode(item.packet.toEncodedVideoChunk());
    }
  }
}

export class PlayerError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
