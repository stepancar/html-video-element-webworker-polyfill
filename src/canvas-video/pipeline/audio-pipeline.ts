import { type EncodedPacket, EncodedPacketSink, type InputAudioTrack } from "mediabunny";
import type { AudioSink } from "../audio/sink.ts";
import { Signal } from "./signal.ts";

interface Anchor {
  media: number;
  wall: number;
  rate: number;
}

const SCHEDULE_AHEAD_MS = 1500;
const PREROLL = 0.05;

export class AudioPipeline {
  readonly #packets: EncodedPacketSink;
  readonly #config: AudioDecoderConfig;
  readonly #sink: AudioSink;
  readonly #decoder: AudioDecoder;
  readonly #signal = new Signal();
  #generation = 0;
  #anchor: Anchor | null = null;
  #from = 0;
  #scheduledEnd = 0;
  #closed = false;

  private constructor(track: InputAudioTrack, config: AudioDecoderConfig, sink: AudioSink) {
    this.#packets = new EncodedPacketSink(track);
    this.#config = config;
    this.#sink = sink;
    this.#decoder = new AudioDecoder({
      output: (data) => this.#output(data),
      error: () => this.stop(),
    });
    this.#decoder.addEventListener("dequeue", () => this.#signal.notify());
    sink.onconsumed = () => this.#signal.notify();
  }

  static async create(track: InputAudioTrack, sink: AudioSink): Promise<AudioPipeline | null> {
    const config = await track.getDecoderConfig();
    if (!config) return null;
    const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!support.supported) return null;
    return new AudioPipeline(track, config, sink);
  }

  start(media: number, wall: number, rate: number): void {
    if (this.#closed) return;
    this.stop();
    const generation = this.#generation;
    this.#anchor = { media, wall: performance.timeOrigin + wall, rate };
    this.#from = media;
    this.#scheduledEnd = 0;
    this.#decoder.configure(this.#config);
    void this.#run(generation);
  }

  stop(): void {
    this.#generation++;
    this.#anchor = null;
    this.#sink.stop();
    if (this.#decoder.state === "configured") this.#decoder.reset();
    this.#signal.notify();
  }

  close(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
    if (this.#decoder.state !== "closed") this.#decoder.close();
    this.#sink.onconsumed = null;
  }

  #ahead(): number {
    return this.#scheduledEnd - (performance.timeOrigin + performance.now());
  }

  async #run(generation: number): Promise<void> {
    const live = () => generation === this.#generation && !this.#closed;
    let packet: EncodedPacket | null;
    try {
      const start = Math.max(0, this.#from / 1e6 - PREROLL);
      packet = (await this.#packets.getPacket(start)) ?? (await this.#packets.getFirstPacket());
      while (packet && live()) {
        if (this.#decoder.decodeQueueSize > 4 || this.#ahead() > SCHEDULE_AHEAD_MS) {
          await this.#signal.wait();
          continue;
        }
        this.#decoder.decode(packet.toEncodedAudioChunk());
        packet = await this.#packets.getNextPacket(packet);
      }
      if (live()) await this.#decoder.flush();
    } catch {
      return;
    }
  }

  #output(data: AudioData): void {
    const anchor = this.#anchor;
    try {
      if (!anchor) return;
      const sampleRate = data.sampleRate;
      const total = data.numberOfFrames;
      const skip = data.timestamp < this.#from ? Math.ceil(((this.#from - data.timestamp) * sampleRate) / 1e6) : 0;
      if (skip >= total) return;
      const frames = total - skip;
      const channels: Float32Array[] = [];
      for (let plane = 0; plane < data.numberOfChannels; plane++) {
        const channel = new Float32Array(frames);
        data.copyTo(channel, { planeIndex: plane, frameOffset: skip, frameCount: frames, format: "f32-planar" });
        channels.push(channel);
      }
      const start = data.timestamp + (skip * 1e6) / sampleRate;
      const at = anchor.wall + (start - anchor.media) / 1000 / anchor.rate;
      this.#sink.schedule({ at, sampleRate, frames, channels, rate: anchor.rate });
      this.#scheduledEnd = at + (frames / sampleRate) * (1000 / anchor.rate);
    } finally {
      data.close();
    }
  }
}
